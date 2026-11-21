// Chasing what others owe the owner: when someone's promise ("Ana sends the numbers by Tuesday") is overdue, Pako offers a short reminder
// for them, ready to send, in two tones (gentle and firm), written from the loop's own facts in a run of its own (src/brief-v2.ts draftFor)
// and held to them by code (src/draft-grounding.ts). The owner taps once: a reply to that person's email goes through the door's held path
// (src/door/held.ts: its receipt and Undo window, then the send); Slack, Teams and Messages are read-only to Pako, so there the tap gives
// the draft back to copy, with a link that opens the app. Nothing is sent without that tap.
//
// When: once its time has passed and half a working day more (working hours, Monday to Friday, never in the owner's quiet hours), and then
// at most once every two working days. "Not needed" stops it for good, and a parked loop is never chased. Whether the owner's own promise
// depends on theirs ("I'll send the report once Ana sends the numbers") is not something the extraction says, so it plays no part here.

import { detectLanguage } from "../language.ts";
import { fold, today } from "../lists.ts";
import { isImessageChannel } from "../imessage.ts";
import { isTeamsChannel } from "../teams.ts";
import type { Base, Chasing, Engine } from "./parts.ts";
import { T } from "./texts.ts";
import type { ChasePress, ChaseTone, FollowupsConfig, FollowupsDoor, Loop, LoopChase } from "./types.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

/** The working day when none is set (WORK_HOURS, WORK_DAYS): minutes of the day [start, end), Monday to Friday. */
export const DEFAULT_WORK: Work = { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] };
type Work = NonNullable<FollowupsConfig["work"]>;
/** The grace after a promise's time before a chase: half a working day. */
const graceMs = (w: Work): number => ((w.end - w.start) / 2) * 60_000;
/** At most one chase suggestion per loop in this much working time: two working days. */
const gapMs = (w: Work): number => 2 * (w.end - w.start) * 60_000;
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** The step working time is counted in. */
const STEP = 15 * 60_000;
/** Two weeks of steps: past that, no working time was found (quiet hours over the whole working day). */
const STEPS_MAX = 14 * 96;
/** A draft shown on the card, at most. */
const DRAFT_MAX = 1200;

/** Button ids: ch1 the gentle draft, ch2 the firm one, ch3 Not needed (src/door/buttons.ts); c1 and c0 are a call card's. */
export const CHASE_BUTTON = /^ch([1-3]):([0-9a-f]{10})$/;

const fmts = new Map<string, Intl.DateTimeFormat>();
const fmtOf = (tz: string): Intl.DateTimeFormat => {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmts.set(tz, f);
  }
  return f;
};

/** Inside the owner's working hours: a working day, within its hours, and not in their quiet hours. */
export function workingAt(t: number, tz: string, quiet: FollowupsConfig["quiet"], w: Work = DEFAULT_WORK): boolean {
  const p = Object.fromEntries(fmtOf(tz).formatToParts(t).map((x) => [x.type, x.value]));
  if (!w.days.includes(WEEKDAY[p.weekday ?? ""] ?? -1)) return false;
  const x = Number(p.hour) * 60 + Number(p.minute);
  if (x < w.start || x >= w.end) return false;
  if (quiet && (quiet.start < quiet.end ? x >= quiet.start && x < quiet.end : x >= quiet.start || x < quiet.end)) return false;
  return true;
}

/** The moment `ms` of working time after `t`; null when there is none in two weeks. */
export function afterWorking(t: number, ms: number, tz: string, quiet: FollowupsConfig["quiet"], w: Work = DEFAULT_WORK): number | null {
  let cur = t;
  let left = ms;
  for (let i = 0; left > 0; i++) {
    if (i > STEPS_MAX) return null;
    if (workingAt(cur, tz, quiet, w)) left -= STEP;
    cur += STEP;
  }
  return cur;
}

/** The first working moment at or after `t`; null when there is none in two weeks. */
export function nextWorking(t: number, tz: string, quiet: FollowupsConfig["quiet"], w: Work = DEFAULT_WORK): number | null {
  let cur = t;
  for (let i = 0; i <= STEPS_MAX; i++, cur += STEP) if (workingAt(cur, tz, quiet, w)) return cur;
  return null;
}

/**
 * When this loop may be chased: someone else's open promise with a time, past that time and the grace, two working days after its last
 * chase, in working hours. Null: never (not theirs, closed, parked, no time, or "Not needed").
 */
export function chaseAt(l: Loop, tz: string, quiet: FollowupsConfig["quiet"], w: Work = DEFAULT_WORK): number | null {
  if (l.kind !== "other_promise" || (l.status !== "open" && l.status !== "snoozed") || !l.dueAt || l.chase?.off) return null;
  let from = afterWorking(l.dueAt, graceMs(w), tz, quiet, w);
  const last = Math.max(l.chase?.askedAt ?? 0, l.chase?.chasedAt ?? 0);
  if (from !== null && last) {
    const gap = afterWorking(last, gapMs(w), tz, quiet, w);
    from = gap === null ? null : Math.max(from, gap);
  }
  return from === null ? null : nextWorking(from, tz, quiet, w);
}

/** A stored chase, checked field by field (src/followups/record.ts loopOf); undefined when there is nothing of one. */
export function chaseOf(v: unknown): LoopChase | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const n = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
  const s = (x: unknown, max: number): string | undefined => (typeof x === "string" ? x.slice(0, max) : undefined);
  const c: LoopChase = {
    ...(n(o.askedAt) ? { askedAt: n(o.askedAt)! } : {}),
    ...(n(o.offeredAt) ? { offeredAt: n(o.offeredAt)! } : {}),
    ...(n(o.chasedAt) ? { chasedAt: n(o.chasedAt)! } : {}),
    ...(o.off === true ? { off: true as const } : {}),
    ...(s(o.gentle, DRAFT_MAX) !== undefined ? { gentle: s(o.gentle, DRAFT_MAX)! } : {}),
    ...(s(o.firm, DRAFT_MAX) !== undefined ? { firm: s(o.firm, DRAFT_MAX)! } : {}),
    ...(s(o.to, 200) ? { to: s(o.to, 200)! } : {}),
    ...(s(o.toName, 80) ? { toName: s(o.toName, 80)! } : {}),
    ...(s(o.subject, 300) ? { subject: s(o.subject, 300)! } : {}),
  };
  return Object.keys(c).length ? c : undefined;
}

/** The languages a chase can be told to write in, by the code src/language.ts detects. */
const LANGUAGES: Record<string, string> = {
  es: "Spanish", en: "English", ca: "Catalan", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch",
};

/**
 * What the run is asked for one tone. The language is the one that person writes in (their own words in the facts, when Pako has them),
 * not the owner's: Pako's own words to the owner stay in its fixed texts. src/brief-v2.ts adds the rules every draft holds to (only what
 * its facts say).
 */
export function chaseRequest(tone: ChaseTone, o: { who: string; where: string; language: string | null; theirs: boolean }): string {
  const who = o.who || "the person in fact D1";
  const lang = o.language && LANGUAGES[o.language]
    ? `Write it in ${LANGUAGES[o.language]}, the language ${who} writes in there.`
    : o.theirs
      ? `Write it in the language of ${who}'s own words in fact D2.`
      : `Write it in the language I use with ${who}.`;
  const how = tone === "gentle"
    ? "Warm and light: a friendly nudge that asks whether it is still coming, with no pressure."
    : "Polite but firm: say plainly that it was due then and is not here yet, and ask for it or for a clear time it will come; no blame, no threat.";
  return `Write a short reminder I send to ${who} about what they promised me in fact D1, ready for me to send myself: first one line saying `
    + `where it goes (${o.where}), then the message, in my own voice, with no greeting from an assistant. ${lang} Name exactly what they `
    + `promised and the time they gave, as fact D1 says them, and nothing else about it. ${how}`;
}

/** The message of a written draft: its first line (where it goes) left out, as the email card does (src/door/actions.ts offerDraftSend). */
export const draftBody = (text: string): string => {
  const lines = text.trim().split("\n");
  return (lines.length > 1 ? lines.slice(1) : lines).join("\n").trim().slice(0, DRAFT_MAX);
};

/** Where a chase goes, as the owner reads it, and whether Pako can send it (an email reply) or the owner copies it (a link to the app). */
export function chaseTarget(l: Loop): { send: boolean; app: string; link?: string } {
  const t = T();
  if (l.chase?.to) return { send: true, app: t("chaseAppMail") };
  const ch = l.where.channel;
  if (ch && isTeamsChannel(ch)) return { send: false, app: "Teams", link: "https://teams.microsoft.com/" };
  if (ch && isImessageChannel(ch)) return { send: false, app: t("messagesWhere") };
  if (ch) return { send: false, app: "Slack", link: `https://slack.com/app_redirect?channel=${encodeURIComponent(ch)}` };
  return { send: false, app: "" };
}

const reSubject = (s: string): string => (/^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`).slice(0, 150);

export function mountChase(
  { d, now, lang, config }: Base,
  { mutate, read, runCheck, draftFacts, forDraft, quietNow, dueText }: Pick<
    Engine,
    "mutate" | "read" | "runCheck" | "draftFacts" | "forDraft" | "quietNow" | "dueText"
  >,
): Chasing {
  /** That person's own words in the conversation, up to the promise (a Slack, Teams or Messages one): what the chase's language follows. */
  const theirWords = async (l: Loop): Promise<string> => {
    const ch = l.where.channel;
    if (!ch || !d.slackHistory) return "";
    const ref = l.sources.find((s) => s.kind === "slack")?.ref;
    try {
      const lines = await d.slackHistory(ch, { limit: 30, ...(l.where.thread ? { thread: l.where.thread } : {}) });
      const first = fold(l.who).split(" ")[0] ?? "";
      const theirs = lines.filter((x) => !x.mine && (!ref || Number(x.ts) <= Number(ref)));
      const named = theirs.filter((x) => first && fold(x.who).split(" ")[0] === first);
      return (named.length ? named : theirs).slice(-3).map((x) => x.text).join("\n").slice(0, 600);
    } catch (err) {
      log.error(`a chase could not read its conversation: ${(err as Error).message}`);
      return "";
    }
  };

  /** Both tones asked of the run (the loop's facts, that person's words, the language they write in). False when neither could be asked. */
  const ask = async (l: Loop): Promise<boolean> => {
    if (!d.chaseDraft) return false;
    const t = T(lang());
    const mailRef = l.sources.find((s) => s.kind === "mail" && s.ref)?.ref;
    const got = mailRef && d.mailOf ? await d.mailOf(mailRef).catch(() => null) : null;
    // Their email only when they sent it: a reply to someone else on the thread would chase the wrong person.
    const first = fold(l.who).split(" ")[0] ?? "";
    const mail = got && (!first || fold(`${got.name} ${got.address}`).includes(first)) ? got : null;
    if (mail?.address) {
      await mutate((s) => {
        const x = s.loops.find((y) => y.id === l.id);
        if (x?.chase) Object.assign(x.chase, { to: mail.address, ...(mail.name ? { toName: mail.name } : {}), subject: mail.subject });
      });
    }
    const words = mail ? mail.text.slice(0, 600) : await theirWords(l);
    const facts = [
      ...draftFacts(l),
      ...(words ? [{ label: t("chaseWords", { who: l.who || "—" }), text: words }] : []),
    ];
    const where = mail?.address ? t("chaseWhereMail", { subject: mail.subject }) : t("chaseWhereChat", { where: l.where.label });
    let asked = 0;
    for (const tone of ["gentle", "firm"] as const) {
      const request = chaseRequest(tone, { who: l.who, where, language: words ? detectLanguage(words) : null, theirs: !!words });
      const ok = await d.chaseDraft({ loop: l, tone, title: t(tone === "gentle" ? "chaseTitleGentle" : "chaseTitleFirm", { title: l.title }), facts, request })
        .catch(() => false);
      if (ok) asked++;
      else await chaseWritten({ loop: l.id, tone, text: "" });
    }
    return asked > 0;
  };

  /** Due chases: each one's drafts asked, within the day's budget and outside the quiet hours. The number asked. */
  const chaseTick = async (): Promise<number> => {
    if (!d.chaseDraft) return 0;
    const t = now();
    if (quietNow(t)) return 0;
    const st = await read();
    const due = st.loops.filter((l) => {
      if (l.kind !== "other_promise" || !l.dueAt || l.dueAt > t) return false;
      const at = chaseAt(l, d.timeZone, config.quiet, config.work);
      return at !== null && at <= t;
    });
    if (!due.length) return 0;
    const g = d.gentle ? await d.gentle().catch(() => null) : null;
    const cap = g ? g.maxPerDay : config.maxPerDay;
    let n = 0;
    for (const l of due) {
      const others = await (d.othersToday?.() ?? Promise.resolve(0)).catch(() => 0);
      const day = today(now(), d.timeZone);
      if (st.budget.day === day && st.budget.n + others >= cap) break;
      // Done after all (their invitation is on the calendar): closed as the round of nudges would, and no chase.
      const seen = l.reopened ? null : await runCheck(l).catch(() => null);
      if (seen?.done) {
        await mutate((s) => {
          const x = s.loops.find((y) => y.id === l.id);
          if (x && (x.status === "open" || x.status === "snoozed")) {
            Object.assign(x, { status: "done", closedAt: now(), nextCheckAt: 0, checkedAt: now(), autoClosed: { at: now(), why: seen.what } });
          }
        });
        continue;
      }
      // Claimed, with the budget, in one write: two processes never both chase one loop, nor spend the last of the day twice.
      const claimed = await mutate((s) => {
        const x = s.loops.find((y) => y.id === l.id);
        const at = x ? chaseAt(x, d.timeZone, config.quiet, config.work) : null;
        if (!x || at === null || at > now()) return false;
        if (s.budget.day !== day) s.budget = { day, n: 0 };
        if (s.budget.n + others >= cap) return false;
        s.budget.n++;
        x.chase = { askedAt: now(), ...(x.chase?.chasedAt ? { chasedAt: x.chase.chasedAt } : {}) };
        return true;
      });
      if (!claimed) continue;
      if (await ask(l)) n++;
      d.control?.log("followup", T(lang())("logChase", { title: l.title }));
    }
    return n;
  };

  /** The card: what they promised and when, both drafts, and the buttons (Send or Copy each, Not needed). */
  const card = (l: Loop): { body: string; buttons: { id: string; title: string }[] } => {
    const t = T(lang());
    const c = l.chase ?? {};
    const to = chaseTarget(l);
    const how = to.send ? t("chaseHowMail", { subject: c.subject ?? "" }) : to.app ? t("chaseHowCopy", { app: to.app }) : t("chaseHowCopyAny");
    const body = [
      t("chaseHead", { who: l.who || t("chaseSomeone"), title: l.title, due: dueText(l, lang()), how }),
      ...(c.gentle ? [t("chaseGentle", { text: c.gentle })] : []),
      ...(c.firm ? [t("chaseFirm", { text: c.firm })] : []),
      ...(to.link ? [t("chaseOpen", { app: to.app, link: to.link })] : []),
    ].join("\n\n");
    const verb = to.send ? "Send" : "Copy";
    const buttons = [
      ...(c.gentle ? [{ id: `ch1:${l.id}`, title: t(`chase${verb}Gentle`) }] : []),
      ...(c.firm ? [{ id: `ch2:${l.id}`, title: t(`chase${verb}Firm`) }] : []),
      { id: `ch3:${l.id}`, title: t("chaseNotNeeded") },
    ];
    return { body, buttons };
  };

  /** A draft written: kept on its loop; once both tones are in (one may have failed), the card goes, once per chase. */
  const chaseWritten: NonNullable<FollowupsDoor["chaseWritten"]> = async (o) => {
    const ready = await mutate((s) => {
      const x = s.loops.find((y) => y.id === o.loop);
      if (!x || (x.status !== "open" && x.status !== "snoozed") || !x.chase?.askedAt || x.chase.off) return null;
      x.chase[o.tone] = o.text ? draftBody(o.text) : "";
      const c = x.chase;
      if (c.gentle === undefined || c.firm === undefined || (c.offeredAt ?? 0) >= c.askedAt! || (!c.gentle && !c.firm)) return null;
      c.offeredAt = now();
      return structuredClone(x);
    });
    if (!ready) return false;
    const { body, buttons } = card(ready);
    const sent = await d.card(body, buttons).catch(() => false);
    if (!sent) await d.notify(T(lang())("held", { text: body }));
    return true;
  };

  /** A press on the card: the draft to send (an email reply) or to copy, or no more chases for it. */
  const chasePressed: NonNullable<FollowupsDoor["chasePressed"]> = async (button, id) => {
    const t = T(lang());
    let title = "";
    const out = await mutate((s): ChasePress => {
      const x = s.loops.find((y) => y.id === id);
      if (!x || (x.status !== "open" && x.status !== "snoozed")) return { say: t("pressedGone") };
      title = x.title;
      if (button === "3") {
        x.chase = { ...x.chase, off: true };
        return { say: t("chaseOff", { title: x.title }) };
      }
      const c = x.chase;
      const text = button === "1" ? c?.gentle : c?.firm;
      if (!c?.askedAt || !text || c.off) return { say: t("chaseGoneDraft") };
      if ((c.chasedAt ?? 0) >= (c.offeredAt ?? c.askedAt)) return { say: t("chaseAlready") };
      c.chasedAt = now();
      const to = chaseTarget(x);
      if (to.send && c.to) {
        return {
          say: "",
          send: { label: c.toName || x.who || c.to, target: c.to, subject: reSubject(c.subject ?? x.title), text, key: `chase-${x.id}-${c.askedAt}` },
        };
      }
      return { say: to.link ? t("chaseCopiedLink", { app: to.app, link: to.link }) : to.app ? t("chaseCopied", { app: to.app }) : t("chaseCopiedAny"), copy: text };
    });
    if (out.send || out.copy) d.control?.log("followup", t("logChased", { title }));
    return out;
  };

  /** "chase <words>": the owner asked, so no wait and no budget; "Not needed" said before is taken back. */
  const chaseNow: NonNullable<FollowupsDoor["chaseNow"]> = async (words) => {
    const t = T(lang());
    if (!d.chaseDraft) return { ok: false, say: t("chaseCant") };
    const found = await forDraft(words);
    if ("none" in found) return { ok: false, say: t("chaseNone", { words }) };
    if ("many" in found) return { ok: false, say: t("chaseMany", { list: found.many.map((x) => `• ${x}`).join("\n") }) };
    const l = found.loop;
    if (l.kind !== "other_promise") return { ok: false, say: t("chaseMine", { title: l.title }) };
    await mutate((s) => {
      const x = s.loops.find((y) => y.id === l.id);
      if (x) x.chase = { askedAt: now(), ...(x.chase?.chasedAt ? { chasedAt: x.chase.chasedAt } : {}) };
    });
    const fresh = (await read()).loops.find((x) => x.id === l.id) ?? l;
    const ok = await ask(fresh);
    return { ok, say: ok ? t("chaseWriting", { who: l.who || t("chaseSomeone"), title: l.title }) : t("chaseCant") };
  };

  return { chaseTick, chaseWritten, chasePressed, chaseNow };
}
