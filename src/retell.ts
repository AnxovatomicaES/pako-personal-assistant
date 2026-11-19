// A small client for Retell's REST API: the calls, voices and agent routes the phone line uses (src/personal-agent.ts,
// src/personal-caller.ts). Request shapes are those of Retell's public OpenAPI file as read in November 2026.

const BASE = "https://api.retellai.com";

export class RetellError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}


type Voice = { voice_id: string; voice_name?: string; provider?: string; accent?: string; gender?: string; preview_audio_url?: string };

/**
 * English-speaking voices first: Retell gives no language field, only a free-text accent, so this is a best guess to listen to. The phone
 * agent's speech recognition is English (src/personal-agent.ts), so its voice should be too; no one country's accent is preferred.
 */
export function englishVoices(voices: Voice[]): Voice[] {
  const score = (v: Voice) => {
    const t = `${v.accent ?? ""} ${v.voice_name ?? ""} ${v.voice_id}`;
    if (/\ben-[A-Z]{2}\b|american|british|australian|canadian|irish|english/i.test(t)) return 2;
    return /\bneutral\b/i.test(t) ? 1 : 0;
  };
  return voices.filter((v) => score(v) > 0).sort((a, b) => score(b) - score(a));
}

/** ElevenLabs community voices matching a query (name, description or id): add one with addCommunityVoice to use it. */
type CommunityVoice = { provider_voice_id: string; name?: string; description?: string; public_user_id?: string };
export async function searchCommunityVoices(apiKey: string, query: string, fetchImpl: typeof fetch = fetch): Promise<CommunityVoice[]> {
  const r = (await call(fetchImpl, apiKey, "POST", "/search-community-voice", { search_query: query.slice(0, 100), voice_provider: "elevenlabs" })) as { voices?: unknown[] };
  return (Array.isArray(r.voices) ? r.voices : []).slice(0, 25) as CommunityVoice[];
}

/** Adds an ElevenLabs community voice to the account; returns it with its Retell voice_id and a preview link. */
export async function addCommunityVoice(apiKey: string, v: { providerVoiceId: string; publicUserId?: string; name: string }, fetchImpl: typeof fetch = fetch): Promise<Voice> {
  return (await call(fetchImpl, apiKey, "POST", "/add-community-voice", {
    provider_voice_id: v.providerVoiceId,
    voice_name: v.name.slice(0, 200),
    voice_provider: "elevenlabs",
    ...(v.publicUserId ? { public_user_id: v.publicUserId } : {}),
  })) as Voice;
}

/** An xAI (Grok) voice: the only kind Retell accepts for xAI's speech-to-speech model. They are multilingual, so no accent label is expected. */
/** A voice added to the account by hand (a library voice or a clone): Retell names them custom_voice_... */
export const isCustomVoice = (v: { voice_id: string }): boolean => /^custom[-_]/i.test(v.voice_id);
export const isXaiVoice = (v: { voice_id: string; provider?: string }): boolean => /^xai[-_]/i.test(v.voice_id) || v.provider === "xai";

export async function listVoices(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<Voice[]> {
  return (await call(fetchImpl, apiKey, "GET", "/list-voices")) as Voice[];
}

export async function call(fetchImpl: typeof fetch, apiKey: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetchImpl(`${BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const msg = (json as { message?: string } | undefined)?.message ?? text.slice(0, 200);
    throw new RetellError(`Retell ${method} ${path} failed: HTTP ${res.status}${msg ? ` (${msg})` : ""}`, res.status);
  }
  return json;
}

