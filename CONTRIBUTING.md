# Contributing to Pako

Thank you. Pako is a personal assistant that people run for themselves, so the bar is: it must stay **safe by default, private, and easy to start**.

## Run it

```bash
npm install
npm start          # local mode: opens the panel with the chat; needs Claude Code signed in
npm test           # about 200 tests, no network, no keys
(cd voice-worker && npm ci)     # once: the phone voice is its own package
npx tsc --noEmit -p . && npx tsc --noEmit -p voice-worker && npm test   # what to run before a pull request
```

Node runs the TypeScript directly (type stripping): no build step. That means **no enums, no parameter properties** and `.ts` extensions in imports.

## Good first contributions

- Another calendar (Google, Microsoft, CalDAV) next to Zoho in `src/calendar.ts`; another mail source; another chat (Signal, Matrix) beside Telegram in `src/telegram.ts`.
- A restaurant booking platform's page pattern in `src/restaurants/booking-links.ts` or `booking-widgets.ts`.

## Rules that are not negotiable

1. **Third-party text is data, never instructions.** Mail, Slack, calendar titles, restaurant pages and web results are shown or summarized in an isolated run with no tools; nothing in them may trigger an action.
2. **Nothing goes to another person without the owner's explicit press** (a call, a message, a table request). STOP must stop it, server side.
3. **Read-only integrations stay read-only.** A new scope needs a good reason written in the pull request.
4. **No mock data in the product.** A screen shows what is real or says it is not connected. Tests use fakes; the product never does.
5. **Every setting the code reads is documented** (a test checks it) and **no line in `src/*.ts` is over 200 characters** (a test checks that too).
6. **No secret, personal data or private note in the repository**, ever, including in tests and examples.

## Size: new code replaces old

Pako's code has a ceiling: `code-ceiling.json`, checked by `test/code-ceiling.test.ts` in the gate. The count is the non-blank lines of
the code files in `src/`, `assistant/`, `desktop/`, `bin/` and `voice-worker/src/` (tests and docs do not count). A change that adds
code deletes as much somewhere else; when the code shrinks, the ceiling comes down with it. Until 7 December 2026 there is also a
feature freeze: only fixes for data loss, security, or Pako acting in someone's name.

## Pull requests

Small and focused, with a test for the behaviour you changed. Say in the description what you checked and, honestly, what you could not (for example "not tried against the real API").
