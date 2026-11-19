// The voice lab: a page behind the admin key where the owner talks to the same LiveKit agent from the browser, over WebRTC and with
// wide-band audio, with no phone line in between. It separates "how the voice sounds" from "how a phone call sounds", and makes
// trying voices quick (pick one, start, talk; stop, pick another).
//
// The browser client is livekit-client from jsDelivr, pinned to a version and checked with its integrity hash.

const LK_CLIENT = "https://cdn.jsdelivr.net/npm/livekit-client@2.23.0/dist/livekit-client.umd.js";
const LK_CLIENT_SRI = "sha384-HkA7rQNo8H04l1p4zoXX1Cy+h9YoYp8LvKt4vfMFhv4KFk07UkrNwIUnyBum8Pw6";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page's own policy: its inline script by nonce, the pinned client from jsDelivr, and the LiveKit project for media and signalling. */
export function voiceLabCsp(nonce: string, livekitUrl: string): string {
  let host = "";
  try {
    host = new URL(livekitUrl.replace(/^ws/, "http")).host;
  } catch {
    /* no LiveKit URL: the page will say so when a session is asked for */
  }
  const lk = host ? ` wss://${host} https://${host} wss://*.livekit.cloud https://*.livekit.cloud` : "";
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
    `connect-src 'self'${lk}`,
    "media-src 'self' blob:",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function voiceLabPage(nonce: string, voices: readonly string[], current: string): string {
  const options = voices.map((v) => `<option${v === current ? " selected" : ""}>${esc(v)}</option>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice lab</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--mut:#78716c;--card:#fff;--line:#e7e5e4;--acc:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#141210;--fg:#f5f5f4;--mut:#a8a29e;--card:#1c1917;--line:#2e2a27;--acc:#2dd4bf}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--mut);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;display:grid;gap:12px}
label{font-size:14px;color:var(--mut)}select,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.row{display:flex;gap:8px;flex-wrap:wrap}button.go{background:var(--acc);color:#fff;border-color:var(--acc)}button:disabled{opacity:.5}
#st{font-size:14px;color:var(--mut);min-height:21px}#log{font-size:14px;white-space:pre-wrap;max-height:260px;overflow:auto}
</style></head><body><main>
<h1>Voice lab</h1>
<p>Talk to your assistant from the browser, with no phone line in between. Use headphones so it does not hear itself.</p>
<div class="card">
  <label for="voice">Voice</label>
  <select id="voice">${options}</select>
  <div class="row"><button id="go" class="go">Start</button><button id="stop" disabled>Stop</button></div>
  <div id="st"></div>
  <div id="log"></div>
  <div id="audio" hidden></div>
</div>
</main>
<script nonce="${nonce}" src="${LK_CLIENT}" integrity="${LK_CLIENT_SRI}" crossorigin="anonymous"></script>
<script nonce="${nonce}">
const { Room, RoomEvent, Track } = LivekitClient;
let room;
const $ = (id) => document.getElementById(id);
const st = (t) => ($("st").textContent = t);
const log = (t) => { $("log").textContent += t + "\\n"; $("log").scrollTop = 1e9; };
$("go").onclick = async () => {
  $("go").disabled = true;
  st("Starting… the voice server may need up to a minute to wake.");
  try {
    const r = await fetch("/admin/voice-lab/session", { method: "POST", headers: { "content-type": "application/json", "x-admin-action": "voice-lab" },
      body: JSON.stringify({ voice: $("voice").value }) });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
    const { url, token, call_id } = await r.json();
    room = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    room.on(RoomEvent.TrackSubscribed, (track) => { if (track.kind === Track.Kind.Audio) $("audio").appendChild(track.attach()); });
    room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
    room.on(RoomEvent.ParticipantConnected, () => st("Your assistant joined. Talk."));
    room.on(RoomEvent.Disconnected, () => { st("Ended. Call id " + call_id + " (get_call has its numbers)."); $("go").disabled = false; $("stop").disabled = true; });
    room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
      const text = await reader.readAll();
      if (text.trim()) log((info.identity && info.identity.startsWith("owner-web") ? "You: " : "Assistant: ") + text.trim());
    });
    await room.connect(url, token);
    await room.startAudio();
    await room.localParticipant.setMicrophoneEnabled(true);
    $("stop").disabled = false;
    st("Connected. Waiting for your assistant…");
  } catch (e) {
    st("Could not start: " + e.message);
    $("go").disabled = false;
  }
};
$("stop").onclick = () => room && room.disconnect();
</script></body></html>`;
}
