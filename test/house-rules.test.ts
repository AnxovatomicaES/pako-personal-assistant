// House rules the code keeps: every setting it reads is documented, lines stay readable, and no node_modules is ever tracked.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
/** Every .ts file under a folder (subfolders too), as paths from the repository root. */
const sources = (dir: string): string[] =>
  readdirSync(new URL(dir, root)).flatMap((f) => {
    const path = `${dir}${f}`;
    if (statSync(new URL(path, root)).isDirectory()) return f === "node_modules" ? [] : sources(`${path}/`);
    return f.endsWith(".ts") ? [path] : [];
  });

test("docs: every environment variable the server, the Mac bridge and the voice worker read is documented", () => {
  const docs = ["README.md", "docs/configuration.md", "docs/personal-caller.md", "assistant/README.md", "voice-worker/README.md"].map(read).join("\n");
  const env = new Set<string>();
  for (const file of [...sources("src/"), ...sources("assistant/"), ...sources("voice-worker/src/")]) {
    const src = read(file);
    // env.X, env["X"], env("X"), num("X", ...) (the bridge's helper), process.env.X
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) env.add(m[1]!);
    for (const m of src.matchAll(/\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g)) env.add(m[1]!);
    for (const m of src.matchAll(/\benv\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g)) env.add(m[1]!);
    for (const m of src.matchAll(/\bnum\(\s*"([A-Z][A-Z0-9_]+)"/g)) env.add(m[1]!);
  }
  env.delete("RENDER"); // set by the host, not by the owner
  for (const host of ["RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "K_SERVICE", "DYNO", "WEBSITE_SITE_NAME", "VERCEL", "KOYEB_APP_NAME"]) env.delete(host);
  assert.ok(env.size > 30, "the scan found the configuration");
  assert.deepEqual([...env].filter((name) => !docs.includes(`\`${name}\``)).sort(), [], "settings missing from docs/configuration.md, docs/personal-caller.md, assistant/README.md and voice-worker/README.md");
});

test("size: no line in src is over 200 characters (wrap long ones); src/restaurants/ is code ported as it was, with its long patterns", () => {
  const long = sources("src/")
    .filter((f) => !f.startsWith("src/restaurants/"))
    .flatMap((f) => read(f).split("\n").map((l, i) => ({ f, i: i + 1, n: l.length })))
    .filter((l) => l.n > 200);
  assert.deepEqual(long.map((l) => `${l.f}:${l.i}`), []);
});

test("git: no tracked path is named node_modules (a worktree's node_modules is a symlink, which `node_modules/` in .gitignore did not match)", () => {
  // git's hook settings (GIT_DIR and the like, from a pre-push hook) must not point this at another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: new URL(".", root), env, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0");
  assert.ok(tracked.length > 100, "git ls-files listed the repository");
  assert.deepEqual(tracked.filter((p) => p.split("/").includes("node_modules")), []);
  // And the ignore rule matches a symlink too: a pattern ending in "/" matches directories only.
  const ignore = read(".gitignore").split("\n").map((l) => l.trim());
  assert.ok(ignore.includes("node_modules") || ignore.includes("/node_modules"), ".gitignore has node_modules without a trailing slash");
  assert.ok(!ignore.includes("node_modules/"), "node_modules/ (with the slash) does not match a symlink");
});

/** Every .ts and .js file under a folder (subfolders too): the panel's browser code counts as src too. */
const scripts = (dir: string): string[] =>
  readdirSync(new URL(dir, root)).flatMap((f) => {
    const path = `${dir}${f}`;
    if (statSync(new URL(path, root)).isDirectory()) return f === "node_modules" ? [] : scripts(`${path}/`);
    return /\.(ts|js)$/.test(f) ? [path] : [];
  });

/**
 * A `catch {` with no binding throws the error away. Each one says why that is safe with a comment (on its own line, the line before it, or
 * the first line inside the block: `catch { /* … *\/ }` is the short form), or logs what it caught.
 */
test("catch: no bare catch {} in src without a comment saying why ignoring is safe, or a log", () => {
  const bare: string[] = [];
  for (const f of scripts("src/")) {
    const lines = read(f).split("\n");
    lines.forEach((l, i) => {
      const m = /\bcatch\s*\{/.exec(l);
      if (!m) return;
      const after = l.slice(m.index + m[0].length);
      const prev = lines[i - 1] ?? "";
      const first = (after.trim() ? after : lines[i + 1] ?? "").trim();
      const said = /\/\/|\/\*/.test(l) || /^\s*(\/\/|\/\*|\*)/.test(prev) || /^(\/\/|\/\*)/.test(first);
      const logs = /^(?:void\s+)?(?:log[A-Z]\w*|log|console)\.(?:debug|info|warn|error|log)\(/.test(first);
      if (!said && !logs) bare.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bare, [], "say why the error is ignored (a short comment) or log it");
});

/** Every file under a folder (subfolders too) whose name matches, as paths from the repository root. */
const filesOf = (dir: string, ext: RegExp): string[] =>
  readdirSync(new URL(dir, root)).flatMap((f) => {
    const path = `${dir}${f}`;
    if (statSync(new URL(path, root)).isDirectory()) return f === "node_modules" ? [] : filesOf(`${path}/`, ext);
    return ext.test(f) ? [path] : [];
  });

/** Common Spanish UI words: the names old buttons, cards and messages carried before Pako's own texts went English only. */
const SPANISH_UI = new RegExp(
  "(?<![\\p{L}])(salud|ajustes|guardar|cancelar|enviar|recordatorios?|reuni[oó]n|reuniones|mañana|correo|calendario|configuraci[oó]n|tareas"
    + "|cerrar|abrir|buscar|borrar|eliminar|aceptar|listo|hecho|pendientes?|cargando|contraseña|también|todavía|ahora|aquí|resumen|importar"
    + "|personas|hola|gracias|seguimiento|panel de control)(?![\\p{L}])",
  "giu",
);

/**
 * The few places that accept Spanish on purpose: a recognition pattern (a greeting the owner types, the kinds older log lines in the store
 * still carry, a reason older loops were saved with). Each is a file and the words it may hold; a new one belongs here only for that reason.
 */
const SPANISH_ALLOWED: Record<string, string[]> = {
  "src/door/format.ts": ["hola"], // the greeting a call's message is cleaned of
  "src/panel/app.js": ["correo", "calendario", "recordatorio", "salud"], // older log lines' kinds, mapped to icons
  "src/followups/checks.ts": ["correo"], // older loops' reasons
  "src/followups/calendar-match.ts": ["reunion"], // older loops' hints: the words that name no meeting (shared with the checks)
  "assistant/prompt.ts": ["correo", "reunion", "seguimiento"], // the fences' names, which the bridge swaps for random ones: never shown
};

test("english: Pako's own fixed texts (chat, panel, follow-ups, gentle, prompt, Mac app, site) carry no Spanish UI words", () => {
  const files = [
    ...filesOf("src/door/", /\.ts$/),
    ...filesOf("src/panel/", /\.(js|html|css)$/),
    ...filesOf("src/followups/", /\.ts$/),
    "src/followups.ts",
    ...filesOf("src/", /^gentle.*\.ts$/).filter((f) => !f.slice(4).includes("/")),
    "assistant/prompt.ts",
    ...filesOf("desktop/mac/", /\.(swift|strings)$/),
    ...filesOf("site/", /\.(js|html|css)$/),
  ];
  assert.ok(files.length > 100, "the scan found the files");
  const found: string[] = [];
  for (const f of files) {
    const allowed = new Set(SPANISH_ALLOWED[f] ?? []);
    read(f).split("\n").forEach((l, i) => {
      for (const m of l.matchAll(SPANISH_UI)) if (!allowed.has(m[1]!.toLowerCase())) found.push(`${f}:${i + 1} "${m[1]}"`);
    });
  }
  assert.deepEqual(found, [], "English only: use the English name the page or the chat shows (or, for a recognition pattern, SPANISH_ALLOWED)");
});
