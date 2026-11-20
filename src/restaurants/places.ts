// Real restaurants from Google Places API (New): name, address, rating, price, phone, website and opening hours.
// Places has no reservation-link field, so the booking platform is found on the restaurant's own website.
//
// Terms (developers.google.com/maps/documentation/places/web-service/policies): place IDs may be stored;
// other content is re-fetched rather than stored, and results shown to people carry a "Google Maps" credit
// and a link to the place. Billing is per call at the tier of the richest field asked for: these masks use
// Enterprise fields (rating, hours, phone, website) and avoid the costlier Atmosphere ones.

import { ownerRegion } from "../region.ts";

export interface OpeningPeriod {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
}

export interface Place {
  id: string;
  name: string;
  address: string;
  primaryType?: string;
  rating?: number;
  ratingCount?: number;
  /** "$" to "$$$$". */
  price?: string;
  /** E.164, e.g. +12125550123. */
  phone?: string;
  /** For people to read, e.g. (212) 555-0123. */
  phoneDisplay?: string;
  website?: string;
  mapsUrl?: string;
  /** Google shows "Reserve a table" for this place (Reserve with Google, through its booking partner). */
  reservable?: boolean;
  businessStatus?: string;
  periods?: OpeningPeriod[];
  /** This week's actual hours from Google, holidays included (currentOpeningHours: the next 7 days). */
  thisWeek?: OpeningPeriod[];
  /** Dates (YYYY-MM-DD) with special hours this week, e.g. closed on Thanksgiving. */
  specialDays?: string[];
}

export interface PlaceDirectory {
  readonly name: string;
  /** `type`: a Google place type to restrict to; null for no type (default: restaurants). */
  searchText(query: string, max: number, type?: string | null): Promise<Place[]>;
  details(id: string): Promise<Place | undefined>;
}

const FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "primaryType",
  "rating",
  "userRatingCount",
  "priceLevel",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "websiteUri",
  "googleMapsUri",
  "businessStatus",
  "regularOpeningHours",
  "currentOpeningHours",
];

const PRICE: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

/** "+1 212-555-0123" -> "+12125550123". Undefined unless it is a plausible E.164 number. */
export function toE164(international: string | undefined): string | undefined {
  if (!international) return undefined;
  // Drop an extension first ("+1 212-555-0123 ext. 45"), or its digits would be dialled as part of the number.
  const digits = international.split(/\s*(?:ext\.?|extension|x|#|;)\s*\d/i)[0]!.replace(/[^\d+]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : undefined;
}

type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  primaryType?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  reservable?: boolean;
  businessStatus?: string;
  regularOpeningHours?: { periods?: OpeningPeriod[] };
  currentOpeningHours?: { periods?: OpeningPeriod[]; specialDays?: { date?: { year?: number; month?: number; day?: number } }[] };
};

/** Business-editable text: one line, no control characters, bounded. */
export function clean(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || undefined;
}

export function fromRaw(p: RawPlace): Place | undefined {
  const name = clean(p.displayName?.text, 100);
  if (!p.id || !/^[A-Za-z0-9_-]{1,290}$/.test(p.id) || !name) return undefined;
  return fromRawChecked(p as RawPlace & { id: string }, name);
}

/** A business-supplied URL, only if it parses as http(s); re-serialised so stray text cannot ride along. */
function safeUrl(raw: string | undefined, hosts?: RegExp): string | undefined {
  if (!raw || raw.length > 500) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (hosts && (u.protocol !== "https:" || !hosts.test(u.hostname))) return undefined;
    return u.href;
  } catch {
    /* not a URL: none */
    return undefined;
  }
}

function fromRawChecked(p: RawPlace & { id: string }, name: string): Place {
  const website = safeUrl(p.websiteUri);
  return {
    id: p.id,
    name,
    address: clean(p.formattedAddress, 200) ?? "",
    primaryType: p.primaryType,
    rating: p.rating,
    ratingCount: p.userRatingCount,
    price: p.priceLevel ? PRICE[p.priceLevel] : undefined,
    phone: toE164(p.internationalPhoneNumber),
    phoneDisplay: clean(p.nationalPhoneNumber, 30),
    website,
    mapsUrl: safeUrl(p.googleMapsUri, /^(?:www\.|maps\.)?google\.com$|^maps\.app\.goo\.gl$/),
    ...(p.reservable === true ? { reservable: true as const } : {}),
    businessStatus: p.businessStatus,
    periods: p.regularOpeningHours?.periods,
    thisWeek: p.currentOpeningHours?.periods,
    specialDays: (p.currentOpeningHours?.specialDays ?? [])
      .map((d) => d.date)
      .filter((d): d is { year: number; month: number; day: number } => !!d && typeof d.year === "number" && typeof d.month === "number" && typeof d.day === "number")
      .map((d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`),
  };
}

const WEEK = 7 * 24 * 60;

/**
 * Is the restaurant open long enough at this local time ("2026-11-20T19:30") to seat a party?
 * Requires `sitMinutes` of opening left after the slot, since kitchens stop seating before closing.
 * Undefined when Google has no hours.
 */
export function openAt(periods: OpeningPeriod[] | undefined, slot: string, sitMinutes = 45): boolean | undefined {
  if (!Array.isArray(periods) || periods.length === 0) return undefined;
  const day = new Date(`${slot.slice(0, 10)}T00:00:00Z`).getUTCDay(); // 0 = Sunday, same as Google
  const [h, m] = slot.slice(11, 16).split(":").map(Number);
  if (!Number.isInteger(day) || !Number.isFinite(h) || !Number.isFinite(m)) return undefined;
  const t = day * 24 * 60 + h! * 60 + m!;
  const at = (x: { day?: unknown; hour?: unknown; minute?: unknown } | undefined) =>
    x && typeof x.day === "number" ? x.day * 24 * 60 + (typeof x.hour === "number" ? x.hour : 0) * 60 + (typeof x.minute === "number" ? x.minute : 0) : undefined;
  // Mark every open minute of the week, then check the whole sitting. Periods that touch (17:00-24:00 then
  // 00:00-02:00, or seven 24-hour days) join up, which checking each period alone would miss.
  const open = new Uint8Array(WEEK);
  for (const p of periods) {
    const start = at(p?.open);
    if (start === undefined) return undefined; // malformed hours: unknown, not closed
    if (!p.close) return true; // open 24 hours
    let end = at(p.close);
    if (end === undefined) return undefined;
    if (p.close.hour === 23 && p.close.minute === 59) end += 1; // "until 23:59" means until midnight
    if (end <= start) end += WEEK; // wraps past Saturday night (or open == close: the whole week)
    for (let x = start; x < end; x++) open[x % WEEK] = 1;
  }
  for (let x = t; x < t + sitMinutes; x++) if (!open[x % WEEK]) return false;
  return true;
}

/**
 * Open at this slot, by this week's real hours when the slot falls within the next 7 days (holiday closures,
 * e.g. Thanksgiving), else by the regular weekly hours.
 */
export function placeOpenAt(place: Pick<Place, "periods" | "thisWeek">, slot: string, now = Date.now(), sitMinutes = 45, timeZone?: string): boolean | undefined {
  // Google's "this week" starts on the restaurant's own today. With a time zone that is exact; without one, the furthest-behind US date (a day early: safe, never late).
  const today = timeZone ? new Intl.DateTimeFormat("en-CA", { timeZone }).format(now) : new Date(now - 11 * 3600_000).toISOString().slice(0, 10);
  const lastDay = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 24 * 3600_000).toISOString().slice(0, 10);
  const day = slot.slice(0, 10);
  if (place.thisWeek && place.thisWeek.length > 0 && day >= today && day <= lastDay) {
    const r = openAt(place.thisWeek, slot, sitMinutes);
    if (r !== undefined) return r;
  }
  return openAt(place.periods, slot, sitMinutes);
}

export class GooglePlaces implements PlaceDirectory {
  readonly name = "google-places";
  private key: string;
  private fetchImpl: typeof fetch;
  private language: string;
  private region: string;

  /**
   * `language` and `region` are what Google answers in and biases to: English (Pako's own language), and the owner's country
   * (src/region.ts) as it is when the server starts; no bias at all when that is not known.
   */
  constructor(key: string, fetchImpl: typeof fetch = fetch, o: { language?: string; region?: string } = {}) {
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.language = o.language ?? "en";
    this.region = o.region ?? ownerRegion();
  }

  async searchText(query: string, max: number, type: string | null = "restaurant"): Promise<Place[]> {
    const res = await this.fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.key,
        "x-goog-fieldmask": FIELDS.map((f) => `places.${f}`).join(","),
      },
      body: JSON.stringify({ textQuery: query, ...(type ? { includedType: type, strictTypeFiltering: true } : {}), pageSize: max, languageCode: this.language, ...(this.region ? { regionCode: this.region } : {}) }),
    });
    if (!res.ok) throw new Error(`Google Places search failed: HTTP ${res.status}`);
    const body = (await res.json()) as { places?: RawPlace[] };
    return (body.places ?? []).map(fromRaw).filter((p): p is Place => !!p);
  }

  async details(id: string): Promise<Place | undefined> {
    const res = await this.fetchImpl(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=${this.language}${this.region ? `&regionCode=${this.region}` : ""}`, {
      signal: AbortSignal.timeout(15_000),
      // "reservable" (Google's "Reserve a table") is a premium field: asked only here, once per booking, not per search.
      headers: { "x-goog-api-key": this.key, "x-goog-fieldmask": [...FIELDS, "reservable"].join(",") },
    });
    if (res.status === 404 || res.status === 400) return undefined;
    if (!res.ok) throw new Error(`Google Places details failed: HTTP ${res.status}`);
    return fromRaw((await res.json()) as RawPlace);
  }
}
