// Lets the owner ring the assistant: an inbound SIP trunk for the Zadarma number and a dispatch rule that sends each call to the
// personal-caller agent. Run once (and again after a change) where the LiveKit project credentials are set:
//
//   node --env-file=<env file> scripts/setup-inbound.ts
//
// Environment: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (the project), SIP_NUMBER (the Zadarma number, +34...),
// PERSONAL_OWNER_NUMBER (the owner's mobile: only calls from it are let through), VOICE_INBOUND_PIN (optional, 4-8 digits: LiveKit asks
// for it on the keypad before the call reaches the assistant; without it the assistant can talk and look things up but cannot ring
// anyone for the owner, since caller ID can be faked), ZADARMA_SIP_CIDRS (optional, comma-separated: only these addresses may send calls).
//
// Then, in Zadarma, forward the number to <SIP_NUMBER>@<your LiveKit SIP host> (LiveKit Cloud: Settings, Telephony, "SIP URI").
// The main server's ask/inbound routes do the rest: a caller that is not the owner is refused there too.
//
// Each run deletes and recreates the trunk and rule it made before (found by name), so it is safe to run again.

import { RoomAgentDispatch, RoomConfiguration, SipClient } from "livekit-server-sdk";

const TRUNK = "owner-inbound";
const RULE = "owner-inbound";

const need = (k: string): string => {
  const v = (process.env[k] ?? "").trim();
  if (!v) {
    console.error(`${k} is missing`);
    process.exit(1);
  }
  return v;
};

const host = need("LIVEKIT_URL").replace(/^wss?:/, "https:");
const sip = new SipClient(host, need("LIVEKIT_API_KEY"), need("LIVEKIT_API_SECRET"));
const number = need("SIP_NUMBER");
const owner = need("PERSONAL_OWNER_NUMBER");
const pin = (process.env.VOICE_INBOUND_PIN ?? "").trim();
if (pin && !/^\d{4,8}$/.test(pin)) {
  console.error("VOICE_INBOUND_PIN must be 4 to 8 digits");
  process.exit(1);
}
const cidrs = (process.env.ZADARMA_SIP_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// Zadarma may send numbers with or without the "+": both forms are accepted. Check what arrives on a first call (LiveKit call logs).
const both = (n: string) => [n, n.replace(/^\+/, "")];

for (const r of await sip.listSipDispatchRule()) {
  if (r.name === RULE) {
    await sip.deleteSipDispatchRule(r.sipDispatchRuleId);
    console.log(`removed old dispatch rule ${r.sipDispatchRuleId}`);
  }
}
for (const t of await sip.listSipInboundTrunk()) {
  if (t.name === TRUNK) {
    await sip.deleteSipTrunk(t.sipTrunkId);
    console.log(`removed old inbound trunk ${t.sipTrunkId}`);
  }
}

const trunk = await sip.createSipInboundTrunk(TRUNK, both(number), {
  allowedNumbers: both(owner),
  ...(cidrs.length ? { allowedAddresses: cidrs } : {}),
  krispEnabled: true,
  ringingTimeout: 30,
});
console.log(`inbound trunk ${trunk.sipTrunkId} for ${number}, only from the owner's number`);

const rule = await sip.createSipDispatchRule(
  { type: "individual", roomPrefix: "owner-in-", ...(pin ? { pin } : {}) },
  {
    name: RULE,
    trunkIds: [trunk.sipTrunkId],
    // The caller's number must stay visible: the main server checks it is the owner's.
    hidePhoneNumber: false,
    roomConfig: new RoomConfiguration({
      emptyTimeout: 30,
      departureTimeout: 5,
      agents: [new RoomAgentDispatch({ agentName: "personal-caller", metadata: JSON.stringify({ mode: "inbound", pin: !!pin }) })],
    }),
  },
);
console.log(`dispatch rule ${rule.sipDispatchRuleId}${pin ? " with a keypad PIN" : " without a PIN (talk and look things up only)"}`);
console.log("Now forward the number in Zadarma to the LiveKit SIP URI (LiveKit Cloud: Settings, Telephony).");
