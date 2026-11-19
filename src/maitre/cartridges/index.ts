// The cartridges Maître has, in the order a restaurant's page is matched against them.

import type { Cartridge } from "../cartridge.ts";
import { coverManager } from "./covermanager.ts";
import { openTable } from "./opentable.ts";
import { theFork } from "./thefork.ts";

export const CARTRIDGES: Cartridge[] = [coverManager, theFork, openTable];

/** The cartridge for a restaurant's booking page, or null when Maître has none for its engine (today's routes are used then). */
export function cartridgeFor(url: string | undefined, list: Cartridge[] = CARTRIDGES): Cartridge | null {
  if (!url) return null;
  return list.find((c) => c.matches(url)) ?? null;
}
