// Pako's figure without WebGL: the CSS twin of the orb (orb.js) for the other places of a page (the chat's header, the welcome, Settings,
// the brief's page), as one page has one WebGL context at most. The same blue orb with its two eyes, drawn with gradients (figure.css); the
// same state as the WebGL one (the page's machine, pako-figure.js), shown by data-state, so the CSS does all the motion on the compositor.
// Here: the blinks, the gaze (the pointer, the chat box), the moments (a new bounce or shake each time), and rest when out of view.

import { makeBlinker, pageFigure } from "./pako-figure.js";

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const twins = new Set();

// The gaze is shared: one listener for the page, each twin's eyes read it on the next frame.
const gaze = { x: 0, y: 0, field: null, raf: 0 };
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  const paint = () => {
    gaze.raf = 0;
    for (const t of twins) t.look();
  };
  const later = () => (gaze.raf ||= requestAnimationFrame(paint));
  addEventListener("pointermove", (e) => {
    if (gaze.field) return;
    gaze.x = e.clientX;
    gaze.y = e.clientY;
    later();
  }, { passive: true });
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.matches("textarea, input[type=text], input:not([type])")) return;
    gaze.field = el;
    // Where the box is once it has settled (the chat slides in as it opens): measured then, not on every frame.
    setTimeout(() => {
      if (gaze.field !== el) return;
      const r = el.getBoundingClientRect();
      gaze.x = r.left + r.width / 2;
      gaze.y = r.top + r.height / 2;
      for (const t of twins) t.measure();
      later();
    }, 380);
  });
  document.addEventListener("focusout", () => (gaze.field = null));
  addEventListener("resize", () => {
    for (const t of twins) t.measure();
  }, { passive: true });
  addEventListener("scroll", () => {
    for (const t of twins) t.measure();
  }, { passive: true, capture: true });
}

const PARTS = `<span class="pt-aura"></span><span class="pt-ring"></span>
<span class="pt-orbit pt-back"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
<span class="pt-core"><span class="pt-body"><span class="pt-flow"></span><span class="pt-swirl"></span><span class="pt-tint"></span>
<span class="pt-face"><i class="pt-eye"></i><i class="pt-eye"></i></span></span></span>
<span class="pt-orbit pt-front"><i></i><i></i><i></i><i></i></span><span class="pt-z"><b>z</b><b>z</b></span>`;

/** Turns `el` into a twin of the figure that follows `machine` (the page's by default). Returns the way to stop. */
export function mountTwin(el, { machine = pageFigure() } = {}) {
  if (el.classList.contains("pako-twin") && el.firstElementChild) return () => {};
  el.classList.add("pako-twin");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = PARTS;
  el.dataset.state = machine.state;
  wire();

  let rect = null;
  let shown = true;
  let moment = 0;
  const blinker = makeBlinker();
  const t0 = performance.now();
  let blinkTimer = 0;

  const twin = {
    measure: () => (rect = null),
    look() {
      if (!shown) return;
      rect ??= el.getBoundingClientRect();
      if (!rect.width) return;
      const span = Math.max(innerWidth, innerHeight) * 0.4;
      const x = Math.max(-1, Math.min(1, (gaze.x - (rect.left + rect.width / 2)) / span));
      const y = Math.max(-1, Math.min(1, (rect.top + rect.height / 2 - gaze.y) / span));
      el.style.setProperty("--lx", x.toFixed(3));
      el.style.setProperty("--ly", y.toFixed(3));
    },
  };
  twins.add(twin);

  // Blinks at the machine's random pace (makeBlinker): the class is on for the blink's 0.16 s.
  const blink = () => {
    clearTimeout(blinkTimer);
    if (reduce()) return;
    const now = (performance.now() - t0) / 1000;
    const wait = Math.max(0.05, blinker.at - now);
    blinkTimer = setTimeout(() => {
      if (shown && !document.hidden) {
        el.classList.add("blink");
        setTimeout(() => el.classList.remove("blink"), 170);
      }
      blinker.open(blinker.at + 0.2); // past this blink: the next one is drawn
      blink();
    }, wait * 1000);
  };
  blink();

  const stop = machine.subscribe((state) => {
    el.dataset.state = state;
    // A happy or an error moment again: the other of two equal animations, so it plays from the start without a reflow.
    if (state === "happy" || state === "error") el.dataset.moment = String((moment = (moment % 2) + 1));
  });

  // Out of view (a closed dialog, the chat closed, scrolled away): its animations rest.
  const io = new IntersectionObserver(([e]) => {
    shown = !!e?.isIntersecting;
    el.toggleAttribute("data-off", !shown);
    if (shown) (rect = null), twin.look();
  });
  io.observe(el);

  return () => {
    stop();
    io.disconnect();
    clearTimeout(blinkTimer);
    twins.delete(twin);
  };
}

/** Every element of `root` marked data-pako-twin becomes a twin. */
export function mountTwins(root = document) {
  for (const el of root.querySelectorAll("[data-pako-twin]")) mountTwin(el);
}
