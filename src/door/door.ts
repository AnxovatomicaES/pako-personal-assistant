// The door's shared context: what its parts read and change together (src/whatsapp.ts builds it, src/door/*.ts fill it in).

import type { CalendarProposalIn } from "./calendar-cards.ts";
import type { CalendarWrite } from "../calendar-writes.ts";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { Express, RequestHandler } from "express";
import type { View } from "../intents.ts";
import type { Lang } from "../i18n.ts";
import type { NotesCommand } from "../voice-memory.ts";
import type { BookingReply } from "../booking.ts";
import type { createUndoJournal, Change, Every, SavedReminder } from "../undo.ts";
import type { HeldActs, OutsideSource } from "../quarantine.ts";
import type { autonomyText, ActionType, Decision, HeldQueue, HeldType, Mode, Origin, TurnSources } from "../autonomy.ts";
import type {
  peopleContext, peopleWords, EditOutcome as PersonEdit, PeopleCommand, PeopleDoor, Person, PersonInput, PersonPatch, PeopleStore,
} from "../people.ts";
import type { Routines } from "../routines.ts";
import type { createInbox } from "./inbox.ts";
import type { Say } from "./texts.ts";
import type { WhatsappDeps, OwnerAsk, OwnerChannel, AskResult } from "./deps.ts";
import type { CardEnd } from "./shared.ts";
import type { Companion } from "../companion.ts";
import type { WhatsappConfig } from "./config.ts";
import type { PeopleGraph } from "../people-graph.ts";
import type { ListStore } from "../lists.ts";
import type { FactStore } from "../memory-facts.ts";
import type { PaperStore } from "../papers.ts";
import type { RateLimitRequestHandler } from "express-rate-limit";

export type Delivery = { ok: boolean; id: string; code: number; detail: string };

/** `recipient`: where the name the model first wrote came from, kept across a which-card (pressing a name only says which one). */
export type Turn = { sources: TurnSources; initiative: boolean; ownerUnknown: boolean; key: string; recipient?: Origin; context?: OutsideSource[] };

// ---------- reminders: kept here (they survive a restart), sent to the owner when due ----------

export interface Reminder {
  id: string;
  at: number;
  text: string;
  /** A repeating one: how often, and its first time as written (src/undo.ts SavedReminder). */
  every?: Every;
  anchor?: string;
  /** A person's birthday (src/people.ts): one per person, outside REMINDERS_MAX, and only that person's changes remove it. */
  birthday?: true;
  held: boolean;
  tries: number;
  /** A held copy of a repeat: its series' id (one copy per series, its latest missed time; it goes with the series). */
  of?: string;
  /** After a failed send, not before this moment (the bridge asks every few seconds: three tries must not be three seconds). */
  retryAt?: number;
}

// ---------- a reminder's buttons: Done, +10 min, Tomorrow ----------

export interface Fired {
  /** The card's id (its buttons carry it: r1, r2, r3). */
  id: string;
  /** The reminder that fired: its id, words, time and repeat. */
  rid: string;
  text: string;
  at: number;
  every?: Every;
  firedAt: number;
  answered?: "done" | "snooze" | "tomorrow";
}

// Notices the server could not give because WhatsApp's 24-hour window was closed and there is no template: they wait for the owner's next message.
// A receipt keeps its entry's id (`undo`), so it comes then with its own Undo button. Kept as text when it has none, as before.
export type HeldNotice = { text: string; undo?: string };

/**
 * Everything the parts of the door share, on one object. Each part (a mount... function in src/door/) reads what earlier parts put here and adds
 * what it declares; mountWhatsapp runs them in the order the door always set itself up, so a part may use an earlier one's names at once and
 * a later one's only from inside its functions (as door.name, read when called). The fields that are not readonly are the door's moving state:
 * each part changes them on this object, so every other part sees the change.
 */
export interface Door {
  // what mountWhatsapp is given
  readonly app: Express;
  readonly d: WhatsappDeps;
  // src/door/core.ts
  readonly config: WhatsappConfig;
  readonly f: typeof fetch;
  readonly now: () => number;
  readonly lang: () => Lang;
  readonly tx: Say;
  readonly inbox: ReturnType<typeof createInbox>;
  readonly lists: ListStore;
  readonly people: PeopleStore;
  readonly facts: FactStore;
  readonly idGraph: PeopleGraph;
  readonly companion: Companion;
  readonly routines: Routines;
  readonly papers: PaperStore;
  readonly paperSummaries: { at: number; name: string; summary: string }[];
  lastPollAt: number;
  readonly seenPresses: Set<string>;
  lastOfflineNoticeAt: number;
  lastOtherNoticeAt: number;
  lastOldBridgeNoticeAt: number;
  lastBadSignatureLogAt: number;
  pendingCall: { id: string; name: string; readback: string; at: number; typed: boolean } | null;
  readonly dayStamps: number[];
  pendingSend: { id: string; digits: string; label: string; text: string; at: number; typed: boolean } | null;
  readonly connectorCards: Map<string, { seq: number; at: number; ask: OwnerAsk; shown: boolean; }>;
  cardSeq: number;
  readonly cardEnds: Map<string, CardEnd>;
  readonly endCard: (id: string, why: CardEnd) => void;
  readonly sweepCards: () => void;
  stops: number;
  readonly sendStamps: { digits: string; at: number }[];
  readonly ownerNumbers: { digits: string; at: number }[];
  readonly sentTo: Map<string, { label: string; at: number; }>;
  readonly tracked: Map<string, { digits: string; label: string; text: string; templated: boolean; }>;
  readonly seenReplies: Set<string>;
  readonly events: { at: number; text: string; outside?: boolean }[];
  readonly note: (text: string, outside?: boolean) => void;
  readonly hhmm: (at: number) => string;
  // src/door/owner.ts
  ownerBsuid: string;
  preferBsuid: boolean;
  readonly isOwner: (m: Record<string, unknown>) => Promise<boolean>;
  readonly via: AsyncLocalStorage<OwnerChannel>;
  readonly setLastChannel: (c: OwnerChannel) => void;
  readonly telegramReady: () => Promise<boolean>;
  readonly startedRoute: () => Promise<OwnerChannel>;
  readonly lastRoute: () => Promise<OwnerChannel>;
  readonly ownStart: AsyncLocalStorage<boolean>;
  readonly reachable: (t: number) => Promise<boolean>;
  readonly placeName: (route: OwnerChannel) => string;
  // src/door/language.ts
  readonly hearLanguage: (text: string, m: Record<string, unknown>) => void;
  readonly ownerLanguage: () => Promise<string>;
  readonly chatLanguage: () => Promise<string | null>;
  // src/door/send.ts
  readonly sendHealth: (status: number) => void;
  readonly graph: (body: Record<string, unknown>, out?: { on?: OwnerChannel; }, secret?: boolean) => Promise<boolean>;
  readonly sendText: (text: string, o?: { secret?: boolean; }) => Promise<boolean>;
  readonly sendButtons: (body: string, yesId: string, noId: string, yesTitle: string, out?: { on?: OwnerChannel; }) => Promise<boolean>;
  readonly sendButton: (body: string, id: string, title: string) => Promise<boolean>;
  readonly sendConfirm: (body: string, id: string) => Promise<boolean>;
  // src/door/calls.ts
  readonly deliverBooking: (r: BookingReply) => Promise<void>;
  /** `turn`: the owner's own turn (no outside text in it), which lets Maître book a restaurant they named at once. */
  readonly startBooking: (req: { what: string; when: string; party: number; notes?: string; name?: string; }, turn?: Turn) => void;
  readonly propose: (call: { name: string; message: string; direct?: boolean; }, why?: string) => Promise<void>;
  readonly watchCall: (placed: { name: string; callId: string; }) => void;
  readonly answerCall: (p: NonNullable<Door["pendingCall"]>, yes: boolean, said: string) => Promise<void>;
  // src/door/asks.ts
  readonly askCall: (ask: OwnerAsk) => Promise<AskResult>;
  readonly answerAsk: (id: string, c: { seq: number; at: number; ask: OwnerAsk; shown: boolean; }, yes: boolean) => Promise<void>;
  // src/door/messages.ts
  readonly prepareMessage: (m: { to: string; text: string; }) => Promise<void>;
  readonly rememberNumbers: (text: string, at: number) => void;
  readonly resolveFriend: (to: string, at: number) => { label: string; digits: string; } | null;
  readonly sendLimit: (digits: string, at: number) => string;
  readonly withOpening: (text: string) => string;
  readonly proposeSend: (s: { to: string; text: string; }, why?: string) => Promise<void>;
  readonly answerSend: (p: NonNullable<Door["pendingSend"]>, yes: boolean) => Promise<void>;
  readonly forwardReply: (m: Record<string, unknown>) => Promise<string | null>;
  // src/door/delivery.ts
  readonly graphTo: (digits: string, body: Record<string, unknown>) => Promise<Delivery>;
  readonly deliver: (p: { digits: string; label: string; text: string; }) => Promise<boolean>;
  readonly handleStatus: (st: Record<string, unknown>) => Promise<string | null>;
  // src/door/autonomy.ts
  readonly at: (key: Parameters<ReturnType<typeof autonomyText>>[0], vars?: Record<string, string | number>) => string;
  readonly saidByOwner: (id: string, text: string, audio?: boolean) => void;
  readonly sawOutside: (source: OutsideSource, lines: unknown) => void;
  readonly sawContext: (c: Record<string, unknown>) => void;
  readonly turnOf: (key: string, heard: string, initiative: boolean) => Promise<Turn>;
  readonly chosen: (turn: Turn, written: string) => Turn;
  readonly originOf: (to: string, turn: Turn) => Origin;
  readonly effective: (type: ActionType) => Promise<{ mode: Mode; seconds: number; }>;
  readonly whatOf: (type: HeldType) => string;
  readonly asked: (dec: Decision, type: HeldType, to: string) => string;
  readonly shortText: (s: string) => string;
  readonly inChat: (route: string | null, fn: () => Promise<void>) => Promise<void>;
  // src/door/held.ts
  readonly heldQueue: HeldQueue;
  readonly holdAction: (
    input: { type: HeldType; label: string; target: string; text: string; subject?: string; direct?: boolean },
    seconds: number,
    key: string,
  ) => Promise<void>;
  readonly undoLatestHeld: () => Promise<boolean>;
  readonly pressedAutonomy: (kind: string, id: string) => Promise<void>;
  // src/door/actions.ts
  readonly choices: Map<string, { at: number; names: string[]; go: (name: string) => Promise<void>; }>;
  readonly emailCards: Map<string, { at: number; label: string; target: string; subject: string; text: string; }>;
  readonly callAuto: (call: { name: string; message: string; direct: boolean; }, turn: Turn) => Promise<void>;
  readonly sendAuto: (s: { to: string; text: string; }, turn: Turn) => Promise<void>;
  readonly emailAuto: (e: { to: string; subject: string; text: string; }, turn: Turn | null) => Promise<void>;
  readonly offerDraftSend: (o: { from: string; subject: string; title: string; text: string }) => Promise<void>;
  readonly proposeCalendar: (p: CalendarProposalIn, why: OutsideSource[]) => Promise<void>;
  readonly pressedCalendar: (yes: boolean, id: string) => Promise<void>;
  readonly calendarResult: (w: CalendarWrite) => Promise<void>;
  // src/door/buttons.ts
  readonly pressed: (buttonId: string, by?: string) => Promise<void>;
  readonly NO: RegExp;
  readonly SEND_YES: RegExp;
  // src/door/reminders.ts
  runningReminders: boolean;
  readonly loadReminders: () => Promise<Reminder[]>;
  readonly saveReminders: (list: Reminder[]) => Promise<void>;
  readonly counted: (list: Reminder[]) => number;
  readonly remLock: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly addReminder: (
    when: string, text: string, every?: Every, o?: { anchor?: string; birthday?: boolean },
  ) => Promise<{ ok: boolean; say: string; warn?: string; added?: SavedReminder }>;
  readonly removeReminders: (words: string[]) => Promise<SavedReminder[]>;
  readonly removeReminderById: (id: string) => Promise<SavedReminder | null>;
  readonly restoreReminders: (gone: SavedReminder[]) => Promise<{ restored: SavedReminder[]; past: SavedReminder[]; full: SavedReminder[]; }>;
  // src/door/window.ts
  lastOwnerAt: number;
  lastHeardAt: number;
  readonly touchOwner: (at: number) => void;
  readonly windowOpen: (t: number) => Promise<boolean>;
  readonly windowOver: (t: number) => Promise<boolean>;
  // src/door/reminder-texts.ts
  readonly reminderLines: () => Promise<string[]>;
  readonly remindersText: () => Promise<string>;
  // src/door/reminder-cards.ts
  readonly sendReminderTemplate: (text: string) => Promise<boolean>;
  readonly repeatNext: (r: Reminder, t: number) => boolean;
  readonly sendReminderCard: (r: Reminder, body: string) => Promise<boolean>;
  readonly answerReminder: (id: string, kind: "done" | "snooze" | "tomorrow") => Promise<void>;
  // src/door/reminders-due.ts
  readonly runReminders: () => Promise<void>;
  // src/door/notices.ts
  readonly hold: (text: string, undo?: string) => Promise<number>;
  readonly notifyOwner: (text: string, o?: { urgent?: boolean; }) => Promise<"sent" | "held">;
  readonly flushHeld: () => Promise<void>;
  // src/door/receipts.ts
  readonly journal: ReturnType<typeof createUndoJournal>;
  readonly replyKeys: Set<string>;
  readonly remember: (set: Set<string>, key: string) => void;
  readonly keyOf: (v: unknown) => string;
  readonly routeOf: (key: string) => OwnerChannel | null;
  readonly inRoute: (key: string, fn: () => Promise<void>) => Promise<void>;
  readonly sendReceipt: (changes: Change[], key?: string) => Promise<void>;
  readonly claimReceipt: (key: string) => void;
  readonly noteReceipt: (key: string, changes: Change[]) => Promise<void>;
  readonly replyReceipt: (key: string, changes: Change[], noted: boolean) => Promise<void>;
  // src/door/revert.ts
  readonly undoNow: (which: { id: string; } | { within: number; }, by: string) => Promise<string>;
  // src/door/people-changes.ts
  readonly pw: () => ReturnType<typeof peopleWords>;
  readonly contactLink: (name: string) => string | undefined;
  readonly keepPeople: (list: PersonInput[], changes: Change[]) => Promise<void>;
  readonly editPerson: (id: string, patch: PersonPatch, was: number | undefined, from: "chat" | "panel") => Promise<{ outcome: PersonEdit | { status: "bad"; }; changes: Change[]; }>;
  readonly forgetPerson: (id: string, was: number | undefined, from: "chat" | "panel") => Promise<{ gone: Person | null | "changed"; changes: Change[]; }>;
  // src/door/facts.ts
  readonly withRecall: (base: ReturnType<typeof peopleContext> | null) => Promise<Record<string, unknown>>;
  readonly learnKnow: (list: { who: string; key: string; value: string; since: string; }[], outsideTurn: boolean) => Promise<void>;
  sameAskedAt: number;
  readonly askSame: (about?: string) => Promise<boolean>;
  readonly answerSame: (id: string, yes: boolean) => Promise<string>;
  readonly whoNow: (name: string) => Promise<string | null>;
  // src/door/people.ts
  readonly peopleNow: (c: PeopleCommand) => Promise<string | null>;
  readonly peopleDoor: PeopleDoor;
  // src/door/webhook.ts
  readonly dailyLimitReached: () => boolean;
  // src/door/inbound.ts
  readonly handleMessage: (m: Record<string, unknown>, channel?: OwnerChannel) => Promise<string>;
  // src/door/papers.ts
  readonly takePaper: (m: Record<string, unknown>, id: string, at: number) => Promise<string>;
  // src/door/views.ts
  readonly viewOn: (v: View) => boolean;
  // src/door/help.ts
  readonly helpText: () => string;
  // src/door/notes.ts
  readonly notesNow: (c: NotesCommand) => Promise<string>;
  // src/door/bridge.ts
  readonly failed: RateLimitRequestHandler;
  readonly bridge: RequestHandler;
  readonly json: RequestHandler;
  readonly strings: (v: unknown, count: number, min: number, max: number) => string[];
  // src/door/media.ts
  readonly downloadMedia: (id: string, max: number) => Promise<{ ok: true; bytes: Buffer; mime: string; } | { ok: false; status: number; why: string; }>;
  // src/door/held-replies.ts
  readonly heldReplies: Map<string, { acts: HeldActs; why: OutsideSource[]; at: number; }>;
  readonly act: (a: HeldActs, changes: Change[], turn?: Turn) => Promise<void>;
  readonly holdReply: (a: HeldActs, why: OutsideSource[]) => Promise<void>;
  readonly answerHeld: (id: string, yes: boolean) => Promise<void>;
  // src/door/tags.ts
  readonly makeRoutines: (
    rs: { at: string; every: string; text: string }[],
    ws: { on: string; from: unknown; words: unknown; once: boolean; text: string }[],
    refused: "outside" | "fromRoutine" | null,
    changes: Change[],
  ) => Promise<void>;
  readonly changeLists: (ops: { name: string; op: "add" | "remove"; items: string[]; }[], adds: { text: string; due: string; }[], done: string[], changes: Change[]) => Promise<void>;
}
