// The follow-ups door as the server hands it out before the engine exists: each method goes to the engine once it is built, and answers
// "nothing" before. Every method of FollowupsDoor is listed here: one left out is one the chat never reaches (test/followups-door-proxy.test.ts
// checks the list against the engine).

import type { Followups } from "./engine.ts";
import type { FollowupsDoor } from "./types.ts";

/** The door's methods, as the proxy carries them. */
export const PROXIED = [
  "press", "command", "context", "result", "offer", "fromMail", "answered", "closeByWords", "calendarChanged", "reopenClosed", "fromChat", "dropFromChat",
  "forDraft", "draftFacts", "observeMail", "snoozeCard", "parked", "parkedText", "unpark",
] as const satisfies readonly (keyof FollowupsDoor)[];

export function followupsProxy(engine: () => Followups | null): FollowupsDoor & Required<Pick<FollowupsDoor, (typeof PROXIED)[number]>> {
  const e = engine;
  return {
    press: (b, id) => (e() ? e()!.press(b, id) : Promise.resolve("")),
    command: () => (e() ? e()!.command() : Promise.resolve("")),
    context: () => (e() ? e()!.context() : Promise.resolve([])),
    result: (id, raw) => (e() ? e()!.result(id, raw) : Promise.resolve({ ok: false, added: 0 })),
    offer: (o) => (e() ? e()!.offer(o) : Promise.resolve(false)),
    fromMail: (o) => (e() ? e()!.fromMail(o) : Promise.resolve(0)),
    answered: (o) => (e() ? e()!.answered(o) : Promise.resolve(0)),
    calendarChanged: (c) => (e() ? e()!.calendarChanged(c) : Promise.resolve(0)),
    closeByWords: (w) => (e() ? e()!.closeByWords(w) : Promise.resolve({ closed: [], none: [...w], many: [] })),
    reopenClosed: (l) => (e() ? e()!.reopenClosed(l) : Promise.resolve([])),
    fromChat: (o) => (e() ? e()!.fromChat(o) : Promise.resolve(null)),
    dropFromChat: (ids) => (e() ? e()!.dropFromChat(ids) : Promise.resolve([])),
    forDraft: (w) => (e() ? e()!.forDraft(w) : Promise.resolve({ none: true as const })),
    draftFacts: (l) => (e() ? e()!.draftFacts(l) : []),
    observeMail: (m, label) => (e() ? e()!.observeMail(m, label) : Promise.resolve(false)),
    snoozeCard: (id) => (e() ? e()!.snoozeCard(id) : Promise.resolve(null)),
    parked: () => (e() ? e()!.parked() : Promise.resolve([])),
    parkedText: () => (e() ? e()!.parkedText() : Promise.resolve("")),
    unpark: (w) => (e() ? e()!.unpark(w) : Promise.resolve({ ok: false, say: "" })),
  };
}
