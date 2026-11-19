import { lockHome } from "../src/local.ts";
const dir = process.argv[2]!;
const at = Number(process.argv[3]);
while (Date.now() < at) { /* spin to a common start */ }
try {
  lockHome(dir, 18999);
  // When the lock was actually taken: lockHome asks ps first, which can take seconds on a busy machine, so the start of the try says nothing
  // about when the lock was held. The parent compares these hold times (each held 3 s) to tell a real race from two turns.
  console.log("LOCKED", process.pid, Date.now());
  setTimeout(() => process.exit(0), 3000);
} catch (e) {
  console.log("REFUSED", process.pid, Date.now());
}
