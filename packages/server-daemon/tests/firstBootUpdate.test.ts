import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFirstBootRecord, runFirstBootUpdate, type FirstBootUpdateOptions } from "../src/firstBootUpdate.js";
import type { ReleaseCatalog } from "../src/updateReleases.js";
import type { UpdateConsumeOutcome } from "../src/updateConsumer.js";

const OLD = "9873b83e".padEnd(40, "0");
const NEW = "57b69edb".padEnd(40, "0");

function catalog(c: Partial<ReleaseCatalog> = {}): ReleaseCatalog {
  return {
    checkedAt: 0,
    currentCommit: OLD,
    latest: { commit: NEW, releaseId: "r", tag: "v0.0.0-2026-10-13-57b69edb", endorsedAt: "2026-10-13T00:00:00Z", relation: "newer" },
    releases: [],
    ...c,
  };
}

async function rig(o: Partial<FirstBootUpdateOptions> & { catalogs?: Array<ReleaseCatalog | Error>; result?: UpdateConsumeOutcome } = {}) {
  const markerPath = join(await mkdtemp(join(tmpdir(), "fbu-")), "first-boot-update.json");
  const applied: string[] = [];
  const catalogs = o.catalogs ?? [catalog()];
  const opts: FirstBootUpdateOptions = {
    markerPath,
    hasUpdateHistory: async () => false,
    appCount: () => 0,
    catalog: {
      get: async () => {
        const c = catalogs.shift() ?? catalog();
        if (c instanceof Error) throw c;
        return c;
      },
    },
    apply: async (from, to) => {
      applied.push(`${from}->${to}`);
      return o.result ?? { applied: true, previousCommit: from, targetCommit: to };
    },
    sleep: async () => {},
    now: () => 1,
    ...o,
  };
  return { opts, markerPath, applied };
}

describe("a new box's first-boot update", () => {
  it("moves to the newest endorsed release, recording it before the apply", async () => {
    const r = await rig();
    let markerAtApply: unknown = null;
    r.opts.apply = async (from, to) => {
      markerAtApply = await readFirstBootRecord(r.markerPath);
      return { applied: true, previousCommit: from, targetCommit: to };
    };
    expect(await runFirstBootUpdate(r.opts)).toMatchObject({ state: "applying", fromCommit: OLD, targetCommit: NEW });
    expect(markerAtApply).toMatchObject({ state: "applying", targetCommit: NEW });
  });

  it("runs once: a rolled-back first update never tries again", async () => {
    const r = await rig();
    await runFirstBootUpdate(r.opts);
    expect(await runFirstBootUpdate(r.opts)).toBeNull();
    expect(r.applied).toHaveLength(1);
  });

  it("leaves a box alone once it has been updated or holds apps", async () => {
    const updated = await rig({ hasUpdateHistory: async () => true });
    expect(await runFirstBootUpdate(updated.opts)).toMatchObject({ state: "not-first-boot" });
    const withApps = await rig({ appCount: () => 1 });
    expect(await runFirstBootUpdate(withApps.opts)).toMatchObject({ state: "not-first-boot" });
    expect([...updated.applied, ...withApps.applied]).toEqual([]);
  });

  it("does nothing when it already runs the newest release", async () => {
    const r = await rig({ catalogs: [catalog({ latest: null })] });
    expect(await runFirstBootUpdate(r.opts)).toMatchObject({ state: "current", fromCommit: OLD });
    expect(r.applied).toEqual([]);
  });

  it("waits for the network instead of deciding on a stale list", async () => {
    const r = await rig({ catalogs: [new Error("offline"), catalog({ stale: true, latest: null }), catalog()] });
    expect(await runFirstBootUpdate(r.opts)).toMatchObject({ state: "applying", targetCommit: NEW });
    const never = await rig({ attempts: 2, catalogs: [catalog({ stale: true }), catalog({ stale: true })] });
    expect(await runFirstBootUpdate(never.opts)).toMatchObject({ state: "gave-up", reason: "no release list" });
    expect(never.applied).toEqual([]);
  });

  it("records a refused or failed apply and stays put", async () => {
    const r = await rig({ result: { applied: false, reason: "unendorsed" } });
    expect(await runFirstBootUpdate(r.opts)).toMatchObject({ state: "gave-up", reason: "unendorsed", targetCommit: NEW });
    expect(await runFirstBootUpdate(r.opts)).toBeNull();
  });
});
