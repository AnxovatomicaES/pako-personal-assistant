import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadBridgeConfig } from "../assistant/bridge/config.ts";

const SCRIPT = join(import.meta.dirname, "..", "assistant", "install.sh");
const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";

function sandbox(o: { withClaude?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "install-home-"));
  // The only programs on the PATH are the ones put here (plus the system's own): a Claude Code next to this machine's node must not leak in.
  const bin = mkdtempSync(join(tmpdir(), "install-bin-"));
  symlinkSync(process.execPath, join(bin, "node"));
  if (o.withClaude !== false) {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
  }
  const envFile = join(home, "assistant.env");
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      input: "",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ASSISTANT_INSTALL_DRY_RUN: "1", ASSISTANT_ENV_FILE: envFile, ASSISTANT_SERVER_URL: "https://pako.example.com", ...extra },
    });
  return { home, bin, envFile, run, plist: join(home, "Library", "LaunchAgents", "local.pako.assistant.plist") };
}

test("install (dry run): writes the config readable by the owner only, keeps other settings, replaces the token, and says nothing of the token", () => {
  const s = sandbox();
  writeFileSync(s.envFile, "ASSISTANT_MODEL=sonnet\nASSISTANT_BRIDGE_TOKEN=oldoldoldoldoldoldoldoldoldoldoldold\nASSISTANT_SERVER_URL=https://old.example.com\n");
  const r = s.run([], { ASSISTANT_BRIDGE_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const env = readFileSync(s.envFile, "utf8").trim().split("\n").sort();
  assert.deepEqual(env, ["ASSISTANT_BRIDGE_TOKEN=" + TOKEN, "ASSISTANT_MODEL=sonnet", "ASSISTANT_SERVER_URL=https://pako.example.com"], "other settings kept, the two it owns replaced");
  assert.equal(statSync(s.envFile).mode & 0o777, 0o600);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), "the token is never printed");
  assert.match(r.stdout, /Dry run: nothing started/);
  assert.equal(statSync(join(s.home, ".pako-assistant")).mode & 0o777, 0o700);
});

test("install (dry run): the LaunchAgent has this machine's paths, runs the bridge with the config file, and does not hold the token", () => {
  const s = sandbox();
  assert.equal(s.run([], { ASSISTANT_BRIDGE_TOKEN: TOKEN }).status, 0);
  const plist = readFileSync(s.plist, "utf8");
  assert.match(plist, /^<\?xml version="1.0"/);
  assert.match(plist, /<\/plist>\s*$/);
  assert.ok(plist.includes(`<string>${join(s.bin, "node")}</string>`), "the node found on this machine's PATH");
  assert.ok(plist.includes(`<string>--env-file=${s.envFile}</string>`));
  assert.match(plist, /assistant\/run\.ts<\/string>/);
  assert.ok(plist.includes(s.bin), "the PATH reaches claude");
  assert.ok(plist.includes("<string>/usr/bin/caffeinate</string>"));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.ok(!plist.includes(TOKEN), "the secret stays in the config file");
  assert.equal(plist.split("<dict>").length, plist.split("</dict>").length, "balanced");
});

test("install: takes exactly the server addresses the bridge takes (no path, no http other than this computer), and writes nothing for the rest", () => {
  // It took https://host/panel and http://localhost.<anything>: it wrote them and said all was well, and the bridge then refused them at every
  // start (the LaunchAgent restarting it in a loop); its own check sent the token over plain http to that other computer.
  const bridgeTakes = (url: string) => {
    try {
      loadBridgeConfig({ ASSISTANT_SERVER_URL: url, ASSISTANT_BRIDGE_TOKEN: TOKEN });
      return true;
    } catch {
      return false;
    }
  };
  for (const url of [
    "https://pako.example.com", "https://pako.example.com/", "https://pako.example.com:8443", "http://localhost:8820", "http://127.0.0.1",
    "https://pako.example.com/panel", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "http://localhost:80/x", "http://pako.example.com",
    "https://", "https://pako example.com", "ftp://pako.example.com",
  ]) {
    const s = sandbox();
    const r = s.run([], { ASSISTANT_BRIDGE_TOKEN: TOKEN, ASSISTANT_SERVER_URL: url });
    assert.equal(r.status === 0, bridgeTakes(url), `${url}: ${r.stderr}`);
    if (r.status !== 0) {
      assert.match(r.stderr, /server's name only/);
      assert.ok(!existsSync(s.envFile) && !existsSync(s.plist), `${url}: nothing written`);
    }
  }
});

test("install: refuses a bad token, a missing Claude Code and an unknown option, and writes nothing then", () => {
  const s = sandbox();
  const bad = (token: string) => s.run([], { ASSISTANT_BRIDGE_TOKEN: token });
  assert.notEqual(bad("short").status, 0);
  assert.match(bad("short").stderr, /too short/);
  assert.match(bad("x".repeat(40) + "; rm -rf /").stderr, /letters, digits/);
  assert.match(bad("x".repeat(40) + "$(id)").stderr, /letters, digits/);
  assert.equal(s.run(["--wat"]).status === 0, false);
  assert.match(s.run(["--wat"]).stderr, /Unknown option/);
  assert.ok(!existsSync(s.envFile) && !existsSync(s.plist), "nothing written");

  const noClaude = sandbox({ withClaude: false });
  const r = noClaude.run([], { ASSISTANT_BRIDGE_TOKEN: TOKEN });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Claude Code is not installed/);
  assert.ok(!existsSync(noClaude.envFile));
});

test("install: Node.js 23.0 to 23.5 is refused like 22.17 (no type stripping by default), and 23.6 and 24 are fine", () => {
  // It took any 23 as new enough, while bin/preflight.cjs and install.sh say 23.6: the assistant then failed at each start in its log.
  for (const [version, ok] of [["23.1.0", false], ["22.17.0", false], ["23.6.0", true], ["24.0.0", true]] as const) {
    const s = sandbox();
    const fake = join(s.bin, "fake-version.cjs");
    writeFileSync(fake, `Object.defineProperty(process, "versions", { value: { ...process.versions, node: ${JSON.stringify(version)} } });\n`);
    rmSync(join(s.bin, "node"));
    writeFileSync(join(s.bin, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --require ${JSON.stringify(fake)} "$@"\n`);
    chmodSync(join(s.bin, "node"), 0o755);
    const r = s.run([], { ASSISTANT_BRIDGE_TOKEN: TOKEN });
    assert.equal(r.status === 0, ok, `${version}: ${r.stderr}${r.stdout}`);
    if (!ok) assert.match(r.stderr, /too old: 22\.18 or newer/);
  }
});

test("install: with no token given it asks for one (not echoed) and uses the one already in the file; --uninstall removes the LaunchAgent and keeps the config", () => {
  const s = sandbox();
  const asked = s.run([], {});
  assert.notEqual(asked.status, 0, "no token and nobody to type it");
  assert.match(asked.stderr + asked.stdout, /Paste the bridge token/);

  mkdirSync(dirname(s.envFile), { recursive: true });
  writeFileSync(s.envFile, `ASSISTANT_BRIDGE_TOKEN=${TOKEN}\n`);
  const again = s.run([], {});
  assert.equal(again.status, 0, again.stderr);
  assert.ok(readFileSync(s.envFile, "utf8").includes(`ASSISTANT_BRIDGE_TOKEN=${TOKEN}`), "reuses the token already there");
  assert.ok(existsSync(s.plist));

  const gone = s.run(["--uninstall"]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!existsSync(s.plist), "the LaunchAgent is gone");
  assert.ok(existsSync(s.envFile), "the config stays");
});

test("voice setup (dry run): says what it would install and download, writes the model path into the settings (replacing an old one, keeping the rest, readable by the owner only), and refuses an unknown model size", () => {
  const home = mkdtempSync(join(tmpdir(), "voice-home-"));
  const bin = mkdtempSync(join(tmpdir(), "voice-bin-"));
  const envFile = join(home, "assistant.env");
  writeFileSync(envFile, "ASSISTANT_MODEL=sonnet\nASSISTANT_WHISPER_MODEL=/old/model.bin\n", { mode: 0o644 });
  const script = join(import.meta.dirname, "..", "assistant", "voice-setup.sh");
  const run = (extra: Record<string, string> = {}) =>
    spawnSync("bash", [script], { encoding: "utf8", input: "", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ASSISTANT_VOICE_DRY_RUN: "1", ASSISTANT_ENV_FILE: envFile, ...extra } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry run\] brew install whisper-cpp ffmpeg/);
  assert.match(r.stdout, /\[dry run\] curl -L --fail --progress-bar -o .*ggml-small\.bin\.part https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-small\.bin/);
  const env = readFileSync(envFile, "utf8").trim().split("\n").sort();
  assert.deepEqual(env, ["ASSISTANT_MODEL=sonnet", `ASSISTANT_WHISPER_MODEL=${join(home, ".pako-assistant", "models", "ggml-small.bin")}`]);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const medium = run({ WHISPER_SIZE: "medium" });
  assert.match(medium.stdout, /ggml-medium\.bin/);
  const bad = run({ WHISPER_SIZE: "huge" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /WHISPER_SIZE must be/);
  assert.equal(spawnSync("bash", ["-n", script]).status, 0, "the script parses");
});


test("install: the server address is never guessed: kept from the settings file, asked when missing, and a quoted or CRLF token in the file is accepted", () => {
  // Kept: running it again without the address leaves the one in the file (and the token with quotes and a carriage return still counts).
  const s = sandbox();
  writeFileSync(s.envFile, `ASSISTANT_SERVER_URL=https://mine.example.com\r\nASSISTANT_BRIDGE_TOKEN="${TOKEN}"\r\n`);
  const kept = s.run([], { ASSISTANT_SERVER_URL: "" });
  assert.equal(kept.status, 0, kept.stderr + kept.stdout);
  const env = readFileSync(s.envFile, "utf8").trim().split("\n").sort();
  assert.deepEqual(env, ["ASSISTANT_BRIDGE_TOKEN=" + TOKEN, "ASSISTANT_SERVER_URL=https://mine.example.com"]);
  // Asked: with no address anywhere it stops (nothing is sent to a default host), and says why.
  const none = sandbox();
  const asked = none.run([], { ASSISTANT_SERVER_URL: "", ASSISTANT_BRIDGE_TOKEN: TOKEN });
  assert.notEqual(asked.status, 0);
  assert.match(asked.stdout + asked.stderr, /server address/i);
  assert.ok(!existsSync(none.envFile), "nothing written");
  // Not https: refused.
  const plain = sandbox().run([], { ASSISTANT_SERVER_URL: "http://example.com", ASSISTANT_BRIDGE_TOKEN: TOKEN });
  assert.notEqual(plain.status, 0);
});

test("install: a Mac set up before Pako had its name keeps its ~/.ai-buyer-assistant, and its com.aibuyer.assistant LaunchAgent is replaced, not doubled", () => {
  const s = sandbox();
  const old = join(s.home, ".ai-buyer-assistant");
  const oldPlist = join(s.home, "Library", "LaunchAgents", "com.aibuyer.assistant.plist");
  mkdirSync(join(old, "models"), { recursive: true, mode: 0o700 });
  writeFileSync(join(old, "state.json"), '{"sessionId":"s1","count":3}');
  mkdirSync(dirname(oldPlist), { recursive: true });
  writeFileSync(oldPlist, "<plist/>");
  const r = s.run([], { ASSISTANT_BRIDGE_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Removed the older LaunchAgent/);
  assert.ok(!existsSync(oldPlist), "the older LaunchAgent is gone: one assistant runs, not two");
  const plist = readFileSync(s.plist, "utf8");
  assert.ok(plist.includes("<string>local.pako.assistant</string>"));
  assert.ok(plist.includes(`<string>${join(old, "assistant.log")}</string>`), "the log stays in the older folder");
  assert.ok(!existsSync(join(s.home, ".pako-assistant")), "no second folder beside it");
  assert.equal(readFileSync(join(old, "state.json"), "utf8"), '{"sessionId":"s1","count":3}', "the conversation is kept");

  // --uninstall removes either LaunchAgent, and keeps the folder.
  writeFileSync(oldPlist, "<plist/>");
  const gone = s.run(["--uninstall"]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!existsSync(s.plist) && !existsSync(oldPlist));
  assert.ok(existsSync(join(old, "state.json")));
});

test("voice setup (dry run): on a Mac with only the older ~/.ai-buyer-assistant, the model goes there and the restart names the LaunchAgent it has", () => {
  const home = mkdtempSync(join(tmpdir(), "voice-home-"));
  const bin = mkdtempSync(join(tmpdir(), "voice-bin-"));
  const envFile = join(home, "assistant.env");
  const script = join(import.meta.dirname, "..", "assistant", "voice-setup.sh");
  const run = () => spawnSync("bash", [script], { encoding: "utf8", input: "", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ASSISTANT_VOICE_DRY_RUN: "1", ASSISTANT_ENV_FILE: envFile } });
  mkdirSync(join(home, ".ai-buyer-assistant"));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.aibuyer.assistant.plist"), "<plist/>");
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(envFile, "utf8").includes(`ASSISTANT_WHISPER_MODEL=${join(home, ".ai-buyer-assistant", "models", "ggml-small.bin")}`));
  assert.match(r.stdout, /gui\/\$\(id -u\)\/com\.aibuyer\.assistant\n/);
  // Once install.sh has run again: the newer LaunchAgent is named.
  writeFileSync(join(home, "Library", "LaunchAgents", "local.pako.assistant.plist"), "<plist/>");
  r = run();
  assert.match(r.stdout, /gui\/\$\(id -u\)\/local\.pako\.assistant\n/);
});
