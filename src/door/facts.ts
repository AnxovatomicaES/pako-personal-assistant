// Dated facts and people with identities (src/memory-facts.ts, src/people-graph.ts): the recall for the assistant, and "what do you know about…?".

import { fold } from "../lists.ts";
import { findPerson, peopleContext, type Person } from "../people.ts";
import { changesSince, currentAbout, ownAttribute, factLine, factWords, judgeText, CHANGES_DAYS, type Fact, type FactInput } from "../memory-facts.ts";
import { cardText, findIn, graphWords, personLabel, questionText, type GraphPerson } from "../people-graph.ts";
import { localToEpoch } from "./time.ts";
import type { Door } from "./door.ts";
import { whoCommand } from "../people-graph.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const logFacts = createLog("facts");
const logPeopleGraph = createLog("people-graph");

export function mountFacts(door: Door): Pick<Door, "withRecall" | "learnKnow" | "askSame" | "answerSame" | "whoNow"> {
  const { d, now, lang, inbox, people, facts, idGraph, graph, sendText } = door;
  // ---------- memory that knows time and people (src/memory-facts.ts, src/people-graph.ts) ----------

  const fw = () => factWords(lang());
  const gw = () => graphWords(lang());
  const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
  /**
   * The assistant's context, from the people's own: each person's record gets the told facts that hold now (the newest five), a person known
   * only by told facts gets a record of their own, and each trusted alias names the same record (the bridge gives a record when the message
   * names it). Then what changed in the last days and the owner's own told facts, and that <know> is kept here.
   */
  const withRecall = async (base: ReturnType<typeof peopleContext> | null): Promise<Record<string, unknown>> => {
    const l = lang();
    const [all, persons] = await Promise.all([facts.read(), idGraph.read().then((g) => g.persons, () => [] as GraphPerson[])]);
    const records = base ? base.peopleRecords.map((r) => ({ ...r })) : [];
    const groups = new Map<string, { names: string[]; told: Fact[] }>();
    for (const f of all) {
      if (f.validTo !== undefined || f.origin || !f.subject) continue;
      const p = findIn(persons, f.subject);
      const key = p ? p.id : fold(f.subject);
      const g = groups.get(key) ?? { names: p ? [p.name, ...p.aliases] : [f.subject], told: [] };
      g.told.push(f);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const lines = g.told.sort((a, b) => b.learnedAt - a.learnedAt).slice(0, 5).map((f) => factLine(f, l, d.timeZone));
      const add = `${fw()("recallNow")}: ${lines.join(" / ")}`;
      const r = records.find((x) => g.names.some((n) => fold(n) === fold(x.name)));
      if (r) r.text = clip(r.text ? `${r.text}; ${add}` : add, 1200);
      else records.push({ name: g.names[0]!, text: clip(add, 1200) });
    }
    for (const p of persons) {
      const r = records.find((x) => fold(x.name) === fold(p.name));
      if (!r) continue;
      for (const a of p.aliases) if (!records.some((x) => fold(x.name) === fold(a))) records.push({ name: a, text: clip(`${p.name}: ${r.text}`, 1200) });
    }
    const changes = changesSince(all, now() - CHANGES_DAYS * 24 * 3600_000, l, d.timeZone);
    const own = currentAbout(all, [""]).filter((f) => !f.origin).slice(0, 10).map((f) => factLine(f, l, d.timeZone));
    return {
      ...(base ?? {}),
      ...(records.length ? { peopleRecords: records } : {}),
      knowOn: 1,
      ...(changes.length ? { memoryChanges: changes } : {}),
      ...(own.length ? { memoryNow: own } : {}),
    };
  };
  /**
   * The <know> tags of an answer: dated facts the owner told. Never from a turn that read other people's text (dropped and logged, like
   * <fact>). Another value for the same subject and attribute goes to the isolated judge while the computer is there; without it the newest
   * wins at once.
   */
  const learnKnow = async (list: { who: string; key: string; value: string; since: string }[], outsideTurn: boolean): Promise<void> => {
    if (outsideTurn) {
      logFacts.info("dropped <know> from a turn that read outside text");
      d.control?.log("security", fw()("logOutside"));
      return;
    }
    const at = now();
    const inputs: FactInput[] = [];
    for (const k of list) {
      const self = !k.who || /^(me|i|myself|owner)$/i.test(k.who);
      const who = self ? "" : ((await idGraph.find(k.who).catch(() => undefined))?.name ?? k.who);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(k.since) ? localToEpoch(`${k.since} 00:00`, d.timeZone) : null;
      inputs.push({ subject: who, attribute: k.key, value: k.value, ...(from !== null ? { validFrom: from } : {}), source: { who: "owner", where: "chat", at } });
    }
    const r = await facts.add(inputs, at, { judge: at - door.lastPollAt < 3 * 60_000 });
    const t = fw();
    for (const f of r.added) d.control?.log("note", t("logKnow", { subject: f.subject || t("owner"), attribute: f.attribute, value: f.value }));
    for (const c of r.closed) {
      d.control?.log("note", t("logClosed", { subject: c.old.subject || t("owner"), attribute: c.old.attribute, old: c.old.value, new: c.by.value }));
    }
    for (const p of r.pending) {
      await inbox.add({ id: `jd:${p.fact.id}`, at, text: "", judge: { text: judgeText(p.fact, p.against, lang(), d.timeZone) } });
    }
  };
  /** When the brief last asked one (the brief asks at most one a day; a person's card asks about that person whenever it is shown). */
  door.sameAskedAt = 0;
  /** One "Is this the same person?" question as a card with Yes / No (`about`: only one about that record). False when none waits or it did not go. */
  const askSame = async (about?: string): Promise<boolean> => {
    const q = await idGraph.nextQuestion(now(), about).catch(() => null);
    if (!q) return false;
    const t = gw();
    const buttons = [{ id: `n1:${q.q.id}`, title: t("yes") }, { id: `n0:${q.q.id}`, title: t("no") }];
    return graph({
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: questionText(q.a, q.b, lang()).slice(0, 1000) },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    });
  };
  /** The owner's press on a same-person question. */
  const answerSame = async (id: string, yes: boolean): Promise<string> => {
    const r = await idGraph.answer(id, yes, now()).catch((err: Error) => (logPeopleGraph.error(`${err.message}`), null));
    if (!r) return gw()("gone");
    const vars = { a: r.a.name, b: personLabel(r.b, lang()) };
    d.control?.log("person", gw()(yes ? "merged" : "kept", vars));
    return gw()(yes ? "merged" : "kept", vars);
  };
  /**
   * "what do you know about Rohan?": the person's card (names, identities, the facts that hold now, what changed, the last contacts), then a waiting
   * question about them. Null when nobody by that name is known: the message goes to the assistant.
   */
  const whoNow = async (name: string): Promise<string | null> => {
    let all: Fact[];
    let g: GraphPerson | undefined;
    let list: Person[];
    try {
      [all, g, list] = await Promise.all([facts.read(), idGraph.find(name), people.read(true)]);
    } catch (err) {
      logFacts.error(`could not read what Pako knows: ${(err as Error).message}`);
      return null;
    }
    // A record that is not one of the owner's people (only seen in mail or Slack) never borrows the relation of another person of that name.
    const own = g?.personId ? list.find((x) => x.id === g!.personId) : g ? undefined : findPerson(list, name);
    const names = g ? [g.name, ...g.aliases] : own ? [own.name] : [name];
    const holds = currentAbout(all, names).filter((f) => !(f.origin && ownAttribute(f) === "relation"));
    if (!g && !own && !holds.length) return null;
    const at = now();
    // Known only from told facts: the name as it was told ("Rohan"), not as the command was read ("rohan").
    const told = holds.find((f) => f.subject)?.subject;
    const person: GraphPerson = g ?? { id: "", name: own?.name ?? told ?? name, aliases: [], seen: [], identities: [], contacts: [], at, updated: at };
    const mine = all.filter((f) => names.some((n) => fold(n) === fold(f.subject)));
    await sendText(cardText(person, {
      facts: holds.map((f) => factLine(f, lang(), d.timeZone)),
      changes: changesSince(mine, at - CHANGES_DAYS * 24 * 3600_000, lang(), d.timeZone, 4),
      ...(own?.relation ? { relation: own.relation } : {}),
      lang: lang(),
      timeZone: d.timeZone,
    }));
    if (g) await askSame(g.id);
    return "person card shown";
  };

  return { withRecall, learnKnow, askSame, answerSame, whoNow };
}

/** "what do you know about Rohan?" (src/people-graph.ts): the person's card at once; someone Pako does not know goes on to the assistant. */
export const onWho: Handler = async (door, { command }) => {
  const whoAsked = whoCommand(command);
  const whoDone = whoAsked ? await door.whoNow(whoAsked) : null;
  if (whoDone !== null) return whoDone;
  return null;
};
