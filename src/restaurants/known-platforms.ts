/**
 * Restaurants whose booking runs on a reservation widget (CoverManager, TheFork...) rather than a platform the
 * connector builds links for: the widget's own page, used as the restaurant's booking page. Keyed by Google place id.
 */
export const KNOWN_BOOKING_PAGES: Record<string, string> = {
  // ----- Barcelona (opened in a browser Nov 2026: each CoverManager module loads with a working calendar) -----
  // 2254 Barcelona Restaurant
  "ChIJ_0MAT42ipBIRzRp5sSdFQL4": "https://www.covermanager.com/reservation/module_restaurant/restaurante-2254-tapas-restaurant/english",
  // 7 Portes
  "ChIJUbEvx_-ipBIRtgarQLBWDZ0": "https://www.covermanager.com/reservation/module_restaurant/restaurante-7-portes/english",
  // Bar Mut
  "ChIJ5_8SapSipBIRQkiXvYQHOmA": "https://www.covermanager.com/reservation/module_restaurant/restaurante-barmut/english",
  // BENZiNA
  "ChIJcWTj-yWjpBIRzxnEBhaddY4": "https://www.covermanager.com/reservation/module_restaurant/restaurante-benzina/english",
  // Botafumeiro
  "ChIJa0Y5HZiipBIROWRrQ0RCjVA": "https://www.covermanager.com/reservation/module_restaurant/restaurante-botafumeiro/english",
  // Brisa Sin Prisa
  "ChIJecNwMj6jpBIRXduXM-y482s": "https://www.covermanager.com/reservation/module_restaurant/restaurante-brisa-sin-prisa/english",
  // Cal Pep
  "ChIJbd9pOf6ipBIRt8JasLJbTHI": "https://www.covermanager.com/reservation/module_restaurant/restaurante-calpep/english",
  // Carlota Akaneya
  "ChIJNweNw_WipBIRc8l5CQyli7g": "https://www.covermanager.com/reservation/module_restaurant/restaurante-carlota-akaneya/english",
  // Cinc Sentits
  "ChIJ8TMSh46ipBIRVmVx_17vwLE": "https://www.covermanager.com/reservation/module_restaurant/cinc-sentits/english",
  // Finca Nebot 1924
  "ChIJie75nh6jpBIRynMLoK3N2o0": "https://www.covermanager.com/reservation/module_restaurant/restaurante-finca-nebot/english",
  // Ikibana Sarrià
  "ChIJD1vjH3CYpBIRnM9zk7IglF0": "https://www.covermanager.com/reservation/module_restaurant/restaurante-ikibana-sarria/english",
  // IKOYA Izakaya
  "ChIJW33aGMWjpBIRS4i9jUmbYKk": "https://www.covermanager.com/reservation/module_restaurant/restaurante-ikoya/english",
  // Irati Taverna Basca
  "ChIJv3TylPeipBIR5Wy-_r2rWzw": "https://www.covermanager.com/reservation/module_restaurant/restaurante-iratitavernabasca/english",
  // Koy Shunka
  "ChIJzwnCHfqipBIRBQbVUnQ5gXU": "https://www.covermanager.com/reservation/module_restaurant/restaurante-koyshunka/english",
  // La Mar Salada
  "ChIJh01b3aujpBIRAxWL8QFNnjE": "https://www.covermanager.com/reservation/module_restaurant/lamarsalada-Barceloneta/english",
  // LAMALVA
  "ChIJ8U98946jpBIRinhPCufu2EQ": "https://www.covermanager.com/reservation/module_restaurant/restaurante-lamalva/english",
  // Listo
  "ChIJGSoQGjGjpBIRl55zFI3LSQY": "https://www.covermanager.com/reservation/module_restaurant/listo-ristorante/english",
  // Maleducat
  "ChIJPw0-66WjpBIRPN6jXT90c54": "https://www.covermanager.com/reservation/module_restaurant/restaurante-maleducat/english",
  // Mont Bar
  "ChIJ0dN7e4yipBIRegh8fqP2o98": "https://www.covermanager.com/reservation/module_restaurant/restaurante-montbar/english",
  // Restaurant Agua
  "ChIJL_kQlAijpBIRCYCEoSNB1cA": "https://www.covermanager.com/reservation/module_restaurant/agua/english",
  // Restaurant Barra Alta Barcelona
  "ChIJ9c5JxpiipBIRmzY14q5u2pQ": "https://www.covermanager.com/reservation/module_restaurant/restaurante-barraalta/english",
  // Restaurant Casa Delfín
  "ChIJRYr4C_6ipBIRFe_LoEEGcPg": "https://www.covermanager.com/reservation/module_restaurant/restaurante-casadelfin/english",
  // Taller de Tapes Born
  "ChIJeRw63f6ipBIRifnzJbcoEvo": "https://www.covermanager.com/reservation/module_restaurant/restaurante-taller-de-tapas-Argenteria/english",
  // Tapes La Bona Sort Born
  "ChIJc_54EPyipBIR9UzQGoUSLzM": "https://www.covermanager.com/reservation/module_restaurant/restaurante-tapas-bona-sort/english",
  // The Grill Barcelona
  "ChIJe4hdggijpBIR1Eh34IJNnAE": "https://www.covermanager.com/reservation/module_restaurant/the-grill-barcelona/english",
  // Txibirita
  "ChIJvTbgLf-ZpBIRAJPv7LluYaE": "https://www.covermanager.com/reservation/module_restaurant/TXIBIRITA/english",
  // Vivanda
  "ChIJPZA7yECYpBIRBtx928ahUJA": "https://www.covermanager.com/reservation/module_restaurant/restaurante-vivanda/english",
  // Vivo Tapas
  "ChIJOz6kWZGipBIR-dPpNFs_4LY": "https://www.covermanager.com/reservation/module_restaurant/restaurante-vivotapas/english",
  // Zarautz
  "ChIJRc73uoGYpBIRWN7q1pb381k": "https://www.covermanager.com/reservation/module_restaurant/restaurante-zarautztabernavasca/english",
  // Ziryab Fusion Tapas Bar
  "ChIJqdpHxP6ipBIRbGTndrM3uLA": "https://www.covermanager.com/reservation/module_restaurant/restaurante-ziryab/english",
  // TheFork pages (TheFork blocks automated browsers, so these were not opened here; a person's browser loads them)
  // Con Gracia
  "ChIJUych0ZWipBIRYdSbrR8MEW8": "https://www.thefork.es/restaurante/con-gracia-r581",
  // Margarit
  "ChIJoX0MRgKjpBIR4cIqWMh8Ojo": "https://widget.thefork.com/a6a35ded-695a-412c-9dc3-ceb69f04795c",
  // ===== Found by reading 91 Barcelona restaurants whose booking system was not recognised (Nov 2026) =====
  // ----- CoverManager pages found on restaurants' own sites (loaded in a browser Nov 2026) -----
  // Sea Breeze Beach House
  "ChIJh-jn_8yjpBIREbYxPww08pw": "https://www.covermanager.com/reservation/module_restaurant/restaurante-seebreezebeachhouse/english",
  // Restaurante Tapas y mar
  "ChIJO269dACjpBIRwUsjbcyVJ5M": "https://www.covermanager.com/reservation/module_restaurant/restaurante.tapasymar/english",
  // ----- Restoo (myrestoo.net): date, service, Continue, time, details; the fill script drives it end to end -----
  // Berbena
  "ChIJAZFXgNujpBIRH2tz97NCL38": "https://berbenabcn.myrestoo.net/en/reservar",
  // Arko Sushi Restaurant
  "ChIJRXXCjMOjpBIRX0xuoVB-EdU": "https://arkorestaurant.myrestoo.net/en/reservar",
  // Mar i Terra Rambla
  "ChIJC8WbGYyjpBIRbuzG5LGbL5k": "https://mariterrarambla.myrestoo.net/en/reservar",
  // Tapería Catalana
  "ChIJkdlUWwCjpBIRYbGahwMcFgc": "https://taperiacatalana.myrestoo.net/en/reservar",
  // Restaurant La Boqueria
  "ChIJWXpb8PeipBIR9qHIBx1PV4U": "https://restaurantelaboqueria.myrestoo.net/en/reservar",
  // El Rectangle
  "ChIJh1MYfACjpBIRRzOoYeD0uis": "https://elrectangle.myrestoo.net/en/reservar",
  // ----- TheFork widgets and the older module.lafourchette.com pages (TheFork blocks automated browsers: a person's browser loads them) -----
  // âme barcelona
  "ChIJLXOejbyjpBIRRf1hAwebQyY": "https://widget.thefork.com/es/b2195aa7-1c33-4099-bc69-8aafdecb0456",
  // La Alcoba Azul Rambla
  "ChIJs3-imnajpBIRMVE_VIfGPhA": "https://widget.thefork.com/es/ccb80e7b-77d5-4552-b4ef-ccf2d16c8b02?step=date",
  // L'Antiquari Gastronòmic
  "ChIJqxIuHHijpBIR8IMG0dLDZeo": "https://widget.thefork.com/22bc5bff-6055-4024-8b50-a8d1fabebdca",
  // Shunka
  "ChIJybfY7_mipBIR9LU_PRzJdqI": "https://module.lafourchette.com/es_ES/module/565045-d7743",
  // Can Solé
  "ChIJOx8QPKqjpBIR1u8Z5hq1qcg": "https://module.lafourchette.com/es_ES/module/1307-0a283",
  // Caelis
  "ChIJxXEkMe6ipBIRHtCUX_CpuCE": "https://module.lafourchette.com/es_ES/module/25836-8b199",
  // Cocina Hermanos Torres
  "ChIJrcC3iq2ZpBIRyVqXiw2N8XU": "https://module.lafourchette.com/es_ES/module/685571-e5916",
  // ----- Hiopos booking pages (Angular app; the fill script picks the date, the rest is by hand) -----
  // La Taverna del Coure
  "ChIJEde25_6ipBIRDDl4GEV98B4": "https://booking00.hiopos.com/booking?data=iV2V94WanlmcvZSZzxWYm1jbp1GZhZSM4YDN4ETPklEcvh2c",
  // Restaurant Glaciar
  "ChIJkaCR-VeipBIR9m-WP1Cgnoo": "https://booking00.hiopos.com/booking?data=iV2V94WanlmcvZSZzxWYm1jbp1GZhZyM3gzN3ETPklEcvh2c",
  // ----- Restaurants whose own page holds the booking form -----
  // Angle Barcelona
  "ChIJecv7K4yipBIRs8mIO7ud1vY": "https://booking.anglebarcelona.com/angle/bookings_online/index.php?lang=es",
  // Restaurant ABaC
  "ChIJjZxWjQ-YpBIR_xbBOD9lZ1k": "https://booking.abacrestaurant.com/abac/bookings_online/index.php?lang=es",
  // Lasarte
  "ChIJ06Abq5OipBIRAAbiw3cStt8": "https://www.restaurantlasarte.com/en/reserve",
  // Can Culleretes
  "ChIJGYMCSPaipBIRXpfmNOCEE3A": "https://culleretes.com/",
  // L’Autentic
  "ChIJUVXFaD6jpBIRgOWiDzHahKw": "https://www.elautentic.es/",
  // Mimi Tapas Restaurant
  "ChIJDaIRz_qjpBIRN2KU00yNnuo": "https://mimitapas.com/reservation-mf/",
  // TAPS Bar
  "ChIJEZknO2WipBIRHhtzH53sgoo": "https://tapsbarcelona.com/reservas/",
};

// Restaurants whose website loads its booking widget with JavaScript, so a plain page check finds no platform, but
// whose booking page is known (from a real booking or the customer). Keyed by Google place id. The connector also
// learns these on its own when a booking on a restaurant's site ends on a platform; the server logs each one as
// "[learned-platform] <place id> <target>" so it can be added here and survive restarts without a disk.
export const KNOWN_PLATFORM_LINKS: Record<string, string> = {
  // Piccola Cucina Osteria Siciliana, 196 Spring St, New York (booked on OpenTable, Nov 2026).
  "ChIJowhlWYxZwokRgrvA8f_x8Es": "https://www.opentable.com/restref/client/?rid=105838",
  // ----- Barcelona (SevenRooms pages that loaded) -----
  // Brugarol Barcelona
  "ChIJS9L1GjSjpBIRKQK3W5JIowM": "https://www.sevenrooms.com/reservations/brugarolbarcelona",
  // Moments
  "ChIJ6zCmfe2ipBIRHC8FSUmHIEg": "https://www.sevenrooms.com/reservations/momentsmobcn",
};

/**
 * How else to reach a restaurant that has no booking page the connector can drive, as the restaurant itself publishes
 * it on its own website. Keyed by Google place id. The connector emails a request from the customer's own address
 * (send_reservation_request) or gives the customer a WhatsApp link with the request already written; the customer
 * taps send, the connector never messages a restaurant over WhatsApp itself. Numbers are digits with country code.
 */
export const KNOWN_CONTACTS: Record<string, { email?: string; whatsapp?: string }> = {
  // Antic Pitarra
  "ChIJC8efEKWjpBIRs3fU6i8FWtE": { email: "anticpitarra@gmail.com" },
  // Arcano Restaurant
  "ChIJb-E-RfmipBIRmDyFS5ND__8": { email: "info@arcanobcn.com" },
  // Can Culleretes
  "ChIJGYMCSPaipBIRXpfmNOCEE3A": { email: "info@culleretes.com" },
  // Can Solé
  "ChIJOx8QPKqjpBIR1u8Z5hq1qcg": { email: "reserves@restaurantcansole.com" },
  // El Rebost de Sant Antoni
  "ChIJwYeCwWGipBIR-6tADaJgIVU": { email: "elrebostdesantantoni@gmail.com" },
  // El Trapella del Poblenou
  "ChIJe2zlRoyjpBIRm-3Mj-WNZyc": { email: "info@eltrapelladelpoblenou.com", whatsapp: "34626728492" },
  // Gràcia Platets i Bistró
  "ChIJS6beY46jpBIR2C0YWmqic74": { email: "graciaplatsetibistro@gmail.com" },
  // L'Arrosseria Xàtiva Gràcia
  "ChIJW3X2gL6ipBIRKMhN7d0NtJI": { email: "xativacorts@grupxativa.com" },
  // L'Arrosseria Xàtiva Les Corts
  "ChIJv1l7h3mYpBIRzjuR_1h-iOA": { email: "xativacorts@grupxativa.com" },
  // La Alcoba Azul
  "ChIJ8dubNviipBIRfwWByME5Om0": { email: "info@la-alcoba.com", whatsapp: "34663256864" },
  // La Alcoba Azul Rambla
  "ChIJs3-imnajpBIRMVE_VIfGPhA": { email: "info@la-alcoba.com", whatsapp: "34663256864" },
  // La Pepita
  "ChIJl7hQSJSipBIRk7b0Z4WCgwE": { email: "booklapepita@gmail.com" },
  // La Tasqueta de Blai
  "ChIJ4Ruxd12ipBIR-DkqG6wqVGQ": { email: "hola@latasquetadeblai.com" },
  // L’Autentic
  "ChIJUVXFaD6jpBIRgOWiDzHahKw": { whatsapp: "34634137279" },
  // Marbar
  "ChIJtSvvO3-ZpBIRedUGNrc_544": { email: "marbarestbarcelona@gmail.com" },
  // Mimi Tapas Restaurant
  "ChIJDaIRz_qjpBIRN2KU00yNnuo": { email: "mimirestaurant6@gmail.com" },
  // Orvay Restaurant
  "ChIJbxdpQ_6ipBIRtiDU9QB39-Q": { email: "info@orvayborn.com" },
  // Prado de Flores
  "ChIJ4aTqxfaipBIRi9Kz759j6GI": { email: "reservaspradodeflores@hotmail.com" },
  // Restaurant Terra Mía
  "ChIJq4cO07OipBIRS5h6cBIPRng": { whatsapp: "34628377219" },
  // Restaurante Tapas y mar
  "ChIJO269dACjpBIRwUsjbcyVJ5M": { email: "reservas@tapasy-mar.com" },
  // Sagardi Argenteria
  "ChIJp5yB5v6ipBIR6nQpmGX1XEk": { email: "reservas@gruposagardi.com" },
};
