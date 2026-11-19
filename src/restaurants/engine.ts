// Real-restaurant engine: Google Places for the restaurant, its own website for the booking platform, and a
// ranked list of ways to get the table. Nothing here books by itself: the agent picks the route.

import { KNOWN_BOOKING_PAGES, KNOWN_CONTACTS, KNOWN_PLATFORM_LINKS } from "./known-platforms.ts";
import {
  bookingShortLinks,
  bookingUrl,
  chooseTarget,
  depositPolicy,
  detectAllBookingPlatforms,
  reservationsPageLink,
  restaurantEmail,
  restaurantWhatsapp,
  walkInOnly,
  type BookingTarget,
} from "./booking-links.ts";
import { chooseWidgetPage, detectWidgetPages, widgetEngineOf } from "./booking-widgets.ts";
import { placeOpenAt, type Place, type PlaceDirectory } from "./places.ts";
import type { PageFetcher } from "./website.ts";
import { createLog } from "../log.ts";

const log = createLog("restaurants");

export const PLACE_PREFIX = "gp_";
/** Longest we wait to read one restaurant's website during a search. */
const DETECT_TIMEOUT_MS = 10_000;

/** Google place types we treat as somewhere one books a table. */
const FOOD_TYPES = new Set(["restaurant", "bar", "pub", "cafe", "bistro", "brasserie", "diner", "steak_house", "pizzeria", "wine_bar", "cocktail_bar", "tavern", "winery", "brewery", "izakaya", "food_court", "bar_and_grill", "gastropub", "fine_dining_restaurant"]);

/** Google place types we treat as somewhere one books a table. Whole types only: "barber_shop" is not a bar. */
export function isFoodPlace(primaryType: string | undefined): boolean {
  return !!primaryType && (FOOD_TYPES.has(primaryType) || primaryType.endsWith("_restaurant"));
}

/** Where a site check survives a restart (the key-value store); optional. */
export interface SiteMemory {
  getSiteCheck(placeId: string): { targetJson?: string; walkIn?: string; ownPage?: string; email?: string; whatsapp?: string; depositPolicy?: string; checkedAt: number } | undefined;
  putSiteCheck(placeId: string, c: { targetJson?: string; walkIn?: string; ownPage?: string; email?: string; whatsapp?: string; depositPolicy?: string }): void;
}

export interface LiveRestaurant {
  restaurantId: string;
  place: Place;
  /** Open long enough at the requested time to seat a party. Undefined when Google has no hours. */
  openAtSlot: boolean | undefined;
  booking?: { target: BookingTarget; url: string };
  /**
   * The restaurant's page on a reservation engine (CoverManager, TheFork, Restoo...), read from its own website or
   * known by heart: where a browser task books it, with that engine's steps.
   */
  widget?: { engine: string; url: string };
  /** What the restaurant's own site says about paying to book (a deposit, a card to hold the table), in its words. */
  depositPolicy?: string;
  /** False while the website check is still running (it finishes in the background). */
  bookingChecked?: boolean;
  /** The restaurant's own words that it takes no reservations, when its website says so. */
  walkIn?: string;
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]).finally(() => clearTimeout(timer));
}

export class RestaurantEngine {
  readonly name: string;
  private places: PlaceDirectory;
  private pages: PageFetcher;
  /** Platform per place id, from the restaurant's own site (not Google content), kept a day. */
  private platformCache = new Map<string, { at: number; target: BookingTarget | undefined }>();
  /** The reservations page found on a restaurant's own site, for a browser task to start on (skips the homepage). */
  private ownPages = new Map<string, string>();
  /** Sites that could not be read, by place id, with when. */
  private unreadable = new Map<string, number>();
  /** The guest email address the restaurant publishes on its own site, by place id. */
  private emails = new Map<string, string>();

  private setEmail(placeId: string, email: string): void {
    this.emails.set(placeId, email);
    if (this.emails.size > 5000) this.emails.delete(this.emails.keys().next().value!);
  }

  /** The restaurant's published guest email, if its website shows one. */
  reservationEmail(restaurantId: string): string | undefined {
    const id = restaurantId.startsWith(PLACE_PREFIX) ? restaurantId.slice(PLACE_PREFIX.length) : restaurantId;
    // The curated address (checked by hand) beats whatever a page says today; a page's address is only used for restaurants nobody listed.
    return KNOWN_CONTACTS[id]?.email ?? this.emails.get(id);
  }

  /** What the restaurant's own site says about paying to book, by place id. */
  private depositPolicies = new Map<string, string>();

  private setDepositPolicy(placeId: string, html: string | undefined): void {
    const words = html ? depositPolicy(html) : undefined;
    if (!words || this.depositPolicies.has(placeId)) return;
    this.depositPolicies.set(placeId, words);
    if (this.depositPolicies.size > 5000) this.depositPolicies.delete(this.depositPolicies.keys().next().value!);
  }

  /** The WhatsApp number the restaurant publishes on its own site, by place id. */
  private whatsapps = new Map<string, string>();

  private setWhatsapp(placeId: string, html: string | undefined): void {
    const number = html ? restaurantWhatsapp(html) : undefined;
    if (!number || this.whatsapps.has(placeId)) return;
    this.whatsapps.set(placeId, number);
    if (this.whatsapps.size > 5000) this.whatsapps.delete(this.whatsapps.keys().next().value!);
  }

  /**
   * The WhatsApp number the restaurant publishes for guests (digits with country code): known by heart, or read from
   * its own website. The customer sends the message themselves; the connector never does.
   */
  reservationWhatsapp(restaurantId: string): string | undefined {
    const id = restaurantId.startsWith(PLACE_PREFIX) ? restaurantId.slice(PLACE_PREFIX.length) : restaurantId;
    return KNOWN_CONTACTS[id]?.whatsapp ?? this.whatsapps.get(id);
  }

  /** What the restaurant's own site says when it takes no reservations ("Walk-in only"), by place id. */
  private walkIns = new Map<string, string>();
  private ttlMs: number;

  private detectTimeoutMs: number;

  constructor(places: PlaceDirectory, pages: PageFetcher, ttlMs = 24 * 60 * 60_000, detectTimeoutMs = DETECT_TIMEOUT_MS) {
    this.places = places;
    this.pages = pages;
    this.ttlMs = ttlMs;
    this.detectTimeoutMs = detectTimeoutMs;
    this.name = places.name;
  }

  /** Where checks survive a restart (the database); optional. */
  memory?: SiteMemory;
  /** The owner's time zone: "this week's hours" start on the restaurant's own today. */
  timeZone?: string;

  /** Booking platform from the restaurant's website. Never throws; undefined when unknown. */
  async platformFor(place: Place): Promise<BookingTarget | undefined> {
    // Known from a real booking (the site's widget loads by script, invisible to a page check).
    const known = KNOWN_PLATFORM_LINKS[place.id];
    if (known) {
      const target = RestaurantEngine.targetFromLink(known);
      if (target) return target;
    }
    if (!place.website) return undefined;
    let hit = this.platformCache.get(place.id);
    if (!hit && this.memory) {
      const saved = this.memory.getSiteCheck(place.id);
      if (saved && Date.now() - saved.checkedAt < this.ttlMs) {
        let target: BookingTarget | undefined;
        try {
          target = saved.targetJson ? (JSON.parse(saved.targetJson) as BookingTarget) : undefined;
        } catch {
          target = undefined;
        }
        hit = { at: saved.checkedAt, target };
        this.platformCache.set(place.id, hit);
        if (saved.walkIn) this.walkIns.set(place.id, saved.walkIn);
        if (saved.ownPage) this.ownPages.set(place.id, saved.ownPage);
        if (saved.email) this.setEmail(place.id, saved.email);
        if (saved.whatsapp) this.whatsapps.set(place.id, saved.whatsapp);
        if (saved.depositPolicy) this.depositPolicies.set(place.id, saved.depositPolicy);
      }
    }
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.target;
    const website = place.website;
    const look = async () => {
      const html = await this.pages.fetchHomepage(website);
      // A fresh reading replaces what an earlier one found: a restaurant that left its booking engine, changed its
      // WhatsApp number or dropped its deposit must not be sent to the old ones for ever.
      if (html !== undefined) {
        this.ownPages.delete(place.id);
        this.whatsapps.delete(place.id);
        this.depositPolicies.delete(place.id);
        this.emails.delete(place.id);
      }
      const walkIn = html ? walkInOnly(html) : undefined;
      const email = html ? restaurantEmail(html, website) : undefined;
      if (email) this.setEmail(place.id, email);
      this.setWhatsapp(place.id, html);
      this.setDepositPolicy(place.id, html);
      if (walkIn) {
        this.walkIns.set(place.id, walkIn);
        if (this.walkIns.size > 5000) this.walkIns.delete(this.walkIns.keys().next().value!);
      }
      else this.walkIns.delete(place.id);
      // The website itself may be the platform page (some restaurants list a Resy or Tock page as their site).
      const found = chooseTarget(detectAllBookingPlatforms(`${website}\n${html ?? ""}`), place);
      if (found || html === undefined) return { html, found };
      // A reservation engine's page for this restaurant (CoverManager, TheFork, Restoo...), embedded or linked on its
      // site: the booking starts there. Nothing more needs reading.
      if (await this.rememberWidget(place, `${website}\n${html}`)) return { html, found: undefined };
      // Short links to the booking page ("bit.ly/LartusiRESY"): read where they point, without following them.
      if (this.pages.resolveShortLink) {
        const targets = await Promise.all(bookingShortLinks(html).map((l) => this.pages.resolveShortLink!(l)));
        const viaShort = chooseTarget(detectAllBookingPlatforms(targets.filter(Boolean).join("\n")), place);
        if (viaShort) return { html, found: viaShort };
      }
      // One more page at most: the site's own reservations page.
      const next = reservationsPageLink(html, website);
      if (next) {
        this.ownPages.set(place.id, next);
        if (this.ownPages.size > 5000) this.ownPages.delete(this.ownPages.keys().next().value!);
      }
      const sub = next ? await this.pages.fetchHomepage(next) : undefined;
      // The engine's page is often only on the reservations page: it replaces that page as the place to book.
      if (sub) await this.rememberWidget(place, sub);
      this.setWhatsapp(place.id, sub);
      this.setDepositPolicy(place.id, sub);
      if (sub && !this.emails.has(place.id)) {
        const subEmail = restaurantEmail(sub, website);
        if (subEmail) this.setEmail(place.id, subEmail);
      }
      return { html, found: sub ? chooseTarget(detectAllBookingPlatforms(sub), place) : undefined };
    };
    const remember = (html: string | undefined, found: BookingTarget | undefined) => {
      const target = found ?? chooseTarget(detectAllBookingPlatforms(website), place);
      // A failed fetch is not cached, so a slow site gets another chance next time.
      if (html !== undefined || target) {
        this.platformCache.set(place.id, { at: Date.now(), target });
        try {
          this.memory?.putSiteCheck(place.id, { targetJson: target ? JSON.stringify(target) : undefined, walkIn: this.walkIns.get(place.id), ownPage: this.ownPages.get(place.id), email: this.emails.get(place.id), whatsapp: this.whatsapps.get(place.id), depositPolicy: this.depositPolicies.get(place.id) });
        } catch (err) {
          log.warn(`Could not save the site check for ${place.id}: ${(err as Error).message}`);
        }
        if (this.platformCache.size > 5000) this.platformCache.delete(this.platformCache.keys().next().value!);
      } else {
        // The site could not be read (down, blocked, robots.txt): not cached, so it is tried again, but the search
        // says "none found" rather than "still checking" for the next half hour.
        this.unreadable.set(place.id, Date.now());
        if (this.unreadable.size > 5000) this.unreadable.delete(this.unreadable.keys().next().value!);
      }
      return target;
    };
    const lookup = look();
    const got = await bounded(lookup, this.detectTimeoutMs).catch(() => undefined);
    if (!got) {
      // Too slow for this search (many sites are checked at once): keep going in the background, so the result is
      // ready when the customer books, instead of reporting "no online booking" for a site that has it.
      lookup.then((r) => remember(r.html, r.found)).catch(() => undefined);
      return chooseTarget(detectAllBookingPlatforms(website), place);
    }
    return remember(got.html, got.found);
  }

  /**
   * A booking-platform link the assistant found itself (the restaurant's OpenTable or Resy page, say) when the site
   * check found none: only https links on the platforms' own domains, read for the platform id; nothing is fetched.
   */
  static targetFromLink(link: string): BookingTarget | undefined {
    let u: URL;
    try {
      u = new URL(link.trim());
    } catch {
      return undefined;
    }
    const host = u.hostname.toLowerCase();
    const own = ["opentable.com", "resy.com", "exploretock.com", "sevenrooms.com", "yelp.com"].some((d) => host === d || host.endsWith(`.${d}`));
    if (u.protocol !== "https:" || !own) return undefined;
    // Only this link's own host and path (and OpenTable's rid parameter): a query string naming another platform
    // (e.g. ?u=resy.com/...) must not become the restaurant's booking target.
    const rid = /(^|\.)opentable\.com$/.test(host) ? u.searchParams.get("rid") ?? u.searchParams.get("restref") : null;
    const path = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/, "");
    const text = `https://${host}${path}${rid && /^\d{1,9}$/.test(rid) ? `?rid=${rid}` : ""}`;
    const platformOf = (h: string) => (/opentable/.test(h) ? "opentable" : /resy/.test(h) ? "resy" : /tock/.test(h) ? "tock" : /sevenrooms/.test(h) ? "sevenrooms" : "yelp");
    return detectAllBookingPlatforms(text).find((t) => t.platform === platformOf(host));
  }

  /**
   * Keeps the reservation engine's page found in this HTML as the restaurant's booking page. True when one was found.
   * The page is read once first: a restaurant that switched its module off (or left the engine) still links it, and
   * the engine then answers with one line, "The booking module is temporarily disabled". Such a page is not used.
   * A page we may not read (robots.txt) is taken as it is.
   */
  private async rememberWidget(place: Place, html: string): Promise<boolean> {
    const page = chooseWidgetPage(detectWidgetPages(html), place);
    if (!page) return false;
    const live = await this.pages.fetchHomepage(page.url).catch(() => undefined);
    if (live !== undefined && (live.trim().length < 100 || (live.length < 3000 && /temporarily disabled|temporalmente deshabilitad|no longer available/i.test(live)))) return false;
    this.ownPages.set(place.id, page.url);
    if (this.ownPages.size > 5000) this.ownPages.delete(this.ownPages.keys().next().value!);
    return true;
  }

  /** The engine page a restaurant is booked on, known by heart or found on its site. */
  widgetFor(restaurantId: string): { engine: string; url: string } | undefined {
    const url = this.ownBookingPage(restaurantId);
    const engine = widgetEngineOf(url);
    if (url && engine) return { engine, url };
    // A page checked by hand (the curated list) is offered even when it is on the restaurant's own domain.
    const id = restaurantId.startsWith(PLACE_PREFIX) ? restaurantId.slice(PLACE_PREFIX.length) : restaurantId;
    return KNOWN_BOOKING_PAGES[id] ? { engine: "its booking page", url: KNOWN_BOOKING_PAGES[id]! } : undefined;
  }

  ownBookingPage(restaurantId: string): string | undefined {
    const id = restaurantId.startsWith(PLACE_PREFIX) ? restaurantId.slice(PLACE_PREFIX.length) : restaurantId;
    return KNOWN_BOOKING_PAGES[id] ?? this.ownPages.get(id);
  }

  /** Whether this restaurant's website has been checked (a slow site may still be in progress). */
  bookingChecked(placeId: string): boolean {
    const hit = this.platformCache.get(placeId);
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs) return true;
    const failed = this.unreadable.get(placeId);
    return failed !== undefined && Date.now() - failed < 30 * 60_000;
  }

  private async enrich(place: Place, slot: string, partySize: number): Promise<LiveRestaurant> {
    const target = await this.platformFor(place);
    return {
      restaurantId: PLACE_PREFIX + place.id,
      place,
      openAtSlot: placeOpenAt(place, slot, Date.now(), 45, this.timeZone),
      booking: target ? { target, url: bookingUrl(target, slot, partySize) } : undefined,
      widget: target ? undefined : this.widgetFor(place.id),
      depositPolicy: this.depositPolicies.get(place.id),
      bookingChecked: target !== undefined || this.bookingChecked(place.id),
      walkIn: target ? undefined : this.walkIns.get(place.id),
    };
  }

  /** The restaurants for "what" (a kind of food, a district, a city: "sushi in Shoreditch, London") that are operating and not known to be closed at the slot. */
  async search(q: { what: string; slot: string; partySize: number; max?: number }): Promise<LiveRestaurant[]> {
    const all = await this.places.searchText(q.what.slice(0, 200), q.max ?? 10);
    // Closed ones are dropped before their websites are read: no point fetching a page we will not show.
    const candidates = all.filter((p) => (!p.businessStatus || p.businessStatus === "OPERATIONAL") && placeOpenAt(p, q.slot, Date.now(), 45, this.timeZone) !== false);
    return Promise.all(candidates.map((p) => this.enrich(p, q.slot, q.partySize)));
  }

  /** Fresh details for one restaurant (Google content is re-fetched, not stored). */
  async get(restaurantId: string, slot: string, partySize: number): Promise<LiveRestaurant | undefined> {
    if (!restaurantId.startsWith(PLACE_PREFIX)) return undefined;
    const place = await this.places.details(restaurantId.slice(PLACE_PREFIX.length));
    return place ? this.enrich(place, slot, partySize) : undefined;
  }
}
