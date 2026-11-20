// Wires booking a table (src/booking.ts): Google Places, Maître in the browser, and the booking service itself (LABS: booking).

import { createHash } from "node:crypto";
import { type Booking, type BookingReply, createBooking } from "../booking.ts";
import { LOCAL_OWNER_NUMBER, pakoHome } from "../local.ts";
import { createLog } from "../log.ts";
import { sendEmail } from "../mail.ts";
import { loadMaitre } from "../maitre/index.ts";
import { RestaurantEngine } from "../restaurants/engine.ts";
import { GooglePlaces } from "../restaurants/places.ts";
import { PublicPageFetcher } from "../restaurants/website.ts";
import type { AfterEngines } from "./context.ts";

const logBooking = createLog("booking");

/** The store key that says this Places key has answered once (a hash of the key): src/data.ts "places-ok". */
const PLACES_OK_KEY = "places-ok";

export function wireBooking(ctx: AfterEngines) {
  const { config, env, local, uiLang, labs, kv, control, timeZone, ownerName, mail, imap, box } = ctx;
  const placesRef = { ok: false };
  // Booking a table (src/booking.ts, the original connector's restaurant engine): off unless GOOGLE_PLACES_API_KEY is set. It can write to a
  // restaurant only when the assistant's inbox is on, and only after the owner presses the card.
  // BOOKING=off turns it off while keeping the key (back on by removing it or setting on).
  const bookingOff = (env.BOOKING ?? "").trim().toLowerCase() === "off";
  // LABS: booking. Off: no Places, no Maître, no browser.
  const placesKey = bookingOff || !labs.on("booking") ? "" : (env.GOOGLE_PLACES_API_KEY ?? "").trim();
  // Whether this Places key has answered once (the settings page says "saved, not tried yet" until then): a mark in the store, by the key's
  // hash, so a new key starts unchecked again.
  const placesMark = placesKey ? createHash("sha256").update(placesKey).digest("hex").slice(0, 16) : "";
  if (placesKey && kv) void kv.get(PLACES_OK_KEY).then((v) => void (placesRef.ok = v === placesMark)).catch(() => undefined);
  const places = placesKey ? new GooglePlaces(placesKey) : null;
  if (places) {
    const search = places.searchText.bind(places);
    places.searchText = async (...a) => {
      const found = await search(...a);
      if (!placesRef.ok) {
        placesRef.ok = true;
        await kv?.set(PLACES_OK_KEY, placesMark, 400 * 24 * 3600).catch(() => undefined);
      }
      return found;
    };
  }
  // Maître (src/maitre/): on a computer with Chrome, Edge, Brave or Chromium, a restaurant on CoverManager, TheFork or OpenTable is booked on
  // its own page, with proof. Its later news (a Handoff that ended by itself) and the reminders go through the door, built below.
  const maitreRef: {
    deliver: ((r: BookingReply) => Promise<void>) | null;
    remind: ((when: string, text: string) => Promise<string | null>) | null;
    unremind: ((id: string) => Promise<void>) | null;
    booking: Booking | null;
  } = { deliver: null, remind: null, unremind: null, booking: null };
  const maitreSetup = places
    ? loadMaitre(env, {
        local: !!local,
        home: pakoHome(env),
        kv,
        ...(box ? { recentMail: () => box.items(60) } : {}),
        onHandoffEnd: async (end) => {
          const b = maitreRef.booking;
          if (b && maitreRef.deliver) await maitreRef.deliver(await b.handoffEnded(end)).catch((err: Error) => logBooking.error(`${err.message}`));
        },
      })
    : null;
  const booking: Booking | null = places
    ? createBooking({
        engine: Object.assign(new RestaurantEngine(places, new PublicPageFetcher()), { timeZone }),
        ...(mail.config ? { mail: { address: mail.config.inbox, send: (m: { to: string; subject: string; text: string }) => sendEmail(mail.config!, m) } } : {}),
        kv,
        control,
        get ownerName() {
          return ownerName();
        },
        // Local mode's stand-in number must never reach a restaurant: without a real one, the email gives no phone.
        ownerPhone: config.personalCaller.ownerNumber === LOCAL_OWNER_NUMBER ? "" : config.personalCaller.ownerNumber.replace(/\D/g, ""),
        timeZone,
        lang: uiLang,
        ...(maitreSetup?.maitre
          ? {
              maitre: maitreSetup.maitre,
              confirmFirst: maitreSetup.confirmFirst,
              // The engines' confirmations go to a mailbox Pako reads (the owner's, else its own inbox), so the ledger can find them.
              ...(imap.config?.user || mail.config?.inbox ? { guestEmail: (imap.config?.user || mail.config?.inbox)! } : {}),
              remind: (when: string, text: string) => maitreRef.remind?.(when, text) ?? Promise.resolve(null),
              unremind: (id: string) => maitreRef.unremind?.(id) ?? Promise.resolve(),
            }
          : {}),
      })
    : null;
  maitreRef.booking = booking;
  if (booking && maitreSetup) {
    const state = maitreSetup.maitre ? (booking.usesMaitre ? "ON" : "ready, but needs your full name, phone and a mailbox") : `off (${maitreSetup.why})`;
    logBooking.info(`Maître ${state}`);
  }
  if (bookingOff && (env.GOOGLE_PLACES_API_KEY ?? "").trim()) logBooking.info("OFF (BOOKING=off)");
  if (booking) logBooking.info(`ON: Google Places, ${mail.config ? "email requests from the assistant's inbox" : "links only (no inbox to write from)"}`);
  return { placesRef, maitreRef, booking };
}
