// Drops the native model that the LiveKit worker uses for its own end-of-turn detection. Gemini Live decides turns itself, and
// that model runs in a second process of about 320 MB: with it the worker does not fit a 512 MB instance, without it it takes
// about 280 MB. (Without the native binding the worker logs a warning and starts no such process.)
import { rmSync } from "node:fs";

for (const d of ["local-inference", "local-inference-linux-x64-gnu", "local-inference-linux-arm64-gnu"]) {
  rmSync(new URL(`../node_modules/@livekit/${d}`, import.meta.url), { recursive: true, force: true });
}
console.log("slimmed: local end-of-turn model removed");
