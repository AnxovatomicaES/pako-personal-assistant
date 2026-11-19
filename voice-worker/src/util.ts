// Pure helpers of the voice worker: nothing here touches the network, so they are unit tested.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface LatencyStat {
  p50: number;
  p90: number;
  n: number;
}

/** Nearest-rank percentile of a list of numbers (empty list: null). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export function latencyStat(values: number[]): LatencyStat | undefined {
  const p50 = percentile(values, 50);
  const p90 = percentile(values, 90);
  if (p50 === null || p90 === null) return undefined;
  return { p50: Math.round(p50), p90: Math.round(p90), n: values.length };
}

export interface WordStat {
  p50: number;
  p90: number;
  max: number;
  n: number;
}

/** How the conversation went, beyond speed: what gives a voice assistant away on a call is long answers and how it takes being cut off. */
export interface TalkStats {
  /** Words per finished assistant turn (the opening and cut-off turns left out): long-windedness. */
  words_per_turn?: WordStat;
  /** Times the person started speaking while the assistant was audibly speaking. */
  interruptions: number;
  /** From the person's first voiced frame over the assistant to the assistant going quiet. */
  barge_in_stop_ms?: LatencyStat;
  /** Cut-offs after which the assistant kept talking for more than a second after the person had finished. */
  talked_over: number;
  /** Replies whose playout started while the person was still speaking. */
  started_over: number;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** How long the assistant may keep talking after the person has finished before it counts as talking over them. */
export const TALKED_OVER_MS = 1000;

/** Loudness of a frame of 16-bit audio in dB relative to full scale (silence: -100). */
export function rmsDb(samples: Int16Array): number {
  if (!samples.length) return -100;
  let sum = 0;
  for (const v of samples) sum += v * v;
  const rms = Math.sqrt(sum / samples.length) / 32768;
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/** Tuning of the speech detector on the person's phone audio. */
export const VOICE = {
  /** Never voice below this level, whatever the line noise. */
  minDb: -45,
  /** Voice is this far above the line's noise floor. */
  marginDb: 12,
  /** The noise floor is a low percentile of this last stretch: speech always has dips between words, steady line noise does not. */
  floorWindowMs: 4000,
  /** Voiced audio this long in a row starts speech (a click or a breath is shorter). */
  startMs: 120,
  /** Silence this long ends speech (pauses between words are shorter). */
  endMs: 350,
} as const;

/**
 * Measures a call from the person's own audio and the assistant's playout, the way the person hears it on the server side.
 * With Gemini Live the session's user states do not follow the person's voice (it reports "speaking" when a reply starts and "listening" when it
 * ends), so this listens to the phone audio itself: a loudness detector whose noise floor is a low percentile of the last few seconds.
 * - reply gap: from the end of the person's last voice to the assistant's playout starting, for a reply that follows voice heard after the
 *   assistant last went quiet; the phone network adds its own delay on top (both ways), which this cannot see.
 * - started over: the assistant's playout starting while the person is still speaking (no reply gap then).
 * - cut-offs: the person starting to speak while the assistant is audibly speaking; the stop delay runs from their first voiced frame to the
 *   assistant going quiet, and it talked over them when it went on more than TALKED_OVER_MS after they had finished.
 * - words per finished assistant turn, the scripted opening left out.
 * Nothing said during the opening phase (the model does not hear the person then) starts a cut-off or a count.
 */
export class VoiceMeter {
  opening = true;
  private recent: number[] = [];
  private runStart: number | null = null;
  private voicedMs = 0;
  private silentMs = 0;
  private inSpeech = false;
  private lastVoiceAt: number | null = null;
  private agentSpeaking = false;
  private agentStoppedAt: number | null = null;
  private bargeAt: number | null = null;
  private userStoppedAt: number | null = null;
  private gaps: number[] = [];
  private stops: number[] = [];
  private words: number[] = [];
  private interrupted = 0;
  private over = 0;
  private startedOver = 0;

  /** One frame of the person's audio: its loudness, when it ended (ms), and how long it lasts. */
  audio(db: number, at: number, ms: number): void {
    this.recent.push(db);
    if (this.recent.length > Math.max(1, Math.round(VOICE.floorWindowMs / ms))) this.recent.shift();
    const sorted = [...this.recent].sort((x, y) => x - y);
    const floor = Math.min(-30, Math.max(-90, sorted[Math.floor(sorted.length * 0.1)]!));
    const voiced = db > Math.max(VOICE.minDb, floor + VOICE.marginDb);
    if (voiced) {
      this.runStart ??= at - ms;
      this.voicedMs += ms;
      // A lone loud frame (a click, a noise peak) is not voice: only a run long enough to start speech, or a short run inside speech, counts.
      if (this.voicedMs >= VOICE.startMs || (this.inSpeech && this.voicedMs >= 2 * ms)) {
        this.silentMs = 0;
        this.lastVoiceAt = at;
      }
      if (!this.inSpeech && this.voicedMs >= VOICE.startMs) this.speechStarted(this.runStart);
    } else {
      this.silentMs += ms;
      this.voicedMs = 0;
      this.runStart = null;
      if (this.inSpeech && this.silentMs >= VOICE.endMs) this.speechEnded();
    }
  }

  private speechStarted(at: number): void {
    this.inSpeech = true;
    this.userStoppedAt = null;
    if (!this.opening && this.agentSpeaking && this.bargeAt === null) {
      this.bargeAt = at;
      this.interrupted++;
    }
  }

  private speechEnded(): void {
    this.inSpeech = false;
    if (this.bargeAt !== null) this.userStoppedAt = this.lastVoiceAt;
  }

  /** Returns the reply gap in ms when this state change is a reply that follows the person's voice (so the call log can show every gap). */
  agentState(newState: string, at: number): number | undefined {
    const speaking = newState === "speaking";
    let gap: number | undefined;
    if (speaking && !this.agentSpeaking && !this.opening) {
      // Gemini can answer 200 ms after the person stops, before this detector calls their speech over: only voice in the last 100 ms is overlap.
      if (this.inSpeech && this.silentMs < 100) this.startedOver++;
      else if (this.lastVoiceAt !== null && this.lastVoiceAt > (this.agentStoppedAt ?? -Infinity)) {
        gap = Math.max(0, at - this.lastVoiceAt);
        this.gaps.push(gap);
      }
    }
    if (this.agentSpeaking && !speaking) {
      this.agentStoppedAt = at;
      if (this.bargeAt !== null) {
        this.stops.push(Math.max(0, at - this.bargeAt));
        if (this.userStoppedAt !== null && at - this.userStoppedAt > TALKED_OVER_MS) this.over++;
        this.bargeAt = null;
        this.userStoppedAt = null;
      }
    }
    this.agentSpeaking = speaking;
    return gap;
  }

  assistantMessage(text: string, interrupted: boolean): void {
    if (!this.opening && !interrupted) this.words.push(wordCount(text));
  }

  stats(): { e2e?: LatencyStat; talk: TalkStats } {
    const p50 = percentile(this.words, 50);
    const p90 = percentile(this.words, 90);
    const stop = latencyStat(this.stops);
    const e2e = latencyStat(this.gaps);
    return {
      ...(e2e ? { e2e } : {}),
      talk: {
        ...(p50 !== null && p90 !== null ? { words_per_turn: { p50, p90, max: Math.max(...this.words), n: this.words.length } } : {}),
        interruptions: this.interrupted,
        ...(stop ? { barge_in_stop_ms: stop } : {}),
        talked_over: this.over,
        started_over: this.startedOver,
      },
    };
  }
}

/**
 * What the owner says, as it is transcribed live. The committed transcript lines are not enough for the confirmation of a call: with Gemini
 * Live the owner's turn is only committed when the model's turn is over, and while a tool runs that turn is still open. The live (partial)
 * transcripts arrive as the owner speaks, each carrying the text so far for its turn: only the new part of each is kept, with its time.
 */
export class LiveHearing {
  private bits: { at: number; text: string }[] = [];
  private seen = new Map<string, number>();
  add(itemId: string | null | undefined, transcript: string, at: number): void {
    const id = itemId ?? "_";
    const prev = this.seen.get(id) ?? 0;
    if (transcript.length <= prev) return;
    this.bits.push({ at, text: transcript.slice(prev) });
    this.seen.set(id, transcript.length);
  }
  /** Everything the owner said from that time on, as one text. */
  after(at: number): string {
    return this.bits.filter((b) => b.at >= at).map((b) => b.text).join("").replace(/\s+/g, " ").trim();
  }
}

/** "low" or "high" for a Gemini Live speech-detection setting; anything else gives the default. */
export function sensitivityOf(raw: string | undefined, fallback: "low" | "high"): "low" | "high" {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "low" || v === "high" ? v : fallback;
}

/** The body of a result post is signed with the LiveKit API secret, which both servers already hold: no second secret to keep. */
export function sign(secret: string, body: string): string {
  return createHmac("sha256", `voice-result:${secret}`).update(body).digest("hex");
}

/** Delegate asks and inbound-session requests: the same shared secret under a key of their own, so a result signature never passes as one. */
export function signAsk(secret: string, body: string): string {
  return createHmac("sha256", `voice-delegate:${secret}`).update(body).digest("hex");
}

/** True when the dispatch came from the inbound dispatch rule (the owner rang in), whose metadata is {"mode":"inbound"}. */
export function inboundRule(raw: string | undefined): { pin: boolean } | null {
  try {
    const o = JSON.parse(raw ?? "") as Record<string, unknown>;
    return o && o.mode === "inbound" ? { pin: o.pin === true } : null;
  } catch {
    return null;
  }
}

export function verify(secret: string, body: string, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const a = Buffer.from(sign(secret, body), "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A credential as pasted into a hosting dashboard: none of ours (URL, API key, API secret) contains whitespace, so any space,
 * tab or line break that came with the paste is dropped, and so are quotes wrapped around it. LiveKit's CLI reads these straight
 * from the environment, where a single stray character gives a 401.
 */
export function cleanSecret(v: string | undefined): string {
  return (v ?? "").replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
}

/** What can be said about the LiveKit credentials without revealing them: shape only, for the start-up log. */
export function credentialShape(url: string, key: string, secret: string): string {
  const host = /^wss?:\/\/([^/\s]+)/.exec(url)?.[1] ?? "no-valid-url";
  return `url host ${host}; key ${key.length} chars${key.startsWith("API") ? ", starts API" : ", does NOT start with API"}; secret ${secret.length} chars`;
}

/**
 * How many standby processes the worker keeps loaded (VOICE_IDLE_PROCESSES). Zero by default: a standby process is replaced the moment a call
 * takes it, and loading the replacement starves the live call on a small host (Render free is 0.1 CPU). With zero, the call's own process is
 * started on demand and nothing else runs next to it. A host with real CPU can set 1 to skip that start-up.
 */
export function idleProcesses(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 4) : 0;
}

/**
 * The main server's address, where results and asks are posted: PAKO_URL, else AI_BUYER_URL, its name from before Pako was called Pako, which a
 * worker set up then still has in its host's settings. No trailing slash.
 */
export function mainServerUrl(env: Record<string, string | undefined>): string {
  return ((env.PAKO_URL ?? "").trim() || (env.AI_BUYER_URL ?? "").trim()).replace(/\/+$/, "");
}

/**
 * True when the assistant's first words tell the person it is an AI. The Spanish words (asistente, IA, inteligencia artificial) stay: the
 * opening of a call the server placed from an older version, or one the person had it say in Spanish, still counts as disclosed.
 */
export function disclosesAi(firstAssistantLine: string | undefined): boolean {
  return !!firstAssistantLine && /\b(asistente|IA|AI|inteligencia artificial|assistant)\b/i.test(firstAssistantLine);
}

/** The languages a call can start in: English, Pako's own; Spanish only for an opening that is plainly Spanish (an older server's). */
export type CallLanguage = "en-US" | "es-ES";

/**
 * The language the voice starts in, read from the opening line (the dispatch carries no language field). The opening is Pako's fixed text,
 * so English; a Spanish greeting (from a server that still wrote Spanish openings) starts in Spanish. Either way the voice follows the person
 * once they answer in another language (agent.ts ACCENT).
 */
export function languageFor(opening: string): CallLanguage {
  return /^\s*(hola|buenas|buenos)\b/i.test(opening) ? "es-ES" : "en-US";
}

/** A phone number the way a dialler wants it: +, then digits only. */
export function e164(n: string): string | null {
  const d = n.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(d) ? d : null;
}

export interface CallMeta {
  callId: string;
  /** "owner" and "friend": the worker dials `to`. "inbound": the owner rang in. "web": the owner is in the browser voice lab. */
  kind: "owner" | "friend" | "inbound" | "web";
  /** The number to dial (owner and friend calls). */
  to?: string;
  /** Who to talk to when nothing is dialled: the inbound caller's or the browser's participant identity. */
  participant?: string;
  instructions: string;
  opening: string;
  voice?: string;
  model?: string;
  /** No message to deliver: an open conversation (longer allowed, no nudge to start). */
  open?: boolean;
  /** Present when the call may use ask_claude: proves the request to the main server. */
  delegateToken?: string;
  /** Whether the main server verified this call (it dialled the owner, or the owner typed the PIN); echoed back in the result. */
  trusted?: boolean;
}

/** Parses the dispatch metadata the main server sends; anything missing or malformed is refused (the worker never dials on a guess). */
export function parseMeta(raw: string | undefined): CallMeta | string {
  if (!raw) return "no metadata";
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return "metadata is not JSON";
  }
  if (!j || typeof j !== "object") return "metadata is not an object";
  const o = j as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string) : undefined);
  if (!/^[\w-]{6,80}$/.test(str("call_id") ?? "")) return "bad call_id";
  if (o.kind !== "owner" && o.kind !== "friend" && o.kind !== "inbound" && o.kind !== "web") return "bad kind";
  if (!str("instructions") || !str("opening")) return "missing instructions or opening";
  const dialled = o.kind === "owner" || o.kind === "friend";
  const to = dialled && str("to") ? e164(str("to")!) : null;
  if (dialled && !to) return "bad destination number";
  const participant = str("participant");
  if (!dialled && (!participant || !/^[\w.+:@-]{3,120}$/.test(participant))) return "bad participant";
  const token = str("delegate_token");
  return {
    callId: str("call_id")!,
    kind: o.kind,
    ...(to ? { to } : {}),
    ...(!dialled ? { participant } : {}),
    instructions: str("instructions")!,
    opening: str("opening")!,
    voice: str("voice"),
    model: str("model"),
    ...(o.open === true ? { open: true } : {}),
    ...(token && /^[\w-]{20,100}$/.test(token) ? { delegateToken: token } : {}),
    ...(typeof o.trusted === "boolean" ? { trusted: o.trusted } : {}),
  };
}
