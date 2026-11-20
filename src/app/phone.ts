// Wires the owner's phone line (src/personal-caller.ts) and reads the WhatsApp door's settings (stand-ins on a computer).

import { type Booking, type BookingRequest, registerBookingTools } from "../booking.ts";
import { LOCAL_OWNER_NUMBER } from "../local.ts";
import { createLog } from "../log.ts";
import { mountPersonalCaller } from "../personal-caller.ts";
import { type AskResult, loadWhatsappConfig, type OwnerAsk } from "../whatsapp.ts";
import type { OwnedCore } from "./context.ts";

const logWhatsapp = createLog("whatsapp");

export function wirePhone(ctx: OwnedCore) {
  const { app, config, env, local, uiLang, ownerZone, labs, adminLimiter, adminOnly, kv, control } = ctx;
  // The owner's phone line: off unless PERSONAL_CALLER_TOKEN is set (docs/personal-caller.md).
  // The connector's table-booking tools use the booking service and the WhatsApp door, which are built below: looked up when a request comes.
  const bookingRef: { booking: Booking | null; start: ((r: BookingRequest) => void) | null } = { booking: null, start: null };
  // The connector's friend calls wait for the owner's press on a card, which the WhatsApp door (built below) sends: looked up when a request comes.
  const askRef: { ask: ((a: OwnerAsk) => Promise<AskResult>) | null } = { ask: null };
  const personal = mountPersonalCaller(app, {
    config: config.personalCaller,
    // LABS: calls. Off: no Retell credentials (the line stays a dry run) and no LiveKit voice stack.
    retell: labs.on("calls") ? config.retell : { apiKey: "", fromNumber: "" },
    ...(labs.on("calls") ? {} : { voice: null }),
    adminOnly,
    adminLimiter,
    control,
    kv,
    lang: uiLang,
    quiet: !!local,
    askOwner: (a) => (askRef.ask ? askRef.ask(a) : Promise.resolve({ ok: false, why: "This server has no WhatsApp set up to send the card to." })),
    extraTools: (server) => {
      if (bookingRef.booking && bookingRef.start) registerBookingTools(server, bookingRef.booking, bookingRef.start, ownerZone);
    },
  });
  // The owner's WhatsApp door: off unless the three Meta values are set (assistant/README.md).
  // Local mode has no WhatsApp: the door runs with stand-in settings (nothing is ever sent to Meta) and the chat window of the panel is its screen.
  const wa = local
    ? {
        config: {
          accessToken: "local", phoneNumberId: "0", appSecret: local.panelSecret, verifyToken: local.panelSecret, bridgeToken: local.bridgeToken,
          ownerDigits: LOCAL_OWNER_NUMBER.replace(/\D/g, ""), ownerBsuid: "", graphVersion: "v23.0", templateName: "", templateLang: "en", friendMessages: false, reminderTemplate: "",
        },
        problems: [] as string[],
      }
    : loadWhatsappConfig(env, config.personalCaller.ownerNumber);
  if (wa.problems.length) logWhatsapp.error(`off, because: ${wa.problems.join("; ")}`);
  return { bookingRef, askRef, personal, wa };
}
