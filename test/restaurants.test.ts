import { setOwnerRegion } from "../src/region.ts";
// The ported restaurant engine (src/restaurants/, from the git tag `connector-final`): the parts Pako's booking leans on.

import assert from "node:assert/strict";
import test from "node:test";
import { bookingUrl, depositPolicy, detectAllBookingPlatforms, restaurantEmail, restaurantWhatsapp, walkInOnly } from "../src/restaurants/booking-links.ts";
import { detectWidgetPages, widgetEngineOf } from "../src/restaurants/booking-widgets.ts";
import { GooglePlaces, openAt, placeOpenAt, toE164 } from "../src/restaurants/places.ts";
import { isPrivateAddress, robotsAllows } from "../src/restaurants/website.ts";
import { EVERY_DAY } from "./helpers/booking-fixtures.ts";

test("places: a search asks Google in English, biased to the owner's country when known, with only the fields it needs; results are cleaned and bounded", async () => {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ places: [
      { id: "ChIJabc", displayName: { text: "Cal\u0007 Pep\n" }, formattedAddress: "Plaça de les Olles, 8, Barcelona", rating: 4.6, userRatingCount: 3200, priceLevel: "PRICE_LEVEL_EXPENSIVE", internationalPhoneNumber: "+34 932 10 19 49", nationalPhoneNumber: "932 10 19 49", websiteUri: "javascript:alert(1)", googleMapsUri: "https://www.google.com/maps/place/?q=place_id:ChIJabc" },
      { id: "bad id with spaces", displayName: { text: "Nope" } },
    ] }), { status: 200 });
  }) as typeof fetch;
  const places = await new GooglePlaces("key_test", f).searchText("tapas en el Born, Barcelona", 5);
  assert.equal(seen[0]!.url, "https://places.googleapis.com/v1/places:searchText");
  assert.equal(seen[0]!.headers["x-goog-api-key"], "key_test");
  assert.equal(seen[0]!.body.languageCode, "en");
  assert.equal("regionCode" in seen[0]!.body, false, "no country known (no region set): no bias, never Spain by default");
  assert.ok(!seen[0]!.headers["x-goog-fieldmask"]!.includes("reservable"), "the costly field is asked for only on a restaurant's details");
  assert.equal(places.length, 1, "an id that is not a place id is dropped");
  assert.deepEqual([places[0]!.name, places[0]!.price, places[0]!.phone, places[0]!.website], ["Cal Pep", "$$$", "+34932101949", undefined], "control characters out; a javascript: link is not a website");
  await new GooglePlaces("key_test", f, { region: "ES" }).searchText("tapas", 5);
  assert.equal(seen[1]!.body.regionCode, "ES", "the owner's country, when known");
});

test("places: opening hours decide a table: seating needs time before closing; midnight and 24 hours are joined up", () => {
  assert.equal(openAt(EVERY_DAY, "2026-11-20T21:00"), true);
  assert.equal(openAt(EVERY_DAY, "2026-11-20T11:00"), false);
  assert.equal(openAt(EVERY_DAY, "2026-11-20T23:45"), false, "no time left to sit before closing");
  assert.equal(openAt(undefined, "2026-11-20T21:00"), undefined, "no hours: unknown, not closed");
  const nights = [{ open: { day: 5, hour: 19, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } }];
  assert.equal(openAt(nights, "2026-11-20T23:30"), true, "Friday 19:00 to Saturday 02:00");
  assert.equal(openAt(nights, "2026-11-21T01:00"), true);
  assert.equal(placeOpenAt({ periods: EVERY_DAY, thisWeek: [{ open: { day: 5, hour: 12, minute: 0 }, close: { day: 5, hour: 16, minute: 0 } }] }, "2026-11-20T21:00", Date.parse("2026-11-18T12:00:00Z")), false, "this week's real hours beat the regular ones");
  assert.equal(toE164("+34 932 10 19 49 ext. 4"), "+34932101949");
  assert.equal(toE164("932101949"), undefined);
});

test("links: a restaurant's own site gives its email, WhatsApp, deposit rule and walk-in notice; a booking link carries the date, time and party", () => {
  assert.equal(restaurantEmail('<a href="mailto:info@calpep.es">x</a><a href="mailto:reservas@calpep.es">y</a><a href="mailto:jobs@calpep.es">z</a><a href="mailto:x@wix.com">w</a>', "https://www.calpep.es/"), "reservas@calpep.es", "reservations first; jobs and a stranger's domain never");
  assert.equal(restaurantWhatsapp('<a href="https://wa.me/34626728492?text=hola">WhatsApp</a>'), "34626728492");
  assert.equal(restaurantWhatsapp('<a href="https://wa.me/?text=compartir">share</a>'), undefined, "a share button is not a number");
  assert.equal(restaurantWhatsapp('<a href="https://wa.me/626728492">WhatsApp</a>'), undefined, "no country code and no owner country: nothing is guessed");
  try {
    setOwnerRegion("ES");
    assert.equal(restaurantWhatsapp('<a href="https://wa.me/626728492">WhatsApp</a>'), "34626728492", "a Spanish owner's national number gets +34");
    assert.equal(restaurantWhatsapp('<a href="https://wa.me/+14155550100">WhatsApp</a>'), "14155550100", "a number with + keeps its own code");
    setOwnerRegion("US");
    assert.equal(restaurantWhatsapp('<a href="https://wa.me/4155550100">WhatsApp</a>'), "14155550100", "a US owner's 10-digit number gets +1");
    assert.equal(restaurantWhatsapp('<a href="https://wa.me/626728492">WhatsApp</a>'), undefined, "not a national number in the owner's country: skipped");
    setOwnerRegion("JP");
    assert.equal(restaurantWhatsapp('<a href="https://wa.me/626728492">WhatsApp</a>'), undefined, "a country with no number rules: skipped");
  } finally {
    setOwnerRegion("");
  }
  assert.match(depositPolicy("<p>Para confirmar la reserva pedimos un depósito de 10 € por persona.</p>") ?? "", /depósito de 10 €/);
  assert.equal(depositPolicy("<p>Compra una tarjeta regalo con depósito de 50 €</p>"), undefined, "a gift card is not a booking deposit");
  assert.match(walkInOnly("<p>We do not take reservations. Walk-ins only.</p>") ?? "", /reservations|walk/i);
  const [t] = detectAllBookingPlatforms('<a href="https://www.sevenrooms.com/reservations/brugarolbarcelona">Reservar</a>');
  assert.deepEqual([t!.platform, t!.id], ["sevenrooms", "brugarolbarcelona"]);
  assert.equal(bookingUrl(t!, "2026-11-20T21:00", 4), "https://www.sevenrooms.com/reservations/brugarolbarcelona?date=2026-11-20&party_size=4&start_time=21%3A00");
});

test("widgets: Spain's reservation engines are recognised from a restaurant's page (CoverManager here)", () => {
  const pages = detectWidgetPages('<iframe src="https://www.covermanager.com/reservation/module_restaurant/restaurante-barmut/spanish"></iframe>');
  assert.deepEqual(pages.map((p) => [p.engine, p.url]), [["CoverManager", "https://www.covermanager.com/reservation/module_restaurant/restaurante-barmut/english"]]);
  assert.equal(widgetEngineOf("https://www.thefork.es/restaurante/x-r1"), "TheFork");
  assert.equal(widgetEngineOf("https://evil.example.com/covermanager.com"), undefined);
});

test("website reading: private addresses and robots.txt are respected", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "169.254.169.254", "::1", "fd00::1"]) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /reservas", "/reservas"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /privado", "/"), true);
});

// ---------- bug hunt 2: regression tests ----------

test("hunt2 restaurants: a page cannot smuggle a line, a second address or another host through a mailto, nor an internal mailbox", () => {
  const mail = (href: string, site = "https://www.calpep.es/") => restaurantEmail(`<a href="mailto:${href}">x</a>`, site);
  assert.equal(mail("reservas%0A%0AConfirmado%20todo@gmail.com"), undefined, "an encoded newline");
  assert.equal(mail("info%2C%20victim@gmail.com"), undefined, "an encoded comma and space");
  assert.equal(mail("x%40gmail.com@evil.example"), undefined, "a second @ after decoding");
  assert.equal(mail("attacker@wixsite.com", "https://calpep.wixsite.com/menu"), undefined, "any address on a shared host proves nothing");
  assert.equal(mail("reservas@gmail.com", "https://calpep.wixsite.com/menu"), "reservas@gmail.com", "a mail provider is still fine");
  for (const internal of ["rrhh", "trabaja", "dpo", "lopd", "comercial", "compras", "eventos-privados", "prensa"]) {
    const a = mail(`${internal}@calpep.es`);
    assert.ok(a === undefined || internal === "eventos-privados", `${internal}@ is not a guest address (got ${a})`);
  }
  assert.equal(restaurantEmail('<a href="mailto:informatica@calpep.es">a</a><a href="mailto:info@calpep.es">b</a>', "https://calpep.es/"), "info@calpep.es", "'informatica' is not 'info'");
  assert.equal(restaurantEmail('<a href="mailto:bookkeeping@calpep.es">a</a><a href="mailto:info@calpep.es">b</a>', "https://calpep.es/"), "info@calpep.es", "'bookkeeping' is not 'booking'");
});

test("hunt2 restaurants: a hostile 1.5 MB page does not stall the server", () => {
  const started = Date.now();
  detectAllBookingPlatforms("<a ".repeat(500_000));
  detectAllBookingPlatforms(`<option ${"data-reservation-service='opentable' ".repeat(30_000)}`);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  const bento = detectAllBookingPlatforms(`<option data-reservation-service="opentable" data-reservation-id="1182799">SoHo</option>`);
  assert.deepEqual(bento.map((t) => [t.platform, t.id, t.label]), [["opentable", "1182799", "SoHo"]], "the real thing is still found");
});

test("hunt2 restaurants: deposit rules read the way the restaurant meant them, in Spanish too; a rule for one meal is not a no-reservations site", () => {
  assert.equal(depositPolicy("<p>No deposit is required to book a table.</p>"), undefined);
  assert.equal(depositPolicy("<p>Reservas sin prepago para mesas de hasta 6 personas.</p>"), undefined);
  assert.equal(depositPolicy("<p>No hace falta depósito de ningún tipo para reservar mesa.</p>"), undefined);
  assert.match(depositPolicy("<p>Para reservar una mesa pedimos una fianza de 20 € por persona.</p>") ?? "", /fianza de 20/);
  assert.match(depositPolicy("<p>Reservar la mesa exige una señal de 10 € por comensal.</p>") ?? "", /señal de 10/);
  assert.equal(walkInOnly("<p>Lunch: walk-ins only. Dinner by reservation.</p>"), undefined);
  assert.equal(walkInOnly("<p>We do not accept reservations after 10pm.</p>"), undefined);
  assert.equal(walkInOnly("<p>No reservations needed, just come.</p>"), undefined);
  assert.match(walkInOnly("<p>No admitimos reservas. Ven cuando quieras.</p>") ?? "", /No admitimos reservas/);
  assert.match(walkInOnly("<p>No acceptem reserves, primer arribat primer servit.</p>") ?? "", /acceptem reserves/);
});

test("hunt2 restaurants: the curated address beats a page's; a page that drops its address stops being used", async () => {
  const { RestaurantEngine } = await import("../src/restaurants/engine.ts");
  let html = '<html><a href="mailto:reservas@old.example">r</a><p>' + "x".repeat(200) + "</p></html>";
  const place = { id: "ChIJnew", name: "Nuevo", address: "Barcelona, Spain", website: "https://old.example/", rating: 4, ratingCount: 5 };
  const engine = new RestaurantEngine({ name: "f", searchText: async () => [place], details: async () => place }, { fetchHomepage: async () => html }, 0);
  await engine.search({ what: "x", slot: "2026-11-20T21:00", partySize: 2 });
  assert.equal(engine.reservationEmail("gp_ChIJnew"), "reservas@old.example");
  html = "<html><p>" + "y".repeat(200) + "</p></html>"; // the site dropped its address
  await engine.search({ what: "x", slot: "2026-11-20T21:00", partySize: 2 });
  assert.equal(engine.reservationEmail("gp_ChIJnew"), undefined, "the stale address is gone");
  // A curated place keeps its hand-checked address whatever the page says today.
  html = '<html><a href="mailto:rrhh@trapella.example">r</a></html>';
  const curated = { id: "ChIJe2zlRoyjpBIRm-3Mj-WNZyc", name: "El Trapella", address: "Barcelona, Spain", website: "https://trapella.example/" };
  const e2 = new RestaurantEngine({ name: "f", searchText: async () => [curated], details: async () => curated }, { fetchHomepage: async () => html }, 0);
  await e2.search({ what: "x", slot: "2026-11-20T21:00", partySize: 2 });
  assert.equal(e2.reservationEmail("gp_ChIJe2zlRoyjpBIRm-3Mj-WNZyc"), "info@eltrapelladelpoblenou.com");
});

test("hunt2 places: this week's special hours apply to a slot six days ahead, early in the morning, when the zone is known", () => {
  const regular = EVERY_DAY;
  const thisWeek = [{ open: { day: 4, hour: 12, minute: 0 }, close: { day: 4, hour: 16, minute: 0 } }]; // Thursday: lunch only
  const now = Date.parse("2026-11-13T08:00:00Z"); // Friday 09:00 in Madrid; the Thursday 19th is its sixth day ahead
  assert.equal(placeOpenAt({ periods: regular, thisWeek }, "2026-11-19T21:00", now, 45, "Europe/Madrid"), false);
});
