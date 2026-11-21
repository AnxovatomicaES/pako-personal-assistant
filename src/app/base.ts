// Wires the app's base: the language of Pako's own texts, the owner's time zone and country, the proxies trusted, and which labs
// (src/labs.ts) start.

import express from "express";
import { loadCountry } from "../health.ts";
import { english } from "../i18n.ts";
import { grandfatherNote, type Labs, parseLabsSetting, readLabChoices, resolveLabs } from "../labs.ts";
import { pakoHome } from "../local.ts";
import { createLog } from "../log.ts";
import { ownerTimeZone, setOwnerRegion } from "../region.ts";
import { type Env, languageIgnoredNote, type LocalContext } from "./config.ts";
import type { AppCtx } from "./context.ts";

const logHealth = createLog("health");
const logLabs = createLog("labs");
const logLanguage = createLog("language");
const logTime = createLog("time");

/** Which labs are on for this start: src/server.ts loads their code with it (src/lab-code.ts) before createApp, and wireBase keeps it. */
export function labsFor(env: Env, local?: LocalContext): Labs {
  return resolveLabs({
    env,
    ...(local ? { choices: readLabChoices(pakoHome(env)), setUp: { whatsapp: !!local.settings?.whatsapp?.() } } : {}),
  });
}

export function wireBase(ctx: AppCtx) {
  const { config, env, local } = ctx;
  const app = express();
  app.disable("x-powered-by");
  // Every module that writes a fixed text still takes the language as a function (src/i18n.ts): always English.
  const uiLang = english;
  const languageNote = languageIgnoredNote(env);
  if (languageNote) logLanguage.warn(languageNote);
  app.locals.uiLang = uiLang;
  // Where the owner is (src/region.ts): their time zone, with or without the phone line's settings, and their country, which sets the
  // emergency numbers and how every date and time is written ("en-US": 3:05 PM; "en-GB": 15:05). Said once when it is only a guess.
  const ownerZone = config.personalCaller?.timeZone ?? ownerTimeZone(env.PERSONAL_TIMEZONE).timeZone;
  const zoneNote = config.personalCaller ? config.personalCaller.timeZoneNote : ownerTimeZone(env.PERSONAL_TIMEZONE).note;
  if (zoneNote) logTime.error(`${zoneNote}`);
  const country = loadCountry(env);
  if (country.problem) logHealth.error(`${country.problem}`);
  setOwnerRegion(country.country);
  app.set("trust proxy", config.trustProxyHops > 0 ? config.trustProxyHops : false);
  // LABS (src/labs.ts): which experimental parts start. Off for a new install; one already set up keeps going (grandfathered). Each gate
  // below is marked "LABS:"; nothing else in createApp depends on it.
  const labsUnknown = parseLabsSetting(env.PAKO_LABS).unknown;
  if (labsUnknown.length) logLabs.warn(`PAKO_LABS: no lab called ${labsUnknown.join(", ")}`);
  const labs = labsFor(env, local);
  const labsNote = grandfatherNote(labs);
  if (labsNote) logLabs.info(labsNote);
  app.locals.labs = labs;
  return { app, uiLang, ownerZone, country, labs };
}
