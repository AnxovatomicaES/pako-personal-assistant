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

function welcomeRig(o: { saved: boolean; dialogOpen: boolean; first: boolean }) {
  const welcome = { first: o.first, finishing: false };
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
