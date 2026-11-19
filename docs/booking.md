# Booking a table

You say "table for 2 at Bar Mut on Friday at 21:00". A few seconds later the table is booked on the restaurant's own booking page, with
proof, a reminder and an **Undo**. When the web says no, Pako still gets the table by another route, or says exactly why not.

This page explains how that works, the rules it never breaks, and what each lane does. The code is in `src/booking.ts` (the search, the
cards, the texts), `src/restaurants/` (finding the restaurant and its booking page) and `src/maitre/` (Maître, the booking engine).

## The idea

A booking is a transaction compiled from what Pako already knows, not an agent improvising on every page. Each reservation engine
(CoverManager, TheFork, OpenTable…) gets a small script, a **cartridge**, written from pages mapped by hand. A cartridge doesn't think: it
looks, books one slot with your details, verifies the result and says, in a typed answer, exactly what happened.

```
 your order ──► search (Google Places + the restaurant's own site) ──► the restaurant's booking page
                                                                       │
                    ┌──────────────── the planner (src/maitre/planner.ts) ────────────────┐
                    │  Passport → Cartridge → Handoff → Off-web                           │
                    └──────────────────────────────┬──────────────────────────────────────┘
                                                   ▼
                    ┌──────────────── the ledger (src/maitre/ledger.ts) ──────────────────┐
                    │  planned → submitted → confirmed │ failed │ cancelled               │
                    │  key: restaurant, date, time, party · evidence · reminder · Undo    │
                    └─────────────────────────────────────────────────────────────────────┘
```

## When Pako books straight away, and when it asks

Your own order is the approval. When **your own message** names the restaurant, the day, the time and the party, and the restaurant books on
an engine Maître has a cartridge for, Pako books at once. No card to press. Afterwards you get a receipt with the proof and an **Undo**
button that cancels the booking.

Pako stops and asks instead when:

- **The turn read someone else's text** (an email, a forward, a web page, a calendar invite). A booking prompted by outside text keeps the
  card, and only your press books. The restaurant's name also has to be in your own words: a name the assistant took from an email doesn't
  count as yours.
- **Anything is ambiguous.** No specific restaurant ("somewhere Japanese in Gràcia"), several restaurants match the name, or the exact time
  isn't free. Pako asks one short question or shows the options (the real free times, when the time was taken). Your pick then books at once.
- **A gate comes up** (a captcha, a code, a card or a deposit). That is a Handoff (below).
- **A limit applies.** STOP pauses everything, at most 5 bookings or booking emails a day, and never two to the same restaurant on one day.

`PAKO_BOOKING_CONFIRM=1` brings back the card for every booking, as it was before Maître (see [Configuration](configuration.md)).

Restaurants without a cartridge keep today's routes: Pako emails them from its inbox (after your press on the card), or hands you the booking
page, their WhatsApp or their phone.

## The rules that are never broken

- **Only your order or your press books.** Never a speculative booking, never a "hold" you didn't ask for, only your real details.
- **Never past a gate.** Pako never solves a captcha, never reads an SMS or email code for you, and never types a card. Those are yours, in
  the Handoff window.
- **Never twice.** One key (restaurant, date, time, party) is one booking. Before any submit the ledger refuses a key that is already
  submitted or confirmed, and Pako checks the inbox for the engine's confirmation email. "Submitted" is written just before the button is
  pressed. A press whose answer is lost may have booked, so it is never pressed again: the inbox will say.
- **A person's pace.** Every engine has a minimum gap between page loads and an hourly budget. A Look is cached for five minutes per
  restaurant, day and party.
- **No agents where they are forbidden.** Resy deactivates accounts for agents, so Pako never automates Resy, not even a Look. It opens the
  page for you (Handoff) or uses the off-web routes.
- **Restaurant pages are third-party text.** Pako reads them for facts (times, a confirmation number) and never obeys them.
- **Your browser stays yours.** Maître drives the Chrome, Edge, Brave or Chromium already on your computer, with its own profile in
  `~/.pako/browser`. Sign in to TheFork or OpenTable there once and it is remembered. It runs headless; a window appears only for a Handoff.

## The lanes

The planner tries these in order. Every failure is typed, and the type chooses the next lane. There is never a blind retry.

| Lane | What it does | When it is used |
| --- | --- | --- |
| **Passport** | What Pako remembers about a restaurant: its engine and booking page, the fields it requires, the gates seen there, the last success and how long booking took. A second booking at a known place skips all discovery. | Every booking after the first at that restaurant. A page that changed twice in a day turns that restaurant's cartridge off for a day. |
| **Cartridge** | The engine's script, headless: pick the day and party, read the free times, choose the slot, fill your details, check the page's own summary, then submit and verify. | A restaurant on an engine with a cartridge (CoverManager, TheFork, OpenTable). |
| **Handoff** | A gate is yours to clear. The window opens on your screen at that step, with everything Pako could fill already filled. Pako tells you the one thing to do ("one tap needed: the captcha") and watches the page. When the confirmation shows, or when you say "done", it verifies and sends the receipt. | A gate, a bot wall (DataDome, Akamai), a page that stopped answering before anything was sent, and any engine that only you may use (Resy). |
| **Off-web** | Today's routes: an email from Pako's inbox, the restaurant's WhatsApp with the request written, or its phone. | No cartridge, a page that changed shape, or missing details (Maître needs your full name, a real phone and a mailbox Pako reads). |

What each typed answer leads to:

| The cartridge says | Next |
| --- | --- |
| `confirmed`, with evidence | Done: the ledger keeps the evidence, a reminder is set three hours before, and you get the receipt with Undo. |
| `gate` (captcha, code, card, login) | Handoff at that step. |
| `blocked` (a bot wall) | Handoff at the deep link. Pako never tries to get past it. |
| `no_slot` | You get the nearest real free times. Your pick books at once. |
| `changed` (the page is not what the cartridge knows) | Off-web, and the Passport remembers it. |
| `timeout` before the submit | Handoff. |
| `timeout` after the submit | Stop. It may be booked: the ledger keeps it as submitted, and Pako waits for the confirmation email. |

## The evidence

A booking is confirmed only with proof read from the page: the confirmation number when there is one, the confirmation page's address
(CoverManager redirects to the restaurant's own thank-you page with the date, time and party in it, which Pako checks against your
order), its text and a screenshot in `~/.pako/maitre/shots/`. The cancel link is kept when the page gives one. If the confirmation states
another date, time or party, the receipt says so.

**Undo** cancels through the engine's own cancel page when the cartridge supports it and the confirmation gave the link. Otherwise the
receipt says how to cancel (the link in the engine's email, or the restaurant's phone).

Pako has no calendar it can write to, so a confirmed table becomes a reminder three hours before. It also shows in the morning brief, in
`BOOKINGS` and in the assistant's context.

## The engines

| Engine | Look | Book | Gates handed over | Mapped |
| --- | --- | --- | --- | --- |
| CoverManager | The module's calendar, then its own `update_hour_people` JSON with the party's free times | Time, zone (required when offered), details, consent (newsletter left off), the summary checked, then Reserve | reCAPTCHA, a returning customer's email code, a card guarantee or deposit | Live: a real booking (Bar Mut, 2026-11-17) and real Looks |
| TheFork | The deep link `#booking=&date=&partySize=`, then the time slots | As far as the sign-in step, with the date, time and party chosen and checked on the summary pill. Signing in, or the email code, is yours. | Sign-in or code, a card, DataDome | Live (2026-11-17), Book stops before sign-in |
| OpenTable | The deep link `?covers=&dateTime=`, then the time slots | The slot, your details (marketing left off), then Complete reservation | A phone or email code, a card, Akamai | From the field guide and hand-made pages; not yet mapped live |

Not automated: Resy (forbids agents: Handoff or off-web only). SevenRooms, Zenchef, ResDiary and Tock come next.

## Tests

The cartridges are tested against hand-made pages of each engine (calendar, slots, form, confirmation, a bot wall, a captcha, a code, a
card), served by a local web server and driven by the real driver against a real local Chrome, headless with a temporary profile. Nothing
leaves the computer. Without a Chromium browser (CI) those tests are skipped, with the reason; the ledger, the lanes, the policy, the pace and
the booking flows run everywhere. One test sends two Book presses for the same table at once and checks that the engine saw exactly one
submit.
