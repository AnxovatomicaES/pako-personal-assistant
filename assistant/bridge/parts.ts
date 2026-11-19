// The bridge's shared context: what its parts read and change together (assistant/bridge.ts builds it, assistant/bridge/*.ts fill it in).
// Each part sees only the parts set up before it, in the order createBridge mounts them.

import type { BridgeDeps, Core } from "./core.ts";
import type { Runs } from "./runs.ts";
import type { Language } from "./language.ts";
import type { Mail } from "./mail.ts";
import type { Slack } from "./slack.ts";
import type { Meetings } from "./meetings.ts";
import type { Jobs } from "./jobs.ts";
import type { Papers } from "./papers.ts";
import type { Turn } from "./turn.ts";
import type { Tick } from "./tick.ts";

export type Base = { d: BridgeDeps };
export type AfterCore = Base & Core;
export type AfterRuns = AfterCore & Runs;
export type AfterLanguage = AfterRuns & Language;
export type AfterJobs = AfterLanguage & Mail & Slack & Meetings & Jobs & Papers;
export type AfterTurn = AfterJobs & Turn;
export type Bridge = AfterTurn & Tick;
