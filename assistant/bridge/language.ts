// The owner's language for what answers no message of theirs, and a voice note's words (heard on this computer).

import type { Lang } from "../../src/i18n.ts";
import { transcribeVoiceNote } from "../voice.ts";
import { LANGUAGE_FRESH_MS, LANGUAGE_RETRY_MS, languageOf, uiOf, zoneOf, type Context } from "./context.ts";
import { T } from "./texts.ts";
import type { AfterRuns } from "./parts.ts";

export function mountLanguage(b: AfterRuns) {
  const { d, config, log, api, say } = b;
  /**
   * The words of a voice note, or null when the owner has been told why there are none. That comes before the message's own context is read, so
   * it is said in the language of Pako's texts as the inbox that brought the note said it (a server that does not say: as the last context
   * did, read now if that was over half an hour ago).
   */
  const listen = async (audio: { id: string; mime: string }): Promise<string | null> => {
    const tell = async (key: "noWhisper" | "notHeard" | "notListened"): Promise<null> => {
      await say({ text: T((await ownerLanguage()).ui)(key) });
      return null;
    };
    if (!config.whisperModel) return tell("noWhisper");
    try {
      const r = await api(`/assistant/media/${encodeURIComponent(audio.id)}`, { timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`the server answered ${r.status}`);
      const words = await (d.transcribe ?? transcribeVoiceNote)(Buffer.from(await r.arrayBuffer()), audio.mime, config);
      if (!words.trim()) return tell("notHeard");
      log(`voice note: ${words.length} characters heard`);
      return words;
    } catch (err) {
      log(`voice note failed: ${(err as Error).message.slice(0, 200)}`);
      return tell("notListened");
    }
  };

  /**
   * The owner's language ("" = the context did not say: English) and the language of Pako's fixed texts (English), as the last context read said them,
   * and until when that serves without reading it again.
   */
  const language: { code: string; ui: Lang; until: number; zone?: string } = { code: "", ui: "en", until: 0 };
  /**
   * For what answers no message of the owner's (an email, a meeting, a voice note that could not be heard): the languages of the context their
   * last message brought, or one read of the context when there was none for half an hour. A context that cannot be read leaves them as they
   * were: an email never waits for it. The language of Pako's own texts is also set by every inbox answer of a server that gives it (tick).
   */
  const ownerLanguage = async (): Promise<{ code: string; ui: Lang }> => {
    if (Date.now() >= language.until) {
      try {
        const r = await api("/assistant/context", { timeoutMs: 10_000 });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ctx = (await r.json()) as Context | null;
        Object.assign(language, { code: languageOf(ctx), ui: uiOf(ctx), zone: zoneOf(ctx), until: Date.now() + LANGUAGE_FRESH_MS });
      } catch (err) {
        language.until = Date.now() + LANGUAGE_RETRY_MS;
        log(`no context for the owner's language (${(err as Error).message}): ${language.code || "en"} for now`);
      }
    }
    return { code: language.code, ui: language.ui };
  };
  return { listen, language, ownerLanguage };
}

export type Language = ReturnType<typeof mountLanguage>;
