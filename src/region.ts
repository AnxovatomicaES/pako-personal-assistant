// Where the owner lives: their time zone, their country, and from those the locale dates, times and numbers are written in.
//
// Nothing here defaults to one country: each of these follows the owner, wherever they are:
//   - the time zone: PERSONAL_TIMEZONE when set, else this computer's own zone. A server with neither (Render runs in UTC and has no zone of
//     its own to give) uses UTC, and says so once in its log, so a brief at "08:00" is not silently three hours off.
//   - the country (two letters): PAKO_COUNTRY when set, else the country of that time zone, else the region of the system's locale. The zone
//     comes before the locale on purpose: many computers say "en-US" only because that is the default, wherever they are (a Mac set up in one
//     country and used in another does), while a zone like Europe/Paris is set by where the computer is. An unknown country is "", and the help numbers
//     then fall back to words that are right anywhere (src/health.ts).
//   - the locale: Pako's fixed texts are English (src/i18n.ts), written the way that country writes English: "en-US" in the US (3:05 PM,
//     11/3), "en-GB", "en-IE", "en-ES", "en-DE"... elsewhere (15:05, 3/11). Set once when the server starts (setOwnerRegion); until then, in
//     tests that never set it, and for a country this computer's Intl has no English data for, en-GB: day before month on a 24-hour clock,
//     the form most of the world reads.
//
// This module reads nothing but its arguments and the process's own Intl: no store, no network.

type Env = Record<string, string | undefined>;

/** A valid IANA zone name, or false ("Mars/Base", ""). */
export function validZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** This computer's own time zone, as Intl reports it (TZ, else the system's setting); "" when it reports none. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** Calling codes of countries with a single time zone, and that zone: enough to place an owner whose server reports UTC. */
const ONE_ZONE_CODES: [string, string][] = [
  ["351", "Europe/Lisbon"], ["353", "Europe/Dublin"], ["852", "Asia/Hong_Kong"], ["971", "Asia/Dubai"],
  ["34", "Europe/Madrid"], ["44", "Europe/London"], ["33", "Europe/Paris"], ["49", "Europe/Berlin"], ["39", "Europe/Rome"],
  ["31", "Europe/Amsterdam"], ["32", "Europe/Brussels"], ["41", "Europe/Zurich"], ["43", "Europe/Vienna"], ["45", "Europe/Copenhagen"],
  ["46", "Europe/Stockholm"], ["47", "Europe/Oslo"], ["48", "Europe/Warsaw"], ["54", "America/Argentina/Buenos_Aires"],
  ["56", "America/Santiago"], ["57", "America/Bogota"], ["81", "Asia/Tokyo"], ["82", "Asia/Seoul"], ["65", "Asia/Singapore"],
];

/** The single time zone of the country a "+34…" or "0034…" number belongs to, or null when unknown or the country has several. */
export function zoneOfNumber(number: string | undefined): string | null {
  const digits = (number ?? "").trim().replace(/^00/, "+").replace(/[\s().-]/g, "");
  if (!digits.startsWith("+")) return null;
  const hit = ONE_ZONE_CODES.find(([code]) => digits.startsWith(`+${code}`));
  return hit ? hit[1] : null;
}

/** UTC under any of its names: a server's zone when nobody set one, not a place the owner lives. */
const UTC_NAMES = /^(?:Etc\/)?(?:UTC|UCT|GMT|Zulu|Universal|Greenwich)(?:[+-]?0)?$/i;

/**
 * The owner's time zone: the setting when it is valid, else this computer's own, else UTC. `note` says, once, why it is not the owner's
 * choice (to be logged at start), and `problem` that a setting was given but is not a zone.
 */
export function ownerTimeZone(
  setting: string | undefined,
  system: string = systemTimeZone(),
  ownerNumber: string | undefined = process.env.PERSONAL_OWNER_NUMBER,
): { timeZone: string; note?: string; problem?: string } {
  const raw = (setting ?? "").trim();
  if (raw && validZone(raw)) return { timeZone: raw };
  const problem = raw ? `PERSONAL_TIMEZONE "${raw}" is not a valid IANA time zone` : undefined;
  if (system && validZone(system) && !UTC_NAMES.test(system)) return { timeZone: system, ...(problem ? { problem } : {}) };
  // A server in UTC with no zone set: the owner's own phone number says the country, and a country with one time zone says the zone. This
  // works for any country with one zone. Countries with several (+1, +7, +52, +55, +61) are not guessed.
  const byPhone = zoneOfNumber(ownerNumber);
  if (byPhone) {
    const note = `no time zone set (PERSONAL_TIMEZONE) on a UTC machine: using ${byPhone}, the owner's phone number's country. Set PERSONAL_TIMEZONE to be explicit`;
    return { timeZone: byPhone, note, ...(problem ? { problem } : {}) };
  }
  return {
    timeZone: "UTC",
    note: "no time zone set (PERSONAL_TIMEZONE) and this computer reports UTC: times are UTC. Set PERSONAL_TIMEZONE, e.g. America/New_York or Asia/Tokyo",
    ...(problem ? { problem } : {}),
  };
}

/**
 * The country of a time zone, for the zones of the countries Pako has help numbers for and a few more; null for a zone that spans several
 * countries or is not listed (UTC, Europe/Zurich is listed, America/Panama is not). Kept small on purpose: PAKO_COUNTRY covers the rest.
 */
const ZONE_COUNTRY: Record<string, string> = {
  "Europe/Madrid": "ES", "Atlantic/Canary": "ES", "Africa/Ceuta": "ES",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US", "America/Phoenix": "US",
  "America/Anchorage": "US", "Pacific/Honolulu": "US", "America/Detroit": "US", "America/Boise": "US", "America/Juneau": "US",
  "America/Adak": "US", "America/Sitka": "US", "America/Nome": "US", "America/Menominee": "US", "America/Metlakatla": "US", "America/Yakutat": "US",
  "US/Eastern": "US", "US/Central": "US", "US/Mountain": "US", "US/Pacific": "US", "US/Arizona": "US", "US/Alaska": "US", "US/Hawaii": "US",
  "Europe/London": "GB", "GB": "GB", "Europe/Belfast": "GB",
  "America/Mexico_City": "MX", "America/Cancun": "MX", "America/Merida": "MX", "America/Monterrey": "MX", "America/Matamoros": "MX",
  "America/Chihuahua": "MX", "America/Ciudad_Juarez": "MX", "America/Ojinaga": "MX", "America/Mazatlan": "MX", "America/Bahia_Banderas": "MX",
  "America/Hermosillo": "MX", "America/Tijuana": "MX", "Mexico/General": "MX",
  "America/Buenos_Aires": "AR", "America/Cordoba": "AR", "America/Mendoza": "AR",
  "America/Bogota": "CO",
  "America/Santiago": "CL", "America/Punta_Arenas": "CL", "Pacific/Easter": "CL", "Chile/Continental": "CL",
  "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Busingen": "DE", "Europe/Rome": "IT",
  "Europe/Lisbon": "PT", "Atlantic/Azores": "PT", "Atlantic/Madeira": "PT",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA", "America/Halifax": "CA",
  "America/St_Johns": "CA", "America/Regina": "CA", "America/Moncton": "CA", "America/Montreal": "CA", "America/Whitehorse": "CA",
  "America/Yellowknife": "CA", "America/Iqaluit": "CA", "America/Glace_Bay": "CA", "America/Goose_Bay": "CA", "America/Swift_Current": "CA",
  "America/Dawson_Creek": "CA", "America/Fort_Nelson": "CA", "America/Rankin_Inlet": "CA", "America/Cambridge_Bay": "CA",
  "Canada/Eastern": "CA", "Canada/Pacific": "CA", "Canada/Central": "CA", "Canada/Mountain": "CA", "Canada/Atlantic": "CA",
  "Europe/Dublin": "IE", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Zurich": "CH", "Europe/Vienna": "AT",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI", "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ", "Europe/Athens": "GR", "Europe/Budapest": "HU", "Europe/Bucharest": "RO", "Europe/Luxembourg": "LU",
  "America/Lima": "PE", "America/Caracas": "VE", "America/Montevideo": "UY", "America/Guayaquil": "EC", "America/Sao_Paulo": "BR",
  "Pacific/Auckland": "NZ", "Asia/Tokyo": "JP", "Asia/Hong_Kong": "HK", "Asia/Singapore": "SG", "Asia/Shanghai": "CN",
  "Africa/Johannesburg": "ZA",
};
const ZONE_PREFIX: [string, string][] = [
  ["America/Argentina/", "AR"], ["America/Indiana/", "US"], ["America/Kentucky/", "US"], ["America/North_Dakota/", "US"], ["Australia/", "AU"],
];

export function zoneCountry(tz: string): string | null {
  return ZONE_COUNTRY[tz] ?? ZONE_PREFIX.find(([p]) => tz.startsWith(p))?.[1] ?? null;
}

/** The region of the system's locale ("en_US.UTF-8" -> "US"), from the variables the C library reads, else Intl's own locale; null without one. */
export function localeRegion(env: Env, intlLocale?: string): string | null {
  const region = (s: string | undefined): string | null => {
    const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec((s ?? "").trim());
    return m ? m[1]!.toUpperCase() : null;
  };
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const r = region(env[name]);
    if (r) return r;
  }
  if (intlLocale !== undefined) return region(intlLocale);
  try {
    return region(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

/**
 * The owner's country, two letters, "" when it cannot be told: PAKO_COUNTRY, else the time zone's country, else the system locale's region.
 * `problem` when PAKO_COUNTRY is set but not two letters (the rest of the order is then used).
 */
export function ownerCountry(env: Env, timeZone: string, intlLocale?: string): { country: string; problem?: string } {
  const raw = (env.PAKO_COUNTRY ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return { country: raw };
  const derived = zoneCountry(timeZone) ?? localeRegion(env, intlLocale) ?? "";
  return raw ? { country: derived, problem: `PAKO_COUNTRY must be two letters, like US or GB (${derived || "none"} is used)` } : { country: derived };
}

// ---------- the region dates are written in ----------

/** The owner's country once the server has read it; null before (a test, a tool), when everything stays as Pako always wrote it. */
let set: string | null = null;
let region = "";

/** Sets the owner's country for every date and phone number written from now on (at start, from ownerCountry); "" when it is not known. */
export function setOwnerRegion(country: string): void {
  region = /^[A-Z]{2}$/.test(country) ? country : "";
  set = region;
}

export const ownerRegion = (): string => region;

/** The locale when the country is not known, or this computer's Intl has no English data for it. */
const FALLBACK_LOCALE = "en-GB";

/**
 * The locale Pako writes dates and numbers in for the owner's country: English as that country writes it ("en-US", "en-AU", "en-IE",
 * "en-ES"), and en-GB when the country is not known or Intl only knows English there through plain "en" (Mexico, Argentina...: plain "en" is
 * US English, and a 12-hour clock with month first would be wrong in most such places). The first argument is the language of Pako's texts,
 * which is always English now; it stays so the callers did not have to change.
 */
export function localeFor(_lang: string = "en", country: string = region): string {
  if (!country) return FALLBACK_LOCALE;
  const tag = `en-${country}`;
  try {
    return new Intl.DateTimeFormat(tag).resolvedOptions().locale === tag ? tag : FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/** Whether a locale writes the time with AM/PM ("3:05 PM") rather than on a 24-hour clock ("15:05"). */
export function uses12h(locale: string): boolean {
  try {
    const c = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    return c === "h12" || c === "h11";
  } catch {
    return false;
  }
}

/** The owner's country as an attribute of a panel page's <html> (' data-region="US"'), so its dates are written as the server's; "" when unknown. */
export const regionAttr = (): string => (region ? ` data-region="${region}"` : "");

// ---------- phone numbers ----------

/**
 * How a number written without its country code ("612 34 56 78", "(415) 555-0100", "07700 900123") reads in a country: its calling code,
 * and the national numbers that take it (the trunk 0 dropped where the country dials one). Only for the countries Pako has help numbers for;
 * any other number stays as written, and a number with + or 00 is never touched.
 */
const NATIONAL: Record<string, { code: string; re: RegExp }> = {
  ES: { code: "34", re: /^([6789]\d{8})$/ },
  US: { code: "1", re: /^1?([2-9]\d{2}[2-9]\d{6})$/ },
  CA: { code: "1", re: /^1?([2-9]\d{2}[2-9]\d{6})$/ },
  GB: { code: "44", re: /^0([1-9]\d{8,9})$/ },
  FR: { code: "33", re: /^0([1-9]\d{8})$/ },
  DE: { code: "49", re: /^0([1-9]\d{6,12})$/ },
  IT: { code: "39", re: /^(3\d{8,9}|0\d{5,10})$/ },
  PT: { code: "351", re: /^([29]\d{8})$/ },
  MX: { code: "52", re: /^(\d{10})$/ },
  AR: { code: "54", re: /^0?([1-9]\d{9})$/ },
  CO: { code: "57", re: /^(3\d{9}|60\d{8})$/ },
  CL: { code: "56", re: /^([2-9]\d{8})$/ },
  AU: { code: "61", re: /^0([2-478]\d{8})$/ },
};

/**
 * The country a number without its code is read in: the owner's, once the server has said. Before that (a test, a tool) none: a number
 * without + or 00 is then left as written rather than guessed into some country.
 */
export const phoneCountry = (): string => set ?? "";

/** A country's calling code ("US" -> "1"), or null for a country not in the table above. */
export const callingCode = (country: string): string | null => NATIONAL[country]?.code ?? null;

/**
 * Digits as written, with no + or 00 in front, read as a national number of a country: "612345678" in Spain is "+34612345678", "4155550100"
 * in the US "+14155550100". Null when they are not a national number there.
 */
export function nationalNumber(digits: string, country: string = phoneCountry()): string | null {
  const n = NATIONAL[country];
  const m = n ? n.re.exec(digits) : null;
  return n && m ? `+${n.code}${m[1]}` : null;
}
