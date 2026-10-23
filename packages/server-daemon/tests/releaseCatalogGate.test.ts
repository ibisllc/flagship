import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, releaseMetaSha256, signReleaseMeta, type RootMeta, type SnapshotMeta, type TargetsMeta, type TimestampMeta } from "@flagship/protocol";
import { ReleaseCatalogGate } from "../src/releaseCatalogGate.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const key = (n: number) => ({ keyId: `k${n}`, privateKey: new Uint8Array(32).fill(n), pub: hex(ed.getPublicKey(new Uint8Array(32).fill(n))) });
const [a, b, c, d] = [1, 2, 3, 4].map(key) as ReturnType<typeof key>[];
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const root: RootMeta = {
  role: "root", format: 1, version: 1, expiresAt: NOW + 365 * DAY,
  keys: Object.fromEntries([a!, b!, c!, d!].map((k) => [k.keyId, k.pub])),
  roles: {
    root: { keyIds: ["k1"], threshold: 1 }, timestamp: { keyIds: ["k2"], threshold: 1 },
    snapshot: { keyIds: ["k3"], threshold: 1 }, targets: { keyIds: ["k4"], threshold: 1 },
  },
};
const rel = (n: number, pct = 100) => ({ commit: n.toString(16).padStart(8, "0") + "a".repeat(32), label: `0.${n}`, securityVersion: n, artifactSha256: "b".repeat(64), rolloutPercent: pct });

function view(over: { tv?: number; floor?: number; releases?: ReturnType<typeof rel>[]; tsExpires?: number }) {
  const tg: TargetsMeta = { role: "targets", format: 1, version: over.tv ?? 1, expiresAt: NOW + 30 * DAY, securityFloor: over.floor ?? 0, releases: over.releases ?? [rel(1), rel(2)] };
  const sn: SnapshotMeta = { role: "snapshot", format: 1, version: over.tv ?? 1, expiresAt: NOW + 7 * DAY, targetsVersion: tg.version, targetsSha256: releaseMetaSha256(tg) };
  const ts: TimestampMeta = { role: "timestamp", format: 1, version: over.tv ?? 1, expiresAt: over.tsExpires ?? NOW + DAY, snapshotVersion: sn.version, snapshotSha256: releaseMetaSha256(sn) };
  return { timestamp: signReleaseMeta(ts, [b!]), snapshot: signReleaseMeta(sn, [c!]), targets: signReleaseMeta(tg, [d!]) };
}

async function gate(now = NOW) {
  const dir = await mkdtemp(join(tmpdir(), "rcg-"));
  const path = join(dir, "release-catalog.json");
  return { path, make: () => new ReleaseCatalogGate({ path, root: () => root, boxSalt: () => "box", now: () => now }) };
}

describe("ReleaseCatalogGate", () => {
  it("takes nothing before a catalog, then offers the newer release", async () => {
    const { make } = await gate();
    const g = make();
    expect(await g.mayTakeNewRelease(rel(2), 1)).toEqual({ ok: false, reason: "no-catalog" });
    expect((await g.accept(view({}))).ok).toBe(true);
    expect(await g.mayTakeNewRelease(rel(2), 1)).toEqual({ ok: true });
    expect(await g.mayTakeNewRelease(rel(1), 1)).toEqual({ ok: false, reason: "not-newer" });
  });

  it("a stale catalog blocks new updates and nothing else", async () => {
    const { make } = await gate();
    const g = make();
    expect((await g.accept(view({ tsExpires: NOW - 1 }))).ok).toBe(true);
    expect(await g.mayTakeNewRelease(rel(2), 1)).toEqual({ ok: false, reason: "stale-catalog" });
    expect(await g.rollbackAllowed(rel(1).commit)).toBe(true);
  });

  it("the floor never goes down and a rollback must meet it", async () => {
    const { make } = await gate();
    const g = make();
    expect((await g.accept(view({ tv: 2, floor: 2 }))).ok).toBe(true);
    expect(await g.floor()).toBe(2);
    expect(await g.rollbackAllowed(rel(2).commit)).toBe(true);
    expect(await g.rollbackAllowed(rel(1).commit)).toBe(false);
    expect(await g.rollbackAllowed("f".repeat(40))).toBe(false);
    const lower = await g.accept(view({ tv: 3, floor: 1 }));
    expect(lower).toEqual({ ok: false, reason: "floor-lowered" });
    expect(await g.floor()).toBe(2);
  });

  it("remembers what it accepted across a restart and refuses an old catalog", async () => {
    const { make } = await gate();
    await make().accept(view({ tv: 5, floor: 1 }));
    const again = make();
    expect(await again.accept(view({ tv: 4, floor: 1 }))).toEqual({ ok: false, reason: "rollback" });
    expect(await again.floor()).toBe(1);
  });

  it("a damaged state file is kept aside and the box starts over without throwing", async () => {
    const { make, path } = await gate();
    await writeFile(path, "{not json");
    const g = make();
    expect(await g.floor()).toBe(0);
    expect((await g.accept(view({}))).ok).toBe(true);
  });

  it("holds a release back until its rollout cohort opens", async () => {
    const { make } = await gate();
    const g = make();
    await g.accept(view({ releases: [rel(1), rel(2, 0)] }));
    expect(await g.mayTakeNewRelease(rel(2, 0), 1)).toEqual({ ok: false, reason: "not-in-cohort" });
  });
});
