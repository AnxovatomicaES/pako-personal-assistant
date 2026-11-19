// Reservation widgets, found on a restaurant's own website.
//
// In Barcelona (and most of Europe) a restaurant rarely links OpenTable or Resy. It embeds a reservation engine:
// CoverManager, TheFork, Restoo, Hiopos, Last.app and a few more. The engine has a page of its own for each
// restaurant, and that page is where a table is booked. Reading the restaurant's site for that page is what lets
// the connector book a restaurant it has never seen: the browser task starts on the engine's page, with the steps
// for that engine, instead of exploring the restaurant's site.
//
// Measured on 262 Barcelona restaurant websites taken from OpenStreetMap (Nov 2026): the platform check alone found
// a booking route on 2 of them; with the engines below, on about a third. The address shapes are the ones those
// sites really use.

/** A restaurant's page on a reservation engine. */
export interface WidgetPage {
  /** The engine's name, as customers are told it: "CoverManager". */
  engine: string;
  /** The page to book on, in the form the browser task and the fill extension know. */
  url: string;
  /** What tells this restaurant from another on the same engine (a slug or an id), for sites that list several. */
  key: string;
}

/** Engines in the order they are preferred when a site carries more than one. */
const ORDER = ["CoverManager", "Restoo", "Hiopos", "Last.app", "TheFork", "Dish", "resOS", "Dimbook"];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Which engine a booking page belongs to, by its host; undefined for anything else (a restaurant's own page). */
export function widgetEngineOf(url: string | undefined): string | undefined {
  let host: string;
  try {
    host = new URL(url ?? "").hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (/(^|\.)covermanager\.com$/.test(host)) return "CoverManager";
  if (/(^|\.)myrestoo\.net$/.test(host)) return "Restoo";
  if (/(^|\.)hiopos\.com$/.test(host)) return "Hiopos";
  if (host === "bookings.last.app") return "Last.app";
  // The TheFork sites a booking task may use (browser-task.ts, WIDGET_SITES): a page on another one is not offered.
  if (/(^|\.)(thefork\.(es|com|fr|it)|lafourchette\.com)$/.test(host)) return "TheFork";
  if (host === "reservation.dish.co") return "Dish";
  if (/(^|\.)resos\.com$/.test(host)) return "resOS";
  if (host === "app.dimbook.com") return "Dimbook";
  return undefined;
}

/** Every distinct reservation-engine page linked or embedded in a page's HTML (links, iframes, scripts). */
export function detectWidgetPages(html: string): WidgetPage[] {
  // The same bounds as the platform check: at most 1.5 MB and 40 pages, whatever the page holds.
  const h = html.slice(0, 1_500_000).replace(/&amp;/g, "&").replace(/\\\//g, "/").replace(/%3D/gi, "=");
  const out: WidgetPage[] = [];
  const seen = new Set<string>();
  const add = (engine: string, url: string, key: string) => {
    const id = `${engine}|${key.toLowerCase()}`;
    if (out.length < 40 && !seen.has(id)) {
      seen.add(id);
      out.push({ engine, url, key });
    }
  };
  const all = (re: string) => [...h.matchAll(new RegExp(re, "gi"))];

  // CoverManager: .../reservation/module_restaurant/<slug>/<language> (older sites say "reserve"). Its shop
  // (eco/buy_products) and tracking paths are not booking pages. The English module is the one the steps are for.
  for (const m of all(`covermanager\\.com\\/(?:reservation|reserve)\\/module_restaurant\\/([A-Za-z0-9][A-Za-z0-9._-]{1,80})`)) {
    // A link at the end of a sentence carries its full stop: not part of the restaurant's name on the engine.
    const slug = m[1]!.replace(/[._-]+$/, "");
    if (slug.length >= 2) add("CoverManager", `https://www.covermanager.com/reservation/module_restaurant/${slug}/english`, slug);
  }

  // Restoo: <restaurant>.myrestoo.net. A site that only links the restaurant's Restoo shop or group form is left out.
  const restoo = new Map<string, boolean>();
  for (const m of all(`https?:\\/\\/([a-z0-9][a-z0-9-]{1,60})\\.myrestoo\\.net(\\/[^"'\\s<>?#]{0,80})?`)) {
    const slug = m[1]!.toLowerCase();
    if (["cdn", "www", "static", "api", "app", "admin"].includes(slug)) continue;
    const books = !/\/(tienda|shop|group|grupos?|regalo|gift)/i.test(m[2] ?? "");
    restoo.set(slug, (restoo.get(slug) ?? false) || books);
  }
  for (const [slug, books] of restoo) if (books) add("Restoo", `https://${slug}.myrestoo.net/en/reservar`, slug);

  // Hiopos: one page per restaurant, named by an opaque data value.
  for (const m of all(`https?:\\/\\/(booking\\d{0,2}\\.hiopos\\.com)\\/booking\\?data=([A-Za-z0-9=_-]{8,200})`)) add("Hiopos", `https://${m[1]!.toLowerCase()}/booking?data=${m[2]!}`, m[2]!);

  // Last.app: bookings.last.app/<organisation>/<location>/booking, or with the location alone.
  for (const m of all(`bookings\\.last\\.app\\/((?:${UUID}\\/)?${UUID})\\/booking`)) add("Last.app", `https://bookings.last.app/${m[1]!.toLowerCase()}/booking`, m[1]!.toLowerCase().split("/").pop()!);

  // TheFork: the widget (optionally under a language), the older LaFourchette module, then the restaurant's page on
  // TheFork itself (last: it asks visitors to prove they are human more often than the widgets do).
  for (const m of all(`widget\\.thefork\\.com\\/(?:([a-z]{2})\\/)?(${UUID})`)) {
    add("TheFork", `https://widget.thefork.com/${m[1] ? `${m[1].toLowerCase()}/` : ""}${m[2]!.toLowerCase()}`, m[2]!.toLowerCase());
  }
  for (const m of all(`module\\.lafourchette\\.com\\/([a-z]{2}_[A-Z]{2})\\/module\\/(\\d{1,9}-[0-9a-f]{3,12})`)) add("TheFork", `https://module.lafourchette.com/${m[1]!}/module/${m[2]!}`, m[2]!);
  for (const m of all(`thefork\\.(es|com|fr|it)\\/(restaurante|restaurant|ristorante)\\/([a-z0-9][a-z0-9-]{1,90}-r\\d{2,9})`)) {
    add("TheFork", `https://www.thefork.${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/${m[3]!.toLowerCase()}`, m[3]!.toLowerCase());
  }

  // A few smaller engines, each with a page per restaurant.
  for (const m of all(`reservation\\.dish\\.co\\/widget\\/(hydra-${UUID})`)) add("Dish", `https://reservation.dish.co/widget/${m[1]!.toLowerCase()}`, m[1]!.toLowerCase());
  for (const m of all(`https?:\\/\\/(restaurant-\\d{3,14})\\.resos\\.com\\/booking`)) add("resOS", `https://${m[1]!.toLowerCase()}.resos.com/booking`, m[1]!.toLowerCase());
  for (const m of all(`app\\.dimbook\\.com\\/booking\\?id=([A-Za-z0-9_-]{8,60})`)) add("Dimbook", `https://app.dimbook.com/booking?id=${m[1]!}`, m[1]!);

  return out.sort((a, b) => ORDER.indexOf(a.engine) - ORDER.indexOf(b.engine));
}

const FILLER = new Set(
  ["restaurante", "restaurant", "restaurants", "barcelona", "bcn", "tapas", "taverna", "taberna", "grill", "the", "del", "les", "els", "las", "los", "and", "bar", "cafe", "casa"],
);

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The words of a name, address or slug that can tell one restaurant from another ("MutGracia" is "mut", "gracia"). */
function words(text: string): string[] {
  return fold(text.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && /^[a-z]+$/.test(w) && !FILLER.has(w));
}

/**
 * The page for this restaurant among those a site carries. One page (the usual case) is it. With several, a page
 * has to name this restaurant: a site may also link a sister restaurant, a friend's place or the group's other
 * branches. Among branches of the same name, the one whose slug also names this restaurant's street or area is
 * chosen. When none stands out nothing is chosen, because a table at another restaurant is worse than no shortcut.
 * (The booking task checks the page's address against the restaurant's as well: a street word can mislead.)
 */
export function chooseWidgetPage(pages: WidgetPage[], place: { name: string; address: string }): WidgetPage | undefined {
  if (pages.length === 0) return undefined;
  if (pages.length === 1) return pages[0];
  const name = new Set(words(place.name));
  const nameRun = fold(place.name).replace(/[^a-z0-9]/g, "");
  const address = new Set(words(place.address));
  const scored = pages.map((p) => {
    const w = words(p.key);
    const inName = w.filter((x) => name.has(x) || (x.length >= 5 && nameRun.includes(x)));
    return { p, described: w.length > 0, name: inName.length, address: w.filter((x) => !inName.includes(x) && address.has(x)).length };
  });
  const named = scored.filter((x) => x.name > 0);
  if (named.length === 0) {
    // No page names the restaurant. Pages known only by an id, one per engine, are the same restaurant on several
    // engines: the preferred engine's (they are sorted that way). Anything else could be someone else's page.
    const oneEach = new Set(pages.map((p) => p.engine)).size === pages.length;
    return oneEach && scored.every((x) => !x.described) ? pages[0] : undefined;
  }
  const best = Math.max(...named.map((x) => x.name));
  const top = named.filter((x) => x.name === best);
  if (top.length === 1) return top[0]!.p;
  // Several pages carry the name: branches, told apart by the street or area in the slug.
  const near = Math.max(...top.map((x) => x.address));
  const here = top.filter((x) => x.address === near);
  if (near > 0 && here.length === 1) return here[0]!.p;
  // The same restaurant on two engines (one page each, nothing else to tell them apart): the preferred engine's.
  return near === 0 && new Set(top.map((x) => x.p.engine)).size === top.length && top.every((x) => words(x.p.key).length === best) ? top[0]!.p : undefined;
}
