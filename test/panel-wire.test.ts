// The panel's own script (src/panel/app.js) cannot be loaded as it is (it starts the orb and draws the whole page), so these run its functions
// as the browser does: each one's source is cut from the file and given stand-ins for what it uses (the repo's way, as test/first-run.test.ts
// does for chatTrouble). Whatever the function does with its arguments is the real code.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/panel/app.js", import.meta.url), "utf8");
const { WORDS } = (await import(new URL("../src/panel/i18n.js", import.meta.url).href)) as { WORDS: Record<string, string> };

/** The source of `function name(...) {...}` (async or not), up to the closing brace at the start of a line. */
function source(name: string): string {
  const m = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(app);
  assert.ok(m, `${name} is in app.js`);
  return m[0];
}

/** The named functions as the page has them, with `deps` as the names they use. */
function page<T>(names: string[], deps: Record<string, unknown>, expose: string): T {
  const body = `const { ${Object.keys(deps).join(", ")} } = deps;\n${names.map(source).join("\n")}\nreturn ${expose};`;
  return new Function("deps", body)(deps) as T;
}

const t = (key: string, vars?: Record<string, unknown>): string => (WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ""));

// ---------- STOP and RESUME on the switch ----------

function pauseRig(answer: { ok?: boolean; body?: Record<string, unknown> }) {
  const warn = { dataset: {} as Record<string, string>, textContent: "", hidden: true };
  const toasts: string[] = [];
  const data: Record<string, unknown> = { paused: null, pauseWhy: null };
  let headers = 0;
  const toggle = page<() => Promise<void>>(
    ["showPauseWarn", "togglePause"],
    {
      $: (s: string) => (s === "#pause-warn" ? warn : null),
      t,
      data,
      confirm: () => true,
      fetch: async () => ({ ok: answer.ok ?? true, json: async () => answer.body ?? {} }),
      renderHeader: () => void headers++,
      toast: (s: string) => void toasts.push(s),
      animate: () => false,
      gsap: () => ({}),
    },
    "togglePause",
  );
  return { warn, toasts, data, headers: () => headers, toggle };
}

test("STOP on the panel the store could not keep: a lasting line says so, in the chat's words; a kept one has none", async () => {
  const notKept = pauseRig({ body: { paused: 1_800_000_000_000, why: "owner", kept: false } });
  await notKept.toggle();
  assert.equal(notKept.data.paused, 1_800_000_000_000, "paused now");
  assert.equal(notKept.warn.hidden, false, "the line shows, beyond the toast's few seconds");
  assert.equal(notKept.warn.textContent, WORDS["stop.notKept"]);
  assert.match(notKept.warn.textContent, /couldn't save/);
  assert.equal(notKept.warn.dataset.for, "true", "it is about the stop");
  assert.deepEqual(notKept.toasts, [WORDS["toast.paused"]]);

  const kept = pauseRig({ body: { paused: 1_800_000_000_000, why: "owner", kept: true } });
  await kept.toggle();
  assert.equal(kept.warn.hidden, true);
  assert.equal(kept.warn.textContent, "");
});

test("RESUME the store could not keep says so too, and a kept one takes the earlier line away", async () => {
  const rig = pauseRig({ body: { paused: null, why: null, kept: false } });
  rig.data.paused = 1_800_000_000_000; // paused: the press resumes
  await rig.toggle();
  assert.equal(rig.warn.hidden, false);
  assert.equal(rig.warn.textContent, WORDS["resume.notKept"]);
  assert.equal(rig.warn.dataset.for, "false");
  assert.match(rig.warn.textContent, /may be paused again/);
  assert.deepEqual(rig.toasts, [WORDS["toast.running"]]);

  // Pressed again (stop) and kept this time: nothing left to warn about.
  const again = pauseRig({ body: { paused: 1_800_000_000_001, why: "owner", kept: true } });
  again.warn.hidden = false;
  again.warn.textContent = "an earlier line";
  await again.toggle();
  assert.equal(again.warn.hidden, true);
  assert.equal(again.warn.textContent, "");
});

test("the panel's words for a pause that was not kept are the chat's (src/door/texts.ts), and the page has a place for the line", () => {
  const chat = readFileSync(new URL("../src/door/texts.ts", import.meta.url), "utf8");
  assert.match(chat, /stopNotKept: "\\n\(I couldn't save it: if the server restarts, type it again\.\)"/);
  assert.match(chat, /resumeNotKept: "\\n\(I couldn't save it: if the server restarts, I may be paused again; type it again then\.\)"/);
  assert.match(WORDS["stop.notKept"]!, /^I couldn't save the stop: /);
  assert.match(WORDS["resume.notKept"]!, /^I couldn't save it: /);
  assert.match(readFileSync(new URL("../src/panel/index.html", import.meta.url), "utf8"), /<p class="sub pause-warn" id="pause-warn" role="status" hidden><\/p>/);
  // A refresh keeps the line while the state is the one it is about; another place that changed the state takes it away.
  assert.match(source("renderHeader"), /warn\.dataset\.for !== String\(!!data\.paused\)\) warn\.hidden = true;/);
});

// ---------- the welcome ----------

function welcomeRig(o: { saved: boolean; dialogOpen: boolean; first: boolean; steps?: string[]; claudeOk?: boolean }) {
  const welcome = { first: o.first, finishing: false, steps: o.steps ?? [] };
  const calls: string[] = [];
  const dialog = { open: o.dialogOpen };
  const finish = page<() => Promise<void>>(
    ["finishWelcome"],
    {
      welcome,
      aboutYou: () => ({ name: "Ana" }),
      saveSettings: async (body: Record<string, unknown>) => {
        calls.push(`save ${JSON.stringify(body)}`);
        return o.saved;
      },
      tellApp: (m: Record<string, unknown>) => void calls.push(`app ${JSON.stringify(m)}`),
      $: () => dialog,
      closeWelcome: () => void calls.push("close"),
      chat: { on: true },
      wc: { test: o.claudeOk === undefined ? null : o.claudeOk ? { ok: true, answer: "Ready." } : { ok: false, why: "login", detail: "" } },
      setChatOpen: () => void calls.push("chat opens"),
      toast: (s: string) => void calls.push(`toast ${s}`),
      t,
    },
    "finishWelcome",
  );
  return { welcome, calls, finish };
}

test("the welcome on a first visit whose save failed stays open: no 'all done' toast, no closing, and a second press tries again", async () => {
  const r = welcomeRig({ saved: false, dialogOpen: true, first: true });
  await r.finish();
  assert.deepEqual(r.calls, ['save {"name":"Ana","welcomed":true}'], "nothing closed, nothing said, the app not told");
  assert.equal(r.welcome.finishing, false, "Done can be pressed again");
});

test("the welcome says it is done only when the save took; closed by the browser meanwhile, a failed save is cleaned up without the toast", async () => {
  const ok = welcomeRig({ saved: true, dialogOpen: true, first: true });
  await ok.finish();
  assert.deepEqual(ok.calls, ['save {"name":"Ana","welcomed":true}', 'app {"lang":"en","welcomed":true}', "close", "chat opens", `toast ${WORDS["w.doneToast"]}`]);

  const gone = welcomeRig({ saved: false, dialogOpen: false, first: true });
  await gone.finish();
  assert.deepEqual(gone.calls, ['save {"name":"Ana","welcomed":true}', "close"], "closed, but never 'done'");

  // From the footer (a change of name): still stays open when it did not take, as it did.
  const footer = welcomeRig({ saved: false, dialogOpen: true, first: false });
  await footer.finish();
  assert.deepEqual(footer.calls, ['save {"name":"Ana"}']);
});

// ---------- the welcome's Claude step ----------

test("the welcome's steps on a first visit: the name, then Claude, then trying Pako and the phone; no Claude step on a server or in the demo", () => {
  const steps = (o: { first: boolean; demo: { on: boolean } | null; name?: boolean; phone?: boolean }) =>
    page<(first: boolean) => string[]>(["welcomeSteps"], { data: { choose: { name: o.name ?? true }, demo: o.demo }, tg: { available: o.phone ?? true } }, "welcomeSteps")(o.first);
  assert.deepEqual(steps({ first: true, demo: { on: false } }), ["start", "name", "claude", "try", "phone"]);
  assert.deepEqual(steps({ first: true, demo: { on: false }, name: false, phone: false }), ["start", "claude", "try"], "a name a setting decides: Claude comes first");
  assert.deepEqual(steps({ first: true, demo: null }), ["name", "try", "phone"], "a server's panel: Claude runs elsewhere, nothing to connect here");
  assert.deepEqual(steps({ first: true, demo: { on: true } }), ["name", "try", "phone"], "the demo week's answers are recorded");
  assert.deepEqual(steps({ first: false, demo: { on: false } }), ["name"], "from the footer: the name only");
  // The page has the step, between the name and the suggestions, with its title and the body the script fills.
  const html = readFileSync(new URL("../src/panel/index.html", import.meta.url), "utf8");
  assert.match(html, /data-step="name"[\s\S]*data-step="claude"[\s\S]*id="w-title-claude"[\s\S]*id="w-claude"[\s\S]*data-step="try"/);
});

/** A tiny DOM: h() makes plain nodes; text() reads what a node says, buttons() what can be pressed. */
type Node = { tag: string; attrs: Record<string, any>; kids: unknown[] };
const h = (tag: string, attrs: Record<string, any> = {}, ...kids: unknown[]): Node => ({ tag, attrs, kids: kids.flat().filter((k) => k !== null && k !== undefined && k !== false) });
const text = (n: unknown): string => (typeof n === "string" ? n : n && typeof n === "object" ? (n as Node).kids.map(text).join("") : "");
const all = (nodes: unknown[], tag: string): Node[] =>
  nodes.flatMap((n) => (n && typeof n === "object" ? [...((n as Node).tag === tag ? [n as Node] : []), ...all((n as Node).kids, tag)] : []));

function claudeRig(answers: Record<string, unknown>, steps = ["name", "claude", "try", "phone"]) {
  const welcome = { open: true, first: true, steps: [...steps], i: steps.indexOf("claude") };
  const wc = { view: null, test: null, testing: false, error: "", timer: null, sig: "" } as Record<string, any>;
  const box = { kids: [] as unknown[], replaceChildren(...k: unknown[]) { this.kids = k; }, contains: () => false, querySelector: () => null, focus() {} };
  const next = { hidden: true, focus() {} };
  const dots = { kids: [] as unknown[], replaceChildren(...k: unknown[]) { this.kids = k; } };
  const calls: string[] = [];
  const fns = page<Record<string, (...a: any[]) => Promise<void> | void>>(
    ["wcCall", "wcEnter", "wcConnect", "wcTest", "wcSkip", "wcBody", "renderWelcomeClaude"],
    {
      welcome, wc, WC_BUSY: new Set(["checking", "installing", "signing-in"]), h, t,
      fill: (el: { replaceChildren: (...k: unknown[]) => void }, ...k: unknown[]) => el.replaceChildren(...k.flat().filter((x) => x != null && x !== false)),
      icon: (name: string) => h("i", { "data-lucide": name }),
      $: (s: string) => (s === "#w-claude" ? box : s === "#w-next" ? next : s === "#w-dots" ? dots : null),
      paintIcons: () => undefined,
      tell: (s: string) => void calls.push(`tell ${s}`),
      welcomeNext: async () => void calls.push(`next ${welcome.steps.join(",")}`),
      document: { activeElement: null },
      location: { reload: () => void calls.push("reload") },
      console: { warn: () => undefined },
      setInterval: () => 1, clearInterval: () => undefined,
      fetch: async (url: string, init?: { method?: string }) => {
        const key = `${init?.method ?? "GET"} ${url}`;
        calls.push(key);
        const a = answers[key];
        if (a === undefined) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => a };
      },
    },
    "{ wcEnter, wcConnect, wcTest, wcSkip }",
  );
  const body = () => text({ tag: "box", attrs: {}, kids: box.kids });
  const pressable = () => all(box.kids, "button").map(text);
  return { welcome, wc, next, dots, calls, fns, body, pressable };
}

const SIGNED_IN = { phase: "connected", seconds: 0, account: { loggedIn: true, billing: "plan", email: "", plan: "pro", planLabel: "Pro", expiresAt: null }, fix: "", detail: "", upgradeUrl: "https://claude.ai/upgrade", emailHint: "" };

test("the Claude step, already connected: Pako asks Claude its question at once, shows the answer, and Continue goes on in one press", async () => {
  const r = claudeRig({ "GET /panel/api/claude/connect": SIGNED_IN, "POST /panel/api/claude/test": { ok: true, answer: "Ready to help." } });
  await r.fns.wcEnter!();
  assert.deepEqual(r.calls.filter((c) => c.includes("/panel/api/")), ["GET /panel/api/claude/connect", "POST /panel/api/claude/test"]);
  assert.match(r.body(), new RegExp(WORDS["w.claude.ok"]!.replace(".", "\\.")));
  assert.match(r.body(), /Ready to help\./, "Claude's own answer is shown");
  assert.equal(r.next.hidden, false, "Continue is there");
  assert.deepEqual(r.pressable(), [], "nothing else to press, no skip");
  assert.ok(r.calls.includes("tell happy"));
});

test("the Claude step when Claude does not answer: a plain reason, the button that fixes it, no Continue, and Skip for now saying Pako won't answer", async () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ ok: false, why: "login", detail: "" }, "w.claude.login", WORDS["w.claude.connect"]!],
    [{ ok: false, why: "missing", detail: "" }, "w.claude.missing", WORDS["w.claude.connect"]!],
    [{ ok: false, why: "limit", detail: "" }, "w.claude.limit", WORDS["w.claude.again"]!],
    [{ ok: false, why: "other", detail: "Claude took longer than 90 s" }, "w.claude.other", WORDS["w.claude.again"]!],
  ];
  for (const [answer, key, button] of cases) {
    const r = claudeRig({ "GET /panel/api/claude/connect": SIGNED_IN, "POST /panel/api/claude/test": answer });
    await r.fns.wcEnter!();
    assert.ok(r.body().includes(WORDS[key]!), `${key}: ${r.body()}`);
    assert.equal(r.next.hidden, true, `${key}: no Continue as if Pako worked`);
    assert.deepEqual(r.pressable(), [button, WORDS["w.claude.skip"]], key);
    assert.ok(r.body().includes(WORDS["w.claude.skipNote"]!), key);
    assert.match(WORDS["w.claude.skipNote"]!, /won't answer until Claude is set up/);
  }
  // Signed out from the start: no question is asked, the step offers Connect Claude.
  const out = claudeRig({ "GET /panel/api/claude/connect": { ...SIGNED_IN, phase: "idle", account: { ...SIGNED_IN.account, loggedIn: false } } });
  await out.fns.wcEnter!();
  assert.ok(!out.calls.includes("POST /panel/api/claude/test"));
  assert.deepEqual(out.pressable(), [WORDS["w.claude.connect"], WORDS["w.claude.skip"]]);
  assert.equal(out.next.hidden, true);
  // Pako itself did not answer: said so, with Try again.
  const gone = claudeRig({});
  await gone.fns.wcEnter!();
  assert.ok(gone.body().includes(WORDS["w.claude.unreachable"]!));
  assert.equal(gone.next.hidden, true);
});

test("Skip for now leaves out the step that tries Pako (nothing would answer there), and the end says Pako won't answer instead of 'all set'", async () => {
  const r = claudeRig({}, ["start", "name", "claude", "try", "phone"]);
  await r.fns.wcSkip!();
  assert.deepEqual(r.welcome.steps, ["start", "name", "claude", "phone"]);
  assert.equal(r.dots.kids.length, 4, "one dot per step left");
  assert.deepEqual(r.calls, ["next start,name,claude,phone"]);

  const skipped = welcomeRig({ saved: true, dialogOpen: true, first: true, steps: ["name", "claude", "phone"], claudeOk: false });
  await skipped.finish();
  assert.equal(skipped.calls.at(-1), `toast ${WORDS["w.doneNoClaude"]}`);
  assert.match(WORDS["w.doneNoClaude"]!, /won't answer until Claude is set up/);
  const worked = welcomeRig({ saved: true, dialogOpen: true, first: true, steps: ["name", "claude", "try"], claudeOk: true });
  await worked.finish();
  assert.equal(worked.calls.at(-1), `toast ${WORDS["w.doneToast"]}`);
});

test("a welcome with its own Claude step does not tell the Mac app at its first step (its Connect window would cover the step)", async () => {
  const told: unknown[] = [];
  const next = (steps: string[]) =>
    page<() => Promise<void>>(["welcomeNext"], { welcome: { i: 0, steps }, tellApp: (m: unknown) => void told.push(m), showStep: () => undefined, finishWelcome: async () => undefined }, "welcomeNext")();
  await next(["start", "name", "claude", "try"]);
  assert.deepEqual(told, []);
  await next(["name", "try"]);
  assert.deepEqual(told, [{ lang: "en" }], "a server's welcome, as before");
  // The app looks at Claude again before it opens its window at the welcome's end.
  const swift = readFileSync(new URL("../desktop/mac/App.swift", import.meta.url), "utf8");
  assert.match(swift, /connectPending = false\n[\s\S]{0,400}checkClaude\(fresh: true\) \{ state in\n\s+if !state\.ready \{ self\.showConnect\(\) \}/);
});

test("the Claude step with a Claude Code too old to report its sign-in (no account): the question tells, it is not taken for signed out", async () => {
  const r = claudeRig({ "GET /panel/api/claude/connect": { ...SIGNED_IN, phase: "idle", account: null }, "POST /panel/api/claude/test": { ok: true, answer: "Ready." } });
  await r.fns.wcEnter!();
  assert.ok(r.calls.includes("POST /panel/api/claude/test"));
  assert.equal(r.next.hidden, false);
});
