// Voice notes: the owner's computer turns the audio into words with Whisper, locally (whisper.cpp), so nothing is sent to anyone and there is no
// speech-to-text bill. WhatsApp voice notes are Opus in an Ogg file; ffmpeg makes the 16 kHz mono WAV that whisper.cpp reads.
//
// Both programs are run with an argument list, never through a shell, on a file this code wrote in a private folder that is deleted afterwards.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface VoiceConfig {
  whisperModel: string;
  whisperBin: string;
  ffmpegBin: string;
  whisperLang: string;
  stateDir: string;
}

export class VoiceError extends Error {}

const extension = (mime: string): string => {
  const m = mime.toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return ".m4a";
  if (m.includes("amr")) return ".amr";
  return ".bin";
};

/** Runs a program with arguments (no shell) and returns what it printed; fails on a bad exit code or a timeout. */
export function runProgram(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (b: string) => {
      if (out.length < 2_000_000) out += b;
    });
    child.stderr.on("data", (b: string) => {
      if (err.length < 20_000) err += b;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new VoiceError(`could not start ${bin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new VoiceError(`${bin} took longer than ${Math.round(timeoutMs / 1000)} s`));
      if (code !== 0) return reject(new VoiceError(`${bin} failed (exit ${code}): ${err.replace(/\s+/g, " ").trim().slice(0, 200)}`));
      resolve(out);
    });
  });
}

/** What whisper.cpp printed, as plain text: no timestamps, no blank or sound-effect-only lines like [MÚSICA]. */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    .join(" ")
    .trim();
}

/** The words in a voice note ("" if there are none). */
export async function transcribeVoiceNote(audio: Buffer, mime: string, c: VoiceConfig, run: typeof runProgram = runProgram): Promise<string> {
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  // A bridge killed in the middle of ffmpeg or whisper leaves its folder (with the owner's audio) behind: the old ones are swept.
  try {
    for (const name of readdirSync(c.stateDir)) {
      if (!name.startsWith("voice-")) continue;
      const path = join(c.stateDir, name);
      if (Date.now() - statSync(path).mtimeMs > 3600_000) rmSync(path, { recursive: true, force: true });
    }
  } catch {
    /* nothing to sweep */
  }
  const dir = mkdtempSync(join(c.stateDir, "voice-"));
  try {
    const input = join(dir, `in${extension(mime)}`);
    const wav = join(dir, "out.wav");
    writeFileSync(input, audio, { mode: 0o600 });
    await run(c.ffmpegBin, ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 60_000);
    const printed = await run(c.whisperBin, ["-m", c.whisperModel, "-f", wav, "-l", c.whisperLang, "-nt", "-np"], 180_000);
    return cleanTranscript(printed).slice(0, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
