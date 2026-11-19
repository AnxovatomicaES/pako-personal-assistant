// Pako's figure (src/panel/pako-figure.js): the state machine that the WebGL orb and its CSS twins share, the page's "pako:<name>" events
// that move it, its blinks and its easing. The page's own module, as the browser runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Machine = {
  send: (name: string, detail?: unknown) => string;
  tick: () => string;
  next: () => number;
  readonly state: string;
  readonly moment: number;
  subscribe: (fn: (state: string, from: string) => void) => () => void;
};
type Figure = {
  STATES: string[];
  EVENTS: string[];
  LOOKS: Record<string, { open: number; squint: number; rest?: number; shade?: number; colors: string[] }>;
  HAPPY_MS: number;
  ERROR_MS: number;
  speakFor: (length: number) => number;
  createFigure: (o?: { now?: () => number }) => Machine;
  wireFigure: (m: Machine, target: EventTarget, timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void }) => () => void;
  makeBlinker: (rand?: () => number) => { open: (t: number) => number; readonly at: number };
  approach: (cur: number, to: number, rate: number, dt: number) => number;
};
const fig = (await import(new URL("../src/panel/pako-figure.js", import.meta.url).href)) as Figure;

function clock() {
  let t = 1000;
  return { now: () => t, go: (ms: number) => (t += ms) };
}

test("figure: every state has its look, and each look its three colours", () => {
  assert.deepEqual(Object.keys(fig.LOOKS).sort(), [...fig.STATES].sort());
  for (const [name, look] of Object.entries(fig.LOOKS)) {
    assert.equal(look.colors.length, 3, name);
    for (const c of look.colors) assert.match(c, /^#[0-9a-f]{6}$/, name);
  }
  assert.equal(fig.LOOKS.happy!.squint, 1, "happy eyes are arcs");
  assert.equal(fig.LOOKS.sleeping!.open, 0, "asleep, the eyes are closed");
});

test("figure: paused rests (eyes closed in calm arcs, a soft rose), and the warm states keep no dark mask around the eyes", () => {
  assert.equal(fig.LOOKS.paused!.rest, 1, "paused: eyes closed, never shrunk to dots");
  assert.equal(fig.LOOKS.sleeping!.rest, 1);
  for (const s of ["idle", "listening", "thinking", "speaking", "happy", "error"]) assert.ok(!fig.LOOKS[s]!.rest, s);
  for (const s of ["paused", "error"]) assert.ok((fig.LOOKS[s]!.shade ?? 0.3) <= 0.15, s);
  // The deep colour of paused is a light rose, not a dark crimson: its brightest channel is well above the old #7a1030.
  const deep = parseInt(fig.LOOKS.paused!.colors[0]!.slice(1, 3), 16);
  assert.ok(deep >= 0xa0, `paused deep red ${deep}`);
});

test("figure: a chat goes listening, thinking, speaking for a time that grows with the text, then idle", () => {
  const c = clock();
  const m = fig.createFigure({ now: c.now });
  assert.equal(m.state, "idle");
  assert.equal(m.send("typing", { on: true }), "listening");
  assert.equal(m.send("typing", { on: false }), "idle", "an empty box again: back to idle");
  m.send("typing", { on: true });
  assert.equal(m.send("sent"), "thinking", "sent: thinking, and no longer listening");
  assert.equal(m.send("waiting", { on: true }), "thinking");
  assert.equal(m.send("answer", { length: 100 }), "speaking");
  const said = fig.speakFor(100);
  assert.equal(m.next(), said);
  c.go(said - 1);
  assert.equal(m.tick(), "speaking");
  c.go(2);
  assert.equal(m.tick(), "idle");
  assert.equal(m.next(), 0, "nothing more is due");
  assert.ok(fig.speakFor(0) >= 1600 && fig.speakFor(1e6) <= 6000 && fig.speakFor(400) > fig.speakFor(50));
});

test("figure: the strongest state shows; what lasts comes back once a moment is over", () => {
  const c = clock();
  const m = fig.createFigure({ now: c.now });
  assert.equal(m.send("quiet", { on: true }), "sleeping");
  assert.equal(m.send("typing", { on: true }), "listening", "writing wakes it in the quiet hours");
  m.send("typing", { on: false });
  assert.equal(m.state, "sleeping");
  assert.equal(m.send("paused", { on: true }), "paused", "paused over asleep");
  assert.equal(m.send("happy"), "happy", "a happy moment shows even when paused");
  c.go(fig.HAPPY_MS + 1);
  assert.equal(m.tick(), "paused");
  assert.equal(m.send("error"), "error");
  assert.equal(m.send("happy"), "happy", "a later success ends the error at once");
  m.send("error");
  c.go(fig.ERROR_MS + 1);
  assert.equal(m.tick(), "paused");
  m.send("paused", { on: false });
  m.send("quiet", { on: false });
  assert.equal(m.state, "idle");
  assert.equal(m.send("nonsense"), "idle", "an unknown event changes nothing");
  // An error ends the wait: no thinking forever after a send that failed.
  m.send("sent");
  m.send("error");
  c.go(fig.ERROR_MS + 1);
  assert.equal(m.tick(), "idle");
});

test("figure: listeners hear each change once, and a new happy moment while already happy (to start the ring again)", () => {
  const c = clock();
  const m = fig.createFigure({ now: c.now });
  const heard: string[] = [];
  const stop = m.subscribe((s, from) => heard.push(`${from}>${s}`));
  m.send("typing", { on: true });
  m.send("typing", { on: true });
  m.send("happy");
  const before = m.moment;
  m.send("happy");
  assert.equal(m.moment, before + 1);
  stop();
  m.send("error");
  assert.deepEqual(heard, ["idle>listening", "listening>happy", "happy>happy"]);
});

test("figure: the page's pako:<name> events move it, and a moment ends on its own timer", () => {
  const c = clock();
  const m = fig.createFigure({ now: c.now });
  const target = new EventTarget();
  const timers: { fn: () => void; ms: number }[] = [];
  const stop = fig.wireFigure(m, target, { set: (fn, ms) => timers.push({ fn, ms }) - 1, clear: (id) => void (timers[id as number] = { fn: () => {}, ms: -1 }) });
  for (const name of fig.EVENTS) assert.equal(typeof name, "string");
  target.dispatchEvent(new CustomEvent("pako:typing", { detail: { on: true } }));
  assert.equal(m.state, "listening");
  target.dispatchEvent(new CustomEvent("pako:happy"));
  assert.equal(m.state, "happy");
  const live = timers.filter((t) => t.ms >= 0);
  assert.equal(live.length, 1);
  assert.ok(live[0]!.ms >= fig.HAPPY_MS);
  c.go(fig.HAPPY_MS + 10);
  live[0]!.fn();
  assert.equal(m.state, "listening", "the happy moment is over: still listening");
  target.dispatchEvent(new CustomEvent("pako:paused", { detail: { on: true } }));
  assert.equal(m.state, "paused");
  target.dispatchEvent(new CustomEvent("pako:paused", { detail: { on: false } }));
  target.dispatchEvent(new CustomEvent("pako:quiet"));
  assert.equal(m.state, "listening", "no detail means on; listening still beats sleeping");
  stop();
  target.dispatchEvent(new CustomEvent("pako:error"));
  assert.equal(m.state, "listening", "after stop, nothing moves it");
});

test("figure: the eyes blink every 2.5 to 6.5 s, closing and opening within 0.16 s", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const b = fig.makeBlinker(rand);
  const closed: number[] = [];
  for (let t = 0; t < 120; t += 0.01) {
    const o = b.open(t);
    assert.ok(o >= 0 && o <= 1);
    if (o < 0.05) closed.push(Math.round(t * 100) / 100);
  }
  const blinks = closed.filter((t, i) => i === 0 || t - closed[i - 1]! > 0.05);
  assert.ok(blinks.length >= 120 / 6.8 && blinks.length <= 120 / 2.2, `${blinks.length} blinks in two minutes`);
  for (let i = 1; i < blinks.length; i++) {
    const gap = blinks[i]! - blinks[i - 1]!;
    assert.ok((gap > 0.15 && gap < 0.45) || (gap >= 2.4 && gap <= 6.8), `a gap of ${gap} s`);
  }
});

test("figure: easing is the same at any frame rate and never overshoots", () => {
  let a = 0;
  for (let i = 0; i < 60; i++) a = fig.approach(a, 1, 3, 1 / 60);
  let b = 0;
  for (let i = 0; i < 30; i++) b = fig.approach(b, 1, 3, 1 / 30);
  assert.ok(Math.abs(a - b) < 1e-9);
  assert.ok(a < 1 && a > 0.9);
  assert.equal(fig.approach(0.4, 0.4, 3, 0.1), 0.4);
});

test("figure: the page serves its files, and the orb, the twins and the brief's page use the one machine", () => {
  const dash = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
  for (const f of ["pako-figure.js", "figure-twin.js", "figure.css"]) assert.match(dash, new RegExp(`PAGES\\["${f.replace(".", "\\.")}"\\]`));
  const orb = readFileSync(new URL("../src/panel/orb.js", import.meta.url), "utf8");
  assert.match(orb, /from "\.\/pako-figure\.js"/);
  assert.match(orb, /Math\.min\(devicePixelRatio \|\| 1, 2\)/, "the pixel ratio is capped");
  assert.match(orb, /visibilitychange/);
  assert.match(orb, /IntersectionObserver/);
  const brief = readFileSync(new URL("../src/panel/brief-page.html", import.meta.url), "utf8");
  assert.match(brief, /data-pako-twin/);
  assert.match(brief, /figure\.css/);
  const page = readFileSync(new URL("../src/panel/index.html", import.meta.url), "utf8");
  assert.equal(page.match(/<canvas/g)?.length, 1, "one WebGL context on the panel");
  assert.ok((page.match(/data-pako-twin/g)?.length ?? 0) >= 3);
  const css = readFileSync(new URL("../src/panel/figure.css", import.meta.url), "utf8");
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-color-scheme: light/);
});
