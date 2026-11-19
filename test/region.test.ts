// Pako for an owner anywhere (src/region.ts): the time zone, the country, the locale, the help numbers and phone numbers follow the owner,
// and nothing defaults to one country. Pako's texts are English everywhere; dates are written the way the owner's country writes English. The tests run with TZ=Europe/Madrid (npm test); each one that needs another place says so.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callingCode, localeFor, localeRegion, nationalNumber, ownerCountry, ownerTimeZone, phoneCountry, regionAttr, setOwnerRegion, uses12h, zoneCountry,
} from "../src/region.ts";
import { locale, ownerClock } from "../src/i18n.ts";
import { crisisLine, emergencyNumber, helpLine, loadCountry, notDeviceText, redFlagReply } from "../src/health.ts";
import { phoneOf } from "../src/contacts.ts";
import { ownerDigits } from "../src/whatsapp-computer.ts";
import { loadPersonalConfig } from "../src/personal-caller.ts";

// 2026-11-16 20:05 UTC: 15:05 in New York, 21:05 in Madrid.
const AT = Date.UTC(2026, 10, 16, 20, 5);

test("time zone: the setting, else this computer's own, else UTC with a note to log once", () => {
  assert.deepEqual(ownerTimeZone("America/New_York", "Europe/Madrid"), { timeZone: "America/New_York" }, "the setting wins");
  assert.deepEqual(ownerTimeZone("", "America/New_York"), { timeZone: "America/New_York" }, "no setting: the computer's zone");
  assert.deepEqual(ownerTimeZone(undefined, "Europe/Madrid"), { timeZone: "Europe/Madrid" });
  for (const system of ["UTC", "Etc/UTC", "GMT", ""]) {
    const z = ownerTimeZone(undefined, system);
    assert.equal(z.timeZone, "UTC", `a server that only says ${system || "nothing"}`);
    assert.match(z.note ?? "", /PERSONAL_TIMEZONE/, "and says how to set it");
  }
  const bad = ownerTimeZone("Mars/Olympus", "America/Chicago");
  assert.equal(bad.timeZone, "America/Chicago", "a wrong setting falls back to the computer's zone, not to Madrid");
  assert.match(bad.problem ?? "", /not a valid IANA time zone/);
  assert.equal(ownerTimeZone(undefined).timeZone, "Europe/Madrid", "the tests' own zone (TZ=Europe/Madrid)");
});

test("the phone line's config: no PERSONAL_TIMEZONE means this computer's zone, an explicit one wins", () => {
  const base = { PERSONAL_CALLER_TOKEN: "x".repeat(24), PERSONAL_OWNER_NUMBER: "+34600111222", PERSONAL_OWNER_NAME: "Linus" };
  assert.equal(loadPersonalConfig(base)!.timeZone, "Europe/Madrid");
  const ny = loadPersonalConfig({ ...base, PERSONAL_TIMEZONE: "America/New_York" })!;
  assert.equal(ny.timeZone, "America/New_York");
  assert.equal(ny.quiet?.timeZone, "America/New_York", "the quiet hours in the same zone");
  assert.equal(ny.timeZoneNote, undefined);
});

test("country: PAKO_COUNTRY, else the time zone's, else the system locale's region, else not known", () => {
  assert.deepEqual(ownerCountry({ PAKO_COUNTRY: "mx" }, "America/New_York"), { country: "MX" }, "the setting wins");
  assert.deepEqual(ownerCountry({ LANG: "en_US.UTF-8" }, "Europe/Madrid", "en-US"), { country: "ES" }, "the zone beats a default en-US locale");
  assert.deepEqual(ownerCountry({}, "America/New_York", "es-ES"), { country: "US" });
  assert.deepEqual(ownerCountry({ LANG: "en_GB.UTF-8" }, "UTC", "en-US"), { country: "GB" }, "UTC says nothing: the locale's region");
  assert.deepEqual(ownerCountry({}, "UTC", "en"), { country: "" }, "nothing tells");
  assert.match(ownerCountry({ PAKO_COUNTRY: "Spain" }, "Europe/Madrid").problem ?? "", /two letters.*ES is used/);
  assert.equal(zoneCountry("America/Argentina/Cordoba"), "AR");
  assert.equal(zoneCountry("Australia/Sydney"), "AU");
  assert.equal(zoneCountry("America/Panama"), null);
  assert.equal(localeRegion({ LC_ALL: "es_MX.UTF-8", LANG: "en_US.UTF-8" }), "MX", "LC_ALL first, as the C library reads it");
  // loadCountry (the server's reading) goes through the same order, with the owner's own zone.
  assert.deepEqual(loadCountry({}), { country: "ES" }, "Madrid's zone (the tests'): Spain");
  assert.deepEqual(loadCountry({ PERSONAL_TIMEZONE: "America/New_York" }), { country: "US" });
});

test("a US owner in America/New_York: 12-hour times, month first, 911 and 988, +1 for a number without its code", (t) => {
  t.after(() => setOwnerRegion(""));
  const { country } = loadCountry({ PERSONAL_TIMEZONE: "America/New_York" });
  setOwnerRegion(country);
  assert.equal(locale("en"), "en-US");
  assert.equal(uses12h(locale("en")), true);
  assert.equal(ownerClock(AT, "America/New_York", "en").replace(/\s/g, " "), "3:05 PM", "(some ICU versions put a narrow space before PM)");
  assert.equal(new Intl.DateTimeFormat(locale("en"), { timeZone: "America/New_York", day: "numeric", month: "numeric" }).format(AT), "11/16");
  assert.equal(regionAttr(), ' data-region="US"', "the panel is told too");

  assert.equal(emergencyNumber("US"), "911");
  assert.equal(crisisLine("US"), "988");
  assert.match(redFlagReply("emergency", "en", country), /call 911 right away/);
  assert.match(redFlagReply("suicide", "en", country), /call 988 now\. If you are in immediate danger, call 911\./);
  assert.equal(helpLine(country, "en"), "911 (for suicidal thoughts: 988)");
  assert.match(notDeviceText("en", country), /call 911\.$/);

  assert.equal(phoneCountry(), "US");
  assert.equal(callingCode("US"), "1");
  assert.equal(phoneOf("(415) 555-0100"), "+14155550100");
  assert.equal(phoneOf("1 415 555 0100"), "+14155550100");
  assert.equal(phoneOf("+34 612 34 56 78"), "+34612345678", "a number with its code is never changed");
  assert.equal(phoneOf("612 34 56 78"), "612345678", "a Spanish national number is not given +34 in the US");
  assert.equal(ownerDigits("(415) 555-0100"), "14155550100");
  assert.equal(ownerDigits("+44 7700 900123"), "447700900123");
});

test("an owner in Spain: English texts, dates the way Spain writes English (24-hour, day first), 112 and 024, +34", (t) => {
  t.after(() => setOwnerRegion(""));
  setOwnerRegion(loadCountry({ PERSONAL_TIMEZONE: "Europe/Madrid" }).country);
  assert.equal(locale(), "en-ES");
  assert.equal(ownerClock(AT, "Europe/Madrid"), "21:05");
  assert.equal(new Intl.DateTimeFormat(locale(), { timeZone: "Europe/Madrid", day: "numeric", month: "numeric" }).format(AT), "16/11");
  assert.equal(regionAttr(), ' data-region="ES"');
  assert.match(redFlagReply("emergency", "en", "ES"), /\b112\b/);
  assert.match(redFlagReply("suicide", "en", "ES"), /\b024\b/);
  assert.match(notDeviceText("en", "ES"), /112\.$/);
  assert.equal(phoneOf("612 34 56 78"), "+34612345678");
  assert.equal(ownerDigits("612 34 56 78"), "34612345678");
});

test("English locales: the country's own where Intl has one, en-GB where it has none or the country is not known", () => {
  assert.equal(localeFor("en", "US"), "en-US");
  assert.equal(localeFor("en", "AU"), "en-AU");
  assert.equal(localeFor("en", "GB"), "en-GB");
  assert.equal(localeFor("en", "DE"), "en-DE");
  assert.equal(localeFor("en", ""), "en-GB");
  assert.equal(localeFor("en", "AR"), "en-GB", "no English data for Argentina: not US English");
  assert.equal(uses12h(localeFor("en", "AR")), false);
});

test("before the server sets a country (tests, tools): British English dates, and no country code guessed for a phone number", () => {
  setOwnerRegion("");
  assert.equal(locale("en"), "en-GB");
  assert.equal(phoneCountry(), "", "not set yet: no country");
  assert.equal(nationalNumber("612345678"), null, "a number without its code is left as written");
  assert.equal(nationalNumber("612345678", "ES"), "+34612345678");
  assert.equal(nationalNumber("612345678", ""), null, "an owner whose country is not known: no code is guessed");
});

test("every listed country has its help numbers; anywhere else, words that are right everywhere", () => {
  const listed: Record<string, [string, string]> = {
    ES: ["112", "024"], US: ["911", "988"], GB: ["999", "116 123"], MX: ["911", "800 911 2000"], AR: ["911", "135"], CO: ["123", "106"],
    CL: ["131", "*4141"], FR: ["112", "3114"], DE: ["112", "0800 111 0 111"], IT: ["112", "02 2327 2327"], PT: ["112", "808 24 24 24"],
    CA: ["911", "988"], AU: ["000", "13 11 14"],
  };
  for (const [c, [n, line]] of Object.entries(listed)) {
    assert.equal(emergencyNumber(c), n, c);
    assert.equal(crisisLine(c), line, c);
  }
  assert.equal(emergencyNumber("NL"), "112", "the EU's 112 for a country with no line of its own here");
  assert.match(redFlagReply("suicide", "en", "NL"), /call 112 now\.\nThere are free crisis lines at findahelpline\.com\./);
  assert.equal(emergencyNumber("ZZ"), null);
  assert.match(redFlagReply("emergency", "en", ""), /call your local emergency number right away/);
  assert.equal(helpLine("", "en"), "their local emergency number (crisis lines: findahelpline.com)");
  assert.match(notDeviceText("en", ""), /call your local emergency number\.$/);
});

test("a UTC server with no zone set takes the zone of the owner's phone country when that country has one zone; +1 is not guessed", async () => {
  const { ownerTimeZone, zoneOfNumber } = await import("../src/region.ts");
  assert.equal(ownerTimeZone(undefined, "UTC", "+34600111222").timeZone, "Europe/Madrid", "a +34 owner on a UTC server: Madrid time");
  assert.match(ownerTimeZone(undefined, "Etc/UTC", "0044 7700 900123").note ?? "", /Europe\/London/);
  assert.equal(ownerTimeZone(undefined, "UTC", "+12125550100").timeZone, "UTC", "+1 spans several zones: not guessed");
  assert.equal(ownerTimeZone("America/Chicago", "UTC", "+34600111222").timeZone, "America/Chicago", "the setting wins");
  assert.equal(ownerTimeZone(undefined, "Europe/Paris", "+34600111222").timeZone, "Europe/Paris", "the computer's zone wins over the phone");
  assert.equal(zoneOfNumber("+351912345678"), "Europe/Lisbon", "the longer code is matched before +35…");
  assert.equal(zoneOfNumber("600111222"), null, "no country code: no guess");
});
