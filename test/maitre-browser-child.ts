// A stand-in for a Pako that has used Maître's browser (test/maitre-browser-life.test.ts): opens a page on the profile it is given, says so,
// then ends the way the first argument says: "exit" (process.exit, as src/server.ts ends) or "kill" (killed outright: no exit handler runs).
import { BrowserPool, findBrowser } from "../src/maitre/cdp.ts";

const [mode, profileDir] = process.argv.slice(2) as [string, string];
const pool = new BrowserPool({ executable: findBrowser()!, profileDir, idleMs: 10 * 60_000, launchTimeoutMs: 60_000 });
await pool.withPage(async (page) => page.goto("about:blank"));
console.log("READY");
if (mode === "kill") process.kill(process.pid, "SIGKILL");
process.exit(0);
