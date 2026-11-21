// The engine's parts and what each one gives (src/followups/engine.ts mounts them in order, handing each only the names it needs).

import type { Lang } from "../i18n.ts";
import type { Seen } from "./checks.ts";
import type { MailLoops } from "./mail.ts";
import type {
  ParkedExpired,
  Batch, DraftInput, DryOutcome, FollowupsConfig, FollowupsDeps, FollowupsDoor, FollowupsState, Job, Loop, LoopSource, SlackSeen,
} from "./types.ts";

/** What every part is given: the deps, the config, the clock and the owner's language. */
export interface Base {
  readonly d: FollowupsDeps;
  readonly config: FollowupsConfig;
  readonly now: () => number;
  readonly lang: () => Lang;
}

/** store.ts */
export interface Store {
  mutate: <R>(fn: (s: FollowupsState) => R | Promise<R>) => Promise<R>;
  read: () => Promise<FollowupsState>;
}

/** words.ts */
export interface Words {
  stamp: (t: number, tz: string) => string;
  dueText: (l: Loop, lg: Lang) => string;
  sourceText: (s: LoopSource | undefined, lg: Lang) => string;
  nudgeText: (l: Loop, said: string, soon: boolean, lg: Lang) => string;
}

/** jobs.ts */
export interface JobsPart {
  jobText: (job: Job, material: string[], people?: string[]) => Promise<string>;
  enqueueJob: (job: Job, material: string[], people?: string[]) => Promise<boolean>;
  queueJob: (job: Job, material: string[], people?: string[], again?: boolean) => Promise<"queued" | "refused" | "failed">;
  slackJob: (b: Pick<Batch, "channel" | "thread" | "where" | "msgs">) => Promise<{ job: Job; material: string[]; people: string[] }>;
  flushBatch: (b: Batch, again?: boolean) => Promise<boolean>;
  observeSlack: (m: SlackSeen) => Promise<void>;
  textJob: (o: { source: "mail" | "meeting"; ref: string; label: string; text: string; at?: number; people?: string[] }) => { job: Job; material: string[]; people: string[] };
  offer: FollowupsDoor["offer"];
}

/** mail-jobs.ts */
export interface MailJobs {
  observeMail: NonNullable<FollowupsDoor["observeMail"]>;
  flushMailDue: (t: number) => Promise<number>;
}

/** matching.ts */
export interface Matching {
  ruledOut: (s: FollowupsState, c: { who: string; title: string }, job: Job) => boolean;
  keep: (s: FollowupsState, job: Job, list: unknown[], max: number, trusted: boolean) => number;
  result: FollowupsDoor["result"];
  ingest: (o: { ref: string; label: string; at: number; loops: unknown[] }) => Promise<number>;
  fromChat: NonNullable<FollowupsDoor["fromChat"]>;
  dropFromChat: NonNullable<FollowupsDoor["dropFromChat"]>;
  /** The beta's audit: the loops a job made or added to, and telling it a conversation was read (src/beta-audit.ts). */
  touched: (s: FollowupsState, job: Job) => number;
  told: (job: Job, loops: number, queued?: boolean) => void;
}

/** checks.ts */
export interface Checks {
  runCheck: (l: Loop) => Promise<Seen>;
}

/** nudges.ts */
export interface Nudges {
  quietNow: (t: number) => boolean;
  nextAfter: (l: Loop, t: number) => number;
  tick: () => Promise<{ jobs: number; checked: number; nudged: number; done: number }>;
}

/** owner.ts */
export interface Owner {
  press: FollowupsDoor["press"];
  open: () => Promise<Loop[]>;
  command: FollowupsDoor["command"];
  context: FollowupsDoor["context"];
  closeByWords: NonNullable<FollowupsDoor["closeByWords"]>;
  calendarChanged: NonNullable<FollowupsDoor["calendarChanged"]>;
  forDraft: NonNullable<FollowupsDoor["forDraft"]>;
  draftFacts: NonNullable<FollowupsDoor["draftFacts"]>;
  reopenClosed: NonNullable<FollowupsDoor["reopenClosed"]>;
  snoozeCard: NonNullable<FollowupsDoor["snoozeCard"]>;
  parked: NonNullable<FollowupsDoor["parked"]>;
  parkedText: NonNullable<FollowupsDoor["parkedText"]>;
  unpark: NonNullable<FollowupsDoor["unpark"]>;
  closedForYou: NonNullable<FollowupsDoor["closedForYou"]>;
  reopenByWords: NonNullable<FollowupsDoor["reopenByWords"]>;
  setStep: (id: string, step: string) => Promise<boolean>;
  letGo: (id: string) => Promise<boolean>;
  engaged: (id: string) => Promise<boolean>;
  expiredParked: () => Promise<ParkedExpired[]>;
}

/** rehearse.ts */
export interface Rehearse {
  draft: (o: DraftInput) => Promise<{ job: Job; text: string }>;
  dryAnswer: (job: Job, raw: string) => Promise<DryOutcome | null>;
}

/** chase.ts (mounted last: no part needs it) */
export interface Chasing {
  chaseTick: () => Promise<number>;
  chaseWritten: NonNullable<FollowupsDoor["chaseWritten"]>;
  chasePressed: NonNullable<FollowupsDoor["chasePressed"]>;
  chaseNow: NonNullable<FollowupsDoor["chaseNow"]>;
}

/** Every part's names together: a part's needs are written as a Pick of this. */
export type Engine = Base & Store & Words & JobsPart & MailJobs & Matching & Checks & Nudges & Owner & Rehearse & MailLoops;
