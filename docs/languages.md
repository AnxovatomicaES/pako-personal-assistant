# Languages and countries

Pako's own words are in English, for an owner in any country. Claude's answers follow the language each message is written in: write in
Japanese, Portuguese or Spanish and the reply comes back in that language, around English buttons. This page says how the language and the
country work, and what adding another language for the fixed words would take.

## Two things, kept apart

- **The language** is the words Pako writes itself: commands, cards, receipts, reminders, notices, the panel, the Mac app. They are English
  only (`src/i18n.ts`). `PAKO_LANGUAGE` is accepted and ignored (the log says so once). Claude's own answers are not part of it: every
  prompt tells Claude to reply in the language the person writes in, with all fixed text and tool arguments in English.
- **The country** is where the owner lives. It sets the emergency number and the crisis line a red flag gets, the country code of a phone
  number written without one, and how dates, times and numbers are written: a US owner reads 3:05 PM and 11/3, a British or Indian owner
  15:05 and 3/11.

## Where the country and the time zone come from

All in `src/region.ts`:

| What | Order |
| --- | --- |
| Time zone | `PERSONAL_TIMEZONE`, else the computer's own zone, else UTC. A server on Render runs in UTC: without `PERSONAL_TIMEZONE` its log says so once at start. |
| Country | `PAKO_COUNTRY`, else the country of that time zone (`America/New_York` is `US`), else the region of the system's locale (`LANG=en_GB.UTF-8` is `GB`), else not known. The zone comes before the locale because many computers say `en-US` only because it is the default. |
| Locale | English as that country writes it: `en-US`, `en-AU`, `en-IE`, `en-IN`. A country that is not known, or one this computer's `Intl` has no English data for, gets `en-GB`: day before month on a 24-hour clock, the form most of the world reads. |

What follows from the locale, all through `Intl` (no hand-built date strings):

- **Times**: `ownerClock` in `src/i18n.ts` writes 15:05 where the locale uses a 24-hour clock and 3:05 PM where it uses AM/PM. Every date
  goes through `locale()`, so day/month order and month names follow too.
- **Numbers**: `Intl.NumberFormat(locale())`.
- **The panel** gets the country on `<html data-region>`, and its pages use `localeFor` from `src/panel/i18n.js`, the same rule.
- **Help numbers**: the per-country table in `src/health.ts` (US, GB, CA, AU, IE, FR, DE, IT, ES, PT, MX, AR, CO, CL, and a few more with
  only the emergency number; 112 for the rest of the EU). For any other country, the fixed reply says "your local emergency number" and
  points to findahelpline.com. Claude is told the same through the context line.
- **Phone numbers**: `nationalNumber` in `src/region.ts` reads a number without its country code in the owner's country ((415) 555-0100 in
  the US, 020 7946 0000 in the UK). A number with `+` or `00` is never changed, and nothing is guessed when the country is not known.

Tests run with a fixed zone (`TZ=Europe/Madrid` in `npm test`) so that every run is the same. A test of another country sets it:
`setOwnerRegion("US")`, `PAKO_COUNTRY`, or an explicit time zone.

## How the fixed words are kept

- **Server**: each module keeps its words with `texts(en)` from `src/i18n.ts`, one English table per module. `Lang` is `"en"` only, so a
  call site that still compares against another language is a type error.
- **Panel**: `src/panel/i18n.js` (`WORDS`, `CHAT_WORDS`) and `src/panel/settings-words.js`, one English object each.
  `test/panel-i18n.test.ts` checks every key the page uses is there.
- **Commands** (`HELP`, `REMINDERS`, `PENDING`…) are English only: the regular expressions in `src/intents.ts` and the door's handlers.
  Anything else reaches Claude as ordinary text, in any language.
- **Prompts** (`assistant/prompt.ts`) are in English, each with the line that has Claude reply in the person's language.
- **Language detection** (`src/language.ts`) tells eight languages apart (en, es, ca, fr, de, it, pt, nl), so the summaries Pako writes
  when the owner has not just written follow the language the owner last wrote in.

## Adding another language

The fixed words were in two languages until 2026-11-18 and are now in one, by choice. Bringing back a second one means, in order: widening
`Lang` in `src/i18n.ts` and `texts()` to take a table per language; a table per module (about 55 files call `texts`, `git grep -n "texts("`
lists them; the door's is the largest, `src/door/texts.ts`); the same in `src/panel/i18n.js`, `src/panel/settings-words.js` and the Mac app's
`Texts.swift`; a way to choose it (a welcome step and a setting in the panel); and the commands' words in `src/intents.ts`. Claude's answers,
the language detection, the dates (`Intl`) and the help numbers (by country) need no change.
