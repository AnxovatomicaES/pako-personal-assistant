// Pako · panel: "How Pako acts". One card for the two ways Pako acts on its own:
// - Autonomy (src/autonomy.ts, /panel/api/autonomy): when the owner asks in their own words, whether a message, an email or a call goes at
//   once with a few seconds to undo it, or a card asks first. One level for all three, and each one apart. Whatever is chosen, a card always
//   asks when the recipient or the words came from someone else's text, when two contacts match, and when Pako itself would start it.
// - On its own (src/proactive.ts, /panel/api/proactive): the topics Pako may suggest something about (each a chip: pressed is on; they cover
//   the habit nudges, the lessons and the birthdays too), what it learnt of the owner's tastes and plans (never health: only how many such
//   things it keeps), and the week's suggestions with what became of them. Off (PROACTIVE=off): the card says so.
// - Gentle mode (src/gentle.ts, /panel/api/gentle): opt-in, with its not-medical line; the day's nudge cap, the time anchors' lead times, and
//   the Parked list, each with a button that brings it back.
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
  gentleTitle: "Gentle mode",
  gentleOn: "Gentle mode",
  gentleCap: "Nudges a day at most",
  gentleCapHint: "Standard mode allows {n}.",
  gentleLeadOnline: "Minutes before an online meeting (wrap up)",
  gentleLeadPlace: "Minutes before a meeting with a place (leave now)",
  gentleWhat: "When it's on: “did it happen?” with Done, Snooze or Park; wording that changes; no more nudges after two go unanswered "
    + "(the brief keeps it); a nudge to wrap up or leave before meetings; and a first tiny step for things that are stuck.",
  checkinTitle: "Check-ins",
  checkinLead: "Ask “check on me at 10:30” or “ping me in 20 min if I haven't started”, or press “Check on me” on a reminder. At that time I ask "
    + "“started?” with Yes, Not yet and Park. Never in your quiet hours or during a meeting. They work with Gentle mode off too.",
  checkinMin: "“Check on me” button: minutes",
  checkinAgain: "After “Not yet”, the next look in (minutes)",
  resetTitle: "Weekly reset",
  resetLead: "Once a week, up to three things that are slipping: pick one for the week and I'll park the rest. Never during a meeting.",
  resetDay: "Day",
  resetAt: "Time",
  wd0: "Sunday", wd1: "Monday", wd2: "Tuesday", wd3: "Wednesday", wd4: "Thursday", wd5: "Friday", wd6: "Saturday",
  historyTitle: "Let go from Parked",
  historyLine: "{title}{who}, let go on {day}",
  historyLineExpired: "{title}{who}, let go after 45 days on {day}",
  parkedTitle: "Parked",
  parkedLead: "Set aside: no nudges, never shown in red or as due. Bring one back whenever you like, or ask “what did I park?” in the chat. "
    + "After a month, the weekly reset asks once whether to bring it back or let it go.",
  parkedNone: "Nothing parked.",
  unpark: "Bring back",
  unparkLabel: "Bring back: {text}",
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

const st = { autonomy: null, life: null, lessons: null, gentle: null, auNote: "", lifeNote: "", lessonsNote: "", gentleNote: "", card: null };

async function saveGentle(change, path = "/panel/api/gentle") {
  try {
    const r = await fetch(path, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(change),
    });
    if (!r.ok && r.status !== 404) throw new Error(String(r.status));
    st.gentle = await r.json();
    st.gentleNote = t("saved");
  } catch {
    /* offline or refused: said in the note */
    st.gentleNote = t("failed");
  }
  paint();
}

async function saveAutonomy(choices) {
  try {
    const r = await fetch("/panel/api/autonomy", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(choices),
    });
    if (!r.ok) throw new Error(String(r.status));
    st.autonomy = await r.json();
    st.auNote = t("saved");
  } catch {
    /* offline or refused: said in the note */
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
    /* offline: said in the note */
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
    /* offline: said in the note */
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

function gentlePart() {
  if (!st.gentle?.settings) return [];
  const g = st.gentle.settings;
  const lim = st.gentle.limits ?? {};
  const range = (k) => (Array.isArray(lim[k]) ? lim[k] : [1, 120]);
  // `always`: a setting that applies with Gentle mode off too (the check-ins).
  const number = (id, key, label, always = false) => {
    const [min, max] = range(key);
    return h("div", { class: "tg-form" },
      h("label", { for: id }, label),
      h("input", {
        id, type: "number", min: String(min), max: String(max), step: "1", value: String(num(g[key])), disabled: !g.on && !always,
        onchange: (e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= min && n <= max) void saveGentle({ [key]: n });
        },
      }));
  };
  const parked = Array.isArray(st.gentle.parked) ? st.gentle.parked : [];
  const history = Array.isArray(st.gentle.history) ? st.gentle.history : [];
  return [
    h("h3", { id: "h-acts-gentle" }, t("gentleTitle")),
    h("p", { class: "tg-lead", id: "gentle-desc" }, str(st.gentle.description)),
    h("div", { class: "tg-form" },
      h("label", { for: "gentle-on" }, t("gentleOn")),
      h("input", {
        id: "gentle-on", type: "checkbox", role: "switch", checked: !!g.on, "aria-describedby": "gentle-desc",
        onchange: (e) => void saveGentle({ on: !!e.target.checked }),
      })),
    h("p", { class: "muted small" }, t("gentleWhat")),
    number("gentle-cap", "maxPerDay", t("gentleCap")),
    h("p", { class: "muted small" }, t("gentleCapHint", { n: num(st.gentle.standardMax) })),
    number("gentle-online", "leadOnlineMin", t("gentleLeadOnline")),
    number("gentle-place", "leadPlaceMin", t("gentleLeadPlace")),
    h("h4", { id: "h-acts-reset" }, t("resetTitle")),
    h("p", { class: "muted small" }, t("resetLead")),
    h("div", { class: "tg-form" },
      h("label", { for: "gentle-reset-day" }, t("resetDay")),
      h("select", {
        id: "gentle-reset-day", disabled: !g.on,
        onchange: (e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 0 && n <= 6) void saveGentle({ resetDay: n });
        },
      }, ...[1, 2, 3, 4, 5, 6, 0].map((n) => h("option", { value: String(n), selected: num(g.resetDay) === n }, t(`wd${n}`))))),
    h("div", { class: "tg-form" },
      h("label", { for: "gentle-reset-at" }, t("resetAt")),
      h("input", {
        id: "gentle-reset-at", type: "time", step: "60", disabled: !g.on,
        value: `${String(Math.floor(num(g.resetAt) / 60)).padStart(2, "0")}:${String(num(g.resetAt) % 60).padStart(2, "0")}`,
        onchange: (e) => {
          const m = /^(\d{2}):(\d{2})$/.exec(String(e.target.value));
          if (m) void saveGentle({ resetAt: Number(m[1]) * 60 + Number(m[2]) });
        },
      })),
    h("h4", { id: "h-acts-checkins" }, t("checkinTitle")),
    h("p", { class: "muted small" }, t("checkinLead")),
    number("gentle-checkin", "checkinMin", t("checkinMin"), true),
    number("gentle-checkin-again", "checkinAgainMin", t("checkinAgain"), true),
    st.gentleNote ? h("p", { class: "hint", role: "status" }, st.gentleNote) : "",
    h("h4", { id: "h-acts-parked" }, t("parkedTitle")),
    h("p", { class: "muted" }, t("parkedLead")),
    parked.length
      ? h("ul", { class: "parked" }, ...parked.slice(0, 40).map((x) => h("li", {},
        h("span", {}, `${str(x.title)}${str(x.who) ? ` (${str(x.who)})` : ""} `),
        h("span", { class: "muted" }, day(num(x.at))), " ",
        h("button", { class: "chip", type: "button", "aria-label": t("unparkLabel", { text: str(x.title) }),
          onclick: () => void saveGentle({ id: str(x.id) }, "/panel/api/gentle/unpark") }, t("unpark")))))
      : h("p", { class: "muted" }, t("parkedNone")),
    ...(history.length
      ? [h("h4", { id: "h-acts-letgo" }, t("historyTitle")),
        h("ul", { class: "parked" }, ...history.slice(0, 20).map((x) => h("li", { class: "muted" },
          t(x.why === "expired" ? "historyLineExpired" : "historyLine", { title: str(x.title), who: str(x.who) ? ` (${str(x.who)})` : "", day: day(num(x.at)) }))))]
      : []),
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
  if (!st.card || (!st.autonomy && !st.life && !st.lessons && !st.gentle)) return;
  st.card.hidden = false;
  st.card.replaceChildren(
    h("div", { class: "card-head" }, h("h2", { id: "h-acts" }, h("i", { "data-lucide": "sparkles" }), h("span", {}, t("title")))),
    h("div", { "aria-live": "polite" },
      st.autonomy ? h("div", { class: "part" }, ...autonomyPart()) : "",
      st.gentle ? h("div", { class: "part", id: "acts-gentle" }, ...gentlePart()) : "",
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

async function loadGentle() {
  try {
    const r = await fetch("/panel/api/gentle", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) st.gentle = await r.json();
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
  void loadGentle();
  void loadLife();
  void loadLessons();
  setInterval(() => void loadLife(), 5 * 60_000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
