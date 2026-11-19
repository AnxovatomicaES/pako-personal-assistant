// Pako · panel · mail. The dashboard's "Needs you" preview (the mail a reply, a decision, a task or a read is on the owner for, with Done and
// its Undo), the Mail section's category tabs with Move to…, the reader that opens a mail in the panel (with "Open in your mail app"), and the
// Mail settings (which categories notify, and the sender rules learned from Move to…). Its routes are in src/mail-panel.ts.
//
// An email is a stranger's text: everything from it is put on the page as text, never as HTML. The reader shows plain text (no image, no
// script, a link as words that are never loaded). Done and Move to… change Pako's own records only, never the owner's real mailbox.
// Its words are English only (the owner's decision).

const $ = (s, root = document) => root.querySelector(s);
const UNDO_MS = 8_000;

export const CATEGORIES = ["needs_you", "waiting", "important", "personal", "updates", "read_later", "promotions", "suspicious"];
export const LABEL = {
  needs_you: "Needs you",
  waiting: "Waiting on others",
  important: "Important",
  personal: "Personal",
  updates: "Updates",
  read_later: "Read later",
  promotions: "Promotions",
  suspicious: "Suspicious",
};
const ICON = {
  needs_you: "bell-ring", waiting: "hourglass", important: "star", personal: "heart", updates: "receipt", read_later: "book-open",
  promotions: "tag", suspicious: "shield-alert",
};
const TAG = { reply: "reply", decide: "decide", do: "do", read: "read" };

/** An element from a tag, attributes and children; text is always text. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (name) => h("i", { "data-lucide": name });
const paint = () => window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });

/** The display name of a From header: the name before the address, else the address. */
export const senderName = (from) => (from || "").replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || from || "—";

/** How long ago, short: "now", "5 min", "2 h", "yesterday", "3 days". */
export function age(at, now = Date.now()) {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h`;
  const d = Math.round(hrs / 24);
  return d === 1 ? "yesterday" : `${d} days`;
}
/** A due time in words: "overdue", "today 17:00", "Fri 20 Nov". */
export function dueWords(at, now = Date.now()) {
  if (at < now) return "overdue";
  const day = (t) => new Date(t).toDateString();
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(at);
  if (day(at) === day(now)) return `today ${time}`;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(at);
}

/** The tab counts: every category, 0 when none (the panel's tabs and the tests read it). */
export function tabCounts(items) {
  const n = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const m of items) if (Object.hasOwn(n, m.category)) n[m.category]++;
  return n;
}

/** The "Open in…" link the page may show: none without one, and an Apple Mail link only on a Mac (message: opens in Mail.app there). */
export const showLink = (link, ua = navigator.userAgent) => !!link && (!link.macOnly || /Macintosh|Mac OS X/.test(ua));

async function call(path, body) {
  const r = await fetch(path, body === undefined
    ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// `fed`: app.js gave the mail (a mailbox is connected); until then the Mail section is app.js's own ("not connected").
const st = { view: null, items: [], tab: "needs_you", hidden: new Set(), fed: false };

function toast(text, action) {
  let box = $("#mail-toast");
  if (!box) {
    box = h("div", { id: "mail-toast", class: "mail-toast", role: "status", "aria-live": "polite" });
    document.body.append(box);
  }
  box.replaceChildren(h("span", {}, text), action ? h("button", { type: "button", class: "btn-link", onclick: action.run }, action.label) : null);
  box.hidden = false;
  clearTimeout(box.timer);
  box.timer = setTimeout(() => (box.hidden = true), UNDO_MS);
}

// ---------- the "Needs you" preview ----------

function drawNeeds() {
  // The dashboard keeps a place for it under the tiles (#needs-you-mail, index.html): the block is a card of its own inside it.
  const mount = $("#needs-you-mail");
  if (!mount) return;
  const v = st.view;
  // Mail not connected: no block at all (the place stays empty, and the page hides an empty one).
  if (!v || !v.connected) {
    mount.replaceChildren();
    return;
  }
  let card = $("#needs-card", mount);
  if (!card) {
    card = h("section", { class: "card needs", id: "needs-card", "aria-label": "Mail that needs you" });
    mount.replaceChildren(card);
  }
  const rows = v.needs.rows.filter((r) => !st.hidden.has(r.id));
  const more = v.needs.more;
  if (!rows.length && !more) {
    card.classList.add("calm");
    card.replaceChildren(h("p", { class: "needs-calm" }, icon("inbox"), "Inbox: nothing needs you ✓"));
    paint();
    return;
  }
  card.classList.remove("calm");
  card.replaceChildren(
    h("div", { class: "card-head" }, h("h2", {}, icon("bell-ring"), h("span", {}, "Needs you"))),
    h("ul", { class: "list needs-list" }, ...rows.map((r) => h("li", { class: `item needs-row${r.overdue ? " overdue" : ""}` },
      h("button", { type: "button", class: "needs-open", onclick: () => openReader(r.id), "aria-label": `Open the mail from ${r.from}` },
        h("div", { class: "row" }, h("span", { class: "who" }, r.from), h("span", { class: `tag t-${r.tag}` }, TAG[r.tag] ?? r.tag),
          h("span", { class: "ago" }, age(r.at))),
        h("div", { class: "subj" }, r.subject || "(no subject)"),
        // Only the triage's own line: without one the subject is all there is.
        r.ask ? h("div", { class: "what" }, r.ask) : null,
        r.dueAt ? h("div", { class: `due${r.overdue ? " late" : ""}` }, icon("clock"), dueWords(r.dueAt)) : null),
      h("button", { type: "button", class: "btn done-btn", onclick: () => markDone(r.id), "aria-label": `Mark the mail from ${r.from} as done` }, icon("check"), "Done")))),
    more ? h("p", { class: "needs-more" }, h("a", { href: "#h-mail", onclick: () => pickTab("needs_you") }, `+${more} more · open Mail`)) : null,
  );
  paint();
}

async function markDone(id) {
  // Gone at once; Undo for a few seconds. Pako's records only: the real mailbox is never touched.
  st.hidden.add(id);
  drawNeeds();
  try {
    await call("/panel/api/mail/done", { id });
  } catch {
    st.hidden.delete(id);
    drawNeeds();
    toast("Couldn't mark it done right now");
    return;
  }
  toast("Marked done", {
    label: "Undo",
    run: async () => {
      $("#mail-toast").hidden = true;
      try {
        await call("/panel/api/mail/undone", { id });
      } catch {
        toast("Couldn't undo it right now");
        return;
      }
      st.hidden.delete(id);
      await refreshView();
    },
  });
}

// ---------- the Mail section ----------

function pickTab(c) {
  st.tab = c;
  drawList();
}

function moveSelect(m) {
  const sel = h("select", { class: "move-to", "aria-label": `Move the mail from ${senderName(m.from)} to another category` },
    h("option", { value: "" }, "Move to…"),
    ...CATEGORIES.filter((c) => c !== m.category).map((c) => h("option", { value: c }, LABEL[c])));
  sel.addEventListener("click", (e) => e.stopPropagation());
  sel.addEventListener("change", async (e) => {
    e.stopPropagation();
    const to = sel.value;
    if (!to) return;
    try {
      await call("/panel/api/mail/move", { id: m.id, category: to });
      m.category = to;
      m.why = `You moved it to ${LABEL[to]}`;
      toast(`Moved to ${LABEL[to]}. Mail from ${senderName(m.from)} will go there from now on.`);
    } catch {
      toast("Couldn't move it right now");
    }
    drawList();
    void refreshView();
  });
  return sel;
}

/** The loop a mail made, as a short line: "Open loop: Approve the budget" or "Loop closed". */
function loopLine(id) {
  const l = st.view?.loops?.[id];
  if (!l) return null;
  return h("div", { class: `loop${l.open ? " open" : ""}` }, icon(l.open ? "circle-dot" : "circle-check"), l.open ? `Open loop: ${l.title}` : `Loop closed: ${l.title}`);
}

export function drawList() {
  const tabs = $("#mail-filter");
  const list = $("#mail-list");
  if (!tabs || !list || !st.fed) return;
  const n = tabCounts(st.items);
  tabs.replaceChildren(...CATEGORIES.map((c) => h("button", {
    type: "button", class: `chip${c === st.tab ? " on" : ""}`, role: "tab", "aria-selected": c === st.tab ? "true" : "false", onclick: () => pickTab(c),
  }, LABEL[c], h("b", { class: "count" }, String(n[c])))));
  const items = st.items.filter((m) => m.category === st.tab).slice(0, 40);
  if (!items.length) {
    list.replaceChildren(h("li", { class: "empty" }, icon("inbox"), "Nothing here."));
    paint();
    return;
  }
  list.replaceChildren(...items.map((m) => h("li", {
    class: `item k-${m.category}${m.category === "suspicious" ? " scam" : ""}`, tabindex: "0", role: "button",
    onclick: () => openReader(m.id), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openReader(m.id)),
  },
    h("span", { class: "ic" }, icon(ICON[m.category] ?? "mail")),
    h("div", { class: "body" },
      h("div", { class: "row" }, h("span", { class: "who" }, senderName(m.from), m.account === "trabajo" ? h("span", { class: "tag" }, "Work") : null),
        h("span", { class: "ago" }, age(m.at))),
      m.subject ? h("div", { class: "subj" }, m.subject) : null,
      m.why ? h("div", { class: "why" }, m.why) : (m.summary || m.preview) ? h("div", { class: "what" }, m.summary || m.preview) : null,
      loopLine(m.id),
      h("div", { class: "acts-row" }, moveSelect(m))))));
  paint();
}

/** What app.js gives on each refresh: the mail (each with its category). */
export function setMail(items) {
  st.items = items ?? [];
  st.fed = true;
  drawList();
}

// ---------- the reader ----------

async function openReader(id) {
  let dlg = $("#mail-reader");
  if (!dlg) {
    dlg = h("dialog", { id: "mail-reader", class: "mail-reader", "aria-labelledby": "mail-reader-subject" });
    document.body.append(dlg);
  }
  dlg.replaceChildren(h("p", { class: "muted" }, "Opening…"));
  if (!dlg.open) dlg.showModal?.();
  let r;
  try {
    r = await call(`/panel/api/mail/item?id=${encodeURIComponent(id)}`);
  } catch {
    dlg.replaceChildren(h("p", {}, "This mail can't be opened right now."), h("button", { type: "button", class: "btn", onclick: () => dlg.close() }, "Close"));
    return;
  }
  const m = r.item;
  const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(m.at);
  const link = showLink(r.link) ? h("a", { class: "btn primary", href: r.link.url, target: "_blank", rel: "noopener noreferrer" }, icon("external-link"), r.link.label) : null;
  dlg.replaceChildren(
    h("header", { class: "reader-head" },
      h("h2", { id: "mail-reader-subject" }, m.subject || "(no subject)"),
      h("button", { type: "button", class: "icon-btn", onclick: () => dlg.close(), "aria-label": "Close" }, icon("x"))),
    h("p", { class: "reader-meta" }, h("b", {}, m.from), " · ", when),
    h("p", { class: `reader-cat k-${m.category}` }, icon(ICON[m.category] ?? "mail"), LABEL[m.category], m.why ? ` · ${m.why}` : ""),
    ...(r.loops ?? []).map((l) => h("p", { class: `loop${l.open ? " open" : ""}` }, icon(l.open ? "circle-dot" : "circle-check"), l.open ? `Open loop: ${l.title}` : `Loop closed: ${l.title}`)),
    // Plain text only: the words are put on the page as text, so no image, script or link in them can load.
    h("pre", { class: "reader-text" }, r.text || "(no text)"),
    r.partial ? h("p", { class: "muted small" }, "Only a summary was kept for this older mail.") : null,
    h("div", { class: "reader-acts" }, link, moveSelect(m)),
  );
  paint();
  // Opening it counts as reading it: a "to read" mail leaves the preview.
  void refreshView();
}

// ---------- the Mail settings ----------

async function drawSettings(holder) {
  let s;
  try {
    s = await call("/panel/api/mail/settings");
  } catch {
    holder.replaceChildren(h("p", { class: "muted small" }, "The mail settings can't be read right now."));
    return;
  }
  const switches = s.keys.map((k) => {
    const box = h("input", { type: "checkbox", id: `mn-${k}` });
    box.checked = !!s.notify[k];
    box.addEventListener("change", async () => {
      try {
        await call("/panel/api/mail/notify", { key: k, on: box.checked });
      } catch {
        box.checked = !box.checked;
        toast("Couldn't change it right now");
      }
    });
    return h("li", {}, h("label", { for: `mn-${k}` }, box, " ", s.labels[k], s.defaults[k] ? h("span", { class: "muted small" }, " (on by default)") : null));
  });
  const rules = s.rules.length
    ? s.rules.slice().reverse().map((r) => h("li", {}, h("code", {}, r.from), ` → ${LABEL[r.category]} `,
        h("button", {
          type: "button", class: "btn-link", "aria-label": `Remove the rule for ${r.from}`,
          onclick: async () => {
            try {
              await call("/panel/api/mail/rule/delete", { from: r.from });
            } catch {
              toast("Couldn't remove it right now");
            }
            void drawSettings(holder);
          },
        }, "Remove")))
    : [h("li", { class: "muted small" }, "No rules yet. Move a mail to another category and its sender's next mail goes there.")];
  holder.replaceChildren(
    h("h3", {}, "Notify me at once for"),
    h("p", { class: "muted small" }, "VIP senders always notify. Waiting on others and Important come in the morning brief."),
    h("ul", { class: "mail-switches" }, ...switches),
    h("h3", {}, "Sender rules"),
    h("ul", { class: "mail-rules" }, ...rules),
  );
}

function mountSettings() {
  const det = $("#mail-settings");
  if (!det) return;
  const holder = $(".mail-settings-body", det);
  det.addEventListener("toggle", () => det.open && void drawSettings(holder));
}

// ---------- refresh ----------

async function refreshView() {
  try {
    st.view = await call("/panel/api/mail/view");
  } catch {
    st.view = null;
  }
  drawNeeds();
  drawList();
}

// app.js asks the block to draw itself on every refresh of the page (window.pakoRenderNeedsYou).
if (typeof window !== "undefined") window.pakoRenderNeedsYou = () => void refreshView();

if (typeof document !== "undefined" && document.getElementById("grid")) {
  mountSettings();
  void refreshView();
}
