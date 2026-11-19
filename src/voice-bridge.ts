// The link between the personal caller and its own voice stack (voice-worker/, a LiveKit agent on its own Render service).
// With the engine "livekit", call_me does not go through Retell: it asks LiveKit to start the worker, which rings the owner
// through the owner's SIP number and talks with Gemini Live. Every rule stays here, on the main server: the caps, the owner
// number, the opening line, the owner-name lock. The worker only dials the number it is handed and reports back.
//
// Off unless LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set. The result post of the worker is signed with the
// LiveKit API secret (both servers hold it already), so there is no second secret to keep.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AccessToken, AgentDispatchClient, TrackSource } from "livekit-server-sdk";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("voice-bridge");

export const VOICE_AGENT_NAME = "personal-caller";

/** The voices of Gemini Live (prebuilt, multilingual): the owner picks one by ear with set_voice "gemini-<Name>". */
export const GEMINI_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe", "Callirrhoe", "Charon", "Despina",
  "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda", "Orus", "Pulcherrima",
  "Puck", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;

export interface VoiceStart {
  to: string;
  kind: "owner" | "friend";
  instructions: string;
  opening: string;
  /** No message to deliver: the owner just wants to talk (a longer call is allowed and the model is not nudged to start). */
  open?: boolean;
  /** Give this call the ask_claude delegate (owner calls only): a per-call token goes into the dispatch. */
  delegate?: boolean;
}

/** One live session on the owner's line, as the server knows it: for checking a delegate request against it. */
export interface LiveCall {
  kind: "owner" | "friend" | "inbound" | "web";
  startedAt: number;
  tokenHash?: string;
  /** Inbound and lab sessions reach the delegate's outward actions only when the owner proved who they are. */
  trusted: boolean;
}

/** What the worker needs to run a session it did not dial (an inbound call or the browser lab): the dispatch metadata. */
export interface SessionMeta {
  call_id: string;
  kind: "inbound" | "web";
  participant: string;
  instructions: string;
  opening: string;
  voice: string;
  model: string;
  open: true;
  trusted: boolean;
  delegate_token?: string;
}

export interface VoiceResult {
  call_id: string;
  call_status: "ended" | "failed";
  duration_seconds: number;
  disconnection_reason: string;
  transcript: string;
  latency_ms?: { e2e: { p50: number; p90: number; n: number } };
  disclosed_ai: boolean;
  talk?: TalkStats;
  /** One line about the call, written by the worker (Gemini): kept in the owner memory when the call was verified. */
  summary?: string;
  /** Echoed from the dispatch: whether the call was verified (the server dialled the owner, or the owner typed the PIN). */
  trusted?: boolean;
  engine: string;
  voice: string;
}

/** How the conversation went (measured by the worker): long answers and the handling of being cut off are what give a voice assistant away. */
export interface TalkStats {
  words_per_turn?: { p50: number; p90: number; max: number; n: number };
  interruptions: number;
  barge_in_stop_ms?: { p50: number; p90: number; n: number };
  talked_over: number;
  started_over?: number;
}

export interface VoiceBridge {
  /**
   * Starts the worker for one call and returns at once with the id get_call looks the result up by. The worker may be asleep
   * (a free Render service sleeps after 15 minutes without a visit), so it is woken first and only then dispatched: that takes
   * up to about a minute in the background. `done` resolves to null when LiveKit has the job, or to the reason it failed
   * (the failure is also recorded as the call's result).
   */
  start(call: VoiceStart & { proceed?: () => Promise<boolean> }): { call_id: string; done: Promise<string | null> };
  /** Keeps the result in memory and, when a key value store is set (VOICE_RESULTS_URL), there too, so a restart does not lose it. */
  record(result: VoiceResult): Promise<void>;
  /** From memory, else from the key value store. Throws when the store cannot be read (so a lookup does not pass for "no result"). */
  result(callId: string): Promise<VoiceResult | undefined>;
  /**
   * True when no report came and none can still come: the call started longer ago than any call lasts, or, with no key value store, it was
   * placed before this server started (a restart forgets the memory). Asked after result() found nothing.
   */
  lost(callId: string, now?: number): boolean;
  verify(body: string, signature: string | undefined): boolean;
  /** A delegate request from the worker, signed with a key of its own (a result signature can never pass as an ask). */
  verifyAsk(body: string, signature: string | undefined): boolean;
  /** The live session a delegate request names, when its token matches and it is not over; undefined otherwise. */
  liveCall(callId: string, token: string, now?: number): LiveCall | undefined;
  /** Whether a call was verified (the server dialled the owner, or the owner typed the PIN): only those may write to the owner memory. */
  trusted(callId: string): boolean;
  /** A session the worker started itself (an inbound call): registered here so its delegate requests are accepted. */
  inbound(o: { participant: string; instructions: string; opening: string; trusted: boolean; delegate: boolean }): SessionMeta;
  /** A browser session for the voice lab: a room, a token for the browser and the agent dispatched into it. */
  lab(o: { instructions: string; opening: string; voice?: string; delegate: boolean }): Promise<{ url: string; token: string; call_id: string; done: Promise<string | null> }>;
  /** The LiveKit project's URL (wss://...), for the voice lab page's content policy. */
  readonly livekitUrl: string;
  /** The Gemini voice and model used from the next call on (set_voice "gemini-Puck"). */
  voice: string;
  model: string;
}

export interface VoiceBridgeDeps {
  /** Replaces the LiveKit dispatch call (tests). */
  dispatch?: (room: string, metadata: string) => Promise<void>;
  /** Replaces the wake-up of the sleeping worker (tests). */
  wake?: () => Promise<void>;
  /** Where results outlive a restart (loadKv(VOICE_RESULTS_URL)); null keeps them in memory only. */
  kv?: Kv | null;
}

/** How long a session on the owner's line may last (an open conversation is allowed 20 minutes; a little spare). */
const SESSION_MAX_MS = 25 * 60_000;
const newCallId = () => `lk_t${Date.now().toString(36).padStart(8, "0")}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

/** How long a stored result is kept. */
const RESULT_TTL_SECONDS = 30 * 24 * 3600;
const kvKey = (callId: string) => `voice-result:${callId}`;

type Env = Record<string, string | undefined>;

/** How long after its start a call's report may still arrive: the 10-minute call cap, the ring and the start-up, with room to spare. */
export const REPORT_DEADLINE_MS = 15 * 60_000;

/**
 * The start time a call id carries (base-36 milliseconds after "lk_t"), so a later get_call can tell a call still on the line from a
 * report that is gone. Undefined for an older id without it.
 */
export function voiceCallStartedAt(callId: string): number | undefined {
  const m = /^lk_t([0-9a-z]{8})[0-9a-f]{12}$/.exec(callId);
  return m ? parseInt(m[1]!, 36) : undefined;
}

export function signResult(secret: string, body: string): string {
  return createHmac("sha256", `voice-result:${secret}`).update(body).digest("hex");
}

/** Delegate requests and inbound-session requests from the worker: the same shared secret, under a key of their own. */
export function signAsk(secret: string, body: string): string {
  return createHmac("sha256", `voice-delegate:${secret}`).update(body).digest("hex");
}

const httpUrl = (u: string) => u.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Visits the worker's health address until it answers 200, which the LiveKit worker does only once it is connected to LiveKit
 * (503 before that). A sleeping free Render service answers the first visit when it is up, after about 30-60 seconds.
 */
export async function wakeWorker(workerUrl: string, f: typeof fetch = fetch, o: { maxMs?: number } = {}): Promise<void> {
  const until = Date.now() + (o.maxMs ?? 100_000);
  let lastError = "no answer";
  while (Date.now() < until) {
    try {
      const r = await f(workerUrl, { signal: AbortSignal.timeout(Math.max(1000, Math.min(35_000, until - Date.now()))) });
      if (r.status === 200) return;
      lastError = `HTTP ${r.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await sleep(2000);
  }
  throw new Error(`the voice worker did not wake up (${lastError})`);
}

/** Null when LiveKit is not configured: the engine "livekit" then does not exist and nothing changes. */
export function loadVoiceBridge(env: Env, deps: VoiceBridgeDeps = {}): VoiceBridge | null {
  const url = (env.LIVEKIT_URL ?? "").trim();
  const key = (env.LIVEKIT_API_KEY ?? "").trim();
  const secret = (env.LIVEKIT_API_SECRET ?? "").trim();
  if (!url || !key || !secret) return null;
  const dispatchClient = new AgentDispatchClient(httpUrl(url), key, secret);
  const dispatch = deps.dispatch ?? (async (room: string, metadata: string) => void (await dispatchClient.createDispatch(room, VOICE_AGENT_NAME, { metadata })));
  const workerUrl = (env.VOICE_WORKER_URL ?? "").trim();
  const wake = deps.wake ?? (workerUrl ? () => wakeWorker(workerUrl) : async () => undefined);
  const results = new Map<string, VoiceResult>();
  const live = new Map<string, LiveCall>();
  const remember = (callId: string, call: LiveCall): void => {
    live.set(callId, call);
    for (const [id, c] of live) if (Date.now() - c.startedAt > SESSION_MAX_MS) live.delete(id);
  };
  const mint = (callId: string, call: Omit<LiveCall, "tokenHash">, delegate: boolean): string | undefined => {
    const token = delegate ? randomBytes(24).toString("base64url") : undefined;
    remember(callId, { ...call, ...(token ? { tokenHash: tokenHash(token) } : {}) });
    return token;
  };
  const bootedAt = Date.now();
  const kv = deps.kv ?? null;
  const bridge: VoiceBridge = {
    livekitUrl: url,
    voice: GEMINI_VOICES.find((v) => v === env.LIVEKIT_VOICE) ?? "Puck",
    model: /^[A-Za-z0-9_.-]{3,60}$/.test(env.LIVEKIT_MODEL ?? "") ? (env.LIVEKIT_MODEL as string) : "gemini-3.8-live",
    start(call) {
      const callId = newCallId();
      // A call the server dials to the owner's own number is trusted: whoever answers the owner's phone is the owner's business.
      const token = mint(callId, { kind: call.kind, startedAt: Date.now(), trusted: call.kind === "owner" }, call.kind === "owner" && call.delegate === true);
      const metadata = JSON.stringify({
        call_id: callId,
        to: call.to,
        kind: call.kind,
        instructions: call.instructions,
        opening: call.opening,
        voice: bridge.voice,
        model: bridge.model,
        ...(call.open ? { open: true } : {}),
        trusted: call.kind === "owner",
        ...(token ? { delegate_token: token } : {}),
      });
      const done = (async (): Promise<string | null> => {
        try {
          await wake();
          // Waking the worker can take a minute: whatever was decided meanwhile (STOP, say) is looked at again just before the phone would ring.
          if (call.proceed && !(await call.proceed())) throw new Error("everything was paused (STOP, or a safety pause) before the call started: nobody was called");
          await dispatch(callId, metadata);
          return null;
        } catch (err) {
          const why = (err as Error).message;
          await bridge.record({
            call_id: callId, call_status: "failed", duration_seconds: 0, disconnection_reason: `not_started: ${why}`.slice(0, 200),
            transcript: "", disclosed_ai: false, engine: `livekit/${bridge.model}`, voice: bridge.voice,
          });
          return why;
        }
      })();
      return { call_id: callId, done };
    },
    async record(result) {
      results.delete(result.call_id);
      results.set(result.call_id, result);
      // A short memory only: the key value store keeps the long one.
      while (results.size > 50) results.delete(results.keys().next().value as string);
      if (!kv) return;
      try {
        await kv.set(kvKey(result.call_id), JSON.stringify(result), RESULT_TTL_SECONDS);
      } catch (err) {
        log.error(`storing ${result.call_id} failed: ${(err as Error).message}`);
      }
    },
    async result(callId) {
      const here = results.get(callId);
      if (here || !kv) return here;
      let raw: string | null;
      try {
        raw = await kv.get(kvKey(callId));
      } catch (err) {
        log.error(`reading ${callId} failed: ${(err as Error).message}`);
        throw err;
      }
      const r = raw ? parseResult(raw) : null;
      if (r) results.set(callId, r);
      return r ?? undefined;
    },
    lost(callId, now = Date.now()) {
      if (results.has(callId)) return false;
      const t = voiceCallStartedAt(callId);
      return t !== undefined && (now - t > REPORT_DEADLINE_MS || (!kv && t < bootedAt));
    },
    verifyAsk(body, signature) {
      if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
      return timingSafeEqual(Buffer.from(signAsk(secret, body), "hex"), Buffer.from(signature, "hex"));
    },
    liveCall(callId, token, now = Date.now()) {
      const c = live.get(callId);
      if (!c?.tokenHash || !token || results.has(callId) || now - c.startedAt > SESSION_MAX_MS) return undefined;
      const a = Buffer.from(c.tokenHash, "hex");
      const b = Buffer.from(tokenHash(token), "hex");
      return a.length === b.length && timingSafeEqual(a, b) ? c : undefined;
    },
    trusted: (callId) => live.get(callId)?.trusted === true,
    inbound(o) {
      const callId = newCallId();
      const token = mint(callId, { kind: "inbound", startedAt: Date.now(), trusted: o.trusted }, o.delegate);
      return {
        call_id: callId, kind: "inbound", participant: o.participant, instructions: o.instructions, opening: o.opening,
        voice: bridge.voice, model: bridge.model, open: true, trusted: o.trusted, ...(token ? { delegate_token: token } : {}),
      };
    },
    async lab(o) {
      const callId = newCallId();
      const identity = `owner-web-${randomUUID().slice(0, 8)}`;
      // The lab page is behind the admin key, so the person on it is the owner.
      const token = mint(callId, { kind: "web", startedAt: Date.now(), trusted: true }, o.delegate);
      const at = new AccessToken(key, secret, { identity, name: "Owner (voice lab)", ttl: "30m" });
      at.addGrant({ roomJoin: true, room: callId, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [TrackSource.MICROPHONE] });
      const jwt = await at.toJwt();
      const voiceName = GEMINI_VOICES.find((v) => v === o.voice) ?? bridge.voice;
      const metadata = JSON.stringify({
        call_id: callId, kind: "web", participant: identity, instructions: o.instructions, opening: o.opening,
        voice: voiceName, model: bridge.model, open: true, trusted: true, ...(token ? { delegate_token: token } : {}),
      });
      const done = (async (): Promise<string | null> => {
        try {
          await wake();
          await dispatch(callId, metadata);
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      })();
      return { url, token: jwt, call_id: callId, done };
    },
    verify(body, signature) {
      if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
      return timingSafeEqual(Buffer.from(signResult(secret, body), "hex"), Buffer.from(signature, "hex"));
    },
  };
  return bridge;
}

/** Checks a posted result and keeps only the fields it knows (the worker is trusted by signature, not by shape). */
export function parseResult(raw: string): VoiceResult | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const str = (k: string, max: number): string => (typeof o[k] === "string" ? (o[k] as string).slice(0, max) : "");
  const id = str("call_id", 80);
  if (!/^lk_[A-Za-z0-9]{6,60}$/.test(id)) return null;
  const e2e = (o.latency_ms as { e2e?: Record<string, unknown> } | undefined)?.e2e;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const p50 = num(e2e?.p50);
  const p90 = num(e2e?.p90);
  const n = num(e2e?.n);
  const talk = parseTalk(o.talk, num);
  return {
    call_id: id,
    call_status: o.call_status === "failed" ? "failed" : "ended",
    duration_seconds: num(o.duration_seconds) ?? 0,
    disconnection_reason: str("disconnection_reason", 200),
    transcript: str("transcript", 8000),
    ...(p50 !== null && p90 !== null && n !== null ? { latency_ms: { e2e: { p50, p90, n } } } : {}),
    disclosed_ai: o.disclosed_ai === true,
    ...(typeof o.trusted === "boolean" ? { trusted: o.trusted } : {}),
    ...(str("summary", 300) ? { summary: str("summary", 300) } : {}),
    ...(talk ? { talk } : {}),
    engine: str("engine", 80),
    voice: str("voice", 40),
  };
}

function parseTalk(raw: unknown, num: (v: unknown) => number | null): TalkStats | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  const interruptions = num(t.interruptions);
  const talkedOver = num(t.talked_over);
  if (interruptions === null || talkedOver === null) return undefined;
  const w = (t.words_per_turn ?? {}) as Record<string, unknown>;
  const s = (t.barge_in_stop_ms ?? {}) as Record<string, unknown>;
  type N = number | null;
  const [wp50, wp90, wmax, wn, sp50, sp90, sn] = [w.p50, w.p90, w.max, w.n, s.p50, s.p90, s.n].map(num) as [N, N, N, N, N, N, N];
  const startedOver = num(t.started_over);
  return {
    ...(wp50 !== null && wp90 !== null && wmax !== null && wn !== null ? { words_per_turn: { p50: wp50, p90: wp90, max: wmax, n: wn } } : {}),
    interruptions,
    ...(sp50 !== null && sp90 !== null && sn !== null ? { barge_in_stop_ms: { p50: sp50, p90: sp90, n: sn } } : {}),
    talked_over: talkedOver,
    ...(startedOver !== null ? { started_over: startedOver } : {}),
  };
}
