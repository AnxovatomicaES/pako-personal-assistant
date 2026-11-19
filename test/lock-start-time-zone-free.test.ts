import assert from "node:assert/strict";
import { test } from "node:test";
import { lstartSeconds, processStart } from "../src/local.ts";

// The Mac app compares the lock's start time with the kernel's (proc_pidinfo, zone-free). A local time read back in the hour repeated when
// the clocks go back (Madrid, 25 October 2026, 02:00-03:00 twice) used to be taken as the first one, an hour off: the app saw Pako as gone.
test("the lock's start time does not depend on the computer's time zone, in the repeated hour of a clock change too", () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = "Europe/Madrid";
    // The second 02:30 in Madrid is 01:30 UTC: that is what ps prints with TZ=UTC.
    assert.equal(lstartSeconds("Sun Oct 25 01:30:00 2026\n"), 1792891800);
    assert.equal(lstartSeconds(""), null);
    const mine = processStart(process.pid);
    if (mine !== null) assert.ok(Math.abs(mine - Math.floor(Date.now() / 1000 - process.uptime())) <= 3, `start ${mine} is off`);
    process.env.TZ = "America/Los_Angeles";
    const again = processStart(process.pid);
    if (mine !== null) assert.equal(again, mine);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
