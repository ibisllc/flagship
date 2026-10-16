/**
 * Keys for a server's scheduled backups (docs/server-backup-and-clone.md,
 * "Scheduled backups"). The box can't make a backup's account slot by itself:
 * its key is `deriveServerArchiveKey(UMK, archiveId)`, and the box never holds
 * the UMK. So an admin device of the account mints a batch of archive ids and
 * their slot keys ahead of time and hands them to the box, signed:
 *
 *   flagship/server-archive-keys/v1|<serverDomain>|<count>|<digest>|<issuedAt ms>
 *
 * digest = SHA-256 (lowercase hex) of the UTF-8 lines `<archiveId>:<kekHex>`
 * joined with "\n", in the order sent. The box checks the signature under its
 * sensitive-order authority (admin root, else IRK), uses each key for one
 * backup and deletes it, so it can seal future backups but never re-open a
 * past one.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import { deriveServerArchiveKey } from "./keys.js";
import type { Bytes, UserMasterKey } from "./types.js";

export const TAG_SERVER_ARCHIVE_KEYS = "flagship/server-archive-keys/v1";
/** The most keys one deposit may carry (about a year of daily backups plus spares). */
export const ARCHIVE_KEYS_MAX_PER_DEPOSIT = 400;

export interface ArchiveKey {
  /** 16 bytes, lowercase hex. */
  archiveId: string;
  /** deriveServerArchiveKey(UMK, archiveId), 32 bytes lowercase hex. */
  kekHex: string;
}

export interface ArchiveKeysDeposit {
  serverDomain: string;
  count: number;
  /** archiveKeysDigest(keys). */
  digest: string;
  issuedAt: number;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function toHex(b: Bytes): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function archiveKeysDigest(keys: readonly ArchiveKey[]): string {
  for (const k of keys) {
    if (!HEX32.test(k.archiveId)) throw new Error("archive-keys: bad archiveId");
    if (!HEX64.test(k.kekHex)) throw new Error("archive-keys: bad kekHex");
  }
  return toHex(sha256(new TextEncoder().encode(keys.map((k) => `${k.archiveId}:${k.kekHex}`).join("\n"))));
}

/** Mint `count` fresh archive ids and their account-slot keys. */
export function mintArchiveKeys(umk: UserMasterKey, count: number, rng: (n: number) => Bytes): ArchiveKey[] {
  const out: ArchiveKey[] = [];
  for (let i = 0; i < count; i++) {
    const archiveId = toHex(rng(16));
    out.push({ archiveId, kekHex: toHex(deriveServerArchiveKey(umk, archiveId)) });
  }
  return out;
}

export function archiveKeysCanonicalBytes(d: ArchiveKeysDeposit): Bytes {
  if (d.serverDomain.length === 0) throw new Error("archive-keys: empty serverDomain");
  legacyFieldGuard("serverDomain", d.serverDomain);
  if (!Number.isSafeInteger(d.count) || d.count < 1 || d.count > ARCHIVE_KEYS_MAX_PER_DEPOSIT) throw new Error("archive-keys: bad count");
  if (!HEX64.test(d.digest)) throw new Error("archive-keys: bad digest");
  if (!Number.isSafeInteger(d.issuedAt) || d.issuedAt < 0) throw new Error("archive-keys: bad issuedAt");
  return new TextEncoder().encode([TAG_SERVER_ARCHIVE_KEYS, d.serverDomain, String(d.count), d.digest, String(d.issuedAt)].join("|"));
}

export function signArchiveKeysDeposit(d: ArchiveKeysDeposit, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(archiveKeysCanonicalBytes(d));
}

/** Never throws: a malformed deposit simply fails. */
export function verifyArchiveKeysDeposit(d: ArchiveKeysDeposit, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, archiveKeysCanonicalBytes(d), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted deposit (no signature check). */
export function parseArchiveKeysDeposit(v: unknown): ArchiveKeysDeposit | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.digest !== "string") return null;
  if (typeof r.count !== "number" || typeof r.issuedAt !== "number") return null;
  const d: ArchiveKeysDeposit = { serverDomain: r.serverDomain, count: r.count, digest: r.digest, issuedAt: r.issuedAt };
  try {
    archiveKeysCanonicalBytes(d);
  } catch {
    return null;
  }
  return d;
}

/** Shape-check untrusted keys; null if any is malformed or an id repeats. */
export function parseArchiveKeys(v: unknown): ArchiveKey[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > ARCHIVE_KEYS_MAX_PER_DEPOSIT) return null;
  const seen = new Set<string>();
  const out: ArchiveKey[] = [];
  for (const x of v) {
    if (typeof x !== "object" || x === null) return null;
    const k = x as Record<string, unknown>;
    if (typeof k.archiveId !== "string" || !HEX32.test(k.archiveId)) return null;
    if (typeof k.kekHex !== "string" || !HEX64.test(k.kekHex)) return null;
    if (seen.has(k.archiveId)) return null;
    seen.add(k.archiveId);
    out.push({ archiveId: k.archiveId, kekHex: k.kekHex });
  }
  return out;
}
