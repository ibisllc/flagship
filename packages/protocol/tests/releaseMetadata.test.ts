import { describe, expect, it } from "vitest";
import { ed } from "../src/edSync.js";
import {
  advanceRoot,
  buildRunningArtifactReport,
  EMPTY_TRUST_STATE,
  inRolloutCohort,
  meetsSecurityFloor,
  offerableReleases,
  releaseMetaSha256,
  rolloutBucket,
  signReleaseMeta,
  verifyReleaseCatalog,
  type RootMeta,
  type SnapshotMeta,
  type TargetsMeta,
  type TimestampMeta,
} from "../src/releaseMetadata.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const mk = (n: number) => {
  const priv = new Uint8Array(32).fill(n);
  return { keyId: `k${n}`, privateKey: priv, pub: hex(ed.getPublicKey(priv)) };
};
const [r1, r2, r3, t1, s1, g1, g2, g3] = [1, 2, 3, 4, 5, 6, 7, 8].map(mk);
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const sha = (c: string) => c.repeat(64).slice(0, 64);

const root = (version = 1, extra: Partial<RootMeta> = {}): RootMeta => ({
  role: "root", format: 1, version, expiresAt: NOW + 365 * DAY,
  keys: Object.fromEntries([r1, r2, r3, t1, s1, g1, g2, g3].map((k) => [k!.keyId, k!.pub])),
  roles: {
    root: { keyIds: ["k1", "k2", "k3"], threshold: 2 },
    timestamp: { keyIds: ["k4"], threshold: 1 },
    snapshot: { keyIds: ["k5"], threshold: 1 },
    targets: { keyIds: ["k6", "k7", "k8"], threshold: 2 },
  },
  ...extra,
});

const release = (n: number, pct = 100) => ({
  commit: n.toString(16).padStart(8, "0") + "a".repeat(32), label: `0.${n}`, securityVersion: n, artifactSha256: sha("b"), rolloutPercent: pct,
});

function catalog(over: { tv?: number; floor?: number; releases?: ReturnType<typeof release>[]; tsExpires?: number; targetSigners?: ReturnType<typeof mk>[] } = {}) {
  const tg: TargetsMeta = { role: "targets", format: 1, version: over.tv ?? 3, expiresAt: NOW + 30 * DAY, securityFloor: over.floor ?? 2, releases: over.releases ?? [release(2), release(3)] };
  const targets = signReleaseMeta(tg, (over.targetSigners ?? [g1!, g2!]));
  const sn: SnapshotMeta = { role: "snapshot", format: 1, version: 5, expiresAt: NOW + 7 * DAY, targetsVersion: tg.version, targetsSha256: releaseMetaSha256(tg) };
  const snapshot = signReleaseMeta(sn, [s1!]);
  const ts: TimestampMeta = { role: "timestamp", format: 1, version: 9, expiresAt: over.tsExpires ?? NOW + DAY, snapshotVersion: sn.version, snapshotSha256: releaseMetaSha256(sn) };
  return { timestamp: signReleaseMeta(ts, [t1!]), snapshot, targets };
}

describe("signed release metadata", () => {
  it("accepts a consistent catalog and advances the trusted state", () => {
    const r = verifyReleaseCatalog({ root: root(), ...catalog(), now: NOW, state: EMPTY_TRUST_STATE });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stale).toBe(false);
      expect(r.value.state).toMatchObject({ rootVersion: 1, timestampVersion: 9, snapshotVersion: 5, targetsVersion: 3, securityFloor: 2 });
    }
  });

  it("refuses a targets file signed below its threshold", () => {
    const r = verifyReleaseCatalog({ root: root(), ...catalog({ targetSigners: [g1!] }), now: NOW, state: EMPTY_TRUST_STATE });
    expect(r).toEqual({ ok: false, reason: "below-threshold" });
  });

  it("counts a repeated signer once", () => {
    const c = catalog({ targetSigners: [g1!, g1!] });
    expect(verifyReleaseCatalog({ root: root(), ...c, now: NOW, state: EMPTY_TRUST_STATE })).toEqual({ ok: false, reason: "below-threshold" });
  });

  it("refuses a signer the root does not list for that role", () => {
    const c = catalog({ targetSigners: [g1!, t1!] });
    expect(verifyReleaseCatalog({ root: root(), ...c, now: NOW, state: EMPTY_TRUST_STATE }).ok).toBe(false);
  });

  it("refuses an older targets version, a lower floor and a mixed view", () => {
    const base = { root: root(), now: NOW };
    expect(verifyReleaseCatalog({ ...base, ...catalog({ tv: 2 }), state: { ...EMPTY_TRUST_STATE, targetsVersion: 3 } })).toEqual({ ok: false, reason: "rollback" });
    expect(verifyReleaseCatalog({ ...base, ...catalog({ floor: 1 }), state: { ...EMPTY_TRUST_STATE, securityFloor: 2 } })).toEqual({ ok: false, reason: "floor-lowered" });
    const a = catalog({ tv: 3 });
    const b = catalog({ tv: 4 });
    expect(verifyReleaseCatalog({ ...base, timestamp: a.timestamp, snapshot: a.snapshot, targets: b.targets, state: EMPTY_TRUST_STATE })).toEqual({ ok: false, reason: "targets-mismatch" });
  });

  it("marks an expired timestamp stale and offers nothing new", () => {
    const r = verifyReleaseCatalog({ root: root(), ...catalog({ tsExpires: NOW - 1 }), now: NOW, state: EMPTY_TRUST_STATE });
    expect(r.ok && r.value.stale).toBe(true);
    if (r.ok) {
      const o = offerableReleases(r.value, "box", 1);
      expect(o.offers).toEqual([]);
      expect(o.blocked.every((b) => b.reason === "stale-catalog")).toBe(true);
    }
  });

  it("refuses everything once the root itself has expired", () => {
    expect(verifyReleaseCatalog({ root: root(1, { expiresAt: NOW - 1 }), ...catalog(), now: NOW, state: EMPTY_TRUST_STATE })).toEqual({ ok: false, reason: "root-expired" });
  });
});

describe("root rotation", () => {
  it("needs the old threshold and the new threshold", () => {
    const next = root(2, { roles: { ...root().roles, root: { keyIds: ["k1", "k2"], threshold: 2 } } });
    expect(advanceRoot(root(), signReleaseMeta(next, [r1!, r2!])).ok).toBe(true);
    expect(advanceRoot(root(), signReleaseMeta(next, [r1!]))).toEqual({ ok: false, reason: "below-threshold" });
    const swapped = root(2, { roles: { ...root().roles, root: { keyIds: ["k3"], threshold: 1 } } });
    expect(advanceRoot(root(), signReleaseMeta(swapped, [r3!]))).toEqual({ ok: false, reason: "below-threshold" });
  });

  it("takes exactly the next version and never an older one", () => {
    expect(advanceRoot(root(), signReleaseMeta(root(3), [r1!, r2!]))).toEqual({ ok: false, reason: "version-not-next" });
    expect(advanceRoot(root(2), signReleaseMeta(root(1), [r1!, r2!]))).toEqual({ ok: false, reason: "rollback" });
  });
});

describe("floor, cohorts and telemetry", () => {
  it("a rollback must meet the floor", () => {
    expect(meetsSecurityFloor(2, 2)).toBe(true);
    expect(meetsSecurityFloor(1, 2)).toBe(false);
  });

  it("offers only newer releases at or above the floor, inside the open cohort", () => {
    const c = verifyReleaseCatalog({ root: root(), ...catalog({ floor: 3, releases: [release(2), release(3), release(4, 0), release(5)] }), now: NOW, state: EMPTY_TRUST_STATE });
    expect(c.ok).toBe(true);
    if (c.ok) {
      const o = offerableReleases(c.value, "box-a", 3);
      expect(o.offers.map((r) => r.securityVersion)).toEqual([5]);
      expect(Object.fromEntries(o.blocked.map((b) => [b.commit.slice(0, 8), b.reason]))).toEqual({
        "00000004": "not-in-cohort", "00000003": "not-newer", "00000002": "below-floor",
      });
    }
  });

  it("buckets are stable, per release, and roughly even", () => {
    const rel = release(7, 25);
    expect(rolloutBucket("a", rel.commit)).toBe(rolloutBucket("a", rel.commit));
    expect(rolloutBucket("a", rel.commit)).not.toBe(rolloutBucket("a", release(8).commit));
    let inside = 0;
    for (let i = 0; i < 4000; i++) if (inRolloutCohort(`box-${i}`, rel)) inside++;
    expect(inside).toBeGreaterThan(800);
    expect(inside).toBeLessThan(1200);
    expect(inRolloutCohort("x", { ...rel, rolloutPercent: 100 })).toBe(true);
    expect(inRolloutCohort("x", { ...rel, rolloutPercent: 0 })).toBe(false);
  });

  it("a running-artifact report needs consent and carries only the fixed fields", () => {
    const rep = { commit: "a".repeat(40), artifactSha256: sha("c"), securityVersion: 3, revocationEpoch: 4, lastUpdateResult: "ok" as const, reportedAt: NOW };
    expect(buildRunningArtifactReport(false, rep)).toBeNull();
    expect(buildRunningArtifactReport(true, rep)).toEqual(rep);
    expect(buildRunningArtifactReport(true, { ...rep, token: "secret" } as never)).toBeNull();
  });
});
