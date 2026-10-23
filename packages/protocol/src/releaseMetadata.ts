/**
 * Signed release metadata in the shape of TUF (SECURITY-HARDENING-PLAN.md 18.13): four roles instead of
 * one signed URL, so a compromised cloud, a stolen CI token or a replayed old catalog cannot push, hide
 * or roll back a release on its own.
 *
 *   root       which keys hold each role and how many must sign (threshold); rotated by a chain in which
 *              every new root is signed by the previous root's keys AND its own
 *   timestamp  short-lived; names the current snapshot by version and SHA-256 (freshness)
 *   snapshot   names the current targets by version and SHA-256 (consistency, so mixed views are refused)
 *   targets    the releases (commit, artifact digest, security version, rollout percent) and the SECURITY
 *              FLOOR: the lowest security version any box may run or roll back to
 *
 * A stale catalog (an expired timestamp, snapshot or targets) blocks NEW updates only; nothing else on the
 * box depends on it. Versions never go down and the floor never goes down, whoever signs.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";

export const RELEASE_META_FORMAT = 1;

export type MetaRole = "root" | "timestamp" | "snapshot" | "targets";
const ROLES: MetaRole[] = ["root", "timestamp", "snapshot", "targets"];

export interface RoleKeys {
  keyIds: string[];
  threshold: number;
}

export interface RootMeta {
  role: "root";
  format: number;
  version: number;
  expiresAt: number;
  /** keyId -> Ed25519 public key, hex. */
  keys: Record<string, string>;
  roles: Record<MetaRole, RoleKeys>;
}

export interface TimestampMeta {
  role: "timestamp";
  format: number;
  version: number;
  expiresAt: number;
  snapshotVersion: number;
  snapshotSha256: string;
}

export interface SnapshotMeta {
  role: "snapshot";
  format: number;
  version: number;
  expiresAt: number;
  targetsVersion: number;
  targetsSha256: string;
}

export interface ReleaseEntry {
  commit: string;
  /** What a person sees ("0.3"). */
  label: string;
  /** Monotonic number the floor is compared with. */
  securityVersion: number;
  artifactSha256: string;
  /** 0 to 100: the share of boxes that may take it yet. */
  rolloutPercent: number;
}

export interface TargetsMeta {
  role: "targets";
  format: number;
  version: number;
  expiresAt: number;
  securityFloor: number;
  releases: ReleaseEntry[];
}

export type AnyMeta = RootMeta | TimestampMeta | SnapshotMeta | TargetsMeta;

export interface Signed<T extends AnyMeta> {
  signed: T;
  signatures: { keyId: string; sigHex: string }[];
}

export interface TrustState {
  rootVersion: number;
  timestampVersion: number;
  snapshotVersion: number;
  targetsVersion: number;
  securityFloor: number;
}

export const EMPTY_TRUST_STATE: TrustState = { rootVersion: 0, timestampVersion: 0, snapshotVersion: 0, targetsVersion: 0, securityFloor: 0 };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{8,64}$/;

function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function unhex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

export function releaseMetaTag(role: MetaRole): string {
  return `flagship/release-meta/${role}/v1`;
}

export function canonicalReleaseMeta(m: AnyMeta): Bytes {
  return new TextEncoder().encode(`${releaseMetaTag(m.role)}|${stable(m)}`);
}

export function releaseMetaSha256(m: AnyMeta): string {
  return hex(sha256(canonicalReleaseMeta(m)));
}

export function signReleaseMeta<T extends AnyMeta>(signed: T, signers: { keyId: string; privateKey: Bytes }[]): Signed<T> {
  const bytes = canonicalReleaseMeta(signed);
  return { signed, signatures: signers.map((s) => ({ keyId: s.keyId, sigHex: hex(ed.sign(bytes, s.privateKey)) })) };
}

function shapeError(m: AnyMeta): string | null {
  if (m.format !== RELEASE_META_FORMAT) return "unknown-format";
  if (!Number.isSafeInteger(m.version) || m.version < 1) return "bad-version";
  if (!Number.isSafeInteger(m.expiresAt) || m.expiresAt <= 0) return "bad-expiry";
  if (m.role === "root") {
    for (const r of ROLES) {
      const k = m.roles?.[r];
      if (!k || !Array.isArray(k.keyIds) || !Number.isSafeInteger(k.threshold) || k.threshold < 1 || k.threshold > k.keyIds.length) return "bad-role-keys";
      if (new Set(k.keyIds).size !== k.keyIds.length) return "bad-role-keys";
      for (const id of k.keyIds) if (!HEX64.test(m.keys?.[id] ?? "")) return "bad-role-keys";
    }
  } else if (m.role === "timestamp") {
    if (!Number.isSafeInteger(m.snapshotVersion) || m.snapshotVersion < 1 || !HEX64.test(m.snapshotSha256)) return "bad-snapshot-ref";
  } else if (m.role === "snapshot") {
    if (!Number.isSafeInteger(m.targetsVersion) || m.targetsVersion < 1 || !HEX64.test(m.targetsSha256)) return "bad-targets-ref";
  } else if (m.role === "targets") {
    if (!Number.isSafeInteger(m.securityFloor) || m.securityFloor < 0) return "bad-floor";
    if (!Array.isArray(m.releases)) return "bad-releases";
    for (const r of m.releases) {
      if (!HEX_COMMIT.test(r.commit) || !HEX64.test(r.artifactSha256)) return "bad-release";
      if (!Number.isSafeInteger(r.securityVersion) || r.securityVersion < 0) return "bad-release";
      if (!Number.isFinite(r.rolloutPercent) || r.rolloutPercent < 0 || r.rolloutPercent > 100) return "bad-release";
      if (typeof r.label !== "string" || r.label.length === 0 || r.label.length > 40 || /[|\u0000-\u001f]/.test(r.label)) return "bad-release";
    }
  } else {
    return "unknown-role";
  }
  return null;
}

/** Distinct, listed keys with a valid signature. */
function validSigners(doc: Signed<AnyMeta>, role: RoleKeys, keys: Record<string, string>): number {
  const bytes = canonicalReleaseMeta(doc.signed);
  const seen = new Set<string>();
  for (const s of doc.signatures) {
    if (seen.has(s.keyId) || !role.keyIds.includes(s.keyId)) continue;
    const pub = keys[s.keyId];
    if (!pub || !/^[0-9a-f]{128}$/.test(s.sigHex)) continue;
    try {
      if (ed.verify(unhex(s.sigHex), bytes, unhex(pub))) seen.add(s.keyId);
    } catch {
      // a malformed key or signature counts as no signature
    }
  }
  return seen.size;
}

export type MetaRefusal =
  | "unknown-format" | "bad-version" | "bad-expiry" | "bad-role-keys" | "bad-snapshot-ref" | "bad-targets-ref"
  | "bad-floor" | "bad-releases" | "bad-release" | "unknown-role" | "wrong-role" | "below-threshold"
  | "version-not-next" | "rollback" | "root-expired" | "snapshot-mismatch" | "targets-mismatch" | "floor-lowered";

export type MetaResult<T> = { ok: true; value: T } | { ok: false; reason: MetaRefusal };

/**
 * Take the next root. It must be exactly one version up, signed by the CURRENT root's root-role threshold
 * and by its own, so neither a stolen old key nor a self-signed jump can replace the keys.
 */
export function advanceRoot(trusted: RootMeta, next: Signed<RootMeta>): MetaResult<RootMeta> {
  const bad = shapeError(next.signed);
  if (bad) return { ok: false, reason: bad as MetaRefusal };
  if (next.signed.role !== "root") return { ok: false, reason: "wrong-role" };
  if (next.signed.version !== trusted.version + 1) return { ok: false, reason: next.signed.version <= trusted.version ? "rollback" : "version-not-next" };
  if (validSigners(next, trusted.roles.root, trusted.keys) < trusted.roles.root.threshold) return { ok: false, reason: "below-threshold" };
  if (validSigners(next, next.signed.roles.root, next.signed.keys) < next.signed.roles.root.threshold) return { ok: false, reason: "below-threshold" };
  return { ok: true, value: next.signed };
}

export interface CatalogInput {
  root: RootMeta;
  timestamp: Signed<TimestampMeta>;
  snapshot: Signed<SnapshotMeta>;
  targets: Signed<TargetsMeta>;
  now: number;
  state: TrustState;
}

export interface Catalog {
  /** An expired timestamp, snapshot or targets: keep what runs, take nothing new. */
  stale: boolean;
  targets: TargetsMeta;
  securityFloor: number;
  state: TrustState;
}

/**
 * Check one fetched view of the catalog against the trusted root and the last state the box accepted.
 * Versions and the floor only go up; the four files must name each other by digest.
 */
export function verifyReleaseCatalog(input: CatalogInput): MetaResult<Catalog> {
  const { root, timestamp, snapshot, targets, now, state } = input;
  if (root.version < state.rootVersion) return { ok: false, reason: "rollback" };
  if (root.expiresAt <= now) return { ok: false, reason: "root-expired" };
  const docs: [MetaRole, Signed<AnyMeta>][] = [["timestamp", timestamp], ["snapshot", snapshot], ["targets", targets]];
  for (const [role, doc] of docs) {
    const bad = shapeError(doc.signed);
    if (bad) return { ok: false, reason: bad as MetaRefusal };
    if (doc.signed.role !== role) return { ok: false, reason: "wrong-role" };
    const rk = root.roles[role];
    if (validSigners(doc, rk, root.keys) < rk.threshold) return { ok: false, reason: "below-threshold" };
  }
  const ts = timestamp.signed, sn = snapshot.signed, tg = targets.signed;
  if (ts.version < state.timestampVersion || sn.version < state.snapshotVersion || tg.version < state.targetsVersion) return { ok: false, reason: "rollback" };
  if (ts.snapshotVersion !== sn.version || ts.snapshotSha256 !== releaseMetaSha256(sn)) return { ok: false, reason: "snapshot-mismatch" };
  if (sn.targetsVersion !== tg.version || sn.targetsSha256 !== releaseMetaSha256(tg)) return { ok: false, reason: "targets-mismatch" };
  if (tg.securityFloor < state.securityFloor) return { ok: false, reason: "floor-lowered" };
  const stale = ts.expiresAt <= now || sn.expiresAt <= now || tg.expiresAt <= now;
  return {
    ok: true,
    value: {
      stale,
      targets: tg,
      securityFloor: tg.securityFloor,
      state: {
        rootVersion: root.version,
        timestampVersion: ts.version,
        snapshotVersion: sn.version,
        targetsVersion: tg.version,
        securityFloor: tg.securityFloor,
      },
    },
  };
}

/** A rollback or health-failure fallback is only allowed to a release that still meets the floor. */
export function meetsSecurityFloor(securityVersion: number, floor: number): boolean {
  return Number.isSafeInteger(securityVersion) && securityVersion >= floor;
}

/** 0 to 9999: where this box sits for this release, stable across restarts and different per release. */
export function rolloutBucket(boxSalt: string, commit: string): number {
  const h = sha256(new TextEncoder().encode(`flagship/rollout/v1|${boxSalt}|${commit.toLowerCase()}`));
  return (((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0) % 10_000;
}

export function inRolloutCohort(boxSalt: string, release: Pick<ReleaseEntry, "commit" | "rolloutPercent">): boolean {
  if (release.rolloutPercent >= 100) return true;
  if (release.rolloutPercent <= 0) return false;
  return rolloutBucket(boxSalt, release.commit) < release.rolloutPercent * 100;
}

export type OfferRefusal = "stale-catalog" | "below-floor" | "not-in-cohort" | "not-newer";

/**
 * The releases a box may be offered: none while the catalog is stale, none below the floor, none outside
 * the cohort that is open yet, none that are not newer than what runs. Newest first.
 */
export function offerableReleases(
  catalog: Catalog,
  boxSalt: string,
  runningSecurityVersion: number,
): { offers: ReleaseEntry[]; blocked: { commit: string; reason: OfferRefusal }[] } {
  const offers: ReleaseEntry[] = [];
  const blocked: { commit: string; reason: OfferRefusal }[] = [];
  for (const r of [...catalog.targets.releases].sort((a, b) => b.securityVersion - a.securityVersion)) {
    if (catalog.stale) blocked.push({ commit: r.commit, reason: "stale-catalog" });
    else if (!meetsSecurityFloor(r.securityVersion, catalog.securityFloor)) blocked.push({ commit: r.commit, reason: "below-floor" });
    else if (r.securityVersion <= runningSecurityVersion) blocked.push({ commit: r.commit, reason: "not-newer" });
    else if (!inRolloutCohort(boxSalt, r)) blocked.push({ commit: r.commit, reason: "not-in-cohort" });
    else offers.push(r);
  }
  return { offers, blocked };
}

/**
 * What a consenting box reports about what it runs. Fixed fields only: never a body, token, phrase, key
 * or source. Without the owner's consent there is no report.
 */
export interface RunningArtifactReport {
  commit: string;
  artifactSha256: string;
  securityVersion: number;
  revocationEpoch: number;
  lastUpdateResult: "ok" | "rolled-back" | "failed" | "none";
  reportedAt: number;
}

const REPORT_KEYS = ["commit", "artifactSha256", "securityVersion", "revocationEpoch", "lastUpdateResult", "reportedAt"].sort().join(",");

export function buildRunningArtifactReport(consented: boolean, r: RunningArtifactReport): RunningArtifactReport | null {
  if (!consented) return null;
  return parseRunningArtifactReport(r);
}

export function parseRunningArtifactReport(v: unknown): RunningArtifactReport | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== REPORT_KEYS) return null;
  if (typeof o.commit !== "string" || !HEX_COMMIT.test(o.commit)) return null;
  if (typeof o.artifactSha256 !== "string" || !HEX64.test(o.artifactSha256)) return null;
  for (const k of ["securityVersion", "revocationEpoch", "reportedAt"] as const) {
    if (!Number.isSafeInteger(o[k]) || (o[k] as number) < 0) return null;
  }
  if (!["ok", "rolled-back", "failed", "none"].includes(o.lastUpdateResult as string)) return null;
  return o as unknown as RunningArtifactReport;
}
