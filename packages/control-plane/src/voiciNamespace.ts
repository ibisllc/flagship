// The names registry's upkeep (docs/voici-namespace-spec.md, Lifecycle and Reserved words): the scheduled job that
// releases held usernames once their grace period ends, and adds any reserved word the config file gained since the
// last run. Storage: packages/storage/src/names.ts; the list: reservedNames.json.

import type { NameRegistryStorage } from "@flagship/storage";
import reservedNames from "./reservedNames.json" with { type: "json" };

/** The reserved words, as the config file lists them (loaded at deploy time: the Worker bundles the file). */
export const RESERVED_NAMES: readonly string[] = reservedNames.words;

export interface NamesUpkeepResult {
  /** Held usernames whose 30 days ended: released, so anyone may claim them now (D6). */
  released: number;
  /** Reserved words new in the config file, now in the registry. */
  added: string[];
  /** Reserved words something already holds: left out, to settle by hand (spec, "Reserved word added"). */
  conflicts: string[];
}

export async function runNamesUpkeep(
  deps: { names: Pick<NameRegistryStorage, "releaseExpiredHolds" | "addReserved">; words?: readonly string[] },
  now: number,
): Promise<NamesUpkeepResult> {
  const released = await deps.names.releaseExpiredHolds(now);
  const { added, conflicts } = await deps.names.addReserved(deps.words ?? RESERVED_NAMES, now);
  return { released, added, conflicts };
}
