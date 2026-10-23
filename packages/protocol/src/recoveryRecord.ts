/**
 * The complete, versioned cloud-recovery record (SECURITY-HARDENING-PLAN.md 18.3, N03).
 *
 * The v1 upload signature (`flagship/upload-recovery-record/v1`) covered only the wrapped-UMK
 * hash, so the escrowed admin root, the escrowed ACME key, the fetch-token hash and the PRF-salt
 * hash could each be swapped, dropped or inherited without breaking it. This envelope signs every
 * behaviour-changing value, the position in the record's history and the previous record's
 * digest, so no valid signature authorizes a different effective record.
 *
 * Optional escrow fields are never "omitted": each is `keep:<digest>`, `replace:<digest>` or
 * `remove`, and `keep` names the digest it keeps, so inheriting security state is a signed act.
 * Compare-and-swap on `priorDigestHex` + `generation` decides concurrent writers.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_RECOVERY_RECORD = "flagship/recovery-record/v2";

export const RECOVERY_KDF_VERSIONS = [1] as const;
export const RECOVERY_ALG_VERSIONS = [1] as const;
/** The only recovery policy v2 knows: the passkey's PRF output AND the passphrase-derived token. */
export const RECOVERY_POLICIES = ["passkey-and-passphrase"] as const;

export type RecoveryEscrowChange =
  | { change: "keep"; digestHex: string }
  | { change: "replace"; digestHex: string }
  | { change: "remove" }
  /** Absent before and absent after: the only way to say "there is none" without inheriting one. */
  | { change: "none" };

export interface RecoveryRecordV2 {
  op: "put" | "delete";
  username: string;
  /** The account key that signs and the admin root it pinned when this was written (`none` if unpinned). */
  irkPubHex: string;
  adminRootPubHex: string;
  credentialIdHex: string;
  wrappedUmkDigestHex: string;
  adminRoot: RecoveryEscrowChange;
  acmeKey: RecoveryEscrowChange;
  fetchTokenHashHex: string;
  prfSaltHashHex: string;
  kdfVersion: number;
  algVersion: number;
  policy: string;
  /** 1 for the first record; each write is the previous generation + 1. */
  generation: number;
  nonceHex: string;
  /** `genesis` (no record yet), `legacy` (a v1 row) or the previous record's digest. */
  priorDigestHex: string;
  issuedAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function escrowField(name: string, e: RecoveryEscrowChange): string {
  if (e.change === "remove" || e.change === "none") return e.change;
  if (e.change !== "keep" && e.change !== "replace") throw new Error(`invalid ${name}`);
  if (!HEX64.test(e.digestHex)) throw new Error(`${name} digest must be 64 lowercase hex characters`);
  return `${e.change}:${e.digestHex}`;
}

export function canonicalRecoveryRecord(r: RecoveryRecordV2): Bytes {
  if (r.op !== "put" && r.op !== "delete") throw new Error("invalid op");
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("credentialIdHex", r.credentialIdHex);
  if (!/^[0-9a-f]{64}$/.test(r.irkPubHex)) throw new Error("irkPubHex must be 64 lowercase hex characters");
  if (r.adminRootPubHex !== "none" && !HEX64.test(r.adminRootPubHex)) throw new Error("invalid adminRootPubHex");
  if (!/^[0-9a-f]{16,512}$/.test(r.credentialIdHex)) throw new Error("invalid credentialIdHex");
  for (const [k, v] of Object.entries({ wrappedUmkDigestHex: r.wrappedUmkDigestHex, fetchTokenHashHex: r.fetchTokenHashHex, prfSaltHashHex: r.prfSaltHashHex })) {
    if (!HEX64.test(v)) throw new Error(`${k} must be 64 lowercase hex characters`);
  }
  if (!(RECOVERY_KDF_VERSIONS as readonly number[]).includes(r.kdfVersion)) throw new Error("unknown kdfVersion");
  if (!(RECOVERY_ALG_VERSIONS as readonly number[]).includes(r.algVersion)) throw new Error("unknown algVersion");
  if (!(RECOVERY_POLICIES as readonly string[]).includes(r.policy)) throw new Error("unknown policy");
  if (!Number.isSafeInteger(r.generation) || r.generation < 1) throw new Error("invalid generation");
  if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0) throw new Error("invalid issuedAt");
  if (!/^[0-9a-f]{32}$/.test(r.nonceHex)) throw new Error("nonceHex must be 32 lowercase hex characters");
  if (r.priorDigestHex !== "genesis" && r.priorDigestHex !== "legacy" && !HEX64.test(r.priorDigestHex)) throw new Error("invalid priorDigestHex");
  if (r.priorDigestHex === "genesis" && r.generation !== 1) throw new Error("a genesis record is generation 1");
  return new TextEncoder().encode(
    [
      TAG_RECOVERY_RECORD, r.op, r.username.toLowerCase(), r.irkPubHex, r.adminRootPubHex, r.credentialIdHex,
      r.wrappedUmkDigestHex, escrowField("adminRoot", r.adminRoot), escrowField("acmeKey", r.acmeKey),
      r.fetchTokenHashHex, r.prfSaltHashHex, r.kdfVersion, r.algVersion, r.policy, r.generation, r.nonceHex,
      r.priorDigestHex, r.issuedAt,
    ].join("|"),
  );
}

/** The chain link the next write must name. */
export function recoveryRecordDigest(r: RecoveryRecordV2): string {
  return hex(sha256(canonicalRecoveryRecord(r)));
}

export function signRecoveryRecord(r: RecoveryRecordV2, irk: Keypair): Bytes {
  return ed.sign(canonicalRecoveryRecord(r), irk.privateKey);
}

export function verifyRecoveryRecord(r: RecoveryRecordV2, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return hex(irkPub) === r.irkPubHex && ed.verify(sig, canonicalRecoveryRecord(r), irkPub);
  } catch {
    return false;
  }
}

export function ciphertextDigestHex(bytes: Bytes): string {
  return hex(sha256(bytes));
}

/** What the store already holds, as the evolution check needs it. */
export interface StoredRecoveryState {
  /** `legacy` for a v1 row, else the digest of the last accepted v2 record. */
  digestHex: string;
  generation: number;
  wrappedUmkDigestHex: string;
  adminRootDigestHex?: string;
  acmeKeyDigestHex?: string;
}

export type RecoveryEvolutionVerdict =
  | { ok: true; adminRootDigestHex?: string; acmeKeyDigestHex?: string }
  | { ok: false; reason: "stale-prior" | "bad-generation" | "keep-mismatch" | "keep-without-prior" | "nothing-to-remove" | "delete-needs-prior" };

type Resolved = { ok: true; digest: string | undefined } | { ok: false; reason: "keep-mismatch" | "nothing-to-remove" };

function resolveEscrow(e: RecoveryEscrowChange, held: string | undefined): Resolved {
  switch (e.change) {
    case "keep":
      return held !== undefined && e.digestHex === held ? { ok: true, digest: held } : { ok: false, reason: "keep-mismatch" };
    case "remove":
      return held === undefined ? { ok: false, reason: "nothing-to-remove" } : { ok: true, digest: undefined };
    case "none":
      return held === undefined ? { ok: true, digest: undefined } : { ok: false, reason: "keep-mismatch" };
    case "replace":
      return { ok: true, digest: e.digestHex };
  }
}

/**
 * Is `next` a legal successor of `stored`? `stored` is undefined for the first record. Returns the
 * escrow digests the new record will hold. Pure so the Worker and tests share one rule.
 */
export function checkRecoveryEvolution(stored: StoredRecoveryState | undefined, next: RecoveryRecordV2): RecoveryEvolutionVerdict {
  if (!stored) {
    if (next.op === "delete") return { ok: false, reason: "delete-needs-prior" };
    if (next.priorDigestHex !== "genesis" || next.generation !== 1) return { ok: false, reason: "stale-prior" };
    if (next.adminRoot.change === "keep" || next.acmeKey.change === "keep") return { ok: false, reason: "keep-without-prior" };
    const a = resolveEscrow(next.adminRoot, undefined);
    if (!a.ok) return { ok: false, reason: a.reason };
    const c = resolveEscrow(next.acmeKey, undefined);
    if (!c.ok) return { ok: false, reason: c.reason };
    return { ok: true, adminRootDigestHex: a.digest, acmeKeyDigestHex: c.digest };
  }
  if (next.priorDigestHex !== stored.digestHex) return { ok: false, reason: "stale-prior" };
  // A legacy row has no generation; the first v2 write over it is generation 1.
  const expectedGeneration = stored.digestHex === "legacy" ? 1 : stored.generation + 1;
  if (next.generation !== expectedGeneration) return { ok: false, reason: "bad-generation" };
  if (next.op === "delete") return { ok: true };
  const a = resolveEscrow(next.adminRoot, stored.adminRootDigestHex);
  if (!a.ok) return { ok: false, reason: a.reason };
  const c = resolveEscrow(next.acmeKey, stored.acmeKeyDigestHex);
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, adminRootDigestHex: a.digest, acmeKeyDigestHex: c.digest };
}
