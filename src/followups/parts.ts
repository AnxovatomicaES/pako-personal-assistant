// The engine's shared context: what its parts read and call from one another (src/followups/engine.ts builds it, each part adds its names).

import type { Lang } from "../i18n.ts";
import type { Seen } from "./checks.ts";
import type {
  Batch, DraftInput, DryOutcome, FollowupsConfig, FollowupsDeps, FollowupsDoor, FollowupsState, Job, Loop, LoopSource, SlackSeen,
} from "./types.ts";

export interface Engine {
  readonly d: FollowupsDeps;
  readonly config: FollowupsConfig;
  readonly now: () => number;
  readonly lang: () => Lang;

  // store.ts
  mutate: <R>(fn: (s: FollowupsState) => R | Promise<R>) => Promise<R>;
  read: () => Promise<FollowupsState>;

  // words.ts
  stamp: (t: number, tz: string) => string;
  dueText: (l: Loop, lg: Lang) => string;
  sourceText: (s: LoopSource | undefined, lg: Lang) => string;
  nudgeText: (l: Loop, said: string, soon: boolean, lg: Lang) => string;

  // jobs.ts
  jobText: (job: Job, material: string[], people?: string[]) => Promise<string>;
  enqueueJob: (job: Job, material: string[], people?: string[]) => Promise<boolean>;
  slackJob: (b: Pick<Batch, "channel" | "thread" | "where" | "msgs">) => Promise<{ job: Job; material: string[]; people: string[] }>;
  flushBatch: (b: Batch) => Promise<boolean>;
  observeSlack: (m: SlackSeen) => Promise<void>;
  textJob: (o: { source: "mail" | "meeting"; ref: string; label: string; text: string; at?: number; people?: string[] }) => { job: Job; material: string[]; people: string[] };
  offer: FollowupsDoor["offer"];

  // mail-jobs.ts
  observeMail: NonNullable<FollowupsDoor["observeMail"]>;
  flushMailDue: (t: number) => Promise<number>;

  // matching.ts
  ruledOut: (s: FollowupsState, c: { who: string; title: string }, job: Job) => boolean;
  keep: (s: FollowupsState, job: Job, list: unknown[], max: number, trusted: boolean) => number;
  result: FollowupsDoor["result"];
  ingest: (o: { ref: string; label: string; at: number; loops: unknown[] }) => Promise<number>;

  // checks.ts
  runCheck: (l: Loop) => Promise<Seen>;

  // nudges.ts
  quietNow: (t: number) => boolean;
  nextAfter: (l: Loop, t: number) => number;
  tick: () => Promise<{ jobs: number; checked: number; nudged: number; done: number }>;

  // owner.ts
  press: FollowupsDoor["press"];
  open: () => Promise<Loop[]>;
  command: FollowupsDoor["command"];
  context: FollowupsDoor["context"];
  closeByWords: NonNullable<FollowupsDoor["closeByWords"]>;
  calendarChanged: NonNullable<FollowupsDoor["calendarChanged"]>;
  forDraft: NonNullable<FollowupsDoor["forDraft"]>;
  draftFacts: NonNullable<FollowupsDoor["draftFacts"]>;
  fromChat: NonNullable<FollowupsDoor["fromChat"]>;
  dropFromChat: NonNullable<FollowupsDoor["dropFromChat"]>;
  reopenClosed: NonNullable<FollowupsDoor["reopenClosed"]>;

  // rehearse.ts
  draft: (o: DraftInput) => Promise<{ job: Job; text: string }>;
  dryAnswer: (job: Job, raw: string) => Promise<DryOutcome | null>;
}
