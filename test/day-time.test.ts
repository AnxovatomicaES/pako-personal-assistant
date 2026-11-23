// The owner's clock, one way everywhere (src/day-time.ts), and the settings that read it the same way: "off" in any case, a mistyped value
// reported with the default used, and a mistyped SLACK_QUIET_HOURS no longer turning Slack off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, hhmm, minutesOfDay, quietAt, quietSetting, weekdayOf, weekStartOf, windowOf, within } from "../src/day-time.ts";
import { loadFollowupsConfig } from "../src/followups/config.ts";
import { loadSlackConfig } from "../src/slack.ts";
import { loadWatchdogConfig } from "../src/watchdog.ts";

test("times, windows and dates", () => {
  assert.equal(hhmm("9:05"), 545);
  assert.equal(hhmm("24:00"), null);
  assert.equal(hhmm("12:60"), null);
  assert.deepEqual(windowOf("23:00-08:00"), { start: 1380, end: 480 });
  assert.equal(windowOf("08:00-08:00"), null);
  assert.equal(windowOf("08:00-09:00-10:00"), null);
  assert.equal(within({ start: 1380, end: 480 }, 30), true);
  assert.equal(within({ start: 1380, end: 480 }, 480), false);
  assert.equal(minutesOfDay(Date.parse("2026-03-29T01:30:00Z"), "Europe/Madrid"), 3 * 60 + 30, "after the clocks go forward");
  assert.equal(quietAt({ start: 1380, end: 480 }, Date.parse("2026-11-25T23:30:00Z"), "Europe/Madrid"), true);
  assert.equal(quietAt(null, 0, "UTC"), false);
  assert.equal(addDays("2026-12-31"), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(weekdayOf("2026-11-27"), 5);
});

test("a working week starts on the working day after its longest days off, Monday when they tie", () => {
  assert.equal(weekStartOf([1, 2, 3, 4, 5]), 1, "Monday to Friday");
  assert.equal(weekStartOf([1, 2, 4, 5]), 1, "a gap inside the week is not its start");
  assert.equal(weekStartOf([0, 1, 2, 3, 4]), 0, "Sunday to Thursday starts on the Sunday");
  assert.equal(weekStartOf([5, 6, 0]), 5, "Friday to Sunday");
  assert.equal(weekStartOf([6, 0]), 6, "a weekend only");
  assert.equal(weekStartOf([3, 4, 5, 6, 0]), 3, "Wednesday to Sunday");
  assert.equal(weekStartOf([1, 2, 3, 4, 5, 6, 0]), 1, "every day: a Monday-first week");
  assert.equal(weekStartOf([4]), 4, "one day a week");
  assert.equal(weekStartOf([]), 1);
});

test("quiet-hours settings: off in any case, empty is the default, a mistake is said and the default used", () => {
  assert.deepEqual(quietSetting("OFF", "X"), { quiet: null });
  assert.deepEqual(quietSetting(undefined, "X"), { quiet: { start: 1380, end: 480 } });
  const bad = quietSetting("late", "X");
  assert.deepEqual(bad.quiet, { start: 1380, end: 480 });
  assert.match(bad.problem!, /^X must be like 23:00-08:00, or off \(23:00-08:00 is used\)$/);
  assert.equal(loadFollowupsConfig({ FOLLOWUP_QUIET_HOURS: "Off" }).config!.quiet, null, "it was refused before, in capitals");
  assert.equal(loadWatchdogConfig({ WATCHDOG_QUIET_HOURS: "22:00-07:00" }).config.quiet!.start, 1320);
  const token = "xoxp-" + "1".repeat(24);
  const slack = loadSlackConfig({ SLACK_USER_TOKEN: token, SLACK_QUIET_HOURS: "nights" });
  assert.ok(slack.config, "a mistyped quiet-hours value no longer turns Slack off");
  assert.deepEqual(slack.config!.quiet, { start: 1380, end: 480 });
  assert.equal(slack.problems.length, 1);
  assert.equal(loadSlackConfig({ SLACK_USER_TOKEN: "nope" }).config, null, "a wrong token still keeps it off");
});
