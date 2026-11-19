// Pako's site · everything that moves on the page: the intro, smooth scrolling, the titles letter by letter, the pinned day, where Pako's
// figure sits and how it feels in each section, the cards that tilt, the buttons that follow the pointer, the STOP demo and the install tabs.

import { createScene } from "./scene.js";

const { gsap, ScrollTrigger, SplitText, Lenis } = window;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

document.documentElement.classList.add("js");
document.body.classList.add("loading");

// ---------- the scene ----------
const stage = createScene($("#stage"), { reduced });
const narrow = () => window.innerWidth < 900;

/** Where the figure sits in each section: [x, y, size] on a wide screen, and on a narrow one. */
const LAYOUTS = {
  hero: [[2.85, 0.15, 0.95], [0, 1.55, 0.72]],
  smart: [[4.6, 2.3, 0.34], [0, 2.7, 0.28]],
  statement: [[-4.4, 1.9, 0.42], [0, 2.6, 0.32]],
  day: [[-4.9, 2.35, 0.3], [0, 2.7, 0.28]],
  does: [[3.6, 1.6, 0.45], [0, 2.6, 0.35]],
  proactive: [[2.4, 0, 0.8], [0, 1.9, 0.5]],
  safety: [[4.7, 2.3, 0.32], [0, 2.7, 0.3]],
  mac: [[-4.8, 2.4, 0.32], [0, 2.8, 0.28]],
  how: [[4.9, -1.9, 0.3], [0, 2.8, 0.28]],
  install: [[-3.4, 0.4, 0.55], [0, 2.6, 0.35]],
  faq: [[3.6, -0.6, 0.5], [0, 2.7, 0.3]],
  final: [[0, 2.8, 0.58], [0, 2.6, 0.5]],
};
const place = (name) => {
  if (!stage) return;
  const l = LAYOUTS[name]?.[narrow() ? 1 : 0];
  if (l) stage.setLayout(...l);
};

// ---------- the intro ----------
function intro() {
  const loader = $(".loader");
  const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
  tl.to(".loader-bar i", { width: "100%", duration: reduced ? 0.2 : 1.1, ease: "power2.inOut" })
    .to(".loader-orb", { scale: 14, opacity: 0, duration: reduced ? 0.2 : 1.0, ease: "expo.in" }, "-=0.15")
    .to(loader, { opacity: 0, duration: 0.5, onComplete: () => { loader.remove(); document.body.classList.remove("loading"); } }, "-=0.35")
    .add(() => stage?.pulse(), "-=0.4");
  return tl;
}

// ---------- titles, letter by letter ----------
function splitTitles(tl) {
  // The hero's lines come in after the intro (they start hidden by the stylesheet, so fromTo, not from).
  tl.fromTo(".hero .reveal-up", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 1.1, stagger: 0.09, ease: "expo.out" }, reduced ? ">" : "-=0.3");
  if (!SplitText || reduced) return;
  const hero = SplitText.create(".hero-title .line", { type: "words,chars", wordsClass: "w", charsClass: "char" });
  gsap.set(".hero-title .line", { perspective: 600 });
  tl.from(hero.chars, { yPercent: 115, rotateX: -80, opacity: 0, duration: 1.2, stagger: 0.022, ease: "expo.out" }, "<-0.2");

  for (const el of $$(".split-words")) {
    const s = SplitText.create(el, { type: "words", wordsClass: "word" });
    gsap.from(s.words, {
      yPercent: 60, opacity: 0, filter: "blur(10px)", duration: 1.1, stagger: 0.06, ease: "expo.out",
      scrollTrigger: { trigger: el, start: "top 85%" },
    });
  }
  const fin = SplitText.create(".final-title .split", { type: "words,chars", wordsClass: "w", charsClass: "char" });
  gsap.from(fin.chars, {
    yPercent: 100, scale: 0.6, opacity: 0, duration: 1.3, stagger: 0.05, ease: "elastic.out(1, 0.6)",
    scrollTrigger: { trigger: ".final", start: "top 70%" },
  });
}

// ---------- smooth scroll ----------
function smooth() {
  // Phones and tablets keep their own scrolling: smooth scrolling on a touch screen fights the finger's momentum and feels sticky.
  if (reduced || !Lenis || !fine) return null;
  const lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 1, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  for (const a of $$('a[href^="#"]')) {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      const el = id === "#top" ? 0 : $(id);
      if (el === null) return;
      e.preventDefault();
      lenis.scrollTo(el, { offset: -20, duration: 1.6, easing: (x) => 1 - Math.pow(1 - x, 4) });
    });
  }
  return lenis;
}

// ---------- sections: where the figure goes, what it feels ----------
function sections() {
  const names = ["hero", "smart", "statement", "day", "does", "proactive", "safety", "mac", "how", "install", "faq", "final"];
  const els = names.map((n) => `section.${n}`); // section.: a class name alone (.mac) also matches a chip inside the bento
  const nodes = els.map((s) => $(s));
  let current = -1;
  /** The section under the middle of the screen (the last one whose top has passed it): one answer, whatever order the scroll came in. */
  const pick = () => {
    const mid = window.innerHeight * 0.55;
    let i = 0;
    nodes.forEach((el, j) => {
      if (el && el.getBoundingClientRect().top < mid) i = j;
    });
    if (i === current) return;
    current = i;
    place(names[i]);
    // The day sets its own moods as it goes; STOP holds the paused look.
    if (names[i] !== "day" && !document.body.classList.contains("paused")) stage?.setMood(nodes[i].dataset.mood || "idle");
    if (names[i] === "final" || names[i] === "statement" || names[i] === "mac") stage?.pulse();
  };
  ScrollTrigger.create({ start: 0, end: "max", onUpdate: (s) => {
    stage?.setScroll(s.progress);
    pick();
  } });
  window.addEventListener("resize", () => {
    current = -1;
    pick();
  });
  place("hero");
  stage?.setMood("listening");
  window.addEventListener("resize", () => ScrollTrigger.refresh());
}

// ---------- reveals ----------
function reveals() {
  for (const el of $$(".reveal-up")) {
    if (el.closest(".hero")) continue;
    gsap.to(el, { opacity: 1, y: 0, duration: 1.1, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 88%" } });
  }
  for (const el of $$(".reveal-scale")) {
    gsap.to(el, { opacity: 1, y: 0, scale: 1, duration: 1.4, ease: "expo.out", clearProps: "transform", scrollTrigger: { trigger: el, start: "top 85%" } });
  }
  // The bento tiles rise one after the other.
  gsap.from(".tile", { y: 80, opacity: 0, duration: 1.2, stagger: 0.08, ease: "expo.out", scrollTrigger: { trigger: ".bento", start: "top 80%" } });
  // Counters.
  for (const b of $$("[data-count]")) {
    const to = Number(b.dataset.count);
    const o = { v: 0 };
    gsap.to(o, { v: to, duration: 1.6, ease: "power3.out", scrollTrigger: { trigger: b, start: "top 85%" },
      onUpdate: () => (b.textContent = `${Math.round(o.v)}${b.dataset.suffix ?? ""}`) });
  }
  // The marquee leans with the scroll's speed.
  const track = $(".marquee-track");
  ScrollTrigger.create({ trigger: ".marquee", start: "top bottom", end: "bottom top",
    onUpdate: (s) => gsap.to(track, { skewX: gsap.utils.clamp(-8, 8, s.getVelocity() / -300), duration: 0.4, ease: "power3.out", overwrite: true }) });
}

// ---------- the day, pinned ----------
function day() {
  const steps = $$(".day-steps li");
  const msgs = $$(".msg");
  const times = ["08:00", "09:20", "11:20", "13:30", "17:45"];
  const labels = ["Morning brief", "Before a meeting", "A follow-up", "A calendar change", "A reminder"];
  const moods = ["speaking", "thinking", "thinking", "happy", "speaking"];
  const clock = $(".clock-time");
  const label = $(".clock-label");
  const status = $(".phone-status");
  let at = -1;
  const show = (i) => {
    if (i === at) return;
    at = i;
    steps.forEach((s, j) => s.classList.toggle("is-on", j === i));
    for (const m of msgs) {
      const on = Number(m.dataset.step) <= i;
      const shown = m.style.display !== "none";
      if (on && !shown) {
        // A bubble that arrives takes its place, then comes in: the chat stays pinned to its last message.
        gsap.set(m, { display: "block" });
        gsap.fromTo(m, { opacity: 0, y: 24, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: "back.out(1.6)", overwrite: true,
          delay: m.classList.contains("you") ? 0 : 0.12 });
      } else if (!on && shown) {
        gsap.to(m, { opacity: 0, y: 24, scale: 0.96, duration: 0.3, ease: "power2.in", overwrite: true, onComplete: () => gsap.set(m, { display: "none" }) });
      }
    }
    gsap.fromTo(clock, { yPercent: 40, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.6, ease: "expo.out" });
    clock.textContent = times[i];
    label.textContent = labels[i];
    status.textContent = "online";
    stage?.setMood(moods[i]);
    if (i === 2) stage?.pulse();
  };
  // 08:00 is the morning brief: the app's real page (brief/) in a browser window, read as you scroll; then the phone takes over.
  const dia = $(".dia");
  const frame = $(".dia iframe");
  /** The page is drawn at a width it was made for, then scaled into the window. */
  const fit = () => {
    const view = frame.parentElement;
    const w = view.clientWidth;
    const logical = w >= 520 ? 980 : 430;
    const k = w / logical;
    Object.assign(frame.style, { width: `${logical}px`, height: `${view.clientHeight / k}px`, transform: `scale(${k})` });
  };
  fit();
  window.addEventListener("resize", fit);
  const readBrief = (p) => {
    const doc = frame.contentDocument?.scrollingElement;
    if (!doc) return;
    doc.scrollTop = Math.max(0, doc.scrollHeight - doc.clientHeight) * gsap.utils.clamp(0, 1, p);
  };
  const BRIEF = 0.36; // the share of the pinned scroll that reads the brief
  let diaOn = null;
  const showDia = (on) => {
    if (on === diaOn) return;
    diaOn = on;
    dia.classList.toggle("live", on);
    gsap.to(dia, on
      ? { opacity: 1, xPercent: -50, yPercent: -50, x: 0, scale: 1, rotateY: 0, duration: 0.9, ease: "expo.out", overwrite: true, pointerEvents: "auto" }
      : { opacity: 0, xPercent: -50, yPercent: -50, x: 160, scale: 0.86, rotateY: -22, duration: 0.7, ease: "power3.in", overwrite: true, pointerEvents: "none" });
    gsap.to(".phone", { opacity: on ? 0.25 : 1, scale: on ? 0.94 : 1, duration: 0.7, ease: "expo.out" });
  };

  if (reduced) {
    show(4);
    gsap.set(dia, { display: "none" });
    return;
  }
  gsap.set(msgs, { opacity: 0, y: 24, scale: 0.96, display: "none" });
  gsap.set(dia, { xPercent: -50, yPercent: -50, x: 0, y: 0, top: "50%", left: "50%", transformPerspective: 1400 });
  show(0);
  showDia(true);
  // On a phone the pinned day is shorter (the same story in fewer thumb swipes), and the address bar hiding and showing does not make it
  // measure itself again mid-scroll (that is the jump people feel).
  const LEN = fine ? 3600 : 2200;
  if (!fine) ScrollTrigger.config({ ignoreMobileResize: true });
  ScrollTrigger.create({
    trigger: ".day", start: "top top", end: `+=${LEN}`, pin: ".day-pin", scrub: true, anticipatePin: 1,
    onUpdate: (s) => {
      const p = s.progress;
      const i = p < BRIEF ? 0 : Math.min(4, 1 + Math.floor(((p - BRIEF) / (1 - BRIEF)) * 4));
      show(i);
      showDia(i === 0);
      if (i === 0) readBrief(p / (BRIEF * 0.92));
      gsap.set(".day-progress i", { width: `${p * 100}%` });
    },
  });
  // The phone turns a little as the day goes by.
  gsap.fromTo(".phone", { rotateY: -18, rotateX: 8 }, { rotateY: 10, rotateX: -4, ease: "none",
    scrollTrigger: { trigger: ".day", start: "top top", end: `+=${LEN}`, scrub: 1 } });
}

// ---------- proactive: many moments, one spoken ----------
function moments() {
  const grid = $(".moments-grid");
  const dots = Array.from({ length: 144 }, () => grid.appendChild(document.createElement("i")));
  const one = 77;
  const tl = gsap.timeline({ scrollTrigger: { trigger: ".proactive", start: "top 65%" } });
  tl.from(dots, { scale: 0, opacity: 0, duration: 0.6, stagger: { each: 0.004, from: "center", grid: [12, 12] }, ease: "back.out(2)" })
    .to(dots.filter((_, i) => i !== one), { opacity: 0.25, duration: 0.8, stagger: { each: 0.003, from: one, grid: [12, 12] } }, "+=0.2")
    .add(() => dots[one].classList.add("lit"))
    .from(dots[one], { scale: 3, duration: 0.8, ease: "elastic.out(1, 0.4)" })
    .to(".moment-card", { opacity: 1, scale: 1, duration: 0.9, ease: "expo.out" }, "+=0.15");
}

// ---------- STOP ----------
function stopDemo() {
  const b = $(".stop-btn");
  const label = $(".stop-label");
  const cap = $(".stop-caption");
  const first = cap.textContent;
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    label.textContent = on ? "RESUME" : "STOP";
    document.body.classList.toggle("paused", on);
    stage?.setMood(on ? "paused" : "idle");
    cap.textContent = on ? "Paused. No call, no message goes out until you say RESUME. Your chat and reminders go on." : first;
    gsap.fromTo(b, { scale: 0.88 }, { scale: 1, duration: 0.8, ease: "elastic.out(1, 0.35)" });
    if (!on) stage?.pulse();
  });
}

// ---------- the Mac window's ring ----------
function ring() {
  const fg = $(".ring-fg");
  const n = $(".ring-n");
  const conns = $$(".conn");
  const total = 314.16;
  const o = { v: 0 };
  const tl = gsap.timeline({ scrollTrigger: { trigger: ".window", start: "top 70%" } });
  tl.from(conns, { x: 30, opacity: 0, duration: 0.7, stagger: 0.07, ease: "expo.out" })
    .to(o, { v: 5, duration: 1.8, ease: "power3.inOut", onUpdate: () => {
      fg.style.strokeDashoffset = String(total - (o.v / 7) * total);
      n.textContent = String(Math.round(o.v));
    } }, 0.2)
    .add(() => stage?.pulse());
}

// ---------- tilt, spotlight, magnetic, cursor ----------
function pointerToys() {
  if (!fine || reduced) return;
  for (const t of $$(".tilt, .tilt-soft")) {
    const max = t.classList.contains("tilt-soft") ? 4 : 9;
    const rx = gsap.quickTo(t, "rotationX", { duration: 0.6, ease: "power3.out" });
    const ry = gsap.quickTo(t, "rotationY", { duration: 0.6, ease: "power3.out" });
    gsap.set(t, { transformPerspective: 900 });
    t.addEventListener("pointermove", (e) => {
      const r = t.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      rx((0.5 - py) * max);
      ry((px - 0.5) * max);
      t.style.setProperty("--mx", `${px * 100}%`);
      t.style.setProperty("--my", `${py * 100}%`);
    });
    t.addEventListener("pointerleave", () => {
      rx(0);
      ry(0);
    });
  }
  for (const m of $$(".magnetic")) {
    m.addEventListener("pointermove", (e) => {
      const r = m.getBoundingClientRect();
      m.style.setProperty("--x", `${(e.clientX - r.left - r.width / 2) * 0.25}px`);
      m.style.setProperty("--y", `${(e.clientY - r.top - r.height / 2) * 0.35}px`);
    });
    m.addEventListener("pointerleave", () => {
      m.style.setProperty("--x", "0px");
      m.style.setProperty("--y", "0px");
    });
  }
  const glow = $(".cursor-glow");
  const gx = gsap.quickTo(glow, "x", { duration: 0.8, ease: "power3.out" });
  const gy = gsap.quickTo(glow, "y", { duration: 0.8, ease: "power3.out" });
  window.addEventListener("pointermove", (e) => {
    gx(e.clientX);
    gy(e.clientY);
  }, { passive: true });
}

// ---------- the nav hides going down, comes back going up ----------
function nav() {
  const n = $(".nav");
  let last = 0;
  ScrollTrigger.create({
    start: 0, end: "max",
    onUpdate: (s) => {
      const y = s.scroll();
      n.classList.toggle("hidden", y > 200 && y > last);
      last = y;
    },
  });
}

// ---------- install tabs and copy ----------
function tabs() {
  const tabsEl = $$('[role="tab"]');
  const ink = $(".tab-ink");
  const select = (t) => {
    for (const x of tabsEl) {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      const p = document.getElementById(x.getAttribute("aria-controls"));
      if (on && p.hidden) {
        p.hidden = false;
        gsap.from(p, { y: 16, opacity: 0, duration: 0.6, ease: "expo.out" });
      } else if (!on) p.hidden = true;
    }
    ink.style.width = `${t.offsetWidth}px`;
    ink.style.transform = `translateX(${t.offsetLeft - 5}px)`;
  };
  tabsEl.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = tabsEl[(i + (e.key === "ArrowRight" ? 1 : -1) + tabsEl.length) % tabsEl.length];
      n.focus();
      select(n);
    });
  });
  // The platform you are on comes first.
  const ua = navigator.userAgent;
  const start = /Windows/.test(ua) ? tabsEl[2] : /Linux/.test(ua) && !/Android/.test(ua) ? tabsEl[1] : tabsEl[0];
  requestAnimationFrame(() => select(start));
  window.addEventListener("resize", () => select(tabsEl.find((t) => t.getAttribute("aria-selected") === "true")));
  for (const b of $$(".copy")) {
    b.addEventListener("click", async () => {
      const text = b.previousElementSibling.textContent;
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
        b.classList.add("done");
      } catch {
        b.textContent = "Select it";
      }
      setTimeout(() => {
        b.textContent = "Copy";
        b.classList.remove("done");
      }, 1800);
    });
  }
}

// ---------- start ----------
if (!gsap || !ScrollTrigger) {
  // The animation library did not load: show everything as it is.
  document.documentElement.classList.remove("js");
  document.body.classList.remove("loading");
  $(".loader")?.remove();
} else {
  gsap.registerPlugin(ScrollTrigger, ...(SplitText ? [SplitText] : []));
  smooth();
  tabs();
  const go = async () => {
    await document.fonts?.ready;
    const tl = intro();
    splitTitles(tl);
    sections();
    reveals();
    day();
    moments();
    stopDemo();
    ring();
    pointerToys();
    nav();
    ScrollTrigger.refresh();
  };
  void go();
}
