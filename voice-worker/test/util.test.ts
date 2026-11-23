import assert from "node:assert/strict";
import { test } from "node:test";
import { CALL_UNKNOWN, CONFIRM_CALL_MS, LiveHearing, VoiceMeter, cleanSecret, credentialShape, disclosesAi, e164, idleProcesses, languageFor, latencyStat, parseMeta, inboundRule, mayHaveGoneOut, percentile, sensitivityOf, rmsDb, sign, signAsk, verify, wordCount } from "../src/util.ts";

test("languageFor: a call starts in English; only a plainly Spanish greeting (an older server's opening) starts in Spanish", () => {
  assert.equal(languageFor("Hi Marta, it's your assistant. Quick one for you."), "en-US");
  assert.equal(languageFor("  hello there"), "en-US");
  assert.equal(languageFor("Marta, your assistant here"), "en-US");
  assert.equal(languageFor("Hola Marta, soy tu asistente. Oye, una cosa rápida."), "es-ES");
  assert.equal(languageFor("Hiciste bien, soy tu asistente"), "en-US", "no greeting: English, Pako's own language");
});

test("idleProcesses: zero unless asked, whole numbers only, capped", () => {
  assert.equal(idleProcesses(undefined), 0);
  assert.equal(idleProcesses(""), 0);
  assert.equal(idleProcesses("abc"), 0);
  assert.equal(idleProcesses("-2"), 0);
  assert.equal(idleProcesses("1"), 1);
  assert.equal(idleProcesses("2.9"), 2);
  assert.equal(idleProcesses("50"), 4);
});

test("cleanSecret drops pasted whitespace and wrapping quotes, never touches the value itself", () => {
  assert.equal(cleanSecret("APIabc123\n"), "APIabc123");
  assert.equal(cleanSecret("  Zk9+/xY=  "), "Zk9+/xY=");
  assert.equal(cleanSecret('"APIabc123"'), "APIabc123");
  assert.equal(cleanSecret("wss://caller-x.livekit.cloud \r\n"), "wss://caller-x.livekit.cloud");
  assert.equal(cleanSecret("AB CD\nEF"), "ABCDEF");
  assert.equal(cleanSecret(undefined), "");
});

test("credentialShape says lengths and the API prefix, nothing of the values", () => {
  const s = credentialShape("wss://caller-x.livekit.cloud", "APIabcdefghijkl", "s".repeat(44));
  assert.match(s, /url host caller-x\.livekit\.cloud; key 15 chars, starts API; secret 44 chars/);
  assert.ok(!s.includes("abcdefghijkl"));
  assert.match(credentialShape("caller-x", "xyz", ""), /no-valid-url; key 3 chars, does NOT start with API; secret 0 chars/);
});

test("percentile: nearest rank, empty list is null", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([100, 200, 300, 400], 50), 200);
  assert.equal(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 90), 900);
});

test("latencyStat rounds and counts", () => {
  assert.deepEqual(latencyStat([1000.4, 1200.6, 1400]), { p50: 1201, p90: 1400, n: 3 });
  assert.equal(latencyStat([]), undefined);
});

test("sign / verify: tampered body, wrong secret and missing signature fail", () => {
  const sig = sign("s3cret", '{"a":1}');
  assert.equal(verify("s3cret", '{"a":1}', sig), true);
  assert.equal(verify("s3cret", '{"a":2}', sig), false);
  assert.equal(verify("other", '{"a":1}', sig), false);
  assert.equal(verify("s3cret", '{"a":1}', undefined), false);
  assert.equal(verify("", '{"a":1}', sig), false);
  assert.equal(verify("s3cret", '{"a":1}', "zz"), false);
});

test("disclosesAi spots the AI line in Spanish and English", () => {
  assert.equal(disclosesAi("Hola Marta, soy tu asistente. Oye, una cosa rápida."), true);
  assert.equal(disclosesAi("Hola, soy una IA que llama de parte de Marta"), true);
  assert.equal(disclosesAi("Hi, it's your assistant."), true);
  assert.equal(disclosesAi("Hola, qué tal"), false);
  assert.equal(disclosesAi(undefined), false);
});

test("e164 accepts a plain number and refuses the rest", () => {
  assert.equal(e164("+34 936 94 43 71"), "+34936944371");
  assert.equal(e164("936944371"), null);
  assert.equal(e164("+0123"), null);
});

test("parseMeta needs every field and a valid number", () => {
  const ok = { call_id: "lk_abcdef12", to: "+34600111222", kind: "owner", instructions: "Be brief", opening: "Hola Marta, soy tu asistente." };
  const m = parseMeta(JSON.stringify(ok));
  assert.equal(typeof m, "object");
  assert.equal((m as { to: string }).to, "+34600111222");
  assert.equal(parseMeta(undefined), "no metadata");
  assert.equal(parseMeta("{"), "metadata is not JSON");
  assert.equal(parseMeta(JSON.stringify({ ...ok, to: "600111222" })), "bad destination number");
  assert.equal(parseMeta(JSON.stringify({ ...ok, call_id: "x" })), "bad call_id");
  assert.equal(parseMeta(JSON.stringify({ ...ok, kind: "stranger" })), "bad kind");
  assert.equal(parseMeta(JSON.stringify({ ...ok, opening: " " })), "missing instructions or opening");
});

test("wordCount: words only, not stray punctuation", () => {
  assert.equal(wordCount("Vale, claro — a las cinco."), 5);
  assert.equal(wordCount("  "), 0);
  assert.equal(wordCount("¿Sí? 3 cosas"), 3);
});

/** Feeds 20 ms frames of the given loudness from `from` to `to` (ms). */
function feed(m: VoiceMeter, db: number, from: number, to: number): void {
  for (let t = from + 20; t <= to; t += 20) m.audio(db, t, 20);
}

test("rmsDb: full scale near 0 dB, silence -100", () => {
  assert.equal(rmsDb(new Int16Array(160)), -100);
  assert.ok(Math.abs(rmsDb(new Int16Array(160).fill(32767))) < 0.01);
  assert.ok(Math.abs(rmsDb(new Int16Array(160).fill(3277)) + 20) < 0.1, "a tenth of full scale is -20 dB");
});

test("VoiceMeter: reply gaps from the person's last voiced frame, cut-offs and talking over from their audio, the opening left out", () => {
  const m = new VoiceMeter();
  assert.deepEqual(m.stats(), { talk: { interruptions: 0, talked_over: 0, started_over: 0 } }, "nothing yet");
  feed(m, -60, 0, 1000); // line noise
  // The opening: the person says "¿Sí?" over it; not counted (the model does not hear them yet).
  m.agentState("speaking", 1000);
  feed(m, -20, 1000, 1400);
  feed(m, -60, 1400, 3000);
  m.agentState("listening", 3000);
  m.assistantMessage("Hola Marta, soy tu asistente. Oye, una cosa rápida.", false);
  m.opening = false;
  // "Dime" (3100-3500), short pause between words does not end it, then the reply starts 600 ms after the last voiced frame.
  feed(m, -60, 3000, 3100);
  feed(m, -22, 3100, 3300);
  feed(m, -60, 3300, 3400);
  feed(m, -22, 3400, 3500);
  feed(m, -60, 3500, 4100);
  assert.equal(m.agentState("speaking", 4100), 600, "the reply gap is returned, for the call log");
  // A cough (60 ms) while it speaks is not a cut-off.
  feed(m, -20, 4100, 4160);
  feed(m, -60, 4160, 5000);
  m.agentState("listening", 5000);
  m.assistantMessage("Vale, a las cinco en la oficina.", false);
  // The assistant carries on by itself without the person speaking: no gap sample.
  m.agentState("speaking", 5500);
  // The person cuts in at 6000; it goes quiet at 6250.
  feed(m, -60, 5000, 6000);
  feed(m, -18, 6000, 6400);
  m.agentState("listening", 6250);
  m.assistantMessage("Y otra cosa que", true);
  feed(m, -60, 6400, 7200);
  // Reply 800 ms after they stopped; they cut in again (8000-8300) and it goes on until 9800: talked over.
  m.agentState("speaking", 7200);
  feed(m, -60, 7200, 8000);
  feed(m, -18, 8000, 8300);
  feed(m, -60, 8300, 9800);
  m.agentState("listening", 9800);
  m.assistantMessage("Pues mira, la reunión es a las cinco en la oficina de siempre y luego cenamos.", false);
  assert.deepEqual(m.stats(), {
    e2e: { p50: 600, p90: 800, n: 2 },
    talk: {
      words_per_turn: { p50: 7, p90: 16, max: 16, n: 2 },
      interruptions: 2,
      barge_in_stop_ms: { p50: 250, p90: 1800, n: 2 },
      talked_over: 1,
      started_over: 0,
    },
  });
});

test("VoiceMeter: the noise floor follows a noisy line, so steady noise is not speech", () => {
  const m = new VoiceMeter();
  m.opening = false;
  feed(m, -38, 0, 3000); // a loud hiss, above the fixed minimum
  m.agentState("speaking", 3000);
  feed(m, -38, 3000, 4000);
  m.agentState("listening", 4000);
  assert.deepEqual(m.stats(), { talk: { interruptions: 0, talked_over: 0, started_over: 0 } });
});

test("VoiceMeter: lone noise peaks are not voice, an overlap is not a 0 ms reply, a backchannel does not leak into the next gap", () => {
  const m = new VoiceMeter();
  feed(m, -60, 0, 2000);
  // The person's answer starts during the opening and goes on after it: its reply is still measured.
  m.agentState("speaking", 2000);
  feed(m, -60, 2000, 2800);
  feed(m, -22, 2800, 3200);
  m.agentState("listening", 3000);
  m.opening = false;
  feed(m, -22, 3200, 3600);
  feed(m, -60, 3600, 3840);
  m.agentState("speaking", 3840); // 240 ms after their last voice, before the detector has called their speech over: still a reply gap
  // While it speaks, a lone 20 ms click: nothing.
  feed(m, -60, 3840, 4500);
  m.audio(-15, 4520, 20);
  feed(m, -60, 4520, 5000);
  // A short "mm" backchannel (200 ms) while it speaks: a cut-off by audio, and the reply after it is not measured from it.
  feed(m, -22, 5000, 5200);
  feed(m, -60, 5200, 6000);
  m.agentState("listening", 6000);
  m.agentState("speaking", 6500); // carries on by itself: no new voice since it stopped, no gap
  m.agentState("listening", 7000);
  // The person speaks and the assistant starts while they are still talking: started over, no gap.
  feed(m, -60, 6000, 7200);
  feed(m, -20, 7200, 8000);
  m.agentState("speaking", 7900);
  feed(m, -20, 8000, 8200);
  feed(m, -60, 8200, 9000);
  m.agentState("listening", 9000);
  const st = m.stats();
  assert.deepEqual(st.e2e, { p50: 240, p90: 240, n: 1 });
  assert.equal(st.talk.started_over, 1);
  assert.equal(st.talk.interruptions, 1, "the backchannel; the overlap the assistant caused is counted as started over, not as a cut-off");
});

test("parseMeta: inbound and browser sessions name a participant instead of a number; the delegate token is kept only when well formed", () => {
  const base = { call_id: "lk_tabc123def456", instructions: "x", opening: "Hola Marta, soy tu asistente. Dime." };
  const web = parseMeta(JSON.stringify({ ...base, kind: "web", participant: "owner-web-1a2b3c4d", open: true, delegate_token: "t".repeat(32) }));
  assert.ok(typeof web !== "string", String(web));
  assert.equal(web.kind, "web");
  assert.equal(web.participant, "owner-web-1a2b3c4d");
  assert.equal(web.to, undefined, "nothing is dialled for a browser session");
  assert.equal(web.open, true);
  assert.equal(web.delegateToken, "t".repeat(32));
  assert.equal(parseMeta(JSON.stringify({ ...base, kind: "inbound" })), "bad participant");
  assert.equal(parseMeta(JSON.stringify({ ...base, kind: "web", participant: "bad id with spaces" })), "bad participant");
  assert.equal(parseMeta(JSON.stringify({ ...base, kind: "owner" })), "bad destination number", "a call to dial still needs its number");
  assert.equal(parseMeta(JSON.stringify({ ...base, kind: "boss", participant: "x-1" })), "bad kind");
  assert.equal(parseMeta(JSON.stringify({ ...base, kind: "web", participant: "owner-web-1a2b3c4d", trusted: true }))!.trusted, true);
  assert.equal(parseMeta(JSON.stringify({ ...base, kind: "inbound", participant: "sip_+34600111222", trusted: false }))!.trusted, false);
  assert.equal(parseMeta(JSON.stringify({ ...base, kind: "inbound", participant: "sip_+34600111222", trusted: "yes" }))!.trusted, undefined, "only a real boolean");
  const noToken = parseMeta(JSON.stringify({ ...base, kind: "owner", to: "+34600111222", delegate_token: "short" }));
  assert.ok(typeof noToken !== "string");
  assert.equal(noToken.delegateToken, undefined);
});

test("inboundRule: only the inbound dispatch rule's metadata, with whether it asked for the PIN", () => {
  assert.deepEqual(inboundRule('{"mode":"inbound","pin":true}'), { pin: true });
  assert.deepEqual(inboundRule('{"mode":"inbound"}'), { pin: false });
  assert.equal(inboundRule('{"call_id":"lk_x","kind":"owner"}'), null);
  assert.equal(inboundRule("not json"), null);
  assert.equal(inboundRule(undefined), null);
});

test("signAsk: a different key from the result signature", () => {
  assert.notEqual(signAsk("s3cret", "{}"), sign("s3cret", "{}"));
  assert.match(signAsk("s3cret", "{}"), /^[0-9a-f]{64}$/);
});

test("LiveHearing: only the new text of each partial transcript, joined, from a given time on", () => {
  const h = new LiveHearing();
  // The request, transcribed in growing pieces for one turn, then the read-back's answer arriving in a later turn.
  h.add("a", "Llama a", 100);
  h.add("a", "Llama a Ana", 200);
  h.add("a", "Llama a Ana", 250); // the final repeat of the same text adds nothing
  assert.equal(h.after(0), "Llama a Ana");
  // The read-back ends at 1000. A "sí" before it (the owner talking over it) is not part of the answer.
  h.add("b", " sí", 900);
  assert.equal(h.after(1000), "");
  h.add("c", "Sí", 1200);
  h.add("c", "Sí, dale", 1400);
  assert.equal(h.after(1000), "Sí, dale");
  // The answer appended to a turn that was already open: only its new part counts.
  h.add("a", "Llama a Ana y dile algo", 1500);
  assert.equal(h.after(1450), "y dile algo");
  assert.equal(h.after(1000), "Sí, dale y dile algo", "several pieces are joined into one text, so a no or any other word anywhere shows");
  // A turn without an id, and text that gets shorter, are tolerated.
  h.add(null, "hola", 1600);
  h.add(null, "ho", 1700);
  assert.equal(h.after(1550), "hola");
});

test("sensitivityOf: low or high, anything else gives the default", () => {
  assert.equal(sensitivityOf("HIGH ", "low"), "high");
  assert.equal(sensitivityOf("low", "high"), "low");
  assert.equal(sensitivityOf(undefined, "low"), "low");
  assert.equal(sensitivityOf("medium", "high"), "high");
  assert.equal(sensitivityOf("", "low"), "low");
});

test("confirm_call: the worker waits longer than the server's own work (a lookup and a call at Retell, 30 s each), and a failed wait is 'not known', not 'failed'", () => {
  assert.ok(CONFIRM_CALL_MS > 2 * 30_000, "longer than the server's agent lookup and Retell's call together");
  assert.equal(mayHaveGoneOut({ ok: false, status: 0 }), true, "no answer: the wait ran out or the connection broke");
  assert.equal(mayHaveGoneOut({ ok: false, status: 502 }), true, "a server error");
  assert.equal(mayHaveGoneOut({ ok: false, status: 400 }), false, "a refusal placed nothing");
  assert.equal(mayHaveGoneOut({ ok: false, status: 401 }), false);
  assert.equal(mayHaveGoneOut({ ok: true, status: 200 }), false);
  assert.match(CALL_UNKNOWN, /don't know whether the call went out/);
  assert.doesNotMatch(CALL_UNKNOWN, /try again\.|did not work/i, "never the old 'offer to try again'");
});
