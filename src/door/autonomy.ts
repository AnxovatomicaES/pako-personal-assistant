// Autonomy (src/autonomy.ts): where the words of a turn came from, and what the owner's settings allow for each kind of action.

import type { OutsideSource } from "../quarantine.ts";
import {
  autonomyText, createAutonomySettings, recipientOrigin, whyLine, type ActionType, type AutonomyConfig, type AutonomySettings, type Decision,
  type HeldType, type Mode, type Origin,
} from "../autonomy.ts";
import type { Person } from "../people.ts";
import type { Inbound } from "./inbox.ts";
import type { OwnerChannel } from "./deps.ts";
import { EVENT_KEEP_MS } from "./shared.ts";
import type { Turn, Door } from "./door.ts";

/** The names this part adds to the door. */
type Part = Pick<
  Door,
  | "at" | "saidByOwner" | "sawOutside" | "sawContext" | "turnOf" | "chosen" | "originOf" | "effective" | "whatOf" | "asked" | "shortText" | "inChat"
>;

export function mountAutonomy(door: Door): Part {
  const { d, now, lang, inbox, people, events, via, startedRoute, ownStart } = door;
  // ---------- autonomy with provenance (src/autonomy.ts): the owner's own request goes, with a window to undo; anything else asks ----------

  const autonomyConfig: AutonomyConfig = d.autonomy?.config ?? { mode: "direct", seconds: 10 };
  const autonomy: AutonomySettings = d.autonomy?.settings ?? createAutonomySettings(d.kv, autonomyConfig);
  const at = (key: Parameters<ReturnType<typeof autonomyText>>[0], vars?: Record<string, string | number>): string => autonomyText(lang())(key, vars);
  /** The owner's own words by their message's id: what provenance is worked out from. A forwarded message is never theirs. */
  const ownerSaid = new Map<string, { text: string; at: number; audio: boolean }>();
  const saidByOwner = (id: string, text: string, audio = false): void => {
    ownerSaid.set(id, { text: text.slice(0, 4000), at: now(), audio });
    while (ownerSaid.size > 50) ownerSaid.delete(ownerSaid.keys().next().value!);
  };
  /** Outside text this server put in front of the model (context lines, forwarded messages), for a day, with where it came from. */
  const outsideSeen: { source: OutsideSource; text: string; at: number }[] = [];
  const sawOutside = (source: OutsideSource, lines: unknown): void => {
    const t = now();
    for (const x of Array.isArray(lines) ? lines : [lines]) {
      if (typeof x !== "string" || !x.trim()) continue;
      const text = x.slice(0, 2000);
      const old = outsideSeen.findIndex((o) => o.source === source && o.text === text);
      if (old >= 0) outsideSeen.splice(old, 1);
      outsideSeen.push({ source, text, at: t });
    }
    while (outsideSeen.length > 300 || (outsideSeen.length && t - outsideSeen[0]!.at > 24 * 3600_000)) outsideSeen.shift();
  };
  /** Every line of other people's text in a context the bridge was given. */
  const sawContext = (c: Record<string, unknown>): void => {
    const zoom = (c.zoom ?? {}) as { upcoming?: unknown; summaries?: unknown };
    sawOutside("email", c.emails);
    sawOutside("slack", c.slack);
    sawOutside("calendar", c.calendar);
    sawOutside("calendar", zoom.upcoming);
    sawOutside("meeting", zoom.summaries);
    sawOutside("meeting", c.meetingTodos);
    sawOutside("booking", c.bookings);
    // Only the events that carry someone else's words: Pako's own receipts are not outside text.
    sawOutside("event", events.filter((e) => e.outside && now() - e.at < EVENT_KEEP_MS).map((e) => e.text));
    sawOutside("document", c.papers);
    sawOutside("document", c.followups);
    sawOutside("document", c.briefTodos);
  };
  /** What the server gave the model for this answer: the owner's words (or what the bridge heard), the people, the outside text. */
  const turnOf = async (key: string, heard: string, initiative: boolean): Promise<Turn> => {
    let said = key ? ownerSaid.get(key) : undefined;
    if (!said && key) {
      // After a restart: the message may still be in the inbox (it goes when the bridge acknowledges it).
      const m = (await inbox.peek().catch(() => [] as Inbound[])).find((x) => x.id === key);
      if (m && !m.forwarded && !m.routine) said = { text: m.text, at: m.at, audio: !!m.audio };
    }
    const owner = initiative || !said ? [] : [said.audio ? heard : said.text].filter((x) => x.trim());
    const list = await people.read(true).catch(() => [] as Person[]);
    return {
      sources: {
        owner,
        people: list.map((p) => ({ name: p.name, ...(p.relation ? { relation: p.relation } : {}) })),
        outside: outsideSeen.map((o) => ({ source: o.source, text: o.text })),
      },
      initiative,
      ownerUnknown: !initiative && !owner.length,
      key,
    };
  };
  /**
   * The owner pressed one of the names: that settles which contact, not whether to send. The recipient keeps the origin of the name the
   * model wrote, so a name taken from an email still gets the card (with its why) after the press.
   */
  const chosen = (turn: Turn, written: string): Turn => ({ ...turn, recipient: turn.recipient ?? recipientOrigin(written, turn.sources) });
  const originOf = (to: string, turn: Turn, resolved?: string): Origin => turn.recipient ?? recipientOrigin(to, turn.sources, resolved);
  const effective = (type: ActionType): Promise<{ mode: Mode; seconds: number }> =>
    autonomy.effective(type).catch(() => ({ mode: "confirm" as Mode, seconds: autonomyConfig.seconds }));
  const whatOf = (type: HeldType): string => at(type === "email" ? "whatEmail" : type === "call" ? "whatCall" : "whatMessage");
  /** Asked with a card: logged with why (a reason that says nothing new is not logged). */
  const asked = (dec: Decision, type: HeldType, to: string): string => {
    const why = whyLine(dec.reasons, lang());
    if (why) d.control?.log("autonomy", at("logAsked", { why: dec.reasons.map((r) => r.kind).join(", "), what: whatOf(type), to }));
    return why;
  };
  /** One line, nothing hidden, short: how the receipt shows the words. */
  const shortText = (s: string): string => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > 160 ? `${one.slice(0, 159)}…` : one;
  };

  /** Inside the chat the answer went to (or, after a restart, where Pako would start one), as something Pako starts. */
  const inChat = async (route: string | null, fn: () => Promise<void>): Promise<void> => {
    const r: OwnerChannel = route === "telegram" ? "telegram" : route === "base" ? "base" : await startedRoute();
    await ownStart.run(true, () => via.run(r, fn));
  };

  return { at, saidByOwner, sawOutside, sawContext, turnOf, chosen, originOf, effective, whatOf, asked, shortText, inChat };
}
