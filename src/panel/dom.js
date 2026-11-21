// Pako · panel: the few helpers every card and page shares, in one place. Before this, each of about twenty files kept its own copy, and
// the copies had drifted: some set a style string as an attribute (which the page's CSP blocks), some printed "null" for an empty child,
// some set `on…` functions as dead attributes, some wrote aria-expanded="false" and others dropped it. Nothing here touches `document` at
// load: the Node tests import modules that import this one.
import { localeFor } from "./i18n.js";

/**
 * An element from a tag, attributes and children. Text is always text (never HTML). `class` is the class name; `style` an object (custom
 * properties "--x" by setProperty) or a string (CSSOM, allowed by the CSP where a style attribute is not); `on…` a function is a listener;
 * an `aria-…` boolean is written "true" or "false"; any other false, null or undefined is left out, true is an empty attribute.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k.startsWith("aria-") && typeof v === "boolean") el.setAttribute(k, String(v));
    else if (v === false || v == null) continue;
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) p.startsWith("--") ? el.style.setProperty(p, String(x)) : (el.style[p] = x);
    else if (k === "style") el.style.cssText = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k.startsWith("on")) continue; // never an inline handler from a string
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/**
 * A card's words: t(key, vars) fills {name} from vars. A name vars does not have stays as it is, or, with `blank`, becomes nothing (the
 * cards that leave an optional part out that way).
 */
export function words(WORDS, o = {}) {
  return (key, vars) => {
    const s = String(WORDS[key] ?? key);
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : o.blank ? "" : m));
  };
}

/** Dates written the way the owner's country writes English (i18n.js localeFor). */
export const localeOf = () => localeFor(typeof document === "undefined" ? "" : document.documentElement.dataset.region);

/** A change sent to Pako, as every card sends one: the session cookie and the x-pako header (like STOP). */
export function post(path, body, method = "POST") {
  return fetch(path, {
    method, credentials: "same-origin", headers: { "content-type": "application/json", "x-pako": "1" }, body: JSON.stringify(body ?? {}),
  });
}

/**
 * After a change that restarts Pako: waits (a minute at most) until it answers again, having seen it go down or eight seconds having
 * passed. `reload` (the default) reloads the page then. Whether it came back.
 */
export async function waitForRestart({ reload = true } = {}) {
  const start = Date.now();
  let down = false;
  while (Date.now() - start < 60_000) {
    await new Promise((r) => setTimeout(r, 700));
    let up = false;
    try {
      up = (await fetch("/health", { cache: "no-store" })).ok;
    } catch {
      /* still restarting: asked again */
      up = false;
    }
    if (!up) down = true;
    else if (down || Date.now() - start > 8_000) {
      if (reload) location.reload();
      return true;
    }
  }
  return false;
}
