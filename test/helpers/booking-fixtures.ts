// Fake Google Places and fake restaurant websites for the booking tests: the engine and the booking service are the real ones.

import { RestaurantEngine } from "../../src/restaurants/engine.ts";
import type { OpeningPeriod, Place, PlaceDirectory } from "../../src/restaurants/places.ts";
import type { PageFetcher } from "../../src/restaurants/website.ts";

/** Open every day from 12:00 to 23:59. */
export const EVERY_DAY: OpeningPeriod[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 23, minute: 59 } }));

export const PLACES: Place[] = [
  {
    id: "ChIJcalpep", name: "Cal Pep", address: "Plaça de les Olles, 8, 08003 Barcelona, Spain", rating: 4.6, ratingCount: 3200, price: "$$$",
    phone: "+34932101949", phoneDisplay: "932 10 19 49", website: "https://calpep.example/", mapsUrl: "https://www.google.com/maps/place/?q=place_id:ChIJcalpep", periods: EVERY_DAY,
  },
  {
    id: "ChIJbarmut", name: "Bar Mut", address: "Carrer de Pau Claris, 192, 08037 Barcelona, Spain", rating: 4.5, ratingCount: 2100, price: "$$$",
    website: "https://barmut.example/", periods: EVERY_DAY,
  },
  { id: "ChIJsolotel", name: "Casa Teléfono", address: "Carrer Gran de Gràcia, 1, 08012 Barcelona, Spain", rating: 4.1, ratingCount: 300, phone: "+34931234567", phoneDisplay: "931 23 45 67", periods: EVERY_DAY },
  { id: "ChIJgone", name: "Cerrado para siempre", address: "Carrer Aragó, 1, 08011 Barcelona, Spain", rating: 4.9, ratingCount: 9000, businessStatus: "CLOSED_PERMANENTLY", periods: EVERY_DAY },
  { id: "ChIJlunes", name: "Solo mediodía", address: "Carrer Aragó, 2, 08011 Barcelona, Spain", rating: 4.8, ratingCount: 5000, periods: [{ open: { day: 5, hour: 12, minute: 0 }, close: { day: 5, hour: 16, minute: 0 } }] },
];

const SITES: Record<string, string> = {
  "https://calpep.example/": `<html><body><h1>Cal Pep</h1><a href="mailto:reservas@calpep.example">Reservas</a><p>Para reservar la mesa se pide un depósito de 20 € por persona.</p></body></html>`,
  "https://barmut.example/": `<html><body><iframe src="https://www.covermanager.com/reservation/module_restaurant/restaurante-barmut/english"></iframe><p>${"Bar Mut, cocina de mercado. ".repeat(10)}</p></body></html>`,
  "https://www.covermanager.com/reservation/module_restaurant/restaurante-barmut/english": `<html><body>${"Reserva tu mesa en Bar Mut. ".repeat(20)}</body></html>`,
};

/** A homepage with a CoverManager booking module for every place that has a website, and the module's own page (text enough to count as a page). */
export function coverManagerSites(places: Place[]): Record<string, string> {
  const sites: Record<string, string> = {};
  for (const p of places) {
    if (!p.website) continue;
    const module = `https://www.covermanager.com/reservation/module_restaurant/${p.id.toLowerCase()}/english`;
    sites[p.website] = `<html><body><iframe src="${module}"></iframe><p>${`${p.name}, cocina de mercado. `.repeat(12)}</p></body></html>`;
    sites[module] = `<html><body>${"Reserva tu mesa. ".repeat(30)}</body></html>`;
  }
  return sites;
}

export class FakePlaces implements PlaceDirectory {
  readonly name = "fake";
  queries: string[] = [];
  private places: Place[];
  constructor(places: Place[] = PLACES) {
    this.places = places;
  }
  async searchText(query: string): Promise<Place[]> {
    this.queries.push(query);
    return this.places;
  }
  async details(id: string): Promise<Place | undefined> {
    return this.places.find((p) => p.id === id);
  }
}

export const fakePages: PageFetcher = { fetchHomepage: async (url) => SITES[url] };

export function fakeEngine(places: Place[] = PLACES, extraSites: Record<string, string> = {}): { engine: RestaurantEngine; places: FakePlaces } {
  const fake = new FakePlaces(places);
  return { engine: new RestaurantEngine(fake, { fetchHomepage: async (url) => extraSites[url] ?? (await fakePages.fetchHomepage(url)) }), places: fake };
}
