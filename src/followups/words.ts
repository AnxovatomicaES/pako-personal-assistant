// How a loop is said: its time (both zones), its source, and the nudge's words.

import { locale, ownerClock, type Lang } from "../i18n.ts";
import { today } from "../lists.ts";
import type { Engine } from "./parts.ts";
import { T } from "./texts.ts";
import { clock12, offsetAt, zoneName } from "./time.ts";
import type { Loop, LoopSource } from "./types.ts";

export function mountWords(fu: Engine): Pick<Engine, "stamp" | "dueText" | "sourceText" | "nudgeText"> {
  const { d, now } = fu;
  const stamp = (t: number, tz: string): string =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(t);
  const whenText = (t: number, l: Lang): string =>
    new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(t);

  /** ", at 5:15 AM ET (10:15 London)": the time in the zone it was said in, and in the owner's. */
  const dueText = (l: Loop, lg: Lang): string => {
    if (!l.dueAt) return "";
    const t = T(lg);
    const mine = ownerClock(l.dueAt, d.timeZone, lg);
    const theirs = l.tz && l.tz !== d.timeZone && offsetAt(l.dueAt, l.tz) !== offsetAt(l.dueAt, d.timeZone) ? l.tz : null;
    const time = theirs ? `${clock12(l.dueAt, theirs)} ${zoneName(theirs)} (${mine} ${zoneName(d.timeZone)})` : mine;
    const dayOf = (x: number) => today(x, d.timeZone);
    if (dayOf(l.dueAt) === dayOf(now())) return t("at", { time });
    if (dayOf(l.dueAt) === dayOf(now() + 24 * 3600_000)) return t("tomorrow", { time });
    const day = new Intl.DateTimeFormat(locale(lg), { timeZone: d.timeZone, day: "numeric", month: "numeric" }).format(l.dueAt);
    return t("atDay", { day, time });
  };
  const sourceText = (s: LoopSource | undefined, lg: Lang): string => {
    if (!s) return "";
    const t = T(lg);
    // A Teams conversation goes through the Slack path (src/teams.ts), and its label already says Teams; a transcript's, the same.
    if (s.label.startsWith("Teams · ")) return `${s.label}, ${whenText(s.at, lg)}`;
    const key = s.kind === "slack" ? "srcSlack" : s.kind === "mail" ? "srcMail" : s.kind === "chat" ? "srcChat" : "srcMeeting";
    return t(key, { label: s.label, when: whenText(s.at, lg) });
  };
  /** "Set up the meeting" → "set up the meeting" after "asked you to"; a name or an acronym keeps its capital. */
  const lower = (s: string): string => (/^\p{Lu}\p{Ll}/u.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

  /** The nudge's words: who asked what, for when (both zones), what was checked, and where it was said. */
  const nudgeText = (l: Loop, said: string, soon: boolean, lg: Lang): string => {
    const t = T(lg);
    // Nobody named (a meeting's to-do nobody in particular waits for): said without a person, never as "?".
    const key = l.who || l.kind === "deadline" ? l.kind : (`${l.kind}Anon` as const);
    const lead = t(key, { who: l.who, title: l.kind === "request_to_owner" ? lower(l.title) : l.title });
    return `${soon ? t("soon") : ""}${t("nudge", { lead, due: dueText(l, lg), checked: said, source: sourceText(l.sources[0], lg) })}`.trim();
  };

  return { stamp, dueText, sourceText, nudgeText };
}
