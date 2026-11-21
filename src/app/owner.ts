// Wires everything that hangs from the owner's settings, in order: the phone line, then (with the WhatsApp door's settings) what Pako
// reads, its engines, the door, the panel, the connections and the clocks. Each part is a module of src/app/ taking the parts before it.

import { labCode } from "../lab-code.ts";
import { createLog } from "../log.ts";
import { ownsLine } from "./config.ts";
import type { AfterCore, AfterEngines, OwnerCtx } from "./context.ts";
import { wirePhone } from "./phone.ts";
import { wireSources } from "./sources.ts";
import { wireEngines } from "./engines.ts";
import type { wireBooking } from "./booking.ts";
import { wireChat } from "./chat.ts";
import { wireDoor } from "./door.ts";
import { wirePanel } from "./panel.ts";
import { wireTelegram } from "./telegram.ts";
import { wireConnectPanels } from "./connect-panels.ts";
import { wireMobile } from "./mobile.ts";
import { wireCalendar } from "./calendar.ts";
import { wireBrief } from "./brief.ts";
import { wireSchedule } from "./schedule.ts";
import { wireMeetings } from "./meetings.ts";
import { wireFollowups } from "./followups.ts";
import { wireProactive } from "./proactive.ts";
import { wireMail } from "./mail.ts";

const logBooking = createLog("booking");
const logWhatsapp = createLog("whatsapp");

/** What wireBooking gives while the booking lab is off: no booking, and its code (src/app/booking.ts) not loaded. */
function bookingOff(ctx: AfterEngines): ReturnType<typeof wireBooking> {
  const { env } = ctx;
  if ((env.BOOKING ?? "").trim().toLowerCase() === "off" && (env.GOOGLE_PLACES_API_KEY ?? "").trim()) logBooking.info("OFF (BOOKING=off)");
  return { placesRef: { ok: false }, maitreRef: { deliver: null, remind: null, unremind: null, booking: null }, booking: null };
}

/**
 * Everything that hangs from the owner's settings, or null when they are off (no phone line settings, or no door): what the store guard
 * needs from the door, the panel's sign-in link, and Telegram's and Slack's handles for src/app/services.ts. Each step takes the context
 * of the steps before it; the order is the order these parts were always built in (later ones reach earlier ones through their refs).
 */
export function wireOwner(ctx: AfterCore) {
  if (!ownsLine(ctx.config)) {
    if ((ctx.env.WHATSAPP_ACCESS_TOKEN ?? "").trim()) {
      // Everything (WhatsApp, mail, Slack, the calendar, the panel) hangs from the owner's settings: one wrong or missing one turns it all off, and the log must say so.
      logWhatsapp.error(
        "off, because the personal caller is off: PERSONAL_CALLER_TOKEN, PERSONAL_OWNER_NAME and PERSONAL_OWNER_NUMBER must all be set and valid "
        + "(see the [personal-caller] line above).",
      );
    }
    return null;
  }
  const owned = { ...ctx, config: ctx.config };
  const phone = wirePhone(owned);
  // The owner's WhatsApp door: off without its settings (a computer always has its stand-ins), and with it everything below.
  if (!phone.wa.config) return null;
  const o: OwnerCtx = { ...owned, ...phone, wa: { ...phone.wa, config: phone.wa.config } };
  const sources = { ...o, ...wireSources(o) };
  const engines = { ...sources, ...wireEngines(sources) };
  // LABS: booking. Off: no Places, no Maître, no browser, and its code is not loaded (src/lab-code.ts).
  const booked = { ...engines, ...(engines.labs.on("booking") ? labCode("booking").wireBooking(engines) : bookingOff(engines)) };
  const chats = { ...booked, ...wireChat(booked) };
  const doored = { ...chats, ...wireDoor(chats) };
  const c = { ...doored, ...wirePanel(doored) };
  const { telegram } = wireTelegram(c);
  wireConnectPanels(c);
  // Pako on the owner's phone, on the same Wi-Fi (Settings › General): a computer only, and off until the owner turns it on.
  const { mobile, phoneLink } = wireMobile(c);
  // The door's late refs, now that it exists: the panel's window and Telegram reach it, Maître's news and reminders, the connector's
  // table booking and friend calls, and the chat's hello.
  const { local, bookingRef, askRef, maitreRef, booking, doorRef, door, hello, panelLink } = c;
  doorRef.ingest = door.ingest;
  doorRef.tell = door.tellBase;
  maitreRef.deliver = door.deliverBooking;
  maitreRef.remind = door.remindBooking;
  maitreRef.unremind = door.unremindBooking;
  doorRef.from = door.ownerFrom;
  // The hello right away, unless the panel's welcome is still to come (it asks for the name first).
  if (local && (!local.settings || local.settings.welcomed())) void hello();
  bookingRef.booking = booking;
  bookingRef.start = (r) => door.startBooking(r);
  askRef.ask = (a) => door.askCall(a);
  const connected = { ...c, mobile, phoneLink };
  const calendar = { ...connected, ...wireCalendar(connected) };
  const briefed = { ...calendar, ...wireBrief(calendar) };
  wireSchedule(briefed);
  const { slackSocket } = wireMeetings(briefed);
  wireFollowups(briefed);
  wireProactive(briefed);
  wireMail(briefed);
  const { tellOwner, tellAssistant, parts } = briefed;
  return { tellOwner, tellAssistant, parts, panelLink, telegram, slackSocket, mobile };
}
