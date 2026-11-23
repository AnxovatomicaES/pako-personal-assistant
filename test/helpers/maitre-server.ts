// A local web server with hand-made pages of the three engines Maître books (CoverManager, TheFork, OpenTable), for the cartridges to
// be driven through by the real CDP driver against a real local Chrome. Nothing leaves 127.0.0.1. It counts every submit and cancel, so a
// test can prove a booking went out exactly once.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "maitre");

export interface FixtureServer {
  base: string;
  submits: Record<string, string>[];
  cancels: string[];
  /** Milliseconds the submit answer is held back (a slow engine). */
  slowSubmitMs: number;
  close(): Promise<void>;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

const page = (title: string, inner: string, script = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${inner}<script>${script}</script></body></html>`;

/** TheFork's booking steps, driven by the address's #booking=&date=&hour=&partySize= like the real page. */
const FORK = page(
  "Le Fixture - TheFork",
  `<h1>Le Fixture</h1><div id="steps"></div><div id="cookies"><button onclick="this.parentElement.remove()">Continue Without Accepting</button></div>`,
  `
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function state() { const p = new URLSearchParams(location.hash.slice(1)); return { date: p.get('date'), hour: p.get('hour'), party: p.get('partySize') }; }
function render() {
  const s = state();
  const el = document.getElementById('steps');
  if (!s.date) { el.innerHTML = ''; return; }
  const d = new Date(s.date + 'T12:00:00');
  const pill = '<div data-testid="reservation-summary-pill-1">' + DAYS[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate() + (s.party ? ' · ' + s.party + ' Pers.' : '') + (s.hour ? ' · ' + s.hour : '') + '</div>';
  if (!s.party) { el.innerHTML = pill + [1,2,3,4,5,6].map(n => '<button data-testid="pax-' + n + '">' + n + '</button>').join(''); return; }
  if (!s.hour) {
    const times = d.getDay() === 0 ? [] : ['20:00','20:30','21:00','21:30'];
    el.innerHTML = pill + '<button data-testid="stephour-button">Time</button><div data-testid="timeslot-service-diner">Dinner</div>' +
      (times.length ? times.map(t => '<button data-testid="timeslot-' + t + '">' + t + '</button>' + (t === '21:00' ? '<span data-testid="hour-slot-' + t + '-offer">-20%</span>' : '')).join('') : '<p data-testid="no-availability">No availability</p>');
    return;
  }
  el.innerHTML = pill + '<div data-testid="step-login-identification"><input type="email"><button data-testid="checkout-submit-email">Continue</button><button data-testid="google-login">Google</button></div>';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-testid]');
  if (!b) return;
  const id = b.dataset.testid, s = state();
  if (id.startsWith('pax-')) location.hash = 'booking=&date=' + s.date + '&partySize=' + id.slice(4);
  else if (id.startsWith('timeslot-') && !id.startsWith('timeslot-service')) location.hash = 'booking=&date=' + s.date + '&hour=' + encodeURIComponent(id.slice(9)) + '&partySize=' + s.party;
});
window.addEventListener('hashchange', render);
render();`,
);

/** OpenTable's restaurant page with its time slots for ?covers=&dateTime=. */
const otSlots = (covers: string, dateTime: string): string =>
  page(
    "Fixture Grill | OpenTable",
    `<h1>Fixture Grill</h1><p>Party of ${covers}</p>` +
      ["8:30 PM", "9:00 PM", "9:30 PM"].map((t) => `<a data-test="time-slot" href="/booking/details?covers=${covers}&dateTime=${encodeURIComponent(dateTime.slice(0, 11))}${encodeURIComponent(t)}">${t}</a> `).join(""),
  );

/** "Friday, December 5": a day as OpenTable's English pages write it. */
const longDay = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
/** The day after a YYYY-MM-DD (what a page offers when the asked day is full). */
const nextDay = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A restaurant page whose asked day has no table: it offers the NEXT day's 9:00 PM instead, as a link to the booking details (`withDateTime`: its address says that day too). */
const otNextDay = (covers: string, dateTime: string, withDateTime: boolean): string => {
  const day = nextDay(dateTime.slice(0, 10));
  const link = withDateTime ? `/booking/details?covers=${covers}&dateTime=${encodeURIComponent(`${day}T9:00 PM`)}` : `/booking/details?covers=${covers}&shown=${day}`;
  return page("Fixture Grill | OpenTable", `<h1>Fixture Grill</h1><p>Nothing free on ${longDay(dateTime.slice(0, 10))}. Next available:</p><a data-test="time-slot" href="${link}">9:00 PM</a>`);
};

const otDetails = (q: URLSearchParams, otp: boolean): string =>
  page(
    "Complete your reservation | OpenTable",
    `<h1>Fixture Grill</h1><p>${longDay(q.get("shown") ?? (q.get("dateTime") ?? "").slice(0, 10))} · ${q.get("covers")} people · ${(q.get("dateTime") ?? "").slice(11) || "9:00 PM"}</p>` +
      (otp
        ? `<p>Enter the verification code we sent to your phone</p><input inputmode="numeric" autocomplete="one-time-code">`
        : `<form id="f"><input id="firstName"><input id="lastName"><input id="phoneNumber"><input id="email"><textarea id="specialRequest"></textarea>
           <label><input type="checkbox" id="marketingOptIn" checked> Offers</label>
           <button type="button" data-test="complete-reservation-button">Complete reservation</button></form>`),
    `document.querySelector('[data-test="complete-reservation-button"]')?.addEventListener('click', async () => {
      const f = (id) => document.getElementById(id).value;
      const r = await fetch('/ot/submit', { method: 'POST', body: new URLSearchParams({ first: f('firstName'), last: f('lastName'), phone: f('phoneNumber'), email: f('email'), when: ${JSON.stringify(q.get("dateTime") ?? "")}, covers: ${JSON.stringify(q.get("covers") ?? "")} }) });
      const j = await r.json();
      location.href = '/booking/view?confirmationNumber=' + j.id + '&day=' + ${JSON.stringify(q.get("shown") ?? (q.get("dateTime") ?? "").slice(0, 10))} + '&covers=' + ${JSON.stringify(q.get("covers") ?? "")} + '&time=' + encodeURIComponent(${JSON.stringify((q.get("dateTime") ?? "").slice(11) || "9:00 PM")});
    });`,
  );

export async function startFixtureServer(): Promise<FixtureServer> {
  const submits: Record<string, string>[] = [];
  const cancels: string[] = [];
  let n = 0;
  const state = { slowSubmitMs: 0 };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, html: string, type = "text/html; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(html);
    };
    const p = url.pathname;
    // ---------- CoverManager ----------
    if (/^\/reservation\/module_restaurant\/[^/]+\/english$/.test(p)) return send(200, readFileSync(join(FIXTURES, "covermanager.html"), "utf8"));
    if (p === "/reservation/update_hour_people/0") {
      const form = new URLSearchParams(await body(req));
      const slug = url.searchParams.get("slug") ?? "";
      const party = Number(form.get("people"));
      const times = slug === "full" || party > 6 ? [] : ["13:00", "13:30", "20:30", "21:00", "21:30"];
      const hourBox = `<label for="hour-box-select">Time</label>\n<div id='horas'><select id="hour-box-select" class="form-control"><option value='-1' disabled>Select</option>${times.map((t) => `<option value="${t}">${t}</option>`).join("")}</select></div>`;
      return send(200, JSON.stringify({ total_fire: false, hoursall: Object.fromEntries(times.map((t) => [t, t])), close: 0, hour_box: hourBox }), "application/json");
    }
    if (p === "/reservation/submit" && req.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await body(req)));
      submits.push({ engine: "CoverManager", ...form });
      if (state.slowSubmitMs) await new Promise((r) => setTimeout(r, state.slowSubmitMs));
      return send(200, JSON.stringify({ id: `CM${++n}X` }), "application/json");
    }
    if (p === "/gracias-por-su-reserva") {
      const id = url.searchParams.get("id") ?? "";
      return send(200, page("Gracias", `<h1>Thank you</h1><p>You will soon receive an e-mail confirming your reservation.</p><p>Locator: ${id}</p><a href="/cancel/${id}">Cancel my reservation</a>`));
    }
    if (p.startsWith("/cancel/")) {
      const id = p.slice(8);
      if (req.method === "POST") {
        cancels.push(id);
        return send(200, "{}", "application/json");
      }
      return send(200, page("Cancel", `<p>Reservation ${id}</p><button id="c">Cancel reservation</button><p id="out"></p>`,
        `document.getElementById('c').onclick = async () => { if (!confirm('Are you sure?')) return; await fetch(location.pathname, { method: 'POST' }); document.getElementById('out').textContent = 'Your reservation has been cancelled'; };`));
    }
    // ---------- TheFork ----------
    if (p === "/restaurant/le-fixture-r123") return send(200, FORK);
    if (p === "/restaurant/le-blocked-r9") {
      // DataDome's answer: a 403 whose page is a challenge frame (served from here: nothing goes out).
      return send(403, page("theFork", `<iframe src="/geo.captcha-delivery.com/captcha/?initialCid=x" width="400" height="300"></iframe>`));
    }
    if (p.startsWith("/geo.captcha-delivery.com/")) return send(200, page("challenge", "<p>Slide to the right</p>"));
    // ---------- OpenTable ----------
    if (p === "/r/akamai-grill") return send(403, page("Access Denied", `<h1>Access Denied</h1><p>You don't have permission to access this server.</p><p>Reference #18.4f2a1b2c.1700000000.abcdef</p>`));
    if (p === "/r/nextday-grill" || p === "/r/textonly-grill") return send(200, otNextDay(url.searchParams.get("covers") ?? "2", url.searchParams.get("dateTime") ?? "", p === "/r/nextday-grill"));
    if (p === "/r/fixture-grill" || p === "/r/otp-grill") return send(200, otSlots(url.searchParams.get("covers") ?? "2", url.searchParams.get("dateTime") ?? ""));
    if (p === "/booking/details") {
      const otp = (req.headers.referer ?? "").includes("/r/otp-grill");
      return send(200, otDetails(url.searchParams, otp));
    }
    if (p === "/ot/submit" && req.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await body(req)));
      submits.push({ engine: "OpenTable", ...form });
      return send(200, JSON.stringify({ id: String(40000 + ++n) }), "application/json");
    }
    if (p === "/booking/view") {
      const id = url.searchParams.get("confirmationNumber") ?? "";
      const day = url.searchParams.get("day");
      const facts = day ? `<p>${longDay(day)} · ${url.searchParams.get("time")} · ${url.searchParams.get("covers")} people</p>` : "";
      return send(200, page("Reservation confirmed", `<h1>You're all set</h1>${facts}<p>Confirmation #${id}</p><a href="/booking/cancel?id=${id}">Cancel reservation</a>`));
    }
    if (p === "/booking/cancel") {
      const id = url.searchParams.get("id") ?? "";
      if (req.method === "POST") {
        cancels.push(id);
        return send(200, "{}", "application/json");
      }
      return send(200, page("Cancel", `<button data-test="cancel-reservation-button">Cancel reservation</button><p id="out"></p>`,
        `document.querySelector('button').onclick = async () => { await fetch(location.href, { method: 'POST' }); document.getElementById('out').textContent = 'Your reservation has been cancelled'; };`));
    }
    send(404, page("Not found", "<p>Not found</p>"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    submits,
    cancels,
    get slowSubmitMs() {
      return state.slowSubmitMs;
    },
    set slowSubmitMs(v: number) {
      state.slowSubmitMs = v;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
