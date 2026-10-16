/**
 * A server's backup policy (docs/server-backup-and-clone.md, "Backup policy"),
 * chosen when the server is created and changed from its page:
 *
 *   flagship/backup-policy/v1|<serverDomain>|<policy>|<phoneReserveBytes>|<issuedAt ms>
 *
 * policy: "phone" (the server makes a backup on a schedule and the owner's
 * phone keeps a copy, so the server's data may not outgrow the space the phone
 * reserved), "peer" (encrypted bricks on other servers; the server may use a
 * third of its own disk for its data) or "none". phoneReserveBytes is 0 unless
 * the policy is "phone". Signed with the sensitive-order key (admin root, else
 * IRK); the box keeps the newest one it has verified.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_BACKUP_POLICY = "flagship/backup-policy/v1";
export const BACKUP_POLICIES = ["phone", "peer", "none"] as const;
export type BackupPolicyKind = (typeof BACKUP_POLICIES)[number];

export interface BackupPolicyOrder {
  serverDomain: string;
  policy: BackupPolicyKind;
  /** Bytes the owner's phone keeps for this server's backup; 0 unless policy is "phone". */
  phoneReserveBytes: number;
  issuedAt: number;
}

export function backupPolicyCanonicalBytes(o: BackupPolicyOrder): Bytes {
  if (o.serverDomain.length === 0) throw new Error("backup-policy: empty serverDomain");
  legacyFieldGuard("serverDomain", o.serverDomain);
  if (!(BACKUP_POLICIES as readonly string[]).includes(o.policy)) throw new Error("backup-policy: bad policy");
  if (!Number.isSafeInteger(o.phoneReserveBytes) || o.phoneReserveBytes < 0) throw new Error("backup-policy: bad phoneReserveBytes");
  if (o.policy === "phone" ? o.phoneReserveBytes === 0 : o.phoneReserveBytes !== 0) {
    throw new Error("backup-policy: phoneReserveBytes is set exactly when the policy is phone");
  }
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("backup-policy: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_BACKUP_POLICY, o.serverDomain, o.policy, String(o.phoneReserveBytes), String(o.issuedAt)].join("|"),
  );
}

export function signBackupPolicy(o: BackupPolicyOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(backupPolicyCanonicalBytes(o));
}

/** Never throws: a malformed order simply fails. */
export function verifyBackupPolicy(o: BackupPolicyOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, backupPolicyCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted order (no signature check). */
export function parseBackupPolicy(v: unknown): BackupPolicyOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.policy !== "string") return null;
  if (typeof r.phoneReserveBytes !== "number" || typeof r.issuedAt !== "number") return null;
  const o: BackupPolicyOrder = {
    serverDomain: r.serverDomain,
    policy: r.policy as BackupPolicyKind,
    phoneReserveBytes: r.phoneReserveBytes,
    issuedAt: r.issuedAt,
  };
  try {
    backupPolicyCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}
