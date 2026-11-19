// Changes to the people in the owner's life (src/people.ts), with the birthday reminder that goes with each person.

import type { Change } from "../undo.ts";
import {
  birthdayOf, birthdayReminder, birthdayReminderText, peopleWords, quotePerson, PEOPLE_MAX, type EditOutcome as PersonEdit, type Person,
  type PersonInput, type PersonPatch,
} from "../people.ts";
import type { Fact } from "../memory-facts.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const logPeople = createLog("people");
const logFacts = createLog("facts");

export function mountPeopleChanges(door: Door): Pick<Door, "pw" | "contactLink" | "keepPeople" | "editPerson" | "forgetPerson"> {
  const { d, now, lang, people, facts, idGraph, note, sendText, addReminder, removeReminderById } = door;
  // ---------- the people in the owner's life (src/people.ts): kept from the owner's own words, each change told with Undo ----------

  const pw = (): ReturnType<typeof peopleWords> => peopleWords(lang());
  /** A wa.me link for someone who is one of the owner's contacts (by the same name): for the owner only, never in the assistant's context. */
  const contactLink = (name: string): string | undefined => {
    const digits = d.contactByName?.(name)?.number.replace(/\D/g, "");
    return digits ? `https://wa.me/${digits}` : undefined;
  };
  /**
   * Keeps a person's one yearly birthday reminder in step with the record: a new or changed birthday (or name or relation: its words say
   * them) removes the old reminder and sets the new one; a birthday cleared removes it; one that could not be set before is set now. The
   * reminder changes go into `changes`; gives the record as it is now (with its reminder's id).
   */
  const syncBirthday = async (before: Person | null, after: Person, changes: Change[]): Promise<Person> => {
    const moved = !!before && (before.birthday !== after.birthday || before.name !== after.name || before.relation !== after.relation);
    if (!moved && (after.reminder || !after.birthday)) return after;
    let id: string | undefined;
    if (after.reminder) {
      const gone = await removeReminderById(after.reminder);
      if (gone) changes.push({ kind: "reminders-removed", reminders: [gone] });
    }
    if (after.birthday) {
      const first = birthdayReminder(after.birthday, now(), d.timeZone);
      const r = await addReminder(first.when, birthdayReminderText(after, lang()), "year", { anchor: first.anchor, birthday: true });
      if (r.added) {
        changes.push({ kind: "reminder-added", reminder: r.added });
        id = r.added.id;
      } else if (!r.ok) await sendText(r.say);
      else if (r.warn) await sendText(r.warn);
    }
    return (await people.link(after.id, id)) ?? { ...after, ...(id ? { reminder: id } : {}) };
  };
  /** The people a reply's <person> tags describe: each kept or merged by name, its birthday reminder set. Never throws. */
  const keepPeople = async (list: PersonInput[], changes: Change[]): Promise<void> => {
    try {
      for (const input of list) {
        if (input.birthday && !birthdayOf(input.birthday)) await sendText(pw()("badBirthday", { q: quotePerson(lang(), input.birthday, 20) }));
        const r = await people.upsert(input, now());
        if (r.status === "full") await sendText(pw()("full", { n: PEOPLE_MAX }));
        if (r.status !== "added" && r.status !== "changed" && r.status !== "same") continue;
        const before = r.status === "changed" ? r.before : r.status === "same" ? r.after : null;
        const reminders: Change[] = [];
        const after = await syncBirthday(before, r.after, reminders);
        if (r.status === "added") changes.push({ kind: "person-added", person: after });
        if (r.status === "changed") changes.push({ kind: "person-changed", before: r.before, after });
        changes.push(...reminders);
        if (r.status !== "same") d.control?.log("person", pw()(r.status === "added" ? "logAdded" : "logChanged", { name: after.name }));
      }
    } catch (err) {
      logPeople.error(`could not keep someone: ${(err as Error).message}`);
      await sendText(pw()("notChanged"));
    }
  };
  /** A correction (a command or the panel): the record, its birthday reminder, the log. A store that fails throws. */
  const editPerson = async (id: string, patch: PersonPatch, was: number | undefined, from: "chat" | "panel"):
    Promise<{ outcome: PersonEdit | { status: "bad" }; changes: Change[] }> => {
    if (patch.birthday && !birthdayOf(patch.birthday)) return { outcome: { status: "bad" }, changes: [] };
    const outcome = await people.edit(id, patch, now(), was);
    if (outcome.status !== "edited") return { outcome, changes: [] };
    const reminders: Change[] = [];
    const after = await syncBirthday(outcome.before, outcome.after, reminders);
    d.control?.log("person", pw()("logChanged", { name: after.name }) + (from === "panel" ? pw()("logPanel") : ""));
    return { outcome: { ...outcome, after }, changes: [{ kind: "person-changed", before: outcome.before, after }, ...reminders] };
  };
  /** Forgets someone, with their birthday reminder. A store that fails throws. */
  const forgetPerson = async (id: string, was: number | undefined, from: "chat" | "panel"): Promise<{ gone: Person | null | "changed"; changes: Change[] }> => {
    // The names the owner's facts about them may be under: the linked record's, with the old names a rename or a same-person yes left.
    const linked = await idGraph.read().then((g) => g.persons.find((x) => x.personId === id), () => undefined);
    const gone = await people.remove(id, was);
    if (!gone || gone === "changed") return { gone, changes: [] };
    const changes: Change[] = [{ kind: "person-removed", person: gone }];
    if (gone.reminder) {
      const r = await removeReminderById(gone.reminder);
      if (r) changes.push({ kind: "reminders-removed", reminders: [r] });
    }
    d.control?.log("person", pw()("logForgotten", { name: gone.name }) + (from === "panel" ? pw()("logPanel") : ""));
    note(pw()("contextForgotten", { name: gone.name }));
    // What the owner told about them goes too (their notes, relation and likes go with the record itself: src/memory-facts.ts).
    const told = await facts.forget([gone.name, ...(linked ? [linked.name, ...linked.aliases] : [])])
      .catch((err: Error) => (logFacts.error(`could not forget ${gone.name}'s facts: ${err.message}`), [] as Fact[]));
    if (told.length) changes.push({ kind: "facts-forgotten", facts: told });
    return { gone, changes };
  };

  return { pw, contactLink, keepPeople, editPerson, forgetPerson };
}
