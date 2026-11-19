// The fixed words Pako writes itself: the server's own replies (STOP, cards, receipts, reminders, notices, the panel). They are English only,
// for every owner anywhere (the owner's decision of 2026-11-18). Claude's free-form answers are not here: they follow the language each
// message is written in (assistant/prompt.ts), so a person who writes in Spanish still gets Claude's reply in Spanish, around English buttons.
//
// Where the owner lives still matters: dates, times and numbers are written the way the owner's country writes English (src/region.ts), so a
// US owner reads 3:05 PM and 11/3 while a British or Spanish one reads 15:05 and 3/11.

import { localeFor, uses12h } from "./region.ts";

/**
 * The language of Pako's fixed texts. Only English now; the type stays so the modules that pass a language function around keep compiling,
 * and a call site that still compares against another language is a type error (the comparison can never be true).
 */
export type Lang = "en";

/** The one language of Pako's fixed texts, for the modules that ask for it as a function. */
export const english = (): Lang => "en";

/**
 * The locale dates, times and numbers are written in: English as the owner's country writes it ("en-US", "en-GB", "en-AU"), and en-GB when
 * the country is not known or this computer's Intl does not know that pair (day before month, a 24-hour clock: the most widely read form).
 */
export const locale = (_l: Lang = "en"): string => localeFor("en");

/**
 * A time of day as the owner reads it: "15:05" on a 24-hour clock (the UK, most of Europe and Latin America), "3:05 PM" where the locale uses
 * AM/PM (the US, Canada, Australia...).
 */
export const ownerClock = (t: number, timeZone: string, _l: Lang = "en"): string => {
  const loc = locale();
  return uses12h(loc)
    ? new Intl.DateTimeFormat(loc, { timeZone, hour: "numeric", minute: "2-digit" }).format(t)
    : new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
};

/** Replaces {name} with vars.name; a placeholder without a value stays visible, so a test catches it. */
export const fill = (s: string, vars?: Record<string, string | number>): string =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s;

/**
 * A module's fixed texts, English only.
 *
 *   const T = texts({ hi: "Hi, {name}." });
 *   const t = T();                // or T(lang()): the language argument is accepted and ignored
 *   t("hi", { name: "Ana" })      // "Hi, Ana."
 *
 * The call shape (a table, then a function of the language) is kept so the many call sites did not have to change at once.
 */
export function texts<K extends string>(en: Record<K, string>) {
  return (_l?: Lang) => (key: K, vars?: Record<string, string | number>): string => fill(en[key], vars);
}
