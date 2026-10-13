/**
 * A new box moves to the newest endorsed release once, on its first boot.
 *
 * Boxes start from whatever their image baked in (a VM appliance carries the
 * code of the day it was built), so without this a new server came up behind
 * and its owner's first job was to update it. Here there is no owner order:
 * the maintainer endorsement is the consent, checked by the same release gate
 * every update passes (only an endorsed descendant of the running commit is
 * ever applied), and the apply goes through the same code swap and boot
 * health gate, so a bad release rolls back on its own. It only runs on a box
 * that has never been updated and holds no apps, so nothing is interrupted.
 */
import { readFile } from "node:fs/promises";
import { writeFileDurable } from "./durableFile.js";
import type { ReleaseCatalogSource } from "./updateReleases.js";
import type { UpdateConsumeOutcome } from "./updateConsumer.js";

export type FirstBootUpdateState = "current" | "applying" | "not-first-boot" | "gave-up";

export interface FirstBootRecord {
  state: FirstBootUpdateState;
  at: number;
  fromCommit?: string;
  targetCommit?: string;
  reason?: string;
}

export interface FirstBootUpdateOptions {
  /** `<dataDir>/first-boot-update.json`: once it exists, this never runs again. */
  markerPath: string;
  /** The box has been updated before (`update-outcome.json`) or has an update staged. */
  hasUpdateHistory: () => Promise<boolean>;
  /** How many apps the box holds. */
  appCount: () => number;
  catalog: ReleaseCatalogSource;
  apply: (fromCommit: string, targetCommit: string) => Promise<UpdateConsumeOutcome>;
  /** Tries while the network or GitHub isn't answering yet. */
  attempts?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

export async function readFirstBootRecord(path: string): Promise<FirstBootRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as FirstBootRecord;
  } catch {
    return null;
  }
}

export async function runFirstBootUpdate(o: FirstBootUpdateOptions): Promise<FirstBootRecord | null> {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if ((await readFirstBootRecord(o.markerPath)) !== null) return null;
  const record = async (r: Omit<FirstBootRecord, "at">): Promise<FirstBootRecord> => {
    const full = { ...r, at: now() };
    await writeFileDurable(o.markerPath, JSON.stringify(full));
    return full;
  };
  if ((await o.hasUpdateHistory()) || o.appCount() > 0) return record({ state: "not-first-boot" });

  const attempts = o.attempts ?? 6;
  for (let i = 1; i <= attempts; i++) {
    const catalog = await o.catalog.get({ refresh: true }).catch((e: Error) => {
      log(`[first-boot-update] couldn't list releases: ${e.message}`);
      return null;
    });
    if (catalog && !catalog.stale && catalog.currentCommit) {
      // Re-checked: an app may have arrived while the network came up.
      if (o.appCount() > 0) return record({ state: "not-first-boot" });
      const from = catalog.currentCommit;
      if (!catalog.latest) {
        log(`[first-boot-update] ${from} is the newest endorsed release`);
        return record({ state: "current", fromCommit: from });
      }
      const target = catalog.latest.commit;
      // Recorded before the apply: whatever happens next (a restart into the
      // new code, a rollback), a first boot never tries twice.
      const rec = await record({ state: "applying", fromCommit: from, targetCommit: target });
      log(`[first-boot-update] moving to the newest endorsed release ${catalog.latest.tag} (${target})`);
      const r = await o.apply(from, target);
      if (r.applied) return rec;
      return record({ state: "gave-up", fromCommit: from, targetCommit: target, reason: r.reason });
    }
    if (i < attempts) await sleep(o.retryMs ?? 2 * 60_000);
  }
  log("[first-boot-update] couldn't reach the release source; staying on the baked release");
  return record({ state: "gave-up", reason: "no release list" });
}
