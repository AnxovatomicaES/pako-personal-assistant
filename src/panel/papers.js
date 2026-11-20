// Pako · panel: a photo or a PDF put in the chat, on a person's computer only (the chat exists there: <html data-chat>). A paperclip beside the
// box picks one file; it goes to POST /panel/api/chat/paper (src/papers-panel.ts) as it is, and the chat shows "📎 name" and then Pako's
// summary like any answer. The server decides what the file is by its bytes: the checks here only save a pointless upload. Everything the
// server sends is put on the page as text, never as HTML.

const WORDS = {
  attach: "Send a photo or a PDF",
  sending: "Sending the file…",
  type: "I only read photos (JPEG, PNG or WebP) and PDFs.",
  heic: "I can't read HEIC photos: send it as a JPEG or PDF.",
  big: "It's too big: photos up to 5 MB, PDFs up to 15 MB.",
  empty: "The file is empty.",
  failed: "I couldn't send the file. Try again.",
};

const t = (key) => WORDS[key] ?? key;
const PAPER_MAX = 15 * 1024 * 1024;
const IMAGE_MAX = 5 * 1024 * 1024;

/** The page's own toast (app.js keeps it in #toast): one line, gone after a moment. */
function say(text) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(say.timer);
  say.timer = setTimeout(() => el.classList.remove("show"), 3200);
}

let busy = false;

async function send(file, button) {
  if (busy || !file) return;
  // What can be told from here without sending it (the server checks again, by the bytes).
  if (/\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type)) return say(t("heic"));
  if (!file.size) return say(t("empty"));
  const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (file.size > (pdf ? PAPER_MAX : IMAGE_MAX)) return say(t("big"));
  busy = true;
  button.disabled = true;
  say(t("sending"));
  try {
    const r = await fetch("/panel/api/chat/paper", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-pako": "1", "content-type": "application/octet-stream", "x-pako-name": encodeURIComponent(file.name.slice(0, 120)) },
      body: file,
    });
    if (r.status === 401) return void location.reload(); // the session ended: the sign-in page says what to do
    if (r.ok) return; // the chat shows the file's line and, soon, Pako's answer
    const body = await r.json().catch(() => null);
    const why = typeof body?.error === "string" && Object.hasOwn(WORDS, body.error) ? body.error : "failed";
    say(t(why));
  } catch {
    /* offline: said */
    say(t("failed"));
  } finally {
    busy = false;
    button.disabled = false;
  }
}

function mount() {
  const form = document.querySelector("#chat-form");
  if (!form || !document.documentElement.hasAttribute("data-chat")) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp,application/pdf,.pdf,.jpg,.jpeg,.png,.webp";
  input.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn chat-attach";
  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", "paperclip");
  button.append(icon);
  const label = () => {
    button.setAttribute("aria-label", t("attach"));
    button.title = t("attach");
  };
  label();
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = ""; // the same file can be picked again
    void send(file, button);
  });
  form.prepend(input, button);
  window.lucide?.createIcons?.({ attrs: { "aria-hidden": "true" } });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
