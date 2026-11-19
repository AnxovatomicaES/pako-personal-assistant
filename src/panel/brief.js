// Pako · panel: the "Resumen de hoy" button. It asks the server for today's brief (POST /panel/api/brief, src/brief.ts) and shows it in a card
// at the top of the page, as text, never as HTML. Asking counts as today's brief: the morning's does not come again that day.
// Its words are English, like all of Pako's fixed texts.

const WORDS = { button: "Today's brief", title: "Today's brief", close: "Close the brief", loading: "Putting your brief together…", failed: "I couldn't get the brief. Try again.", full: "See the full brief →"
};
/** A text of this card. */
const t = (key) => WORDS[key] ?? key;
const paintIcons = () => window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const button = el("button", { class: "btn", id: "brief-open", type: "button" }, el("i", { "data-lucide": "sunrise" }), el("span", {}));
const card = el("section", { class: "card brief", id: "brief-card", "aria-labelledby": "h-brief", hidden: "" });
const title = el("span", {});
const close = el("button", { class: "icon-btn", id: "brief-close", type: "button" }, el("i", { "data-lucide": "x" }));
card.append(
  el("div", { class: "card-head" }, el("h2", { id: "h-brief" }, el("i", { "data-lucide": "sunrise" }), title), close),
  el("p", { class: "bubble-text", id: "brief-text", "aria-live": "polite" }),
  // The written brief's page (src/brief-v2.ts): the whole of today's, with its sources.
  el("p", {}, el("a", { href: "/panel/brief", id: "brief-full" }, "")),
);
const text = card.querySelector("#brief-text");

// On a phone the top bar has no room for the words beside the clock, the switch and the refresh button: the icon alone, named for readers.
const narrow = window.matchMedia("(max-width: 520px)");
function fit() {
  button.querySelector("span").hidden = narrow.matches;
}

function words() {
  button.querySelector("span").textContent = t("button");
  button.setAttribute("aria-label", t("button"));
  button.title = t("button");
  title.textContent = t("title");
  close.setAttribute("aria-label", t("close"));
  card.querySelector("#brief-full").textContent = t("full");
}

let asking = false;
async function ask() {
  if (asking) return;
  asking = true;
  button.disabled = true;
  card.hidden = false;
  text.textContent = t("loading");
  try {
    const r = await fetch("/panel/api/brief", { method: "POST", credentials: "same-origin", headers: { "x-pako": "1" } });
    if (r.status === 401) return void location.reload(); // the session ended: the sign-in page says what to do
    const body = r.ok ? await r.json() : null;
    text.textContent = typeof body?.text === "string" && body.text ? body.text : t("failed");
  } catch {
    text.textContent = t("failed");
  } finally {
    asking = false;
    button.disabled = false;
  }
}

function mount() {
  const actions = document.querySelector(".top-actions");
  const grid = document.querySelector("#grid");
  if (!actions || !grid) return;
  words();
  fit();
  narrow.addEventListener("change", fit);
  actions.insertBefore(button, document.querySelector("#pause"));
  // Under the compact brief at the top (app.js), the most prominent block; first when that block is not on the page.
  const top = document.querySelector("#brief-top");
  if (top) top.after(card);
  else grid.prepend(card);
  button.addEventListener("click", ask);
  close.addEventListener("click", () => {
    card.hidden = true;
    button.focus();
  });
  paintIcons();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
