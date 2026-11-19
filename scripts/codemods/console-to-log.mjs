#!/usr/bin/env node
// Turns console.log/info/warn/error/debug("[part] message", ...rest) into the part's structured log (src/log.ts):
//
//   console.error("[whatsapp] send failed:", err)   becomes   logWhatsapp.error("send failed:", err)
//
// with `const logWhatsapp = createLog("whatsapp");` after the file's imports, and the import of createLog added. The part's name comes from
// the bracket at the start of the message. A console.error or console.warn with no bracket gets the file's name as its part, except in the
// files that talk to the person at the terminal (TERMINAL below). Everything else is left as it is and listed: a message that is not written
// out (a sink like (s) => console.log(s)), console.log with no bracket (what a command prints for people), other console methods
// (console.table...), the files the log itself imports (they would import each other), and any call with "console: keep" in a comment on its
// line or the line above.
//
// Run it again at any time, on a newer tree (after a rebase, say): what it already turned is no console call any more, the parts' logs it
// added are found and reused, and the import is added only once. With nothing left to turn it changes no file.
//
//   node scripts/codemods/console-to-log.mjs            turn src/, assistant/ and voice-worker/src/, and list what was left
//   node scripts/codemods/console-to-log.mjs --check    change nothing; exit 1 when a file would change
//   node scripts/codemods/console-to-log.mjs FILE...    only these files
//
// There is no TypeScript parser in the repository's dependencies (the compiler is the native one), so the code is read by a small scanner
// that knows strings, template literals, comments and regular expressions: enough to find calls and their first argument. The type check
// and the tests run after it.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOTS = ["src", "assistant", "voice-worker/src"];
/** Where each tree's log lives: the voice worker is built on its own and has its copy. */
const LOG_MODULE = { "voice-worker/src": "voice-worker/src/log.ts", default: "src/log.ts" };
/** Files whose console.log and console.error with no bracket are what a person at the terminal reads: they stay as they are. */
const TERMINAL = new Set(["src/server.ts", "src/autostart.ts", "src/autostart-windows.ts", "assistant/run.ts", "assistant/update.ts"]);
/** Files never touched: the log itself. */
const OWN = new Set(["src/log.ts", "src/log-core.ts", "voice-worker/src/log.ts"]);
const LEVEL = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };
const PREFIX = /^\[([a-z][a-z0-9 _./-]*)\] ?/;

const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

// ---------- the scanner ----------

/**
 * The source with every comment, string, template text and regular expression replaced by spaces (their quotes kept), so brackets and the
 * word console are only found in code. Lengths and line breaks are kept: a position in one is the same position in the other.
 */
export function blank(src) {
  const out = src.split("");
  const fill = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = src.length;
  // Each open template's ${ depth: a } at depth 0 inside one closes the expression and goes back to the template's text.
  const templates = [];
  let lastSig = ""; // the last meaningful character or word of code, to tell a regular expression from a division
  const regexAfter = /^(?:[(,=:[!&|?{};+\-*%<>~^]|return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await|)$/;
  const template = () => {
    // at a backtick or a } that ends an expression: scan the template's text up to its end or its next ${
    const start = i;
    i++;
    while (i < n) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "`") {
        fill(start + 1, i);
        i++;
        lastSig = "`";
        return;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        fill(start + 1, i);
        i += 2;
        templates.push(0);
        lastSig = "{";
        return;
      } else i++;
    }
    fill(start + 1, n);
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      fill(i, end);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      fill(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      fill(start + 1, i);
      i++;
      lastSig = c;
    } else if (c === "`") {
      template();
    } else if (c === "/" && regexAfter.test(lastSig)) {
      const start = i;
      i++;
      let cls = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") i += 2;
        else if (cls) {
          if (src[i] === "]") cls = false;
          i++;
        } else if (src[i] === "[") {
          cls = true;
          i++;
        } else if (src[i] === "/") break;
        else i++;
      }
      fill(start + 1, i);
      i++;
      while (i < n && /[a-z]/.test(src[i])) i++;
      lastSig = "/re";
    } else if (templates.length && c === "{") {
      templates[templates.length - 1]++;
      lastSig = c;
      i++;
    } else if (templates.length && c === "}") {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        template();
      } else {
        templates[templates.length - 1]--;
        lastSig = c;
        i++;
      }
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
      lastSig = m[0];
      i += m[0].length;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      lastSig = /[0-9]/.test(c) ? "0" : c;
      i++;
    }
  }
  return out.join("");
}

/** The calls console.<method>( in the code, each with where it starts, its method, and its arguments' ranges. */
export function findCalls(src, code) {
  const calls = [];
  const re = /(?<![.\w$])console\s*\.\s*([A-Za-z]+)\s*\(/g;
  for (let m; (m = re.exec(code)); ) {
    const open = m.index + m[0].length - 1;
    const args = [];
    let depth = 0;
    let from = open + 1;
    let close = -1;
    for (let k = open + 1; k < code.length; k++) {
      const ch = code[k];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) {
          close = k;
          break;
        }
        depth--;
      } else if (ch === "," && depth === 0) {
        args.push([from, k]);
        from = k + 1;
      }
    }
    if (close < 0) continue;
    if (src.slice(from, close).trim()) args.push([from, close]);
    calls.push({ start: m.index, open, close, method: m[1], args });
  }
  return calls;
}

// ---------- one file ----------

function pascal(name) {
  return name.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

function lineOf(src, pos) {
  let line = 1;
  for (let k = 0; k < pos; k++) if (src.charCodeAt(k) === 10) line++;
  return line;
}

/** The file turned, what was turned and what was left (with why). */
export function transform(src, file) {
  const code = blank(src);
  const calls = findCalls(src, code);
  const skipped = [];
  const turned = [];
  const edits = [];
  const fileName = file.split("/").pop().replace(/\.[mc]?[tj]s$/, "");
  // A file in a folder of its own (src/restaurants/engine.ts) speaks for that folder's part.
  const parts = file.split("/");
  const fileComponent = file.startsWith("voice-worker/") ? "voice-worker" : parts.length > 2 ? parts[parts.length - 2] : fileName;
  for (const c of calls) {
    const line = lineOf(src, c.start);
    const lines = src.split("\n");
    const near = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
    const skip = (why) => skipped.push({ file, line, why });
    if (!(c.method in LEVEL)) {
      skip(`console.${c.method} is not a log line`);
      continue;
    }
    if (/console: keep/.test(near)) {
      skip("marked console: keep");
      continue;
    }
    const first = c.args[0];
    const firstText = first ? src.slice(first[0], first[1]) : "";
    const lead = firstText.length - firstText.trimStart().length;
    const quote = firstText.trimStart()[0];
    if (!first || !(quote === '"' || quote === "'" || quote === "`")) {
      skip("the message is not written out (a sink or a value)");
      continue;
    }
    const textAt = first[0] + lead + 1;
    const pm = PREFIX.exec(src.slice(textAt, textAt + 80));
    let component;
    let cut = 0;
    if (pm) {
      component = pm[1];
      cut = pm[0].length;
    } else if ((c.method === "error" || c.method === "warn") && !TERMINAL.has(file)) {
      component = fileComponent;
    } else {
      skip(TERMINAL.has(file) ? "printed for the person at the terminal" : `console.${c.method} with no [part]: printed for people`);
      continue;
    }
    turned.push({ component, line, level: LEVEL[c.method], cut: [textAt, textAt + cut], callee: [c.start, c.open] });
  }
  if (!turned.length) return { out: src, turned, skipped };

  // The parts' logs already declared in the file (by an earlier run), and the names already taken.
  const have = new Map();
  for (const m of src.matchAll(/^const ([A-Za-z_$][\w$]*) = createLog\("([^"]+)"\);$/gm)) have.set(m[2], m[1]);
  const taken = new Set(code.match(/(?<![.\w$])[A-Za-z_$][\w$]*/g) ?? []);
  const components = [...new Set(turned.map((t) => t.component))];
  const fresh = components.filter((comp) => !have.has(comp));
  const declared = [];
  for (const comp of fresh) {
    let name = fresh.length === 1 && have.size === 0 && !taken.has("log") ? "log" : `log${pascal(comp)}`;
    for (let k = 2; taken.has(name); k++) name = `log${pascal(comp)}${k}`;
    taken.add(name);
    have.set(comp, name);
    declared.push(`const ${name} = createLog(${JSON.stringify(comp)});`);
  }

  for (const t of turned) {
    edits.push({ at: t.callee[0], end: t.callee[1], text: `${have.get(t.component)}.${t.level}` });
    if (t.cut[1] > t.cut[0]) edits.push({ at: t.cut[0], end: t.cut[1], text: "" });
  }

  // The import, then the parts' logs, after the last import of the file.
  const logModule = file.startsWith("voice-worker/src/") ? LOG_MODULE["voice-worker/src"] : LOG_MODULE.default;
  let spec = relative(dirname(join(ROOT, file)), join(ROOT, logModule)).split(sep).join("/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  const imports = [...code.matchAll(/^import\b[^;]*;/gm)];
  const afterImports = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : -1;
  const existing = new RegExp(`^import \\{([^}]*)\\} from "${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";`, "m").exec(src);
  let head = "";
  if (!existing) head += `import { createLog } from "${spec}";\n`;
  else if (!/\bcreateLog\b/.test(existing[1])) {
    const names = existing[1].split(",").map((s) => s.trim()).filter(Boolean);
    edits.push({ at: existing.index, end: existing.index + existing[0].length, text: `import { ${[...names, "createLog"].sort().join(", ")} } from "${spec}";` });
  }
  const block = (head ? `\n${head.replace(/\n$/, "")}` : "") + (declared.length ? `\n\n${declared.join("\n")}` : "");
  if (block) {
    if (afterImports >= 0) edits.push({ at: afterImports, end: afterImports, text: block });
    else {
      // No import: after the comments that open the file.
      const m = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*/.exec(src);
      edits.push({ at: m[0].length, end: m[0].length, text: `${block.replace(/^\n+/, "")}\n\n` });
    }
  }
  edits.sort((a, b) => b.at - a.at || b.end - a.end);
  let out = src;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return { out, turned, skipped };
}

// ---------- the tree ----------

/** The files the log imports, near or far: they cannot import it back. */
function logImports(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try {
      src = readFileSync(join(ROOT, file), "utf8");
    } catch {
      return;
    }
    for (const m of src.matchAll(/^(?:import|export)\b[^;]*?from\s*"(\.[^"]+)"/gm)) walk(rel(resolve(dirname(join(ROOT, file)), m[1])));
  };
  walk(entry);
  return seen;
}

function walkTs(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel(p));
  }
  return out;
}

function main(argv) {
  const check = argv.includes("--check");
  const named = argv.filter((a) => !a.startsWith("--"));
  const files = named.length ? named.map((f) => rel(resolve(f))) : ROOTS.flatMap((r) => walkTs(join(ROOT, r), []));
  const cycle = new Set([...logImports("src/log.ts"), ...logImports("voice-worker/src/log.ts")]);
  const skipped = [];
  let turnedCount = 0;
  const changed = [];
  for (const file of files.sort()) {
    if (OWN.has(file)) continue;
    const src = readFileSync(join(ROOT, file), "utf8");
    if (cycle.has(file)) {
      const left = findCalls(src, blank(src));
      for (const c of left) skipped.push({ file, line: lineOf(src, c.start), why: "the log imports this file" });
      continue;
    }
    const r = transform(src, file);
    skipped.push(...r.skipped);
    turnedCount += r.turned.length;
    if (r.out !== src) {
      changed.push(`${file} (${r.turned.length})`);
      if (!check) writeFileSync(join(ROOT, file), r.out);
    }
  }
  const verb = check ? "would turn" : "turned";
  console.log(`${verb} ${turnedCount} console calls in ${changed.length} files`);
  for (const c of changed) console.log(`  ${c}`);
  console.log(`left ${skipped.length} console calls:`);
  for (const s of skipped) console.log(`  ${s.file}:${s.line}  ${s.why}`);
  if (check && changed.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
