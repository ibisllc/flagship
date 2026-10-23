import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, releaseMetaSha256, signReleaseMeta, type RootMeta, type SnapshotMeta, type TargetsMeta, type TimestampMeta } from "@flagship/protocol";
import { ReleaseCatalogGate } from "../src/releaseCatalogGate.js";
import { TrustedRootStore, refreshReleaseCatalog } from "../src/releaseCatalogFeed.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const key = (n: number) => ({ keyId: `k${n}`, privateKey: new Uint8Array(32).fill(n) });
const pub = (n: number) => Buffer.from(ed.getPublicKey(new Uint8Array(32).fill(n))).toString("hex");
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

function root(version: number, keyIds: number[]): RootMeta {
  const role = { keyIds: keyIds.map((k) => `k${k}`), threshold: 1 };
  return { role: "root", format: 1, version, expiresAt: NOW + 365 * DAY, keys: Object.fromEntries(keyIds.map((k) => [`k${k}`, pub(k)])), roles: { root: role, timestamp: role, snapshot: role, targets: role } };
}

function catalog(signer: number, opts: { floor?: number; percent?: number; version?: number } = {}) {
  const v = opts.version ?? 1;
  const targets: TargetsMeta = {
    role: "targets", format: 1, version: v, expiresAt: NOW + 30 * DAY, securityFloor: opts.floor ?? 1,
    releases: [
      { commit: OLD, label: "0.2", securityVersion: 1, artifactSha256: "1".repeat(64), rolloutPercent: 100 },
      { commit: NEW, label: "0.3", securityVersion: 2, artifactSha256: "2".repeat(64), rolloutPercent: opts.percent ?? 100 },
    ],
  };
  const snapshot: SnapshotMeta = { role: "snapshot", format: 1, version: v, expiresAt: NOW + 7 * DAY, targetsVersion: v, targetsSha256: releaseMetaSha256(targets) };
  const timestamp: TimestampMeta = { role: "timestamp", format: 1, version: v, expiresAt: NOW + DAY, snapshotVersion: v, snapshotSha256: releaseMetaSha256(snapshot) };
  return {
    "timestamp.json": signReleaseMeta(timestamp, [key(signer)]),
    "snapshot.json": signReleaseMeta(snapshot, [key(signer)]),
    "targets.json": signReleaseMeta(targets, [key(signer)]),
  };
}

function world(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"));
  writeFileSync(join(dir, "pinned.json"), JSON.stringify(root(1, [1])));
  const roots = new TrustedRootStore({ pinnedPath: join(dir, "pinned.json"), statePath: join(dir, "root-state.json") });
  const gate = new ReleaseCatalogGate({ path: join(dir, "catalog.json"), root: () => roots.current(), boxSalt: () => "home.alice.flagship.services", now: () => NOW });
  const fetchImpl = (async (url: string) => {
    const name = url.split("/catalog-")[1]!;
    return name in files ? new Response(JSON.stringify(files[name])) : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { dir, roots, gate, refresh: () => refreshReleaseCatalog({ base: "https://x.test/build/iso", roots, gate, fetchImpl }) };
}

describe("the signed release catalog, fed to the box", () => {
  it("accepts a catalog under the pinned root and decides updates and rollbacks from it", async () => {
    const w = world(catalog(1));
    expect(await w.roots.load()).not.toBeNull();
    expect(await w.gate.allowsUpdateTo(NEW, OLD)).toEqual({ ok: false, reason: "no-catalog" });
    expect(await w.refresh()).toMatch(/accepted/);
    expect(await w.gate.allowsUpdateTo(NEW, OLD)).toEqual({ ok: true });
    expect((await w.gate.allowsUpdateTo("c".repeat(40), OLD)).ok).toBe(false); // not in the catalog
    expect(await w.gate.rollbackAllowed(OLD)).toBe(true);
  });

  it("follows a root chain the previous root signed, and refuses one it did not", async () => {
    const next = root(2, [2]);
    const good = world({ "root.json": signReleaseMeta(next, [key(1), key(2)]), ...catalog(2) });
    await good.roots.load();
    expect(await good.refresh()).toMatch(/accepted/);
    expect(good.roots.current().version).toBe(2);
    const forged = world({ "root.json": signReleaseMeta(next, [key(2)]), ...catalog(2) });
    await forged.roots.load();
    expect(await forged.refresh()).toMatch(/root chain broke/);
    expect(forged.roots.current().version).toBe(1);
  });

  it("refuses a catalog signed by a key the root does not list, and an update below the floor or outside the rollout", async () => {
    const w = world(catalog(9));
    await w.roots.load();
    expect(await w.refresh()).toMatch(/refused/);
    const floor = world(catalog(1, { floor: 3 }));
    await floor.roots.load();
    await floor.refresh();
    expect(await floor.gate.allowsUpdateTo(NEW, OLD)).toEqual({ ok: false, reason: "below-floor" });
    expect(await floor.gate.rollbackAllowed(OLD)).toBe(false);
    const cohort = world(catalog(1, { percent: 0 }));
    await cohort.roots.load();
    await cohort.refresh();
    expect(await cohort.gate.allowsUpdateTo(NEW, OLD)).toEqual({ ok: false, reason: "not-in-cohort" });
  });

  it("is off for a release that pins no root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-none-"));
    const roots = new TrustedRootStore({ pinnedPath: join(dir, "missing.json"), statePath: join(dir, "s.json") });
    expect(await roots.load()).toBeNull();
  });
});
