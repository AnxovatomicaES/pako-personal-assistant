// The people in the owner's life (src/people.ts) from the chat's commands and the panel: the same changes and receipts.

import { receiptText, type Change, type UndoEntry } from "../undo.ts";
import { findPerson, patchOf, peopleCommand, peopleText, personText, quotePerson, type PeopleCommand, type PeopleDoor, type Person } from "../people.ts";
import type { Door } from "./door.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const logUndo = createLog("undo");
const logPeople = createLog("people");

export function mountPeople(door: Door): Pick<Door, "peopleNow" | "peopleDoor"> {
  const { d, lang, tx, people, sendText, sendButton, journal, sendReceipt, pw, contactLink, editPerson, forgetPerson } = door;
  /** A change the owner made by command: its receipt goes now, as a card with Undo (a journal that could not keep it: as text). */
  const commandReceipt = async (changes: Change[]): Promise<void> => {
    const body = receiptText(changes, d.timeZone, lang());
    let entry: UndoEntry | null = null;
    try {
      entry = await journal.record(changes, { carded: true });
    } catch (err) {
      logUndo.error(`could not record a change: ${(err as Error).message}`);
    }
    if (!entry || !(await sendButton(body, `u1:${entry.id}`, tx("btnUndo")))) await sendText(entry ? pw()("typed", { body }) : body);
  };
  /**
   * PEOPLE, PERSON <name>, PERSON <name>: <field> <words>, FORGET PERSON <name>. Answered here at once (the Mac off too, and
   * while paused: they change only what Pako knows). Null when "PERSON <words>" names nobody: the message goes to the assistant.
   */
  const peopleNow = async (c: PeopleCommand): Promise<string | null> => {
    const l = lang();
    let list: Person[];
    try {
      list = await people.read(true);
    } catch (err) {
      logPeople.error(`could not read them: ${(err as Error).message}`);
      if (c.kind === "show") return null;
      await sendText(pw()("unread"));
      return "people not read";
    }
    if (c.kind === "list") {
      await sendText(peopleText(list, l));
      return "people shown";
    }
    const p = findPerson(list, c.name);
    if (c.kind === "show") {
      if (!p) return null;
      await sendText(personText(p, l, contactLink(p.name)));
      return "person shown";
    }
    if (!p) {
      await sendText(pw()("unknown", { q: quotePerson(l, c.name) }));
      return "no such person";
    }
    try {
      if (c.kind === "forget") {
        const { changes } = await forgetPerson(p.id, undefined, "chat");
        if (!changes.length) {
          await sendText(pw()("unknown", { q: quotePerson(l, c.name) }));
          return "no such person";
        }
        await commandReceipt(changes);
        return "person forgotten";
      }
      const { outcome, changes } = await editPerson(p.id, patchOf(c.field, c.text), undefined, "chat");
      if (outcome.status !== "edited") {
        const why = outcome.status === "bad" ? pw()("badBirthday", { q: quotePerson(l, c.text, 20) })
          : outcome.status === "duplicate" ? pw()("duplicate", { q: quotePerson(l, c.text), name: p.name })
          : outcome.status === "empty" ? pw()("empty")
          : outcome.status === "same" ? pw()("same", { name: p.name })
          : pw()("unknown", { q: quotePerson(l, c.name) });
        await sendText(why);
        return `person not edited (${outcome.status})`;
      }
      await commandReceipt(changes);
      return "person edited";
    } catch (err) {
      logPeople.error(`could not change someone: ${(err as Error).message}`);
      await sendText(pw()("notChanged"));
      return "person not changed";
    }
  };
  /** For the panel (src/people.ts mountPeoplePanel, a computer only): the same changes, their receipt sent to the chat with Undo. */
  const peopleDoor: PeopleDoor = {
    store: people,
    edit: async (id, patch, was) => {
      const { outcome, changes } = await editPerson(id, patch, was, "panel");
      if (changes.length) await sendReceipt(changes);
      return outcome;
    },
    forget: async (id, was) => {
      const { gone, changes } = await forgetPerson(id, was, "panel");
      if (changes.length) await sendReceipt(changes);
      return gone;
    },
    contactLink,
  };

  return { peopleNow, peopleDoor };
}

/** PEOPLE and the rest (src/people.ts): the same, at once; "PERSON <words>" that names nobody goes on to the assistant. */
export const onPeople: Handler = async (door, { text, command }) => {
  const peopleAsked = peopleCommand(text, command);
  const peopleDone = peopleAsked ? await door.peopleNow(peopleAsked) : null;
  if (peopleDone !== null) return peopleDone;
  return null;
};
