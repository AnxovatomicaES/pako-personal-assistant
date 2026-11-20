// The typed context the app's wiring passes along. Each module (src/app/*.ts) takes what the ones before it made, in the order src/app.ts
// and src/app/owner.ts compose them, so its dependencies are typed fields of one object rather than createApp's locals.

import type { AppConfig, Env, LocalContext, OwnedConfig } from "./config.ts";
import type { wireBase } from "./base.ts";
import type { wireCore } from "./core.ts";
import type { wireGuards } from "./guards.ts";
import type { wirePhone } from "./phone.ts";
import type { wireSources } from "./sources.ts";
import type { wireEngines } from "./engines.ts";
import type { wireBooking } from "./booking.ts";
import type { wireChat } from "./chat.ts";
import type { wireDoor } from "./door.ts";
import type { wirePanel } from "./panel.ts";
import type { wireCalendar } from "./calendar.ts";
import type { wireBrief } from "./brief.ts";

/** What createApp is given. */
export interface AppCtx {
  config: AppConfig;
  env: Env;
  local: LocalContext | undefined;
}

export type AfterBase = AppCtx & ReturnType<typeof wireBase>;
export type AfterGuards = AfterBase & ReturnType<typeof wireGuards>;
export type AfterCore = AfterGuards & ReturnType<typeof wireCore>;

/** The core once the phone line's settings are known to be right (src/app/owner.ts goes on only then). */
export type OwnedCore = Omit<AfterCore, "config"> & { config: OwnedConfig };
type Phone = ReturnType<typeof wirePhone>;
/** With the WhatsApp door's settings (a computer's stand-ins, or Meta's): everything in src/app/owner.ts is wired from here. */
export type OwnerCtx = OwnedCore & Omit<Phone, "wa"> & { wa: Phone["wa"] & { config: NonNullable<Phone["wa"]["config"]> } };

// The owner's part, module by module (src/app/owner.ts composes them in this order).
export type AfterSources = OwnerCtx & ReturnType<typeof wireSources>;
export type AfterEngines = AfterSources & ReturnType<typeof wireEngines>;
export type AfterBooking = AfterEngines & ReturnType<typeof wireBooking>;
export type AfterChat = AfterBooking & ReturnType<typeof wireChat>;
export type AfterDoor = AfterChat & ReturnType<typeof wireDoor>;
export type AfterPanel = AfterDoor & ReturnType<typeof wirePanel>;
export type AfterTelegram = AfterPanel;
export type AfterConnect = AfterTelegram;
export type AfterCalendar = AfterConnect & ReturnType<typeof wireCalendar>;
export type AfterBrief = AfterCalendar & ReturnType<typeof wireBrief>;
export type AfterSchedule = AfterBrief;
export type AfterMeetings = AfterSchedule;
export type AfterFollowups = AfterMeetings;
export type AfterProactive = AfterFollowups;
export type AfterMail = AfterProactive;
