import { nationalNumber } from "../region.ts";
// Booking platforms a restaurant uses, found on its own public website, and links to that platform's own
// booking page with the date, time and party size filled in.
//
// No reservation platform gives an outside app an open booking API (OpenTable and Yelp are partner-only under
// contract; Resy, Tock and SevenRooms have no consumer route), and their terms forbid bots. So the customer
// finishes the booking on the platform's page themselves. These link formats are observed, not documented:
// if a platform ignores a parameter, the link still opens the right restaurant's booking page.

export type Platform = "opentable" | "resy" | "tock" | "sevenrooms" | "yelp";

export interface BookingTarget {
  platform: Platform;
  /** OpenTable: numeric rid, or "r/<slug>". Resy: venue slug. Tock, SevenRooms: slug. Yelp: business alias. */
  id: string;
  /** Resy only: city slug, e.g. "new-york-ny". */
  city?: string;
  /** The location name the site shows next to this booking option ("SoHo", "Coral Gables"), when it has one. */
  label?: string;
}

export const PLATFORM_NAMES: Record<Platform, string> = {
  opentable: "OpenTable",
  resy: "Resy",
  tock: "Tock",
  sevenrooms: "SevenRooms",
  yelp: "Yelp",
};

const SLUG = "[a-z0-9][a-z0-9-]{0,80}";
/** Paths on exploretock.com that are not a restaurant. */
const TOCK_RESERVED = new Set(["tock", "api", "help", "city", "search", "explore", "login", "signup", "giftcards", "gift-cards", "about", "careers", "terms", "privacy", "static", "widget", "embed", "partners"]);
/** resy.com/cities/<city>/<word> pages that are not a restaurant (lists, guides, events). */
const RESY_RESERVED = new Set(["search", "list", "lists", "collections", "collection", "events", "event", "guides", "guide", "hit-list", "editorial", "features", "venues", "about"]);
/** opentable.com/<word> pages that are not a restaurant. */
const OPENTABLE_RESERVED = new Set(["gift-cards", "giftcards", "my-profile", "user-profile", "sign-in", "sign-up", "start-dining", "restaurant-reservations", "about-us", "privacy-policy", "terms-of-use", "cookie-policy", "help-center", "dining-rewards", "best-restaurants", "new-restaurants", "booking-widget", "widget-builder", "for-restaurants", "restaurant-solutions"]);
const SEVENROOMS_RESERVED = new Set(["widget", "explore", "reservations", "static", "api", "manager"]);

/** Every distinct booking target in a page's HTML (links, widget scripts, iframes), in platform priority order. */
export function detectAllBookingPlatforms(html: string): BookingTarget[] {
  // Bounded work on hostile pages: the 1.5 MB the fetcher reads (Squarespace and Wix pages put the booking link
  // past 500 KB), at most 40 distinct targets, Set-based de-duplication.
  const h = html.slice(0, 1_500_000).replace(/&amp;/g, "&").replace(/\\\//g, "/");
  const out: BookingTarget[] = [];
  const seen = new Set<string>();
  const add = (t: BookingTarget) => {
    const key = `${t.platform}|${t.id}|${t.city ?? ""}`;
    if (out.length < 40 && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  };
  const all = (re: string) => [...h.matchAll(new RegExp(re, "gi"))];

  // OpenTable: rid in widget loaders, restref links and profile links; or an /r/<slug> profile.
  for (const m of all(`opentable\\.com\\/[^"'\\s<>]{0,300}?[?&](?:rid|restref)=(\\d{1,9})`)) add({ platform: "opentable", id: m[1]! });
  for (const m of all(`opentable\\.com\\/restaurant\\/profile\\/(\\d{1,9})`)) add({ platform: "opentable", id: m[1]! });
  for (const m of all(`opentable\\.com\\/r\\/(${SLUG})`)) add({ platform: "opentable", id: `r/${m[1]!.toLowerCase()}` });
  // Vanity profile pages: opentable.com/san-carlo-osteria-piemonte (a hyphenated slug that is not a site page).
  for (const m of all(`opentable\\.com\\/(${SLUG})(?=[/?#"'\\s<]|$)`)) {
    const slug = m[1]!.toLowerCase();
    if (slug.includes("-") && !OPENTABLE_RESERVED.has(slug) && !/^(?:s|c|r|lp|m|n|p)$/.test(slug) && !/^[a-z]{2}-[a-z]{2}$/.test(slug)) add({ platform: "opentable", id: slug });
  }

  // Resy: resy.com/cities/<city>/venues/<slug> or the older resy.com/cities/<city>/<slug>.
  for (const m of all(`resy\\.com\\/cities\\/(${SLUG})\\/(?:venues\\/)?(${SLUG})`)) {
    if (!RESY_RESERVED.has(m[2]!.toLowerCase())) add({ platform: "resy", id: m[2]!.toLowerCase(), city: m[1]!.toLowerCase() });
  }

  // Tock: exploretock.com/<slug>, skipping site paths like /tock.js; or tock('init', '<slug>').
  for (const m of all(`exploretock\\.com\\/(${SLUG})(?=[/?#"'\\s<]|$)`)) {
    if (!TOCK_RESERVED.has(m[1]!.toLowerCase())) add({ platform: "tock", id: m[1]!.toLowerCase() });
  }
  for (const m of all(`tock\\(\\s*['"]init['"]\\s*,\\s*['"](${SLUG})['"]`)) add({ platform: "tock", id: m[1]!.toLowerCase() });

  // SevenRooms: /reservations/<slug> or /explore/<slug>/..., or the widget's venueId.
  for (const m of all(`sevenrooms\\.com\\/(?:reservations|explore)\\/(${SLUG})`)) {
    if (!SEVENROOMS_RESERVED.has(m[1]!.toLowerCase())) add({ platform: "sevenrooms", id: m[1]!.toLowerCase() });
  }
  if (/sevenrooms\.com\/widget\/embed\.js/i.test(h)) {
    for (const m of all(`venueId\\s*:\\s*['"](${SLUG})['"]`)) add({ platform: "sevenrooms", id: m[1]!.toLowerCase() });
  }

  // BentoBox sites (a very common restaurant website builder) keep the booking in a form: one element per
  // location, e.g. <option data-reservation-service="opentable" data-reservation-id="1182799">SoHo</option>.
  // Found by the attribute and read around it (a lazy pattern over `<tag ...` would be quadratic on a hostile page of 1.5 MB).
  let seenBento = 0;
  for (const m of h.matchAll(/data-reservation-service\s*=\s*["'](opentable|tock|sevenrooms|yelp)["']/gi)) {
    if (++seenBento > 40) break;
    const start = h.lastIndexOf("<", m.index!);
    const end = h.indexOf(">", m.index! + m[0].length);
    if (start < 0 || end < 0 || m.index! - start > 400 || end - m.index! > 400) continue;
    const tag = h.slice(start, end + 1);
    const id = /data-reservation-id\s*=\s*["']([^"']{1,80})["']/i.exec(tag)?.[1]?.trim().toLowerCase();
    if (!id) continue;
    const label = /^[^<]{0,80}/.exec(h.slice(end + 1, end + 81))?.[0].replace(/\s+/g, " ").trim().slice(0, 60) || undefined;
    const platform = m[1]!.toLowerCase() as Platform;
    if (platform === "opentable" ? /^\d{1,9}$/.test(id) : new RegExp(`^${SLUG}$`).test(id)) add({ platform, id, label });
  }

  // Yelp Reservations.
  for (const m of all(`yelp\\.com\\/reservations\\/(${SLUG})`)) add({ platform: "yelp", id: m[1]!.toLowerCase() });
  return out;
}

/** The first booking target in a page, by platform priority. */
export function detectBookingPlatform(html: string): BookingTarget | undefined {
  return detectAllBookingPlatforms(html)[0];
}

const PRIORITY: Platform[] = ["opentable", "resy", "tock", "sevenrooms", "yelp"];
const FILLER = new Set(["r", "at", "the", "and", "restaurant", "restaurants", "reservations", "reservation", "booking", "book", "nyc", "usa", "us", "bar", "grill", "kitchen", "cafe", "steakhouse"]);
const STATES: Record<string, string[]> = { ny: ["new", "york"], ca: ["california"], il: ["illinois"], fl: ["florida"], tx: ["texas"], dc: ["washington"] };
/** City shortcodes in booking links ("resy.com/cities/sf/..."): they stand for the city in the address. */
const CITY_CODES: Record<string, string[]> = {
  sf: ["san", "francisco"], la: ["los", "angeles"], chi: ["chicago"], nola: ["new", "orleans"], lv: ["las", "vegas"], atx: ["austin"],
  mia: ["miami"], phl: ["philadelphia"], philly: ["philadelphia"], bos: ["boston"], sea: ["seattle"], atl: ["atlanta"], den: ["denver"],
  pdx: ["portland"], sd: ["san", "diego"], hou: ["houston"], dal: ["dallas"], nash: ["nashville"], bk: ["brooklyn"], wdc: ["washington"],
};
/** Cities inside a metro that booking platforms file under the big city ("la" on Resy for West Hollywood). */
const METROS: Record<string, string[][]> = {
  "los angeles": [["west", "hollywood"], ["hollywood"], ["santa", "monica"], ["beverly", "hills"], ["culver", "city"], ["venice"], ["pasadena"], ["burbank"], ["malibu"], ["marina", "del", "rey"], ["studio", "city"], ["sherman", "oaks"], ["manhattan", "beach"], ["long", "beach"]],
  "new york": [["brooklyn"], ["queens"], ["bronx"], ["staten", "island"], ["long", "island", "city"], ["astoria"]],
  "san francisco": [["oakland"], ["berkeley"], ["sausalito"]],
  miami: [["miami", "beach"], ["coral", "gables"], ["coconut", "grove"], ["key", "biscayne"]],
  chicago: [["evanston"], ["oak", "park"]],
  washington: [["arlington"], ["bethesda"], ["alexandria"]],
  boston: [["cambridge"], ["somerville"], ["brookline"]],
  "las vegas": [["paradise"], ["henderson"]],
  phoenix: [["scottsdale"], ["tempe"]],
};

function words(text: string): string[] {
  // "Española" is "espanola" in a booking link: drop accents before splitting. German umlauts are also written
  // "ue/oe/ae" ("suppenkueche" for Suppenküche): words() of a name returns both spellings.
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0 && !FILLER.has(w));
}

/** "atomixnyc" for Atomix: a name word run together with filler ("nyc") or nothing is still the name. */
function isNameWord(w: string, name: Set<string>): boolean {
  if (name.has(w)) return true;
  // Possessive run-togethers too: "rosemarys" for Rosemary's.
  for (const n of name) if (n.length >= 3 && w.startsWith(n) && (w.length === n.length || w.slice(n.length) === "s" || FILLER.has(w.slice(n.length)))) return true;
  return false;
}

/**
 * Restaurant groups link every location's booking page from one website (Peter Luger's lists Brooklyn,
 * Great Neck and Las Vegas). Pick the one that fits this restaurant's address: words in the booking id or
 * Resy city that are not part of the restaurant's name are location words; they count for the address when
 * they appear in it and against it when they do not. With several candidates and no clear winner, or a single
 * candidate that plainly names somewhere else, return undefined rather than send the customer to the wrong city.
 */
export function chooseTarget(targets: BookingTarget[], place: { name: string; address: string }): BookingTarget | undefined {
  if (targets.length === 0) return undefined;
  const name = new Set([...words(place.name), ...words(place.name.replace(/ä/gi, "ae").replace(/ö/gi, "oe").replace(/ü/gi, "ue").replace(/ß/g, "ss"))]);
  // "L'Artusi" is "lartusi" on Resy: the name run together counts as a name word too.
  for (const n of [place.name, place.name.replace(/ä/gi, "ae").replace(/ö/gi, "oe").replace(/ü/gi, "ue")]) {
    const compact = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact.length >= 3) name.add(compact);
  }
  const addressWords = words(place.address);
  // Two address words run together count too ("santamonica" for Santa Monica, "westhollywood").
  const address = new Set([...addressWords, ...addressWords.slice(1).map((w, i) => addressWords[i] + w)]);
  // "Brooklyn, NY" is in New York: a state code also stands for its long name ("new-york-ny" on Resy). These
  // implied words count half, so a town named in the address ("Great Neck, NY") beats the state's big city.
  const implied = new Set<string>();
  for (const [code, long] of Object.entries(STATES)) if (address.has(code)) long.forEach((w) => !address.has(w) && implied.add(w));
  // "oriolechicago" for Oriole in Chicago: a name word run together with an address word is the name plus a match.
  const nameThenAddress = (w: string) => [...name].some((n) => n.length >= 3 && w.startsWith(n) && w.length > n.length && address.has(w.slice(n.length)));
  const score = (t: BookingTarget) => {
    const raw = [...words(t.id), ...words(t.city ?? "")];
    const bonus = raw.filter(nameThenAddress).length;
    const loc = new Set(raw.filter((w) => !isNameWord(w, name) && !nameThenAddress(w) && !/^\d+$/.test(w)));
    let s = bonus;
    for (const w of loc) {
      const code = CITY_CODES[w];
      const metro = code ? METROS[code.join(" ")] : undefined;
      const inMetro = !!metro && metro.some((m) => m.every((c) => address.has(c)));
      // A shortened town ("scott" for Scottsdale) is a weaker match.
      const prefix = w.length >= 4 && addressWords.some((a) => a.length > w.length && a.startsWith(w));
      s += address.has(w) ? 1 : code && code.every((c) => address.has(c)) ? 1 : implied.has(w) || prefix || inMetro ? 0.5 : -1;
    }
    // A location label next to the booking option: it names this place when its words are in the name
    // ("La Pecora Bianca SoHo") or the address ("Coral Gables, FL"), and somewhere else when they are not.
    for (const w of new Set(words(t.label ?? ""))) s += name.has(w) ? 1.5 : address.has(w) ? 1 : implied.has(w) ? 0.5 : -1;
    return s;
  };
  // A named link must name this restaurant: "r/atoboy-new-york" on Atomix's site is a sister restaurant, however
  // well its city matches. Numeric ids (an OpenTable rid in the site's own widget) carry no name to check.
  const named = (t: BookingTarget) => /^\d+$/.test(t.id) || words(t.id).some((w) => isNameWord(w, name) || nameThenAddress(w));
  const candidates = targets.filter(named);
  if (candidates.length === 0) return undefined;
  const ranked = candidates.map((t, i) => ({ t, s: score(t), i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const best = ranked[0]!;
  // Any unmatched location word counts against a link ("peter-luger-las-vegas" for a Brooklyn address). This can
  // also drop a link that names a neighborhood Google leaves out of the address; that only costs a phone call
  // or the Maps link, while a wrong-city link sends the customer to the wrong restaurant.
  if (best.s < 0) return undefined;
  const tied = ranked.filter((r) => r.s === best.s);
  if (tied.length === 1) return best.t;
  // Two different numeric rids and nothing else to go on: two restaurants, not one. Do not guess.
  if (tied.every((r) => /^\d+$/.test(r.t.id))) return undefined;
  // A tie means the same place under several ids: rid and slug, two rooms, or an OpenTable widget plus a Resy
  // link. Pick by platform priority, then the shorter id (main room over "the-tavern-at-..."). Different named
  // locations differ in location words, so they cannot tie at a score of zero or more.
  const rank = (t: BookingTarget) => PRIORITY.indexOf(t.platform);
  return tied.sort((a, b) => rank(a.t) - rank(b.t) || a.t.id.length - b.t.id.length || a.i - b.i)[0]!.t;
}

/**
 * A same-site link to the restaurant's reservations page, for sites that keep the booking widget off the homepage
 * (e.g. "/reservations/"). Undefined if none.
 */
/** Pages about something other than a normal booking: private events, parties, gift cards, jobs, legal. */
export const NOT_A_TABLE = /private|event|part(?:y|ies)|group|catering|wedding|birthday|corporate|gift|career|jobs?\b|press|terms|privacy|policy|faq/i;

/**
 * The restaurant's own words that it takes no reservations ("Walk-in only", "We don't take reservations"), quoted
 * back to the customer. Only in the page's visible text; undefined when it says nothing like that.
 */
/** Removes <script> and <style> blocks in one pass (a regex here backtracks badly on unclosed tags). */
export function stripScripts(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const s = lower.indexOf("<script", i);
    const t = lower.indexOf("<style", i);
    const at = s === -1 ? t : t === -1 ? s : Math.min(s, t);
    if (at === -1) return out + html.slice(i);
    out += html.slice(i, at) + " ";
    const close = lower.indexOf(at === s ? "</script" : "</style", at);
    if (close === -1) return out;
    const end = lower.indexOf(">", close);
    if (end === -1) return out;
    i = end + 1;
  }
}

export function walkInOnly(html: string): string | undefined {
  const text = stripScripts(html.slice(0, 400_000))
    .replace(/<[^<>]{0,2000}>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, " ");
  const m =
    /\b(walk[- ]?ins? only|no reservations(?! (?:are )?(?:needed|required|necessary))|we do(?:n't| not) (?:take|accept) reservations|reservations are not (?:accepted|available)|first[- ]come,? first[- ]served(?! (?:for|on) (?:the )?(?:patio|bar|outdoor|terrace))|no (?:se )?(?:admiten|aceptan|hacemos|tomamos|cogemos) reservas|no admitimos reservas|no (?:admetem|acceptem|fem) reserves|no es posible reservar|no se puede reservar)\b/i.exec(text);
  if (!m) return undefined;
  // A rule for one meal, hour or day ("walk-ins only at lunch", "no reservations after 10 pm") does not make the whole restaurant walk-in only.
  const near = text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50);
  if (/\b(lunch|dinner|brunch|breakfast|after|before|until|from \d|sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|weekdays?|weekends?|mediod[ií]a|comidas?|cenas?|almuerzo|despu[eé]s|antes de|domingos?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|dinars?|sopars?)\b/i.test(near)) return undefined;
  // Bar seats or the patio being first come does not make the whole restaurant walk-in only.
  const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
  if (/\b(bar|patio|counter|terrace|outdoor|lounge|parties of \d|groups? of \d|large parties)\b/i.test(around) && !/walk[- ]?ins? only/i.test(m[0])) return undefined;
  return around.trim().slice(0, 140);
}

/**
 * What a restaurant's own site says about paying to book: a deposit, a prepayment, a card to hold the table or a
 * no-show charge, in its own words (Spanish, Catalan or English). So a customer can be told before approving, even
 * when nobody has booked there through this service yet. Only where the words sit next to booking: a "deposit" in a
 * shop or a jobs page is not one.
 */
export function depositPolicy(html: string): string | undefined {
  const text = stripScripts(html.slice(0, 600_000))
    .replace(/<[^<>]{0,2000}>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&euro;|&#8364;/g, "€")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, " ");
  const re = new RegExp(
    "\\b(" +
      [
        "dep[oó]sito de \\d|un dep[oó]sito|dip[oò]sit de \\d|un dip[oò]sit|a deposit|deposit of|deposit is required|fianza de \\d|una fianza|se[ñn]al de \\d|una se[ñn]al de",
        "prepago|prepagament|pre-?payment|pago por adelantado|pagament per avan[cç]at|paga y se[ñn]al|paga i senyal",
        "tarjeta (?:de cr[eé]dito )?(?:como|en|de|a modo de) garant[ií]a|garant[ií]a (?:con|de|mediante) tarjeta|targeta (?:de cr[eè]dit )?(?:com a|de|en) garantia",
        "credit card (?:is |will be |details are )?(?:required|needed)|card (?:details )?(?:is |are )?(?:required )?to (?:secure|guarantee|hold|confirm)",
        "no[- ]?show (?:fee|charge|policy)|cargo (?:de \\d+ ?€ )?por no presentarse|se cobrar[aá]n? \\d|es cobrar[aà]n? \\d|penalizaci[oó]n de \\d",
      ].join("|") +
      ")",
    "gi",
  );
  for (const m of text.matchAll(re)) {
    const around = text.slice(Math.max(0, m.index! - 110), m.index! + m[0].length + 110);
    if (!/reserv|booking|book a|mesa|taula|table|comensal|cancel|no[- ]?show|persona/i.test(around)) continue;
    if (/gift|regalo|regal\b|tienda|botiga|shop|empleo|job|career|alquiler|rental|catering/i.test(around)) continue;
    // "No deposit is required", "sin prepago", "no hace falta depósito": the opposite of a warning.
    const lead = text.slice(Math.max(0, m.index! - 32), m.index!);
    const tail = text.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    if (/\b(no|sin|not|without|ning[uú]n[ao]?|cap|no hace falta|no es necesari[oa]|no necesitas)\s+(?:\w+\s+){0,2}$/i.test(lead)) continue;
    if (/^\W{0,3}(?:\w+\s+){0,3}(?:is |are |es |son )?(?:not|no) (?:required|needed|necessary|necesari[oa]s?|obligatori[oa]s?)/i.test(tail)) continue;
    // From the start of its sentence where there is one, so the quote reads as the restaurant wrote it.
    const before = text.slice(Math.max(0, m.index! - 110), m.index!);
    const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
    const from = m.index! - (start === -1 ? Math.min(before.length, 60) : before.length - start - 2);
    const quote = text.slice(from, from + 170);
    // Cut at a word when the text goes on past the quote; a sentence that ends inside it is kept whole.
    return (from + 170 < text.length ? quote.replace(/\s+\S*$/, "") : quote).trim();
  }
  return undefined;
}

const MAIL_PROVIDERS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "me.com", "msn.com", "live.com", "protonmail.com"]);
/** Addresses that are not for guests: press, jobs, sales, systems, privacy. */
const NOT_GUEST_MAIL = new RegExp(
  "^(press|media|pr|jobs?|careers?|hiring|hr|rrhh|rh|trabaja|trabajo|empleo|talento|curriculum|cv|marketing|sales|comercial|compras|proveedores|ventas|partners?|webmaster|"
  + "admin|administracion|administraci[oó]n|contabilidad|facturas?|facturacion|privacy|privacidad|dpo|lopd|rgpd|gdpr|legal|accounting|billing|ap|invoices?|no-?reply|donotreply|"
  + "support|soporte|prensa|comunicacion|wordpress|test|example|user|name|email|your(name|email)?)[@.+_-]", "i");
/** Hosting and blogging domains: an address there proves nothing about the restaurant (anyone can get one). */
const SHARED_HOSTS = new Set(["wixsite.com", "wix.com", "blogspot.com", "github.io", "netlify.app", "vercel.app", "herokuapp.com", "wordpress.com", "weebly.com", "squarespace.com", "business.site", "myshopify.com", "webflow.io", "carrd.co", "godaddysites.com", "site123.me", "jimdosite.com", "strikingly.com"]);
const FULL_ADDRESS = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * The address a restaurant publishes for guests (mailto links on its own site), preferring reservation and general
 * inboxes. Only on the restaurant's own domain or a common mail provider; never the website builder's address.
 */
export function restaurantEmail(html: string, website: string): string | undefined {
  let domain: string;
  try {
    const parts = new URL(website).hostname.toLowerCase().split(".");
    domain = parts.slice(parts.length > 2 && /^(co|com|org|net)$/.test(parts.at(-2)!) && parts.at(-1)!.length === 2 ? -3 : -2).join(".");
  } catch {
    return undefined;
  }
  const found = new Set<string>();
  for (const m of html.slice(0, 1_500_000).matchAll(/mailto:([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{3,253}\.[A-Za-z]{2,24})/gi)) {
    let addr: string;
    try {
      addr = decodeURIComponent(m[1]!).toLowerCase();
    } catch {
      continue;
    }
    // After decoding the whole address is checked again: %0A, %2C, %40 or an extra @ must not smuggle a line, a second address or another host in.
    if (!FULL_ADDRESS.test(addr) || addr.length > 120) continue;
    const host = addr.split("@")[1]!;
    if (NOT_GUEST_MAIL.test(addr)) continue;
    const own = !SHARED_HOSTS.has(domain) && (host === domain || host.endsWith(`.${domain}`));
    if (own || MAIL_PROVIDERS.has(host)) found.add(addr);
    if (found.size >= 10) break;
  }
  const rank = (a: string) => (/^(reservas?|reservations?|reserves?|booking|bookings?|book|rsvp|tables?|mesa|taula)[@.+_-]/.test(a) ? 0 : /^(info|hello|hi|contact|contacto|eat|dine|dining|host|manager|gm|office|restaurante)[@.+_-]/.test(a) ? 1 : /^(events?|eventos?|private|catering)[@.+_-]/.test(a) ? 3 : 2);
  return [...found].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The WhatsApp number a restaurant publishes for guests on its own site (a wa.me or "send" link), as digits with the
 * country code. A link without one is read as a national number of the owner's country (region.ts), and skipped when it is not one
 * there or the country is not known yet: no other country is guessed. Share buttons (no number) are not one. When a
 * site carries several numbers, the one it links most.
 */
export function restaurantWhatsapp(html: string): string | undefined {
  const h = html.slice(0, 1_500_000).replace(/&amp;/g, "&").replace(/\\\//g, "/");
  const seen = new Map<string, number>();
  for (const m of h.matchAll(/(?:wa\.me\/|(?:api|web)\.whatsapp\.com\/send\/?\?(?:[^"'\s<>]{0,80}&)?phone=|whatsapp:\/\/send\/?\?(?:[^"'\s<>]{0,80}&)?phone=)(%2B|\+|00)?(\d{9,15})(?!\d)/gi)) {
    // Digits only, as the links are written: anything looser would run on into the text after the link. A number written with + or 00
    // already carries its code and is never read as a national one.
    const national = m[1] ? null : nationalNumber(m[2]!);
    const digits = national ? national.slice(1) : m[2]!;
    if (digits.length < 10 || digits.length > 15) continue;
    seen.set(digits, (seen.get(digits) ?? 0) + 1);
    if (seen.size >= 10) break;
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function reservationsPageLink(html: string, base: string): string | undefined {
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return undefined;
  }
  const host = (h: string) => h.replace(/^www\./, "");
  // Links people click (<a href>), not stylesheets or scripts of a "restaurant-reservations" plugin.
  for (const m of html.slice(0, 400_000).matchAll(/<a\s[^>]{0,300}?href\s*=\s*["']([^"'#\s<>]{1,500})["']/gi)) {
    const href = m[1]!.replace(/&amp;/g, "&");
    if (!/reserv|booking|book-a-table|book-now/i.test(href)) continue;
    if (NOT_A_TABLE.test(href)) continue;
    if (/\/wp-(?:content|includes|json)\/|\.(?:css|js|png|jpe?g|gif|svg|webp|pdf|ico|woff2?)(?:[?#]|$)/i.test(href)) continue;
    try {
      const u = new URL(href, origin);
      if ((u.protocol === "https:" || u.protocol === "http:") && host(u.hostname) === host(origin.hostname) && u.pathname !== origin.pathname) return u.href;
    } catch {
      // not a URL
    }
  }
  return undefined;
}

const SHORTENERS = /^(?:www\.)?(?:bit\.ly|tinyurl\.com|rebrand\.ly|ow\.ly|t\.co|linktr\.ee|tiny\.cc|cutt\.ly|bl\.ink|shorturl\.at)$/i;

/**
 * Short links on the page that look like they lead to bookings ("bit.ly/LartusiRESY", or link text "Reserve").
 * Their target is read with one request, never followed. At most 3.
 */
export function bookingShortLinks(html: string): string[] {
  const out: string[] = [];
  // One linear pass over href values (bounded), judging each short link by its own path ("bit.ly/LartusiRESY").
  for (const m of html.slice(0, 400_000).matchAll(/href\s*=\s*["'](https?:\/\/[^"'\s<>]{4,200})["']/gi)) {
    let u: URL;
    try {
      u = new URL(m[1]!);
    } catch {
      continue;
    }
    if (!SHORTENERS.test(u.hostname)) continue;
    if (/resy|opentable|tock|sevenrooms|yelp|reserv|book/i.test(u.pathname) && !out.includes(m[1]!)) out.push(m[1]!);
    if (out.length >= 3) break;
  }
  return out;
}

/** Link to the platform's own booking page for this slot ("2026-11-20T19:30") and party size. */
export function bookingUrl(t: BookingTarget, slot: string, partySize: number): string {
  const date = slot.slice(0, 10);
  const time = slot.slice(11, 16);
  const seats = String(partySize);
  switch (t.platform) {
    case "opentable": {
      if (t.id.startsWith("r/") || !/^\d+$/.test(t.id)) {
        return `https://www.opentable.com/${t.id}?${new URLSearchParams({ covers: seats, dateTime: `${date}T${time}` })}`;
      }
      return `https://www.opentable.com/restref/client/?${new URLSearchParams({ rid: t.id, restref: t.id, datetime: `${date}T${time}`, covers: seats })}`;
    }
    case "resy":
      return `https://resy.com/cities/${t.city ?? "new-york-ny"}/venues/${t.id}?${new URLSearchParams({ date, seats })}`;
    case "tock":
      return `https://www.exploretock.com/${t.id}/search?${new URLSearchParams({ date, size: seats, time })}`;
    case "sevenrooms":
      return `https://www.sevenrooms.com/reservations/${t.id}?${new URLSearchParams({ date, party_size: seats, start_time: time })}`;
    case "yelp":
      return `https://www.yelp.com/reservations/${t.id}?${new URLSearchParams({ date, time: time.replace(":", ""), covers: seats })}`;
  }
}

/** What to tell the customer if the platform shows no table at that time. */
export function notifyHint(p: Platform): string {
  switch (p) {
    case "resy":
      return "If that time is gone, tap Notify on Resy to get an alert when a table opens.";
    case "opentable":
      return "If that time is gone, use OpenTable's Notify me option to get an alert when a table opens.";
    case "tock":
      return "If that time is gone, join the waitlist on Tock.";
    case "sevenrooms":
      return "If that time is gone, join the waitlist on the SevenRooms page if the restaurant offers one.";
    case "yelp":
      return "If that time is gone, try the nearby times Yelp shows or join the restaurant's waitlist.";
  }
}
