// The door's stores and the state its parts share: the inbox, the owner's lists and people, the cards in flight, the notes on what happened.

import { locale, type Lang } from "../i18n.ts";
import { createLists } from "../lists.ts";
import { createPeople } from "../people.ts";
import { createCompanion } from "../companion.ts";
import { createFacts } from "../memory-facts.ts";
import { createPeopleGraph } from "../people-graph.ts";
import { createRoutines, type Routines } from "../routines.ts";
import { createPaperStore } from "../papers.ts";
import { createInbox } from "./inbox.ts";
import { type Say, T } from "./texts.ts";
import type { OwnerAsk } from "./deps.ts";
import { type CardEnd, PENDING_CALL_MS, EVENT_KEEP } from "./shared.ts";
import type { Door } from "./door.ts";

/** The names this part adds to the door. */
type Part = Pick<
  Door,
  | "config" | "f" | "now" | "lang" | "tx" | "inbox" | "lists" | "people" | "facts" | "idGraph" | "companion" | "routines" | "papers"
  | "paperSummaries" | "seenPresses" | "dayStamps" | "connectorCards" | "cardEnds" | "endCard" | "sweepCards" | "sendStamps" | "ownerNumbers"
  | "sentTo" | "tracked" | "seenReplies" | "events" | "note" | "hhmm"
>;

export function mountCore(door: Door): Part {
  const { d } = door;
  const { config } = d;
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const lang = (): Lang => d.lang?.() ?? "en";
  /** One of the door's own texts, in the language of this moment. */
  const tx: Say = (key, vars) => T(lang())(key, vars);
  const inbox = createInbox(d.kv);
  const lists = d.lists ?? createLists(d.kv, now);
  const people = d.people ?? createPeople(d.kv);
  // Dated facts read the notes and the people in on every load (the first one migrates them); the identities link the owner's people.
  const facts = d.facts ?? createFacts(d.kv, { now, seed: async () => ({ notes: await d.memory.numbered(), people: await people.read(true) }) });
  const idGraph = d.peopleGraph ?? createPeopleGraph(d.kv, { now, people: () => people.read(true) });
  const companion = d.companion
    ?? createCompanion({
      kv: d.kv, timeZone: d.timeZone, lang, now, people: () => people.read(true), ...(d.country ? { country: d.country } : {}),
      // Health data stays on the owner's computer: a server on the internet keeps the diary in memory only.
      healthOnDisk: d.healthOnDisk !== false,
      ...(d.labs === false ? { labs: false } : {}),
      // One FORGET MY HEALTH (asked twice) forgets proactive Pako's mood and health facts too; "how am I sleeping?" reads both.
      alsoForget: async () => {
        await d.life?.forgetHealth?.();
      },
      moreHealth: async () => (d.life?.health ? await d.life.health() : []),
    });
  // Routines and watches (src/routines.ts): a routine's run goes into this inbox as a turn of the owner's; a watch's hit is a notice.
  const routines: Routines = createRoutines({
    kv: d.kv,
    timeZone: d.timeZone,
    now,
    lang,
    ...(d.control ? { control: d.control } : {}),
    enqueue: (m) => inbox.add(m),
    notify: (text) => door.notifyOwner(text),
    ...(d.watchSources ? { sources: d.watchSources } : {}),
    ...(d.routineClaimMs !== undefined ? { claimMs: d.routineClaimMs } : {}),
    ...(d.jobs ? { jobs: d.jobs } : {}),
  });
  const papers = d.papers ?? createPaperStore({ now });
  /** What the latest papers said, as the bridge's isolated read summarized them: for the assistant's context. In memory only, for a day. */
  const paperSummaries: { at: number; name: string; summary: string }[] = [];
  // Starts "now": after a restart of the server the assistant's computer needs a moment to ask again, which is not an outage.
  door.lastPollAt = now();
  const seenPresses = new Set<string>();
  door.lastOfflineNoticeAt = 0;
  door.lastOtherNoticeAt = 0;
  // An older bridge acknowledges each paper of an album on its own: the owner hears how to update once every ten minutes, not once a photo.
  door.lastOldBridgeNoticeAt = 0;
  door.lastBadSignatureLogAt = 0;
  // `typed`: the owner's very next message may answer it in words (yes or no); once any other message comes it can only be answered with its buttons.
  door.pendingCall = null;
  const dayStamps: number[] = [];
  // A message from the assistant's own number to a friend: staged like a call, sent only on the owner's press (or typed yes).
  door.pendingSend = null;
  // Friend calls the connector asked for: a card each, answered by its buttons only (a typed "yes" here was written for this chat, not for a
  // request that came from somewhere else). Several can wait at once ("llama a Ana y a Luis"); a newer one for the same friend replaces the
  // older, once it is shown. `seq` orders them as they were asked for; `shown` is set once WhatsApp took the card.
  const connectorCards = new Map<string, { seq: number; at: number; ask: OwnerAsk; shown: boolean }>();
  door.cardSeq = 0;
  /** Connector cards that stopped counting, and why: a later press on one says what really happened to it (the last few are kept). */
  const cardEnds = new Map<string, CardEnd>();
  const endCard = (id: string, why: CardEnd): void => {
    cardEnds.set(id, why);
    while (cardEnds.size > 30) cardEnds.delete(cardEnds.keys().next().value!);
  };
  /** Cards past their minutes are over: not replaced, not annulled by STOP, not kept. */
  const sweepCards = (): void => {
    for (const [id, c] of connectorCards) {
      if (now() - c.at < PENDING_CALL_MS) continue;
      connectorCards.delete(id);
      endCard(id, "expired");
      c.ask.closed("expired");
    }
  };
  /** STOPs so far: a card that was being sent while one came must count for nothing. */
  door.stops = 0;
  const sendStamps: { digits: string; at: number }[] = [];
  /** Numbers the owner wrote in the chat: a number the assistant proposes to write to must be one of them (or a contact). */
  const ownerNumbers: { digits: string; at: number }[] = [];
  /** Friends the assistant wrote to: their answers are passed on to the owner (anyone else is still dropped). */
  const sentTo = new Map<string, { label: string; at: number }>();
  /** Messages sent to friends whose delivery is not known yet, by WhatsApp's message id. */
  const tracked = new Map<string, { digits: string; label: string; text: string; templated: boolean }>();
  const seenReplies = new Set<string>();

  // What happened to the calls the assistant proposed, in a line each. The assistant never sees a button press or a call's end, so the
  // context it is given carries these: that is how "how did it go?" gets an answer. Kept in memory only (a restart forgets them).
  // `outside`: the line carries someone else's words (a call's automatic summary); Pako's own records ("Sent to Luis: “…”") do not, so
  // provenance (src/autonomy.ts) never takes the owner's own request, said back in a receipt, for third-party text.
  const events: { at: number; text: string; outside?: boolean }[] = [];
  const note = (text: string, outside = false): void => {
    events.push({ at: now(), text, ...(outside ? { outside } : {}) });
    while (events.length > EVENT_KEEP) events.shift();
  };
  const hhmm = (at: number): string => new Intl.DateTimeFormat(locale(lang()), { timeZone: d.timeZone, hour: "2-digit", minute: "2-digit" }).format(at);

  return {
    config, f, now, lang, tx, inbox, lists, people, facts, idGraph, companion, routines, papers, paperSummaries, seenPresses, dayStamps,
    connectorCards, cardEnds, endCard, sweepCards, sendStamps, ownerNumbers, sentTo, tracked, seenReplies, events, note, hhmm,
  };
}
