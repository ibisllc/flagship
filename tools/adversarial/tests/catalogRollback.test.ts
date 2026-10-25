/**
 * V01 adversarial suite: the signed release catalog (TUF-shaped metadata, N13) and the update gate
 * that consults it. Attacker models: a malicious mirror / `.com` / R2 serving catalog files, a
 * stolen ONLINE timestamp key, an operator mistake, and local state damage on the box.
 *
 *   AT-CAT-01  targets version rolled back                         -> refused (rollback)
 *   AT-CAT-02  timestamp version rolled back                       -> refused (rollback)
 *   AT-CAT-03  snapshot+targets rolled back under a fresh timestamp -> refused (rollback)
 *   AT-CAT-04  trusted root rolled back                            -> refused (rollback)
 *   AT-CAT-05  security floor lowered in a newer targets           -> refused (floor-lowered)
 *   AT-CAT-06  freeze: expired timestamp served                    -> stale: new updates blocked, rollback unaffected
 *   AT-CAT-07  freeze: refetch blocked after a fresh accept        -> FINDING: last view never goes stale
 *   AT-CAT-08  mix-and-match snapshot / targets                    -> refused (snapshot-/targets-mismatch)
 *   AT-CAT-09  same version, different targets content             -> FINDING: accepted
 *   AT-CAT-10  targets signed only by the online timestamp key     -> refused (below-threshold)
 *   AT-CAT-11  threshold 2 met by one key signing twice            -> refused (below-threshold)
 *   AT-CAT-12  threshold 2 met by two key ids aliasing one key     -> FINDING: accepted
 *   AT-CAT-13  root chain: skip, self-signed jump, old-only signed -> refused; proper rotation accepted
 *   AT-CAT-14  feed: a forged root step stops the chain            -> old root kept, view under new keys refused
 *   AT-CAT-15  release removed from targets, floor > 0             -> rollback to it refused (confirms suspicion 2)
 *   AT-CAT-16  rollout cohort / unlisted / no catalog              -> update refused for each
 *   AT-CAT-17  feed serves a multi-megabyte document               -> refused, but FINDING: whole body buffered first
 *   AT-CAT-18  update gate: rollback below the floor               -> restricted recovery, no restore
 *   AT-CAT-19  a refused view changes nothing persisted            -> state file byte-identical
 *   AT-CAT-20  catalog state file damaged                          -> FINDING: floor reads 0 until a refetch
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TRUST_STATE,
  advanceRoot,
  releaseMetaSha256,
  signReleaseMeta,
  verifyReleaseCatalog,
  type ReleaseEntry,
  type RootMeta,
  type SnapshotMeta,
  type TargetsMeta,
  type TimestampMeta,
  type TrustState,
} from "../../../packages/protocol/src/releaseMetadata.js";
import { ed } from "../../../packages/protocol/src/edSync.js";
import { ReleaseCatalogGate } from "../../../packages/server-daemon/src/releaseCatalogGate.js";
import { TrustedRootStore, refreshReleaseCatalog } from "../../../packages/server-daemon/src/releaseCatalogFeed.js";
import { runUpdateBootGate } from "../../../packages/server-daemon/src/updateHealthGate.js";
import type { PendingVerifyMarker } from "../../../packages/server-daemon/src/updateConsumer.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (n: number) => ({ keyId: `k${n}`, privateKey: new Uint8Array(32).fill(n), pub: hex(ed.getPublicKey(new Uint8Array(32).fill(n))) });
const ROOTK = key(1);
const TSK = key(2); // the only online key
const SNK = key(3);
const TGK = key(4);

const root1: RootMeta = {
  role: "root", format: 1, version: 1, expiresAt: NOW + 365 * DAY,
  keys: Object.fromEntries([ROOTK, TSK, SNK, TGK].map((k) => [k.keyId, k.pub])),
  roles: {
    root: { keyIds: ["k1"], threshold: 1 }, timestamp: { keyIds: ["k2"], threshold: 1 },
    snapshot: { keyIds: ["k3"], threshold: 1 }, targets: { keyIds: ["k4"], threshold: 1 },
  },
};

const commit = (n: number) => n.toString(16).padStart(2, "0").repeat(20);
const rel = (n: number, pct = 100): ReleaseEntry => ({ commit: commit(n), label: `0.${n}`, securityVersion: n, artifactSha256: "b".repeat(64), rolloutPercent: pct });

interface ViewOpts {
  tv?: number; sv?: number; tsv?: number; floor?: number; releases?: ReleaseEntry[];
  tsExpires?: number; snExpires?: number; tgExpires?: number;
  tsSigners?: { keyId: string; privateKey: Uint8Array }[]; snSigners?: { keyId: string; privateKey: Uint8Array }[]; tgSigners?: { keyId: string; privateKey: Uint8Array }[];
}

function view(o: ViewOpts = {}) {
  const tv = o.tv ?? 1;
  const sv = o.sv ?? tv;
  const tsv = o.tsv ?? sv;
  const tg: TargetsMeta = { role: "targets", format: 1, version: tv, expiresAt: o.tgExpires ?? NOW + 30 * DAY, securityFloor: o.floor ?? 0, releases: o.releases ?? [rel(1), rel(2)] };
  const sn: SnapshotMeta = { role: "snapshot", format: 1, version: sv, expiresAt: o.snExpires ?? NOW + 7 * DAY, targetsVersion: tv, targetsSha256: releaseMetaSha256(tg) };
  const ts: TimestampMeta = { role: "timestamp", format: 1, version: tsv, expiresAt: o.tsExpires ?? NOW + DAY, snapshotVersion: sv, snapshotSha256: releaseMetaSha256(sn) };
  return {
    timestamp: signReleaseMeta(ts, o.tsSigners ?? [TSK]),
    snapshot: signReleaseMeta(sn, o.snSigners ?? [SNK]),
    targets: signReleaseMeta(tg, o.tgSigners ?? [TGK]),
  };
}

const verify = (v: ReturnType<typeof view>, state: TrustState = EMPTY_TRUST_STATE, root: RootMeta = root1, now = NOW) =>
  verifyReleaseCatalog({ root, ...v, now, state });

function gateWorld(salt = "box-salt") {
  const dir = mkdtempSync(join(tmpdir(), "at-cat-"));
  const path = join(dir, "release-catalog.json");
  const clock = { t: NOW };
  const make = () => new ReleaseCatalogGate({ path, root: () => root1, boxSalt: () => salt, now: () => clock.t });
  return { dir, path, clock, make };
}

const stateAfter = (v: ReturnType<typeof view>) => {
  const r = verify(v);
  if (!r.ok) throw new Error(`setup refused: ${r.reason}`);
  return r.value.state;
};

describe("V01 release catalog: rollback, freeze and mix-and-match (AT-CAT)", () => {
  it("AT-CAT-01 boundary: catalog version anti-rollback. A mirror replaying an older targets is refused (catches: versions compared per role missing)", () => {
    const st = stateAfter(view({ tv: 3 }));
    const r = verify(view({ tv: 2, tsv: 4 }), st);
    expect(r).toEqual({ ok: false, reason: "rollback" });
  });

  it("AT-CAT-02 boundary: timestamp anti-rollback. An older timestamp over the same snapshot is refused (catches: freshness taken from any signed timestamp)", () => {
    const st = stateAfter(view({ tv: 3, tsv: 5 }));
    expect(verify(view({ tv: 3, tsv: 4 }), st)).toEqual({ ok: false, reason: "rollback" });
  });

  it("AT-CAT-03 boundary: a stolen ONLINE timestamp key re-signing a fresh timestamp over an old snapshot+targets is refused (catches: snapshot/targets versions not checked against state)", () => {
    const st = stateAfter(view({ tv: 3, tsv: 3 }));
    // The attacker holds k2 (online) and the old, still-unexpired snapshot/targets v2.
    expect(verify(view({ tv: 2, tsv: 9 }), st)).toEqual({ ok: false, reason: "rollback" });
  });

  it("AT-CAT-04 boundary: root anti-rollback. Verifying against a root older than the one in state is refused (catches: rootVersion not persisted/compared)", () => {
    const st = { ...stateAfter(view()), rootVersion: 2 };
    expect(verify(view({ tv: 2 }), st)).toEqual({ ok: false, reason: "rollback" });
  });

  it("AT-CAT-05 boundary: the security floor never goes down, even in a newer, properly signed targets (catches: floor taken from the newest targets unconditionally)", () => {
    const st = stateAfter(view({ tv: 2, floor: 2 }));
    expect(verify(view({ tv: 3, floor: 1 }), st)).toEqual({ ok: false, reason: "floor-lowered" });
  });

  it("AT-CAT-06 boundary: freeze attack. An expired timestamp is accepted as STALE: new updates blocked, rollback and running code unaffected (catches: stale view either refused outright or treated as fresh)", async () => {
    const w = gateWorld();
    const g = w.make();
    expect((await g.accept(view({ tsExpires: NOW - 1 }))).ok).toBe(true);
    expect(await g.allowsUpdateTo(commit(2), commit(1))).toEqual({ ok: false, reason: "stale-catalog" });
    expect(await g.rollbackAllowed(commit(1))).toBe(true);
    // An expired snapshot (timestamp still fresh) is equally stale.
    const w2 = gateWorld();
    const g2 = w2.make();
    expect((await g2.accept(view({ snExpires: NOW - 1 }))).ok).toBe(true);
    expect(await g2.allowsUpdateTo(commit(2), commit(1))).toEqual({ ok: false, reason: "stale-catalog" });
  });

  // FINDING AT-CAT-07: ReleaseCatalogGate.mayTakeNewRelease (packages/server-daemon/src/releaseCatalogGate.ts:100-108)
  // reads the `stale` flag persisted at accept() time; it never compares the accepted view's expiries with the
  // current clock. An attacker who blocks the box's catalog refresh (network position, a `.com`/R2 outage, or a
  // mirror answering 404) freezes the box on its last FRESH view forever, so a later stop rule (rolloutPercent 0 or a
  // removed release) never reaches it and it keeps taking the stopped release. The class comment ("counts as fresh only
  // until its own expiry") says the opposite of what the code does.
  it.fails("AT-CAT-07 boundary: freeze by blocking refresh. The last accepted view must go stale at its own expiry (FINDING: it stays fresh forever)", async () => {
    const w = gateWorld();
    const g = w.make();
    expect((await g.accept(view())).ok).toBe(true);
    expect(await g.allowsUpdateTo(commit(2), commit(1))).toEqual({ ok: true });
    w.clock.t = NOW + 60 * DAY; // timestamp (1 d), snapshot (7 d) and targets (30 d) all long expired; no refetch succeeded
    expect(await g.allowsUpdateTo(commit(2), commit(1))).toEqual({ ok: false, reason: "stale-catalog" });
  });

  it("AT-CAT-08 boundary: consistency. A timestamp naming another snapshot, or a snapshot naming another targets, is refused (catches: files fetched separately and trusted individually)", () => {
    const a = view({ tv: 2, releases: [rel(1), rel(2, 5)] });
    const b = view({ tv: 2, releases: [rel(1), rel(2, 100)] });
    expect(verify({ ...a, targets: b.targets })).toEqual({ ok: false, reason: "targets-mismatch" });
    expect(verify({ ...a, snapshot: b.snapshot })).toEqual({ ok: false, reason: "snapshot-mismatch" });
  });

  // FINDING AT-CAT-09: verifyReleaseCatalog (packages/protocol/src/releaseMetadata.ts:236) only refuses LOWER versions.
  // A targets/snapshot/timestamp at the SAME version as the accepted state but with different content is accepted,
  // so two differently-signed catalogs sharing a version number (e.g. a stop rule that reused the version of the
  // catalog it stops, or a re-sign after an edit) let a mirror flip boxes between them: re-opening a stopped rollout.
  // TUF keeps the trusted file when the version is equal; the box should refuse equal-version-different-digest.
  it.fails("AT-CAT-09 boundary: equal version must mean equal content. A re-signed targets v1 with rollout widened is refused (FINDING: accepted)", async () => {
    const w = gateWorld();
    const g = w.make();
    expect((await g.accept(view({ releases: [rel(1), rel(2, 0)] }))).ok).toBe(true); // the stop: rollout 0
    const widened = await g.accept(view({ releases: [rel(1), rel(2, 100)] })); // same versions, other content
    expect(widened.ok).toBe(false);
  });

  it("AT-CAT-10 boundary: role separation. Targets and snapshot signed with the ONLINE timestamp key are refused (catches: any root-listed key accepted for any role)", () => {
    expect(verify(view({ tgSigners: [TSK] }))).toEqual({ ok: false, reason: "below-threshold" });
    expect(verify(view({ snSigners: [TSK] }))).toEqual({ ok: false, reason: "below-threshold" });
  });

  it("AT-CAT-11 boundary: threshold counting. One key signing twice does not meet a threshold of 2 (catches: signatures counted, not distinct keys)", () => {
    const root2: RootMeta = { ...root1, roles: { ...root1.roles, targets: { keyIds: ["k4", "k3"], threshold: 2 } } };
    const v = view();
    const doubled = { ...v.targets, signatures: [v.targets.signatures[0]!, v.targets.signatures[0]!] };
    expect(verify({ ...v, targets: doubled }, EMPTY_TRUST_STATE, root2)).toEqual({ ok: false, reason: "below-threshold" });
  });

  // FINDING AT-CAT-12: validSigners (packages/protocol/src/releaseMetadata.ts:165-179) dedupes by keyId, and the root
  // shape check (line 139-144) never refuses two keyIds mapping to the SAME public key. A root that lists k4 and an alias
  // k4b = pub(k4) with threshold 2 is satisfied by one private key, silently defeating k-of-n. TUF derives key ids from
  // the key for this reason. Needs a root signed by the root role, so it is a ceremony/rotation-tooling defect, not a
  // remote attack; catalog.ts `root` accepts any --key id=pub pairs.
  it.fails("AT-CAT-12 boundary: threshold must count distinct KEYS. Two key ids aliasing one public key cannot meet threshold 2 (FINDING: accepted)", () => {
    const root2: RootMeta = {
      ...root1,
      keys: { ...root1.keys, k4b: TGK.pub },
      roles: { ...root1.roles, targets: { keyIds: ["k4", "k4b"], threshold: 2 } },
    };
    const v = view({ tgSigners: [TGK, { keyId: "k4b", privateKey: TGK.privateKey }] });
    expect(verify(v, EMPTY_TRUST_STATE, root2).ok).toBe(false);
  });

  it("AT-CAT-13 boundary: root rotation. Skipping a version, a self-signed jump and a root not signed by its own keys are refused; a proper rotation is accepted (catches: TOFU on a newer root)", () => {
    const NEWK = key(9);
    const next = (v: number): RootMeta => ({
      ...root1, version: v, keys: { k9: NEWK.pub, k2: TSK.pub, k3: SNK.pub, k4: TGK.pub },
      roles: { ...root1.roles, root: { keyIds: ["k9"], threshold: 1 } },
    });
    expect(advanceRoot(root1, signReleaseMeta(next(3), [ROOTK, NEWK]))).toEqual({ ok: false, reason: "version-not-next" });
    expect(advanceRoot(root1, signReleaseMeta(next(2), [NEWK]))).toEqual({ ok: false, reason: "below-threshold" });
    expect(advanceRoot(root1, signReleaseMeta(next(2), [ROOTK]))).toEqual({ ok: false, reason: "below-threshold" });
    expect(advanceRoot(root1, signReleaseMeta(next(1), [ROOTK, NEWK]))).toEqual({ ok: false, reason: "rollback" });
    expect(advanceRoot(root1, signReleaseMeta(next(2), [ROOTK, NEWK])).ok).toBe(true);
  });

  it("AT-CAT-14 boundary: the feed follows a root chain only step by step. A forged step stops it and the old root keeps judging (catches: newest root.json trusted directly)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "at-cat-feed-"));
    writeFileSync(join(dir, "pinned.json"), JSON.stringify(root1));
    const roots = new TrustedRootStore({ pinnedPath: join(dir, "pinned.json"), statePath: join(dir, "root-state.json") });
    await roots.load();
    const gate = new ReleaseCatalogGate({ path: join(dir, "catalog.json"), root: () => roots.current(), boxSalt: () => "s", now: () => NOW });
    // The attacker's root v2 makes its own key every role, signed only by itself.
    const EVIL = key(66);
    const evilRole = { keyIds: ["k66"], threshold: 1 };
    const evilRoot: RootMeta = { ...root1, version: 2, keys: { k66: EVIL.pub }, roles: { root: evilRole, timestamp: evilRole, snapshot: evilRole, targets: evilRole } };
    const evilView = view({ tsSigners: [EVIL], snSigners: [EVIL], tgSigners: [EVIL], releases: [rel(1), rel(7)] });
    const files: Record<string, unknown> = {
      "root.json": signReleaseMeta(evilRoot, [EVIL]),
      "root-2.json": signReleaseMeta(evilRoot, [EVIL]),
      "timestamp.json": evilView.timestamp, "snapshot.json": evilView.snapshot, "targets.json": evilView.targets,
    };
    const fetchImpl = (async (url: string) => {
      const n = url.split("/catalog-")[1]!;
      return n in files ? new Response(JSON.stringify(files[n])) : new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await refreshReleaseCatalog({ base: "https://x.test/build/iso", roots, gate, fetchImpl })).toBe("root chain broke at version 2");
    expect(roots.current().version).toBe(1);
    expect(await gate.allowsUpdateTo(commit(7), commit(1))).toEqual({ ok: false, reason: "no-catalog" });
  });

  it("AT-CAT-15 boundary: rollback target must stay known. Removing a release from targets while a floor is set makes a later health rollback to it refused; rollout 0 keeps it known (confirms parent suspicion 2: designed, but a stop rule must lower rolloutPercent, never remove)", async () => {
    const w = gateWorld();
    const g = w.make();
    expect((await g.accept(view({ tv: 1, floor: 1, releases: [rel(1), rel(2), rel(3)] }))).ok).toBe(true);
    expect(await g.rollbackAllowed(commit(2))).toBe(true);
    // Stop rule A (wrong): remove 0.2 from targets.
    expect((await g.accept(view({ tv: 2, floor: 1, releases: [rel(1), rel(3)] }))).ok).toBe(true);
    expect(await g.rollbackAllowed(commit(2))).toBe(false);
    // Stop rule B (right): keep it, rollout 0.
    expect((await g.accept(view({ tv: 3, floor: 1, releases: [rel(1), rel(2, 0), rel(3)] }))).ok).toBe(true);
    expect(await g.rollbackAllowed(commit(2))).toBe(true);
    expect(await g.allowsUpdateTo(commit(2), commit(1))).toEqual({ ok: false, reason: "not-in-cohort" });
    // A commit the catalog never listed (a release older than the catalog) is never a rollback target once a floor is set.
    expect(await g.rollbackAllowed(commit(0x99))).toBe(false);
  });

  it("AT-CAT-16 boundary: rollout cohort. A box outside the open cohort, an unlisted commit and a box with no catalog are all refused (catches: the cohort decided by the order, not the box)", async () => {
    const w = gateWorld();
    const g = w.make();
    expect(await g.allowsUpdateTo(commit(2), commit(1))).toEqual({ ok: false, reason: "no-catalog" });
    expect((await g.accept(view({ releases: [rel(1), rel(2, 0)] }))).ok).toBe(true);
    expect(await g.allowsUpdateTo(commit(2), commit(1))).toEqual({ ok: false, reason: "not-in-cohort" });
    expect(await g.allowsUpdateTo(commit(0x42), commit(1))).toEqual({ ok: false, reason: "not-in-catalog" });
    // Across many box salts a 10% rollout admits roughly 10%, never everyone.
    const { inRolloutCohort } = await import("../../../packages/protocol/src/releaseMetadata.js");
    const admitted = Array.from({ length: 2000 }, (_, i) => inRolloutCohort(`salt-${i}`, { commit: commit(2), rolloutPercent: 10 })).filter(Boolean).length;
    expect(admitted).toBeGreaterThan(120);
    expect(admitted).toBeLessThan(280);
  });

  // FINDING AT-CAT-17: fetchJson (packages/server-daemon/src/releaseCatalogFeed.ts:66-76) calls res.text() and only then
  // compares the length with MAX_DOC (1 MiB). Whoever answers the catalog URL (`.com`, R2, anyone on the path if TLS
  // fails open) can make the daemon buffer an unbounded body for up to the 30 s timeout: a memory-exhaustion lever
  // against the management process. The cap should be enforced while streaming (content-length + reader).
  it.fails("AT-CAT-17 boundary: catalog fetch size cap. A multi-megabyte body is cut off near 1 MiB, not read whole (FINDING: read whole before the check)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "at-cat-big-"));
    writeFileSync(join(dir, "pinned.json"), JSON.stringify(root1));
    const roots = new TrustedRootStore({ pinnedPath: join(dir, "pinned.json"), statePath: join(dir, "root-state.json") });
    await roots.load();
    const gate = new ReleaseCatalogGate({ path: join(dir, "catalog.json"), root: () => roots.current(), boxSalt: () => "s", now: () => NOW });
    const CHUNK = 64 * 1024;
    const TOTAL = 16 * 1024 * 1024;
    let pulled = 0;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (pulled >= TOTAL) return c.close();
            pulled += CHUNK;
            c.enqueue(new Uint8Array(CHUNK).fill(0x20));
          },
        }),
      )) as unknown as typeof fetch;
    const msg = await refreshReleaseCatalog({ base: "https://x.test/build/iso", roots, gate, fetchImpl });
    expect(msg).toBe("catalog not reachable");
    expect(pulled).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("AT-CAT-18 boundary: health rollback vs floor. A failed update whose previous release is below the floor (or whose floor check throws) does not restore it; the box stays in restricted recovery (catches: rollback below the floor re-opens a fixed vulnerability)", async () => {
    for (const rollbackAllowed of [() => false, () => { throw new Error("gate unreadable"); }]) {
      let marker: PendingVerifyMarker | null = { previousCommit: commit(1), targetCommit: commit(2), bootAttempts: 3 };
      const calls: string[] = [];
      const reports: string[] = [];
      const out = await runUpdateBootGate({
        pendingStore: { read: async () => marker, write: async (m) => void (marker = m), clear: async () => void (marker = null) },
        swapper: { install: async (c) => void calls.push(`install ${c}`), restore: async (c) => void calls.push(`restore ${c}`) },
        awaitHealthy: async () => false,
        requestRestart: () => calls.push("restart"),
        rollbackAllowed,
        report: (e) => void reports.push(e),
      });
      expect(out.action).toBe("restricted-recovery");
      expect(calls).toEqual([]);
      expect(marker).not.toBeNull();
      expect(reports).toEqual(["update-rollback-refused"]);
    }
  });

  it("AT-CAT-19 boundary: a refused view changes nothing. After a forged/lowered view the persisted state is byte-identical (catches: partial state write before verification)", async () => {
    const w = gateWorld();
    const g = w.make();
    expect((await g.accept(view({ tv: 2, floor: 2 }))).ok).toBe(true);
    const before = readFileSync(w.path, "utf8");
    expect((await g.accept(view({ tv: 3, floor: 1 }))).ok).toBe(false);
    expect((await g.accept(view({ tv: 3, tgSigners: [TSK] }))).ok).toBe(false);
    expect(readFileSync(w.path, "utf8")).toBe(before);
    expect(await w.make().floor()).toBe(2);
  });

  // FINDING AT-CAT-20: ReleaseCatalogGate.load (packages/server-daemon/src/releaseCatalogGate.ts:56-72) reads a damaged
  // state file as EMPTY_TRUST_STATE: floor 0 and every version 0. Until the next successful fetch, rollbackAllowed()
  // returns true for ANY commit (line 130), and the box will accept any older-but-unexpired signed catalog (lower
  // versions, lower floor) a mirror replays. The update boot gate runs at boot, before the fire-and-forget refresh, so a
  // failed update right after the damage rolls back below the floor. The class comment claims the floor is never
  // lowered. The high-water marks need a second copy (or fail closed: refuse rollbacks until a catalog is re-accepted).
  it.fails("AT-CAT-20 boundary: damaged catalog state must not lower the floor. A rollback below the old floor stays refused before the next fetch (FINDING: floor reads 0)", async () => {
    const w = gateWorld();
    expect((await w.make().accept(view({ tv: 2, floor: 2, releases: [rel(1), rel(2)] }))).ok).toBe(true);
    expect(await w.make().rollbackAllowed(commit(1))).toBe(false);
    writeFileSync(w.path, "{damaged");
    expect(await w.make().rollbackAllowed(commit(1))).toBe(false);
  });
});
