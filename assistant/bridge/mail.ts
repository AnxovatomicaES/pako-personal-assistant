// An email in the assistant's own inbox: read in an isolated run, its summary kept by the server, the owner told when it is worth it.

import { randomBytes } from "node:crypto";
import type { Verdict } from "../../src/mail-categories.ts";
import { EMAIL_PROMPT } from "../prompt.ts";
import { ClaudeError } from "./claude.ts";
import { dayIn, fenced, languageLine } from "./context.ts";
import { parseEmailVerdict, type Email } from "./items.ts";
import { T } from "./texts.ts";
import type { AfterLanguage } from "./parts.ts";

export function mountMail(b: AfterLanguage) {
  const { config, log, api, say, background, retryAt, hold, attempts, ownerLanguage, language } = b;
  /**
   * An email that arrived in the assistant's own inbox. Its words come from a stranger, so Claude reads it in a run of its own: no web search, no
   * conversation, a prompt that only asks for a summary, and every tag in the answer is dropped. Nothing an email says can act.
   */
  const handleEmail = async (id: string, e: Email, at?: number): Promise<boolean> => {
    // The fence has a name made up for this one run, and nothing the sender wrote can contain "<<<" or ">>>": the email cannot close its own block.
    // The sender, subject and attachments are the sender's words too, so they sit INSIDE it; only what the server decided is outside.
    const fence = `CORREO-${randomBytes(4).toString("hex")}`;
    const { code, ui } = await ownerLanguage();
    const t = T(ui);
    const tongue = languageLine(code);
    const from = e.from || t("unknownSender");
    const prompt = [
      ...(tongue ? [tongue] : []),
      ...(e.account === "trabajo" ? [t("workMail")] : e.account === "personal" ? [t("personalMail")] : []),
      ...(e.vip ? [t("vip")] : []),
      // The owner's day (an email at 00:30 in Berlin is the 16th's, not the 15th's in UTC), so "tomorrow" in it is read right.
      ...(at ? [t("received", { date: language.zone ? dayIn(at, language.zone) : new Date(at).toISOString().slice(0, 10) })] : []),
      "",
      `<<<${fence}`,
      t("from", { from: fenced(from) }),
      t("subject", { subject: fenced(e.subject || t("noSubject")) }),
      ...(e.attachments.length ? [t("attachments", { list: fenced(e.attachments.join(", ")) })] : []),
      "",
      fenced(e.text || t("noText"), 12_000),
      `${fence}>>>`,
    ].join("\n");
    let summary: string;
    let notify = true;
    // Not known until Claude's verdict is read: a summary made without one (Claude failed) says nothing about a scam or a category.
    let scam: boolean | undefined;
    let verdict: Verdict | undefined;
    try {
      // The material compared for coalescing is the email and what this run is told about it, not the fence (new for every run).
      // A mailbox's catch-up has its own allowance (the server paces it), so it never eats the day's background runs.
      const r = await background(e.quiet ? "backfill" : "email", JSON.stringify([e, code, ui, at ?? 0]), prompt,
        { ...config, tools: [], systemPrompt: EMAIL_PROMPT.replaceAll("CORREO", fence) });
      if ("skipped" in r) {
        // Claude's limit: the email waits for the reset, like any email that finds the limit. Over the day's budget: kept with its first lines
        // (the panel and tomorrow's brief show it), and told only when its sender is one the owner always wants to hear about.
        if (r.skipped === "paused") {
          hold(id, r.until);
          return false;
        }
        notify = false;
        summary = e.text.replace(/\s+/g, " ").trim().slice(0, 300);
        log(`email ${id.slice(-8)}: kept without Claude (over today's background budget)`);
      } else {
        ({ notify, summary, scam, verdict } = parseEmailVerdict(r.text));
        log(`email ${id.slice(-8)}: ${verdict?.category ?? "no category"}, ${summary.length} chars, $${r.costUsd.toFixed(4)}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on an email (${kind}): ${(err as Error).message.slice(0, 200)}`);
      if (kind === "limit" || kind === "login") {
        if (kind === "limit") hold(id);
        else retryAt.set(id, Date.now() + 5 * 60_000); // later, without blocking the owner's own messages (tick goes on past it)
        return false;
      }
      summary = e.text.replace(/\s+/g, " ").trim().slice(0, 300);
    }
    // A VIP is always told; the server answers the same for one.
    if (e.vip) notify = true;
    // Mail that was already in the mailbox when it was connected is never told, whatever the verdict: the server still hears whether it was
    // worth telling (`worth`), so the follow-ups can look at it silently.
    const worth = notify;
    if (e.quiet) notify = false;
    // The summary is kept by the server (the CORREO command and the assistant's context), told or not.
    try {
      // `scam` lets the panel mark it in red whatever language the summary is in, and "no" keeps it from guessing by the summary's words (a
      // bank's own advice about phishing); an older server ignores it.
      // The category and its lines go with it; the server answers whether the owner is told now (their switches), and an older server does not.
      const r = await api("/assistant/mail-summary", {
        method: "POST",
        body: {
          id, notify, summary, ...(scam === undefined ? {} : { scam }), ...(verdict ? { verdict } : {}),
          ...(e.quiet ? { quiet: true, worth } : {}), ...(e.replied ? { replied: true } : {}),
        },
      });
      if (!r.ok) log(`mail summary refused: ${r.status}`);
      else {
        const said = (await r.json().catch(() => null)) as { notify?: unknown } | null;
        // A catch-up email is never told, whatever the switches say.
        if (typeof said?.notify === "boolean" && !e.quiet) notify = said.notify;
      }
    } catch (err) {
      log(`mail summary failed: ${(err as Error).message}`);
    }
    if (e.vip && !e.quiet) notify = true;
    if (!notify) return true;
    const tag = e.account === "trabajo" ? "💼 " : "";
    const head = `${t("emailHead", { tag, from })}${e.subject ? t("emailSubject", { subject: e.subject }) : ""}`;
    const sent = await say({ text: summary ? `${head}\n${summary}` : head, notice: true });
    if (sent) return true;
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    return n >= 3;
  };
  return { handleEmail };
}

export type Mail = ReturnType<typeof mountMail>;
