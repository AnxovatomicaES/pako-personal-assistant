// A search of the owner's Slack the assistant asked for: the server searches, a run of its own answers from the results.

import type { Lang } from "../../src/i18n.ts";
import { inline } from "../../src/quarantine.ts";
import { languageLine } from "./context.ts";
import { parseReply } from "./reply.ts";
import { T } from "./texts.ts";
import type { AfterLanguage } from "./parts.ts";

export function mountSlack(b: AfterLanguage) {
  const { config, log, api, run } = b;
  /**
   * The assistant asked to search Slack: the server searches, and a run of its own (not the conversation, so the results never stay where tags act)
   * answers the owner's question from them. Its answer is taken as text only: a Slack message cannot make the assistant act. It answers in the
   * language of the question; the owner's language (from the context of their message) is for a question too short to show one.
   */
  const answerWithSlack = async (query: string, question: string, fallback: string, lang = "", ui: Lang = "en"): Promise<string> => {
    const t = T(ui);
    let found: string;
    try {
      const r = await api(`/assistant/slack/search?q=${encodeURIComponent(query)}`);
      const j = (await r.json().catch(() => ({}))) as { results?: unknown; error?: unknown };
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `HTTP ${r.status}`);
      const lines = (Array.isArray(j.results) ? j.results : []).filter((x): x is string => typeof x === "string");
      // Each result on its own line, neutralised and cut (src/quarantine.ts): read in full only here, in a run whose tags act on nothing.
      found = lines.length ? lines.slice(0, 40).map((l) => inline(l, 600)).join("\n") : t("noResults");
    } catch (err) {
      log(`slack search failed: ${(err as Error).message.slice(0, 200)}`);
      return fallback || t("slackFailed");
    }
    const tongue = languageLine(lang);
    const prompt = `${tongue ? `[${tongue}]\n\n` : ""}${t("asked", { question: question.slice(0, 1500) })}\n\n`
      + `${t("results", { query: inline(query, 200), found })}\n\n`
      + t("answer", { hint: tongue ? t("answerHint") : "" });
    try {
      const again = await run("slack", prompt, { ...config, tools: [] });
      log(`slack: ${found.split("\n").length} results, $${again.costUsd.toFixed(4)}`);
      return parseReply(again.text).text;
    } catch (err) {
      log(`claude failed after the slack search: ${(err as Error).message.slice(0, 200)}`);
      return t("slackThinkFailed");
    }
  };
  return { answerWithSlack };
}

export type Slack = ReturnType<typeof mountSlack>;
