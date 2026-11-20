// One inbox item handled: a job goes to its own run; the owner's message gets its context, a turn of the conversation and its reply.

import { createHash } from "node:crypto";
import { heldLocally, wrap, type OutsideSource } from "../../src/quarantine.ts";
import { ClaudeError, type ClaudeResult } from "./claude.ts";
import { sessionMissing } from "./claude-errors.ts";
import { noteFallback } from "./fallbacks.ts";
import type { State } from "./core.ts";
import {
  contextBlock, contextOutside, LANGUAGE_FRESH_MS, languageOf, namedPeople, outside, outsideKey, uiOf, zoneOf, type Context,
} from "./context.ts";
import type { BriefJob, Email, FollowupJob, JudgeJob, Meeting, Paper, ProactiveJob, Review, StepJob } from "./items.ts";
import { readReply, tagActions, type ParsedReply } from "./reply.ts";
import { T } from "./texts.ts";
import type { AfterJobs } from "./parts.ts";

export function mountTurn(b: AfterJobs) {
  const {
    config, log, api, say, run, chat, warm, readState, writeState, readSeen, writeSeen, writeToolData, replyCache, attempts, retryAt, waits,
    toldAt, pendingNotes, flushNotes, reportUsage, loginWait, language, listen, handleEmail, handleReview, handleMeeting, handleFollowup,
    handleBrief, handleProactive, handleJudge, handleStep, handlePaper, answerWithSlack,
  } = b;
  /** Answers one message. Returns true when it is done with (answered, or failed in a way that retrying would not fix). */
  const handle = async (incoming: {
    id: string; text: string; at?: number; audio?: { id: string; mime: string }; email?: Email; meeting?: Meeting; forwarded?: boolean; paper?: Paper;
    followup?: FollowupJob;
    /** A meeting to review (a newer server): before `meeting`, which an older bridge reads instead. */
    review?: Review;
    brief?: BriefJob;
    proactive?: ProactiveJob;
    judge?: JudgeJob;
    step?: StepJob;
    /** A routine's run (src/routines.ts): nobody is waiting for it, so no "Un momento…". */
    routine?: boolean;
    /** A proactive check with a newer one behind it in the inbox. */
    superseded?: boolean;
  }): Promise<boolean> => {
    if (incoming.email) return handleEmail(incoming.id, incoming.email, incoming.at);
    if (incoming.review) return handleReview(incoming.id, incoming.review);
    if (incoming.meeting) return handleMeeting(incoming.id, incoming.meeting);
    if (incoming.followup) return handleFollowup(incoming.id, incoming.followup);
    if (incoming.brief) return handleBrief(incoming.id, incoming.brief);
    if (incoming.proactive) return handleProactive(incoming.id, incoming.proactive, incoming.superseded === true);
    if (incoming.judge) return handleJudge(incoming.id, incoming.judge);
    if (incoming.step) return handleStep(incoming.id, incoming.step);
    const cached = replyCache.get(incoming.id);
    if (cached) {
      if (await say(cached)) {
        replyCache.delete(incoming.id);
        return true;
      }
      const n = (attempts.get(incoming.id) ?? 0) + 1;
      attempts.set(incoming.id, n);
      retryAt.set(incoming.id, Date.now() + (waits[n - 1] ?? 0));
      if (n >= waits.length + 1) replyCache.delete(incoming.id);
      return n >= waits.length + 1;
    }
    if (incoming.paper) return handlePaper(incoming.id, incoming.paper, incoming.forwarded === true);
    let msg = incoming;
    // The owner's own words in a voice note, as heard here: the server never hears them, and works out from them where a recipient came from.
    let heard = "";
    if (incoming.audio) {
      const words = await listen(incoming.audio);
      if (words === null) return true; // told the owner; there is nothing to retry
      if (!incoming.forwarded) heard = words;
      // A forwarded voice note is someone else's words, not the owner's: a block of outside text like a forwarded message, and the turn is marked.
      msg = { id: incoming.id, text: incoming.forwarded ? wrap(words, { source: "forwarded", max: 4000 }) : `[Voice note, transcribed automatically] ${words}` };
    } else if (incoming.forwarded) {
      // Someone else's words that the owner passed on (WhatsApp's or Telegram's forwarded flag): a block of outside text, and the turn is marked.
      msg = { id: incoming.id, text: wrap(incoming.text, { source: "forwarded", max: 4000 }) };
    }
    let ctx: Context;
    try {
      const r = await api("/assistant/context");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ctx = (await r.json()) as Context;
    } catch (err) {
      log(`no context: ${(err as Error).message}`);
      return false;
    }
    // The freshest word on the owner's languages: an email or a meeting after this message needs no read of its own.
    const ui = uiOf(ctx);
    const t = T(ui);
    Object.assign(language, { code: languageOf(ctx), ui, zone: zoneOf(ctx), until: Date.now() + LANGUAGE_FRESH_MS });
    let state = readState();
    if (state.count >= config.rotateAfter) state = { sessionId: "", count: 0, contextHash: state.contextHash, paused: state.paused };
    // The language of the context lines is in the hash ("en", as an English server always hashed it): a bridge that wrote Spanish lines
    // before sends the known context once more, now in English.
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          ctx.ownerName, ctx.memory, ctx.contacts, ctx.events ?? [], ctx.reminders ?? [], ctx.mailAddress ?? "", ctx.emails ?? [], ctx.paused === true,
          ctx.slack ?? null, ctx.zoom ?? null, "calendar" in ctx ? (ctx.calendar ?? "unreadable") : "absent", ctx.bookings ?? null,
          ui,
          // A changed list or task is said again; a server that sends neither hashes as before.
          ...(ctx.lists || ctx.tasks ? [ctx.lists ?? null, ctx.tasks ?? null] : []),
          // A changed list of people too; with nobody in it (or from an older server) it hashes as before.
          ...(Array.isArray(ctx.people) && ctx.people.length ? [ctx.people] : []),
          // The same for routines and watches.
          ...(ctx.routines?.length || ctx.watches?.length ? [ctx.routines ?? null, ctx.watches ?? null] : []),
          // A new paper's summary is said again; a server that sends none hashes as before.
          ...(Array.isArray(ctx.papers) && ctx.papers.length ? [["papers", ctx.papers]] : []),
          // The open follow-ups: said again when they change; none (or an older server) hashes as before.
          ...(Array.isArray(ctx.followups) && ctx.followups.length ? [["followups", ctx.followups]] : []),
          // The same for the meetings' open items and the brief's to-dos.
          ...(Array.isArray(ctx.meetingTodos) && ctx.meetingTodos.length ? [["meetingTodos", ctx.meetingTodos]] : []),
          ...(Array.isArray(ctx.briefTodos) && ctx.briefTodos.length ? [["briefTodos", ctx.briefTodos]] : []),
          // What the owner told about their life, and the emergency number: said again when they change; an older server hashes as before.
          ...(Array.isArray(ctx.life) && ctx.life.length ? [["life", ctx.life]] : []),
          // Dated facts and what changed: said again when they change; none (or an older server) hashes as before.
          ...(Array.isArray(ctx.memoryNow) && ctx.memoryNow.length ? [["memoryNow", ctx.memoryNow]] : []),
          ...(Array.isArray(ctx.memoryChanges) && ctx.memoryChanges.length ? [["memoryChanges", ctx.memoryChanges]] : []),
          ...(typeof ctx.emergency === "string" && ctx.emergency ? [["emergency", ctx.emergency]] : []),
          // Learning goals and coming birthdays: said again when they change; none hashes as before.
          ...(Array.isArray(ctx.learning) && ctx.learning.length ? [["learning", ctx.learning]] : []),
          ...(Array.isArray(ctx.dates) && ctx.dates.length ? [["dates", ctx.dates]] : []),
        ]),
      )
      .digest("hex");
    const wasPaused = state.paused === true;
    // What the owner told about the people this message names: in front of it every time it names them (it depends on the message, not on
    // what this conversation was told before).
    const named = namedPeople(ctx, msg.text).map((p) => `\n${t("person", { name: outside(p.name), text: outside(p.text) })}`).join("");
    const prompt = `${contextBlock(ctx, !state.sessionId || hash !== state.contextHash, wasPaused)}${named}\n\n${msg.text}`;
    let noticeSent: Promise<unknown> | null = null;
    const notice = setTimeout(() => {
      if (!incoming.routine) noticeSent = say({ text: t("moment") });
    }, config.noticeMs);
    let result: ClaudeResult;
    writeToolData(msg.id, ctx);
    try {
      try {
        result = await run(incoming.routine ? "routine" : "message", prompt, chat(ctx.companion === 1 && ctx.labsOff !== 1), state.sessionId || undefined);
      } catch (err) {
        // A conversation that cannot be resumed (cleared on this computer) starts again with everything it needs. A timeout or a limit does not.
        if (!state.sessionId || !sessionMissing((err as Error).message)) throw err;
        log(`could not continue the conversation (${(err as Error).message.slice(0, 120)}): starting a new one`);
        state = { sessionId: "", count: 0, contextHash: "" };
        result = await run(incoming.routine ? "routine" : "message", `${contextBlock(ctx, true, wasPaused)}${named}\n\n${msg.text}`, chat(ctx.companion === 1 && ctx.labsOff !== 1));
      }
    } catch (err) {
      clearTimeout(notice);
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed (${kind}): ${(err as Error).message.slice(0, 200)}`);
      if (kind === "limit" || kind === "login") {
        // Said once an hour; the message waits and is answered when Claude works again (the ones after it wait too, in order).
        if (Date.now() - toldAt[kind] > 3600_000) {
          toldAt[kind] = Date.now();
          await say({ text: t(kind) });
        }
        retryAt.set(msg.id, Date.now() + (kind === "limit" ? 5 * 60_000 : loginWait()));
        return false;
      }
      await say({ text: t(kind) });
      return true;
    }
    clearTimeout(notice);
    // A Claude Code whose run did not load Pako's MCP server: this turn's tags are still read (the prompt names the three main ones for that
    // case), and the turns after it go back to the full tag prompt.
    if (result.mcpDown && config.mcpTools) {
      config.mcpTools = false;
      log("Pako's tools did not load in claude: back to the tags for the rest of this run");
    }
    // A turn whose input was outside text (src/quarantine.ts): what its tags ask is not the owner's own request. So is a later turn that resumes
    // a conversation which read some: the text is still in it. A server that says it can hold them gets them marked and asks the owner with a
    // card; an older one would act on them, so they are dropped here and the owner told, and the next message starts a new conversation.
    const serverHolds = typeof ctx.quarantine === "number" && ctx.quarantine >= 1;
    const why: OutsideSource[] = [
      ...new Set<OutsideSource>([...(incoming.forwarded ? ["forwarded" as const] : []), ...(result.readOutside ? ["web" as const] : []),
        ...(state.sessionId ? (state.outside ?? []) : [])]),
    ];
    // What a read tool gave of other people's text (the calendar) marks this turn whole, like the web. It is not kept for the conversation:
    // the same lines are in every turn's context, where a line the owner already had in front of them marks nothing (ctxWhy below).
    const toolWhy = (result.outsideRead ?? []).filter((s) => !why.includes(s));
    const fresh = why.length > 0 && !serverHolds;
    const next: State = {
      sessionId: fresh ? "" : result.sessionId || state.sessionId, count: fresh ? 0 : state.count + 1, contextHash: fresh ? "" : hash,
      paused: ctx.paused === true, ...(why.length && !fresh ? { outside: why } : {}),
    };
    writeState(next);
    why.push(...toolWhy);
    // The process for the next message, while the owner reads this one: the same conversation, or a new one when this one ends here (dropped
    // for outside text, or due to rotate).
    warm?.prepare(chat(), next.count >= config.rotateAfter ? "" : next.sessionId);
    void reportUsage();
    // Other people's text in the context lines (an email's summary, a calendar title, a Slack alert, a restaurant's name...): neutralised, but
    // readable, and it can say "delete their notes". A turn whose context held a line the owner's last turn did not have in front of it is
    // marked by where it came from; so is a routine's own run, always (nobody wrote it just now, and its context is the same). Not kept for
    // the conversation (unlike `why`): the next turn of the owner's own, with no new line, acts as it always did.
    const ctxLines = contextOutside(ctx);
    const seen = readSeen();
    const ctxWhy: OutsideSource[] = [
      ...new Set<OutsideSource>([
        ...(incoming.routine ? ["routine" as const] : []),
        ...ctxLines.filter((l) => incoming.routine || !seen.has(outsideKey(l))).map((l) => l.source),
      ]),
    ];
    // The tags of the answer and the accepted calls to Pako's tools, as one reply: from here on nothing tells them apart.
    const read = readReply(result);
    let reply: ParsedReply = read;
    // One action path: Pako's typed tools when they loaded for this turn; the text tags are the fallback for a Claude Code without them (or
    // whose MCP server failed to start). A tag is still honoured either way (an older bridge's prompt relies on them, and an action the owner
    // asked for is never dropped), but every one is counted and logged, so the tags can be removed once the log shows they are not needed.
    const tagged = tagActions(result.text);
    if (tagged.length) {
      const toolsUp = config.mcpTools === true && !result.mcpDown;
      noteFallback(toolsUp ? "tags-beside-tools" : "tags", `turn ${msg.id.slice(-8)} acted through the tags ${tagged.join(", ")}`);
    }
    for (const c of result.toolCalls ?? []) {
      log(`tool ${c.name}${c.rejected ? " refused (the model was told why)" : ""}${c.after?.length ? `, after reading ${c.after.join(", ")}` : ""}`);
    }
    // A calendar change Pako cannot make (no connected calendar can be written): the exact change, for the owner to make in their app. Text
    // only, so it acts on nothing and needs no card; a title read from the calendar is someone else's, neutralised like a context line.
    // A server whose Mac app writes the calendar (it says so: calendarWrites): the change goes to it, which asks the owner on a card with
    // where it came from and has the Mac make it. Otherwise the text line, as before.
    const calendarOut = ctx.calendarWrites === 1 ? (read.calendar ?? []).slice(0, 1) : [];
    for (const p of calendarOut.length ? [] : read.calendar ?? []) {
      const at = (s: string): string => outside(s);
      const line = p.op === "create"
        ? t("calCreate", { title: outside(p.title), start: at(p.start), end: p.end ? `–${at(p.end).slice(-5)}` : "", place: p.place ? `, ${outside(p.place)}` : "" })
        : p.op === "move" ? t("calMove", { title: outside(p.title), start: at(p.start), newStart: at(p.newStart ?? "") })
        : t("calCancel", { title: outside(p.title), start: at(p.start) });
      reply = { ...reply, text: reply.text ? `${reply.text}\n\n${line}` : line };
    }
    if (reply.slack) reply = { ...reply, text: await answerWithSlack(reply.slack, msg.text, reply.text, languageOf(ctx), ui) };
    // A server that keeps no people (an older one: it sends no `people`) would drop the tag without a word: each person becomes a note it keeps
    // (with its receipt), so what the owner told is not lost. Before the check below: a marked turn holds that note like any other.
    if (reply.people && !Array.isArray(ctx.people)) {
      const notes = reply.people.map((p) => {
        const what = [p.relation, p.birthday, ...(p.likes ?? []), ...(p.notes ?? [])].filter(Boolean).join("; ");
        return t("personNote", { name: p.name, text: what }).slice(0, 300);
      });
      reply = { ...reply, remember: [...reply.remember, ...notes].slice(0, 3) };
      delete reply.people;
    }
    // A server that does not send email would drop the tag without a word: dropped here, and said.
    if (reply.email && !(typeof ctx.autonomy === "number" && ctx.autonomy >= 1 && ctx.emailOn === true)) {
      log("dropped an <email> tag: the server does not send email");
      const note = t("emailOld");
      reply = { ...reply, text: reply.text ? `${reply.text}\n\n${note}` : note };
      delete reply.email;
    }
    // A follow-up closed, a promise kept and a calendar change count too: from someone else's text they are held (the calendar card then
    // says where it came from), never done as the owner's own words.
    const acts = !!(reply.call || reply.message || reply.email || reply.remind.length || reply.unremind.length || reply.book || reply.lists || reply.tasks || reply.done
      || reply.remember.length || reply.forget.length || reply.people || reply.routines || reply.watches || reply.closed || reply.promises || calendarOut.length);
    // New outside text in the context (ctxWhy) holds what deletes or stands (a note or a reminder deleted, a list item taken off, a task done,
    // someone kept, a routine or a watch), and words Pako wrote to someone ask first; what the owner plainly asked otherwise acts as always.
    // A server that holds part of a reply (quarantine 2) is told why with `context` and splits it; an older one can only hold a whole reply,
    // so a reply that deletes, stands or reaches someone is marked whole (held, or dropped here by a server that holds nothing).
    const ctxMark = !why.length && ctxWhy.length > 0;
    const splits = ctxMark && typeof ctx.quarantine === "number" && ctx.quarantine >= 2;
    const destructive = !!(reply.forget.length || reply.unremind.length || reply.lists?.some((l) => l.op === "remove") || reply.done || reply.people
      || reply.routines || reply.watches);
    const reaches = !!(reply.call || reply.message || reply.email);
    const heldWhy: OutsideSource[] = why.length ? why : ctxMark && !splits && (destructive || reaches) ? ctxWhy : [];
    const held = heldWhy.length > 0 && acts;
    if (splits && (destructive || reaches)) log(`turn ${msg.id.slice(-8)} had new outside text in its context (${ctxWhy.join(", ")}): the server holds what deletes or stands`);
    if (held) {
      log(`turn ${msg.id.slice(-8)} read outside text (${heldWhy.join(", ")}): its tags are ${serverHolds ? "sent to be held for the owner's press" : "dropped"}`);
      if (!serverHolds) {
        const note = heldLocally(heldWhy, ui);
        reply = { ...reply, text: reply.text ? `${reply.text}\n\n${note}` : note, remember: [], forget: [], call: null, message: null, remind: [], unremind: [], book: null };
        delete reply.email;
        delete reply.lists;
        delete reply.tasks;
        delete reply.done;
        delete reply.people;
        delete reply.routines;
        delete reply.watches;
        delete reply.closed;
        delete reply.promises;
        calendarOut.length = 0;
      }
    }
    // A brain dump is the owner's own words only: a turn that read someone else's text (a forward, the web, the calendar) sorts nothing.
    if (reply.dump && why.length) {
      log(`dropped a brain dump of ${reply.dump.length} items: the turn read outside text (${why.join(", ")})`);
      delete reply.dump;
    }
    // A server that does not sort a brain dump (an older one: no dumpOn) still gets the items, as its ordinary tags and within their caps.
    if (reply.dump && !(typeof ctx.dumpOn === "number" && ctx.dumpOn >= 1)) {
      const d = reply.dump;
      delete reply.dump;
      reply = {
        ...reply,
        remind: [...reply.remind, ...d.filter((x) => x.kind === "reminder" && x.at).map((x) => ({ at: x.at!, text: x.text }))].slice(0, 2),
        tasks: [
          ...(reply.tasks ?? []),
          ...d.filter((x) => x.kind === "task" || (x.kind === "reminder" && !x.at)).map((x) => ({ text: x.text, ...(x.due ? { due: x.due.slice(0, 10) } : {}) })),
        ].slice(0, 3),
        promises: [...(reply.promises ?? []), ...d.filter((x) => x.kind === "promise").map((x) => ({ text: x.text, ...(x.who ? { who: x.who } : {}), ...(x.due ? { due: x.due } : {}) }))].slice(0, 2),
        remember: [...reply.remember, ...d.filter((x) => x.kind === "note").map((x) => x.text)].slice(0, 3),
      };
      if (!reply.tasks?.length) delete reply.tasks;
      if (!reply.promises?.length) delete reply.promises;
    }
    // A check-in is the owner's own ask: a turn that read someone else's text sets none, and a server without check-ins (no checkinOn) gets
    // none (the answer then says so, so it never promises a look that will not come).
    if (reply.checkins && (why.length || !(typeof ctx.checkinOn === "number" && ctx.checkinOn >= 1))) {
      log(`dropped ${reply.checkins.length} check-in(s): ${why.length ? `the turn read outside text (${why.join(", ")})` : "the server does not keep them"}`);
      if (!why.length) {
        const note = t("checkinsOld");
        reply = { ...reply, text: reply.text ? `${reply.text}\n\n${note}` : note };
      }
      delete reply.checkins;
    }
    // A server that keeps no facts ignores <fact>: dropped here (nothing is said: the answer never claims to have kept it).
    if (reply.facts && !(typeof ctx.lifeOn === "number" && ctx.lifeOn >= 1)) delete reply.facts;
    // The same for <know> (src/memory-facts.ts): a server without dated facts would take nothing.
    if (reply.know && !(typeof ctx.knowOn === "number" && ctx.knowOn >= 1)) delete reply.know;
    // The health diary, learning goals and cards are the owner's own: a turn that read outside text keeps none, and a server without them
    // (an older one: no `companion` in its context) is not sent them.
    if (why.length || !(typeof ctx.companion === "number" && ctx.companion >= 1)) {
      if (reply.health || reply.goals || reply.cards) log("dropped <health>, <goal> or <card> tags: an outside turn, or a server without them");
      delete reply.health;
      delete reply.goals;
      delete reply.cards;
    }
    // A server that does not make routines would take the tags silently while the answer says they are set: dropped here, and said.
    if ((reply.routines || reply.watches) && !(typeof ctx.routinesOn === "number" && ctx.routinesOn >= 1)) {
      log("dropped a <routine> or <watch> tag: the server does not make them");
      const note = t("routinesOld");
      reply = { ...reply, text: reply.text ? `${reply.text}\n\n${note}` : note };
      delete reply.routines;
      delete reply.watches;
    }
    log(`answered ${msg.id.slice(-8)}: ${reply.text.length} chars, ${reply.remember.length} notes, ${reply.forget.length} forgets, `
      + `${reply.call ? "a proposed call" : "no call"}, ${reply.message ? "a WhatsApp to send" : "no WhatsApp"}`
      + `${reply.send ? ", a message to send itself" : ""}, $${result.costUsd.toFixed(4)}`);
    // Held notes go with the reply (the server keeps them with the rest until the owner presses), never straight to the notes.
    // A turn the server splits sends its forgets with the reply too (held there), and its new notes straight on as always.
    const noted = held ? null : { remember: reply.remember, forget: splits ? [] : reply.forget };
    if (noted && (noted.remember.length || noted.forget.length)) {
      // Kept until the server has them: a note lost to a blip would be "Apuntado" to the owner and gone.
      pendingNotes.push({ ...noted, key: msg.id });
      if (pendingNotes.length > 20) pendingNotes.shift();
      await flushNotes();
    }
    if (reply.send) log("dropped a <send> tag: the assistant is not offered it, so it can only come from someone else's text");
    const body = {
      ...(reply.text ? { text: reply.text } : {}),
      ...(reply.call ? { call: reply.call } : {}),
      ...(reply.message ? { message: reply.message } : {}),
      ...(reply.email ? { email: reply.email } : {}),
      ...(reply.remind.length ? { remind: reply.remind } : {}),
      ...(reply.unremind.length ? { unremind: reply.unremind } : {}),
      ...(reply.book ? { book: reply.book } : {}),
      ...(reply.lists ? { lists: reply.lists } : {}),
      ...(reply.tasks ? { tasks: reply.tasks } : {}),
      ...(reply.done ? { done: reply.done } : {}),
      ...(calendarOut.length ? { calendar: calendarOut } : {}),
      ...(reply.closed ? { closed: reply.closed } : {}),
      ...(reply.promises ? { promises: reply.promises } : {}),
      ...(reply.people ? { people: reply.people } : {}),
      ...(reply.routines ? { routines: reply.routines } : {}),
      ...(reply.watches ? { watches: reply.watches } : {}),
      ...(heard && (reply.call || reply.email || reply.message || reply.dump) ? { heard } : {}),
      ...(reply.dump ? { dump: reply.dump } : {}),
      ...(reply.checkins ? { checkins: reply.checkins } : {}),
      // Facts go with the turn's mark: the server keeps none from a turn that read outside text.
      ...(reply.facts && (!why.length || serverHolds) ? { facts: reply.facts } : {}),
      ...(reply.know && (!why.length || serverHolds) ? { know: reply.know } : {}),
      ...(why.length && serverHolds && (reply.facts || reply.know) ? { outside: why } : {}),
      ...(reply.health ? { health: reply.health } : {}),
      ...(reply.goals ? { goals: reply.goals } : {}),
      ...(reply.cards ? { cards: reply.cards } : {}),
      ...(held && serverHolds
        ? { outside: heldWhy, ...(reply.remember.length ? { remember: reply.remember } : {}), ...(reply.forget.length ? { forget: reply.forget } : {}) }
        : {}),
      ...(splits && !held ? { context: ctxWhy, ...(reply.forget.length ? { forget: reply.forget } : {}) } : {}),
    };
    // The lines this owner's turn had in front of it are seen once its answer is with the server: a restart before that answers it again
    // with them still new (marked), never unmarked.
    const seenNow = (): void => {
      if (!incoming.routine) writeSeen(ctxLines.map(outsideKey));
    };
    if (!Object.keys(body).length) return (seenNow(), true);
    if (noticeSent) await noticeSent; // "Un momento…" never arrives after the answer
    // The key lets the server do what the reply asks (a call card, a reminder, a table search) once, however many times this is sent again.
    // `noted`: this answer's notes went first, so the server joins them to this reply's receipt even if another copy of it took them (a
    // restart in between); an older server ignores it.
    const keyed = { ...body, key: msg.id, ...(noted && (noted.remember.length || noted.forget.length) ? { noted: true } : {}) };
    const sent = await say(keyed);
    if (sent) return (seenNow(), true);
    replyCache.set(msg.id, keyed);
    // The server could not send it (it is down, or WhatsApp refused): tried again with growing waits (5 s, 15 s, 45 s, 2 min, 5 min), then let go.
    const n = (attempts.get(msg.id) ?? 0) + 1;
    attempts.set(msg.id, n);
    retryAt.set(msg.id, Date.now() + (waits[n - 1] ?? 0));
    return n >= waits.length + 1;
  };
  return { handle };
}

export type Turn = ReturnType<typeof mountTurn>;
