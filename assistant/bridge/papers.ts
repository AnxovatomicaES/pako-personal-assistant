// A photo or a PDF the owner sent: read in an isolated run with the file as a content block, its summary kept and sent back.

import { randomBytes } from "node:crypto";
import { inline } from "../../src/quarantine.ts";
import { checkPaper, hidePaperCodes, paperText } from "../../src/papers.ts";
import { PAPER_PROMPT } from "../prompt.ts";
import { ClaudeError } from "./claude.ts";
import { fenced, languageLine } from "./context.ts";
import type { Paper } from "./items.ts";
import { parseReply } from "./reply.ts";
import { T } from "./texts.ts";
import type { AfterLanguage } from "./parts.ts";

export function mountPapers(b: AfterLanguage) {
  const { config, log, api, say, run, replyCache, attempts, retryAt, waits, toldAt, hold, ownerLanguage } = b;
  /**
   * A photo or a PDF the owner sent (src/papers.ts): read in a run of its own like an email (the file as a content block, no tools, no
   * conversation, tags dropped), its codes hidden, its summary kept by the server for the context and sent back on the chat it came from. What
   * the paper says can never act: the owner's own next words do ("remind me about it"), in the conversation.
   */
  const handlePaper = async (id: string, p: Paper, forwarded: boolean): Promise<boolean> => {
    const { code, ui } = await ownerLanguage();
    const t = T(ui);
    /** The answer to the owner's message: kept and sent again as it is if the server cannot take it now (Claude is not asked twice). */
    const answer = async (text: string): Promise<boolean> => {
      const body = { text, key: id };
      if (await say(body)) return true;
      replyCache.set(id, body);
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      retryAt.set(id, Date.now() + (waits[n - 1] ?? 0));
      return n >= waits.length + 1;
    };
    let bytes: Buffer;
    try {
      const r = await api(`/assistant/paper/${encodeURIComponent(p.id)}`, { timeoutMs: 60_000 });
      // Not kept any more (a server keeps papers in memory only, and restarted): nothing to retry.
      if (r.status === 404) return answer(paperText("lost", ui));
      if (!r.ok) throw new Error(`the server answered ${r.status}`);
      bytes = Buffer.from(await r.arrayBuffer());
    } catch (err) {
      log(`paper ${id.slice(-8)} not fetched: ${(err as Error).message.slice(0, 200)} (tried again soon)`);
      retryAt.set(id, Date.now() + 30_000);
      return false;
    }
    // Checked again here, by its bytes: only the four kinds Claude reads go in, whatever answered.
    const checked = checkPaper(bytes);
    if (!checked.ok) {
      log(`paper ${id.slice(-8)} is not one Claude reads (${checked.why})`);
      return answer(paperText("failed", ui));
    }
    // The fence has a name made up for this one run; the file's name and a forwarded caption are someone else's words, so they sit inside it.
    const fence = `PAPEL-${randomBytes(4).toString("hex")}`;
    const tongue = languageLine(code);
    const prompt = [
      ...(tongue ? [tongue] : []),
      ...(p.caption && !forwarded ? [paperText("asked", ui, { text: inline(p.caption, 1500) })] : []),
      "",
      `<<<${fence}`,
      paperText("file", ui, { name: fenced(p.name || "-", 120) }),
      ...(p.caption && forwarded ? [paperText("caption", ui, { text: fenced(p.caption, 1500) })] : []),
      `${fence}>>>`,
      "",
      paperText("fileLine", ui),
    ].join("\n");
    const file = { type: checked.mime === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: checked.mime, data: bytes.toString("base64") } } as const;
    let notice: Promise<unknown> | null = null;
    const timer = setTimeout(() => {
      notice = say({ text: t("moment") });
    }, config.noticeMs);
    let summary: string;
    try {
      const result = await run("paper", prompt, { ...config, tools: [], systemPrompt: PAPER_PROMPT.replaceAll("PAPEL", fence), files: [file] });
      // Text only: every tag is dropped, and a one-time code in it is hidden before it goes anywhere.
      summary = hidePaperCodes(parseReply(result.text).text, ui);
      log(`paper ${id.slice(-8)}: ${checked.mime}, ${summary.length} chars, $${result.costUsd.toFixed(4)}`);
    } catch (err) {
      clearTimeout(timer);
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a paper (${kind}): ${(err as Error).message.slice(0, 200)}`);
      // As for any message of theirs: the limit was told once (runs.ts), a lost login once an hour, and the paper is read when Claude works again.
      if (kind === "limit") {
        hold(id);
        return false;
      }
      if (kind === "login") {
        if (Date.now() - toldAt.login > 3600_000) {
          toldAt.login = Date.now();
          await say({ text: t(kind) });
        }
        retryAt.set(id, Date.now() + (config.loginRetryMs ?? 2 * 60_000));
        return false;
      }
      if (notice) await notice; // "One moment…" never arrives after it
      return answer(paperText("failed", ui));
    }
    clearTimeout(timer);
    if (notice) await notice;
    if (!summary) return answer(paperText("failed", ui));
    try {
      const r = await api("/assistant/paper-summary", { method: "POST", body: { id: p.id, name: p.name, summary } });
      if (!r.ok) log(`paper summary refused: ${r.status}`);
    } catch (err) {
      log(`paper summary failed: ${(err as Error).message}`);
    }
    const head = paperText("head", ui, { name: p.name || paperText(checked.mime === "application/pdf" ? "noName" : "photo", ui) });
    return answer(`${head}\n${summary}`);
  };
  return { handlePaper };
}

export type Papers = ReturnType<typeof mountPapers>;
