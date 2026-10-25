/**
 * The canary's stop rule and widen step on the signed release catalog (docs/runbooks/canary.md).
 *
 * A rollout change is a NEW targets version: the release list in `release/catalog-releases.json` with one
 * release's rolloutPercent lowered (stop), raised (widen) or the release removed, signed like any catalog
 * and checked against the state a box holds after the catalog that is published now. Versions only go up
 * and the floor never moves here, so a stop can never be undone by replaying the old catalog, and a box
 * that already took the release keeps running it (the catalog only gates NEW updates): the remedy for a
 * bad release that went out is a fixed release with a higher security version.
 */
import {
  releaseMetaSha256,
  signReleaseMeta,
  verifyReleaseCatalog,
  EMPTY_TRUST_STATE,
  type MetaRefusal,
  type ReleaseEntry,
  type RootMeta,
  type Signed,
  type SnapshotMeta,
  type TargetsMeta,
  type TimestampMeta,
  type TrustState,
} from "../../packages/protocol/src/index.js";

const DAY = 86_400_000;

export interface ReleaseList {
  version: number;
  floor: number;
  releases: ReleaseEntry[];
}

export type RolloutChange = { percent: number } | { remove: true };

export type RolloutResult =
  | { ok: true; list: ReleaseList; before: number | null; after: number | null; warnings: string[] }
  | { ok: false; reason: string };

/** The list with one release changed; the version is NOT moved here (signing picks it). */
export function applyRollout(list: ReleaseList, commit: string, change: RolloutChange): RolloutResult {
  const i = list.releases.findIndex((r) => r.commit === commit);
  if (i < 0) return { ok: false, reason: `release ${commit} is not in the list` };
  const cur = list.releases[i]!;
  const warnings: string[] = [];
  if ("remove" in change) {
    if (list.floor > 0) {
      warnings.push(
        "with a security floor set, a box can no longer roll back to a release the catalog does not list: prefer --percent 0, which stops new updates and keeps it known",
      );
    }
    const releases = list.releases.filter((_, j) => j !== i);
    return { ok: true, list: { ...list, releases }, before: cur.rolloutPercent, after: null, warnings };
  }
  const p = change.percent;
  if (!Number.isInteger(p) || p < 0 || p > 100) return { ok: false, reason: "the percent is a whole number from 0 to 100" };
  if (p === cur.rolloutPercent) return { ok: false, reason: `release ${commit} is already at ${p}%` };
  const releases = list.releases.map((r, j) => (j === i ? { ...r, rolloutPercent: p } : r));
  return { ok: true, list: { ...list, releases }, before: cur.rolloutPercent, after: p, warnings };
}

export interface Signer {
  keyId: string;
  privateKey: Uint8Array;
}

export interface SignedCatalog {
  targets: Signed<TargetsMeta>;
  snapshot: Signed<SnapshotMeta>;
  timestamp: Signed<TimestampMeta>;
}

/**
 * Sign targets/snapshot/timestamp at `version` and check them the way a box that holds `state` (the
 * published catalog's state; empty for the first) will, before anything is written.
 */
export function signCatalog(o: {
  root: RootMeta;
  list: ReleaseList;
  version: number;
  signers: Signer[];
  timestampSigners?: Signer[];
  previousTimestampVersion?: number;
  state?: TrustState;
  now?: number;
  targetsDays?: number;
  snapshotDays?: number;
  timestampDays?: number;
}): { ok: true; catalog: SignedCatalog } | { ok: false; reason: MetaRefusal | string } {
  const now = o.now ?? Date.now();
  if (o.signers.length === 0) return { ok: false, reason: "at least one key" };
  const targets: TargetsMeta = {
    role: "targets", format: 1, version: o.version, expiresAt: now + (o.targetsDays ?? 30) * DAY, securityFloor: o.list.floor, releases: o.list.releases,
  };
  const snapshot: SnapshotMeta = {
    role: "snapshot", format: 1, version: o.version, expiresAt: now + (o.snapshotDays ?? 7) * DAY, targetsVersion: o.version, targetsSha256: releaseMetaSha256(targets),
  };
  const timestamp: TimestampMeta = {
    role: "timestamp", format: 1, version: Math.max(o.version, (o.previousTimestampVersion ?? 0) + 1), expiresAt: now + (o.timestampDays ?? 1) * DAY,
    snapshotVersion: o.version, snapshotSha256: releaseMetaSha256(snapshot),
  };
  const catalog: SignedCatalog = {
    targets: signReleaseMeta(targets, o.signers),
    snapshot: signReleaseMeta(snapshot, o.signers),
    timestamp: signReleaseMeta(timestamp, o.timestampSigners?.length ? o.timestampSigners : o.signers),
  };
  const check = verifyReleaseCatalog({ root: o.root, ...catalog, now, state: o.state ?? EMPTY_TRUST_STATE });
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, catalog };
}

/** The state a box keeps after accepting the published catalog (what the new one must move past). */
export function stateAfter(root: RootMeta, published: { targets: Signed<TargetsMeta>; timestamp?: Signed<TimestampMeta> }): TrustState {
  return {
    rootVersion: root.version,
    timestampVersion: published.timestamp?.signed.version ?? 0,
    snapshotVersion: published.targets.signed.version,
    targetsVersion: published.targets.signed.version,
    securityFloor: published.targets.signed.securityFloor,
  };
}

/** The next targets version: above the list and above what is published. */
export function nextVersion(list: ReleaseList, published?: Signed<TargetsMeta>): number {
  return Math.max(list.version, published?.signed.version ?? 0) + 1;
}
