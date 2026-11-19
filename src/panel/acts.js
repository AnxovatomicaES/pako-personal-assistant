// Pako · panel: "How Pako acts". One card for the two ways Pako acts on its own:
// - Autonomy (src/autonomy.ts, /panel/api/autonomy): when the owner asks in their own words, whether a message, an email or a call goes at
//   once with a few seconds to undo it, or a card asks first. One level for all three, and each one apart. Whatever is chosen, a card always
//   asks when the recipient or the words came from someone else's text, when two contacts match, and when Pako itself would start it.
// - On its own (src/proactive.ts, /panel/api/proactive): the topics Pako may suggest something about (each a chip: pressed is on; they cover
//   the habit nudges, the lessons and the birthdays too), what it learnt of the owner's tastes and plans (never health: only how many such
//   things it keeps), and the week's suggestions with what became of them. Off (PROACTIVE=off): the card says so.
// - What Pako learned from you (src/lessons.ts, /panel/api/lessons): each correction kept as a short dated lesson (Not mine, an undo, a 👎,
//   a draft changed before it was sent), how often it was taught, and a button that deletes one.
// Saved with the strict session cookie and the x-pako header, like STOP. Everything is put on the page as text, never as HTML.

import { localeFor } from "./i18n.js";

const WORDS = {
  title: "How Pako acts",
  auTitle: "When you ask",
  auLead: "When you ask in your own words, Pako does it and gives you a few seconds to undo it. If the recipient or the text come from an "
    + "email, Slack or the web, if two contacts match, or if it is money or deleting something, it always asks first.",
  level: "Autonomy level",
  lvDirect: "Do it, with a few seconds to undo",
  lvConfirm: "Always ask me first",
  lvMixed: "Custom (below)",
  message: "WhatsApp to your contacts",
  email: "Emails",
  call: "Calls with a message",
  direct: "Do it (with undo)",
  confirm: "Ask first",
  seconds: "Seconds to undo",
  def: "Default",
  saved: "Saved.",
  failed: "Couldn't save it right now.",
  lifeTitle: "On your own",
  lifeLead: "Topics I may bring up on my own (ideas, a habit, a quick review, a birthday): a few times a day in all, only when worth it, never "
    + "in your quiet hours, while we talk or in a meeting. I never write to anyone on my own. "
    + "Also on the chat: “don't talk to me about food”, “talk to me about travel”.",
  off: "It's off (PROACTIVE=off).",
  learnt: "What you told me", none: "Nothing yet: you'll tell me as we talk.",
  health: "I also keep {n} thing(s) about your health or mood, on this computer only. To delete them: “forget my health”.",
  week: "This week", noneSent: "No suggestions this week.",
  st_sent: "", st_accepted: "accepted", st_declined: "no, thanks", st_less: "topic off",
  trabajo: "Work", comida: "Food", viajes: "Travel", ocio: "Fun", deporte: "Sport", aficiones: "Hobbies", bienestar: "Wellbeing",
  aprendizaje: "Learning", amigos: "Friends", topicFailed: "I couldn't change it. Try again.",
  lessonsTitle: "What Pako learned from you",
  lessonsLead: "When you press Not mine, undo something, give a 👎 or change a draft before you send it, I keep a short lesson and follow it "
    + "next time: in the follow-ups I catch, the drafts I write and the brief. Delete any you don't want me to follow.",
  noLessons: "Nothing yet.",
  taught: "taught {n} times",
  k_not_mine: "Not mine", k_wrong: "Not useful", k_undo: "Undone", k_draft_edit: "Draft changed",
  draftWas: "My draft: {text}", draftSent: "You sent: {text}",
  forget: "Delete this lesson: {text}", forgotten: "Deleted.", forgetFailed: "I couldn't delete it. Try again.",
};
/** Dates written the way the owner's country writes English (i18n.js localeFor). */
const localeOf = () => localeFor(document.documentElement.dataset.region);
const t = (key, vars = {}) => String(WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** An element from a tag, attributes and children; text is always text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false && c !== "") el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const st = { autonomy: null, life: null, lessons: null, auNote: "", lifeNote: "", lessonsNote: "", card: null };

async function saveAutonomy(choices) {
  try {
    const r = await fetch("/panel/api/autonomy", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(choices),
    });
    if (!r.ok) throw new Error(String(r.status));
    st.autonomy = await r.json();
    st.auNote = t("saved");
  } catch {
    st.auNote = t("failed");
  }
  paint();
}

async function setTopic(topic, on) {
  try {
    const r = await fetch("/panel/api/proactive/topic", {
      method: "POST", credentials: "same-origin", headers: { "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify({ topic, on }),
    });
    st.lifeNote = r.ok ? "" : t("topicFailed");
  } catch {
    st.lifeNote = t("topicFailed");
  }
  await loadLife();
}

async function forgetLesson(id) {
  try {
    const r = await fetch("/panel/api/lessons/delete", {
      method: "POST", credentials: "same-origin", headers: { "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify({ id }),
    });
    st.lessonsNote = r.ok ? t("forgotten") : t("forgetFailed");
  } catch {
    st.lessonsNote = t("forgetFailed");
  }
  await loadLessons();
}

const day = (at) => new Intl.DateTimeFormat(localeOf(), { day: "2-digit", month: "2-digit" }).format(new Date(at));

function autonomyPart() {
  if (!st.autonomy) return [];
  const { types, choices, defaults } = st.autonomy;
  const modes = types.map((type) => choices.types[type] || defaults.mode);
  const level = modes.every((m) => m === "direct") ? "direct" : modes.every((m) => m === "confirm") ? "confirm" : "mixed";
  const pickLevel = h("select", {
    id: "acts-level",
    onchange: (e) => {
      const v = e.target.value;
      if (v !== "direct" && v !== "confirm") return;
      void saveAutonomy({ ...choices, types: Object.fromEntries(types.map((type) => [type, v])) });
    },
  },
  h("option", { value: "direct", selected: level === "direct" }, t("lvDirect")),
  h("option", { value: "confirm", selected: level === "confirm" }, t("lvConfirm")),
  h("option", { value: "mixed", selected: level === "mixed", disabled: level !== "mixed" }, t("lvMixed")));
  const rows = types.map((type) => {
    const mode = choices.types[type] ?? "";
    const secs = choices.seconds[type] ?? "";
    const pick = h("select", {
      id: `au-${type}`,
      onchange: (e) => void saveAutonomy({ ...choices, types: { ...choices.types, [type]: e.target.value || undefined } }),
    },
    h("option", { value: "", selected: !mode }, `${t("def")}: ${t(defaults.mode)}`),
    h("option", { value: "direct", selected: mode === "direct" }, t("direct")),
    h("option", { value: "confirm", selected: mode === "confirm" }, t("confirm")));
    const wait = h("input", {
      id: `au-${type}-s`, type: "number", min: "3", max: "120", step: "1", value: String(secs), placeholder: String(defaults.seconds),
      "aria-label": `${t(type)} · ${t("seconds")}`,
      onchange: (e) => {
        const n = Number(e.target.value);
        void saveAutonomy({ ...choices, seconds: { ...choices.seconds, [type]: Number.isInteger(n) && n >= 3 && n <= 120 ? n : undefined } });
      },
    });
    return h("div", { class: "tg-form" }, h("label", { for: `au-${type}` }, t(type)), pick, wait);
  });
  return [
    h("h3", { id: "h-acts-au" }, t("auTitle")),
    h("p", { class: "tg-lead" }, t("auLead")),
    h("div", { class: "tg-form" }, h("label", { for: "acts-level" }, t("level")), pickLevel),
    ...rows,
    st.auNote ? h("p", { class: "hint", role: "status" }, st.auNote) : "",
  ];
}

function lifePart() {
  if (!st.life) return [];
  const head = [h("h3", { id: "h-acts-life" }, t("lifeTitle")), h("p", { class: "muted" }, t("lifeLead"))];
  const v = st.life;
  if (!v.on) return [...head, h("p", { class: "muted" }, t("off"))];
  const chips = (Array.isArray(v.topics) ? v.topics : []).map((x) =>
    h("button", { class: `chip${x.on ? " on" : ""}`, type: "button", "aria-pressed": x.on ? "true" : "false", onclick: () => void setTopic(str(x.topic), !x.on) },
      t(str(x.topic))));
  const facts = Array.isArray(v.facts) ? v.facts : [];
  const sent = Array.isArray(v.sent) ? v.sent : [];
  return [
    ...head,
    h("div", { class: "chips" }, ...chips),
    st.lifeNote ? h("p", { role: "status" }, st.lifeNote) : "",
    h("h4", {}, t("learnt")),
    facts.length
      ? h("ul", {}, ...facts.slice(-20).reverse().map((f) => h("li", {}, `${str(f.kind)} · ${str(f.text)} `, h("span", { class: "muted" }, day(num(f.at))))))
      : h("p", { class: "muted" }, t("none")),
    num(v.health) ? h("p", { class: "muted" }, t("health", { n: num(v.health) })) : "",
    h("h4", {}, t("week")),
    sent.length
      ? h("ul", {}, ...sent.slice().reverse().map((x) => h("li", {}, `${day(num(x.at))} · ${t(str(x.topic))}: ${str(x.say)} `,
        t(`st_${str(x.status)}`) ? h("span", { class: "muted" }, `(${t(`st_${str(x.status)}`)})`) : "")))
      : h("p", { class: "muted" }, t("noneSent")),
  ];
}

function lessonsPart() {
  if (!st.lessons) return [];
  const list = Array.isArray(st.lessons.lessons) ? st.lessons.lessons : [];
  const head = [h("h3", { id: "h-acts-lessons" }, t("lessonsTitle")), h("p", { class: "muted" }, t("lessonsLead"))];
  if (!list.length) return [...head, h("p", { class: "muted" }, t("noLessons"))];
  const item = (x) => {
    const text = str(x.text);
    const kind = t(`k_${str(x.kind)}`);
    const n = num(x.count);
    const extra = [str(x.draft) ? t("draftWas", { text: str(x.draft).slice(0, 200) }) : "", str(x.sent) ? t("draftSent", { text: str(x.sent).slice(0, 200) }) : ""]
      .filter(Boolean);
    return h("li", { class: "lesson" },
      h("span", {}, `${day(num(x.last))} · ${kind}: ${text} `),
      n > 1 ? h("span", { class: "muted" }, `(${t("taught", { n })}) `) : "",
      ...extra.map((e) => h("div", { class: "muted small" }, e)),
      h("button", { class: "ic", type: "button", "aria-label": t("forget", { text }), onclick: () => void forgetLesson(str(x.id)) }, h("i", { "data-lucide": "x" })));
  };
  return [...head, h("ul", {}, ...list.slice(0, 60).map(item)), st.lessonsNote ? h("p", { role: "status" }, st.lessonsNote) : ""];
}

function paint() {
  if (!st.card || (!st.autonomy && !st.life && !st.lessons)) return;
  st.card.hidden = false;
  st.card.replaceChildren(
    h("div", { class: "card-head" }, h("h2", { id: "h-acts" }, h("i", { "data-lucide": "sparkles" }), h("span", {}, t("title")))),
    h("div", { "aria-live": "polite" },
      st.autonomy ? h("div", { class: "part" }, ...autonomyPart()) : "",
      st.life ? h("div", { class: "part" }, ...lifePart()) : "",
      st.lessons ? h("div", { class: "part" }, ...lessonsPart()) : ""),
  );
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

async function loadAutonomy() {
  try {
    const r = await fetch("/panel/api/autonomy", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) st.autonomy = await r.json();
  } catch {
    /* the server is restarting: the next load asks again */
  }
  paint();
}

async function loadLessons() {
  try {
    const r = await fetch("/panel/api/lessons", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) st.lessons = await r.json();
  } catch {
    /* the server is restarting: the next load asks again */
  }
  paint();
}

async function loadLife() {
  try {
    const r = await fetch("/panel/api/proactive", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) st.life = await r.json();
  } catch {
    /* the server is restarting: the next load asks again */
  }
  paint();
}

function mount() {
  // In Settings, its own tab ("How Pako acts"): every "may Pako do this by itself" choice in one place. Never on the dashboard.
  const slot = document.querySelector('[data-mount="acts"]');
  if (!slot) return;
  st.card = h("section", { class: "card acts", id: "acts-card", "aria-labelledby": "h-acts", hidden: true });
  slot.append(st.card);
  void loadAutonomy();
  void loadLife();
  void loadLessons();
  setInterval(() => void loadLife(), 5 * 60_000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
