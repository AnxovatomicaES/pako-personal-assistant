// Pako's figure: what it is doing now, as a small state machine, and the events of the page that move it. No drawing here: the WebGL figure
// (orb.js) and its CSS twins (figure-twin.js) both read the one machine of the page, so every place shows the same Pako at the same moment.
//
// The page says what happens with custom events on window, "pako:<name>" with an optional detail:
//   pako:typing   { on }      the owner writes in the chat (listening); on: false when the box is empty again or loses the focus
//   pako:sent                 a message left (thinking until the answer comes)
//   pako:waiting  { on }      an answer is still due (thinking), as the chat's poll sees it
//   pako:answer   { length }  an answer arrived (speaking for a while, longer for a longer text)
//   pako:happy                something worked: a connection, a task done (a bounce and a ring of light)
//   pako:error                something failed (a short shake, amber)
//   pako:paused   { on }      Pako is paused (the slow red)
//   pako:quiet    { on }      the owner's quiet hours (sleeping)

export const STATES = ["idle", "listening", "thinking", "speaking", "happy", "sleeping", "paused", "error"];
export const EVENTS = ["typing", "sent", "waiting", "answer", "happy", "error", "paused", "quiet"];

/** How long a moment lasts (ms): a happy bounce, an error's shake, and speaking for a text of `length` characters (1.6 s to 6 s). */
export const HAPPY_MS = 1800;
export const ERROR_MS = 1400;
export const speakFor = (length) => Math.round(Math.min(6000, Math.max(1600, 1200 + (Number(length) || 0) * 18)));

/**
 * How each state looks, for both renderers. open: how open the eyes are (1 normal); squint: 1 for the happy arcs; look: where the eyes go
 * (x, y in -1..1, added to the gaze); glow: the rim's strength; swirl: the inner swirl; gather: the particles' orbit (1 normal, smaller is
 * closer); orbit: how fast they go round; amp/speed: the surface's breathing; dim: the brightness; lean: how much it leans to the gaze;
 * rest: 1 for eyes closed in calm arcs (asleep, paused); shade: how much the face's place darkens so the eyes read (low for the warm
 * colours, where a dark patch reads as a mask); colors: the shader's three colours (deep, rim, highlight).
 */
export const LOOKS = {
  idle: { open: 1, squint: 0, look: [0, 0], glow: 1, swirl: 0, gather: 1, orbit: 0.25, amp: 0.085, speed: 0.28, dim: 1, lean: 0.25,
    colors: ["#5b46ff", "#29c4ff", "#4ff2b0"] },
  listening: { open: 1.18, squint: 0, look: [0, 0], glow: 1.25, swirl: 0, gather: 0.82, orbit: 0.45, amp: 0.07, speed: 0.34, dim: 1.05, lean: 1,
    colors: ["#4a4bff", "#36d2ff", "#7ff7d0"] },
  thinking: { open: 0.92, squint: 0, look: [0.15, 0.85], glow: 1.15, swirl: 1, gather: 0.95, orbit: 1.1, amp: 0.11, speed: 0.5, dim: 1, lean: 0,
    colors: ["#3f36ff", "#5aa8ff", "#a98bff"] },
  speaking: { open: 1, squint: 0.15, look: [0, 0], glow: 1.3, swirl: 0.25, gather: 1, orbit: 0.5, amp: 0.1, speed: 0.42, dim: 1.08, lean: 0.4,
    colors: ["#5246ff", "#2fc8ff", "#6ff5c4"] },
  happy: { open: 1, squint: 1, look: [0, 0.1], glow: 1.6, swirl: 0, gather: 1.12, orbit: 0.8, amp: 0.1, speed: 0.4, dim: 1.15, lean: 0,
    colors: ["#5b46ff", "#39d0ff", "#8dffc9"] },
  sleeping: { open: 0, squint: 0, look: [0, -0.3], glow: 0.7, swirl: 0, gather: 1.08, orbit: 0.08, amp: 0.04, speed: 0.1, dim: 0.8, lean: 0, rest: 1,
    colors: ["#3036a8", "#4a86e8", "#6aa0f0"] },
  paused: { open: 1, squint: 0, look: [0, -0.2], glow: 0.85, swirl: 0, gather: 1, orbit: 0.06, amp: 0.035, speed: 0.1, dim: 1, lean: 0,
    rest: 1, shade: 0.12, colors: ["#c45b7a", "#ff9db0", "#ffd0b8"] },
  error: { open: 1.1, squint: 0, look: [0, 0], glow: 1.2, swirl: 0, gather: 1, orbit: 0.3, amp: 0.06, speed: 0.3, dim: 1, lean: 0,
    shade: 0.12, colors: ["#c8701c", "#ffb547", "#ffd27a"] },
};

/**
 * The machine. `now`: the clock (ms), given by the tests. What lasts (paused, quiet hours, typing, waiting) are flags; what passes (an answer
 * being said, a happy moment, an error) ends at a time. The state shown is the strongest of them: an error, then happy, then speaking, then
 * paused, thinking, listening, sleeping, and idle when nothing else holds.
 */
export function createFigure({ now = () => Date.now() } = {}) {
  const flags = { typing: false, waiting: false, paused: false, quiet: false };
  const until = { error: 0, happy: 0, speaking: 0 };
  const listeners = new Set();
  let state = "idle";
  let since = now();
  let moment = 0; // counts the happy and error moments, so a renderer starts a new ring or shake even when the state was already that one

  const pick = (t) => {
    if (until.error > t) return "error";
    if (until.happy > t) return "happy";
    if (until.speaking > t) return "speaking";
    if (flags.paused) return "paused";
    if (flags.waiting) return "thinking";
    if (flags.typing) return "listening";
    if (flags.quiet) return "sleeping";
    return "idle";
  };
  const settle = () => {
    const t = now();
    const next = pick(t);
    if (next !== state) {
      const from = state;
      state = next;
      since = t;
      for (const fn of listeners) fn(state, from);
    }
    return state;
  };
  const on = (detail) => (detail && typeof detail === "object" && "on" in detail ? detail.on !== false : true);

  /** Takes one event of the page (a name of EVENTS) and returns the state now. Unknown names change nothing. */
  const send = (name, detail) => {
    const t = now();
    switch (name) {
      case "typing":
        flags.typing = on(detail);
        break;
      case "sent":
        flags.typing = false;
        flags.waiting = true;
        until.speaking = 0;
        break;
      case "waiting":
        flags.waiting = on(detail);
        break;
      case "answer":
        flags.waiting = false;
        until.speaking = t + speakFor(detail?.length);
        break;
      case "happy":
        until.happy = t + HAPPY_MS;
        until.error = 0;
        moment++;
        break;
      case "error":
        until.error = t + ERROR_MS;
        until.happy = 0;
        flags.waiting = false;
        moment++;
        break;
      case "paused":
        flags.paused = on(detail);
        break;
      case "quiet":
        flags.quiet = on(detail);
        break;
      default:
        return state;
    }
    if (state === pick(t) && (name === "happy" || name === "error")) for (const fn of listeners) fn(state, state); // a new moment, same state
    return settle();
  };

  /** When the next moment ends (ms from now), or 0 when nothing is due: the page wakes the machine then (tick). */
  const next = () => {
    const t = now();
    const due = Object.values(until).filter((u) => u > t);
    return due.length ? Math.min(...due) - t : 0;
  };

  return {
    send,
    tick: settle,
    next,
    get state() {
      return state;
    },
    /** Since when (ms, the machine's clock) the state is the one it is. */
    get since() {
      return since;
    },
    get moment() {
      return moment;
    },
    get flags() {
      return { ...flags };
    },
    /** fn(state, from) on every change (and on a new happy or error moment while already in it); returns the way to stop listening. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Listens on `target` (window) for the "pako:<name>" events and moves `machine`; ends each moment on time with `timers` (setTimeout and
 * clearTimeout, given by the tests). Returns the way to stop.
 */
export function wireFigure(machine, target, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }) {
  let timer = null;
  const arm = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    const ms = machine.next();
    if (ms > 0) timer = timers.set(() => (machine.tick(), arm()), ms + 5);
  };
  const handlers = EVENTS.map((name) => {
    const fn = (e) => {
      machine.send(name, e?.detail);
      arm();
    };
    target.addEventListener(`pako:${name}`, fn);
    return [name, fn];
  });
  return () => {
    for (const [name, fn] of handlers) target.removeEventListener(`pako:${name}`, fn);
    if (timer !== null) timers.clear(timer);
  };
}

/**
 * When the eyes blink: a blink every 2.5 to 6.5 s, now and then a double one. `rand`: Math.random, given by the tests. open(t) is how
 * open the eyes are at time t (s, rising): 1, down to 0 and back in 0.16 s.
 */
export function makeBlinker(rand = Math.random) {
  let at = 1.2 + rand() * 2;
  let doubled = false;
  const DUR = 0.16;
  return {
    open(t) {
      if (t > at + DUR) {
        doubled = !doubled && rand() < 0.18;
        at = doubled ? at + DUR + 0.12 : t + 2.5 + rand() * 4;
      }
      const k = (t - at) / DUR;
      if (k < 0 || k > 1) return 1;
      return Math.abs(1 - 2 * k) ** 1.5; // fast close, fast open
    },
    /** When the next blink starts (s). */
    get at() {
      return at;
    },
  };
}

/** Moves `cur` toward `to` by a rate (1/s) over dt (s), the same at any frame rate: never a jump. */
export const approach = (cur, to, rate, dt) => cur + (to - cur) * (1 - Math.exp(-rate * dt));

let shared = null;
/** The page's one machine, wired to window on first use (both renderers share it). */
export function pageFigure() {
  if (!shared) {
    shared = createFigure({ now: () => performance.now() });
    if (typeof window !== "undefined") wireFigure(shared, window);
  }
  return shared;
}

/** Says something happened, for any part of the page: tell("happy"), tell("paused", { on: true }). */
export const tell = (name, detail) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(`pako:${name}`, detail === undefined ? undefined : { detail }));
};
