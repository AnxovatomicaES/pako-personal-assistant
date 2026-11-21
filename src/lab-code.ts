// The labs' code (src/labs.ts LAB_FILES), loaded with import() before the app is built, and only for the labs that are on: the code of a
// lab that is off is never loaded. createApp is synchronous, so src/server.ts (and a test that turns a lab on) awaits loadLabCode first,
// and the wiring takes a lab's parts from labCode() inside that lab's gate.

import type { wireBooking } from "./app/booking.ts";
import type { registerBookingTools } from "./booking.ts";
import { LAB_IDS, type LabId, type Labs } from "./labs.ts";
import type { createRelayClient, loadRelayClientConfig } from "./relay-client.ts";
import type { createRelay, loadRelayConfig, mountRelay, telegramSender } from "./relay.ts";
import type { createTunnel, installCloudflared } from "./tunnel.ts";
import type { loadVoiceBridge } from "./voice-bridge.ts";
import type { createComputerWhatsapp } from "./whatsapp-computer.ts";

/** What core's wiring takes from each lab. */
export interface LabCode {
  booking: { wireBooking: typeof wireBooking; registerBookingTools: typeof registerBookingTools };
  calls: { loadVoiceBridge: typeof loadVoiceBridge };
  whatsapp: { createComputerWhatsapp: typeof createComputerWhatsapp; createTunnel: typeof createTunnel; installCloudflared: typeof installCloudflared };
  relay: {
    createRelay: typeof createRelay;
    loadRelayConfig: typeof loadRelayConfig;
    mountRelay: typeof mountRelay;
    telegramSender: typeof telegramSender;
    createRelayClient: typeof createRelayClient;
    loadRelayClientConfig: typeof loadRelayClientConfig;
  };
  /** A switch inside src/companion.ts: nothing to load. */
  companion: Record<string, never>;
}

const LOADERS: { [K in LabId]: () => Promise<LabCode[K]> } = {
  booking: async () => {
    const [{ wireBooking }, { registerBookingTools }] = await Promise.all([import("./app/booking.ts"), import("./booking.ts")]);
    return { wireBooking, registerBookingTools };
  },
  calls: async () => {
    const { loadVoiceBridge } = await import("./voice-bridge.ts");
    return { loadVoiceBridge };
  },
  whatsapp: async () => {
    const [{ createComputerWhatsapp }, { createTunnel, installCloudflared }] = await Promise.all([import("./whatsapp-computer.ts"), import("./tunnel.ts")]);
    return { createComputerWhatsapp, createTunnel, installCloudflared };
  },
  relay: async () => {
    const [relay, client] = await Promise.all([import("./relay.ts"), import("./relay-client.ts")]);
    const { createRelay, loadRelayConfig, mountRelay, telegramSender } = relay;
    return { createRelay, loadRelayConfig, mountRelay, telegramSender, createRelayClient: client.createRelayClient, loadRelayClientConfig: client.loadRelayClientConfig };
  },
  companion: async () => ({}),
};

const loaded: Partial<LabCode> = {};

/** Loads the code of the labs that are on (every lab without an argument, as a test that turns labs on does). A second load is free. */
export async function loadLabCode(on: Labs | readonly LabId[] = LAB_IDS): Promise<void> {
  const ids = "enabled" in on ? on.enabled() : on;
  await Promise.all(ids.map(async (id) => {
    if (!loaded[id]) Object.assign(loaded, { [id]: await LOADERS[id]() });
  }));
}

/** A lab's parts, for the wiring of a lab that is on. Throws when its code was not loaded first (an app built without loadLabCode). */
export function labCode<K extends LabId>(id: K): LabCode[K] {
  const code = loaded[id];
  if (!code) throw new Error(`the ${id} lab is on, but its code was not loaded: await loadLabCode() before createApp`);
  return code as LabCode[K];
}
