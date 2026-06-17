/**
 * Device-capability-grant domain (v2 device-addressing) — a per-device IRK
 * bound to a user under a human label with an explicit scope set, plus the
 * revoke envelope.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; the scope list
 * + index sort order, tags, field order, label rules, and validators are
 * unchanged, so canonical bytes and signatures remain byte-identical.
 */
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// DeviceCapabilityGrant (v2 device-addressing — S3.1)
//
// Models a per-device IRK bound to a user under a human-meaningful
// label, with an explicit capability scope set. The User IRK signs the
// envelope; consumers verify under the user's IRK pub, check expiry,
// and confirm the requested operation is in `scopes`.
//
// Shape parallels ServiceGrant: canonical-bytes are a '|'-joined
// positional string, every field rejects '|' and control bytes (H1
// hardening), and a SHA-256 hex of the canonical bytes (grantId
// helper) is used as the D1 primary key + revocation handle.
//
// The single envelope serves BOTH the demo flow ("demoalice.reviewer"
// is a browse-only sub-identity) and the corporate / restricted-device
// path. See docs/v2-device-addressing-and-real-ticket.md §2 + §11.
// ──────────────────────────────────────────────────────────────────────

export type DeviceScope =
  | "browse"
  | "install-service"
  | "vibe-code"
  | "add-device"
  | "manage-services"
  | "revoke-others"
  | "demo-provision"
  // The "administrator" authority (per-user-cert design): a device with the
  // `admin` scope may perform security operations on the account — chiefly
  // minting/renewing the per-user TLS cert (it holds the sealed ACME account
  // key). Granting it to only a subset of the user's devices keeps a lost or
  // less-trusted device from minting for the whole `*.<user>` namespace.
  // Appended LAST so existing grants' canonical-byte scope indices are
  // unchanged.
  | "admin";

/**
 * Canonical scope list — also the sort order for canonical-bytes. We
 * sort by index in THIS list (not alphabetically) so the audit-vector
 * ordering stays stable even if a future scope name would re-shuffle
 * an alphabetical sort. APPEND new scopes; never reorder.
 */
export const DEVICE_SCOPES: readonly DeviceScope[] = [
  "browse",
  "install-service",
  "vibe-code",
  "add-device",
  "manage-services",
  "revoke-others",
  "demo-provision",
  "admin",
] as const;

const DEVICE_SCOPE_INDEX: ReadonlyMap<DeviceScope, number> = new Map(
  DEVICE_SCOPES.map((s, i) => [s, i] as const),
);

const DEVICE_LABEL_RE = /^[a-z0-9-]{1,24}$/;
const RESERVED_DEVICE_LABELS: ReadonlySet<string> = new Set([
  "admin",
  "user",
  "root",
  "home",
  "service",
  "services",
]);

export interface DeviceCapabilityGrant {
  /** Fresh v4 UUID; consumers reject duplicates within the active window. */
  grantId: string;
  /** Username at issuance time. Renames produce new grants under the new name. */
  username: string;
  /** Human-meaningful device label ("ipad", "work-laptop", "reviewer"). */
  deviceLabel: string;
  /** Device's Ed25519 pubkey (32 bytes). Identifies the device. */
  devicePubKey: Bytes;
  /** Authorized scopes (sorted at canonicalization). */
  scopes: DeviceScope[];
  /** ms since epoch. */
  issuedAt: number;
  /** ms since epoch; SHOULD be issuedAt + 90*24*3600*1000 by convention (90d). */
  expiresAt: number;
}

const TAG_DEVICE_CAPABILITY_GRANT = "flagship/device-capability-grant/v1";

/**
 * Validate that no string field in a DeviceCapabilityGrant contains the
 * canonical-bytes separator '|' or any control byte (H1 hardening).
 * Also enforces structural rules: expiry ordering, non-empty + unique +
 * known-set scopes, deviceLabel charset + reserved-list. Throws on
 * violation.
 */
function validateDeviceCapabilityGrantFields(g: DeviceCapabilityGrant): void {
  const fields: Array<[string, string]> = [
    ["grantId", g.grantId],
    ["username", g.username],
    ["deviceLabel", g.deviceLabel],
  ];
  for (const [name, value] of fields) {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c)
        throw new Error(`DeviceCapabilityGrant field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) {
        throw new Error(
          `DeviceCapabilityGrant field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
        );
      }
    }
  }
  if (g.expiresAt <= g.issuedAt) {
    throw new Error("DeviceCapabilityGrant: expiresAt must be strictly after issuedAt");
  }
  if (g.scopes.length === 0) {
    throw new Error("DeviceCapabilityGrant: scopes must have at least one entry");
  }
  const seen = new Set<DeviceScope>();
  for (const s of g.scopes) {
    if (!DEVICE_SCOPE_INDEX.has(s)) {
      throw new Error(`DeviceCapabilityGrant: unknown scope "${String(s)}"`);
    }
    if (seen.has(s)) {
      throw new Error(`DeviceCapabilityGrant: duplicate scope "${s}"`);
    }
    seen.add(s);
  }
  if (!DEVICE_LABEL_RE.test(g.deviceLabel)) {
    throw new Error(
      `DeviceCapabilityGrant: deviceLabel "${g.deviceLabel}" must match /^[a-z0-9-]{1,24}$/`,
    );
  }
  if (g.deviceLabel.startsWith("-") || g.deviceLabel.endsWith("-")) {
    throw new Error("DeviceCapabilityGrant: deviceLabel must not start or end with '-'");
  }
  if (RESERVED_DEVICE_LABELS.has(g.deviceLabel)) {
    throw new Error(`DeviceCapabilityGrant: deviceLabel "${g.deviceLabel}" is reserved`);
  }
  if (g.devicePubKey.length !== 32) {
    throw new Error(
      `DeviceCapabilityGrant: devicePubKey must be 32 bytes, got ${g.devicePubKey.length}`,
    );
  }
}

/**
 * Sort by DEVICE_SCOPES index (NOT alphabetical) for canonical-bytes
 * stability — a future scope name would otherwise re-shuffle the order
 * and invalidate every prior audit vector.
 */
function canonicalDeviceCapabilityGrant(g: DeviceCapabilityGrant): Bytes {
  validateDeviceCapabilityGrantFields(g);
  const sortedScopes = [...g.scopes]
    .sort((a, b) => (DEVICE_SCOPE_INDEX.get(a) ?? 0) - (DEVICE_SCOPE_INDEX.get(b) ?? 0))
    .join(",");
  return new TextEncoder().encode(
    [
      TAG_DEVICE_CAPABILITY_GRANT,
      g.grantId,
      g.username,
      g.deviceLabel,
      hex(g.devicePubKey),
      sortedScopes,
      g.issuedAt,
      g.expiresAt,
    ].join("|"),
  );
}

export function signDeviceCapabilityGrant(g: DeviceCapabilityGrant, irk: Keypair): Bytes {
  return ed.sign(canonicalDeviceCapabilityGrant(g), irk.privateKey);
}

export function verifyDeviceCapabilityGrant(
  g: DeviceCapabilityGrant,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalDeviceCapabilityGrant(g), irkPub);
  } catch {
    return false;
  }
}

/**
 * Stable identifier for a DeviceCapabilityGrant — SHA-256 hex of its
 * canonical bytes. Used as the D1 primary key and the revocation
 * lookup handle.
 */
export async function deviceCapabilityGrantId(g: DeviceCapabilityGrant): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalDeviceCapabilityGrant(g));
  return hex(new Uint8Array(digest));
}

/**
 * Pure scope-membership check. Consumers MUST also call
 * `verifyDeviceCapabilityGrant`, confirm `now < expiresAt`, and confirm
 * the grant is not on the revocation list — this helper is the
 * permission-check half ONLY.
 */
export function deviceCapabilityGrantAuthorizesScope(
  g: DeviceCapabilityGrant,
  scope: DeviceScope,
): boolean {
  return g.scopes.includes(scope);
}

export type RevokeDeviceCapabilityGrantReason = "lost" | "stolen" | "decommissioned" | "replaced";

const REVOKE_DEVICE_REASONS: ReadonlySet<RevokeDeviceCapabilityGrantReason> = new Set([
  "lost",
  "stolen",
  "decommissioned",
  "replaced",
]);

export interface RevokeDeviceCapabilityGrant {
  /** grantId of the DeviceCapabilityGrant being revoked. */
  grantId: string;
  /** Username at issuance time of the parent grant. */
  username: string;
  /** Why the grant is being revoked. */
  reason: RevokeDeviceCapabilityGrantReason;
  /** ms since epoch. */
  issuedAt: number;
}

const TAG_REVOKE_DEVICE_CAPABILITY_GRANT = "flagship/revoke-device-capability-grant/v1";

function validateRevokeDeviceCapabilityGrantFields(r: RevokeDeviceCapabilityGrant): void {
  const fields: Array<[string, string]> = [
    ["grantId", r.grantId],
    ["username", r.username],
  ];
  for (const [name, value] of fields) {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c)
        throw new Error(`RevokeDeviceCapabilityGrant field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) {
        throw new Error(
          `RevokeDeviceCapabilityGrant field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
        );
      }
    }
  }
  if (!REVOKE_DEVICE_REASONS.has(r.reason)) {
    throw new Error(`RevokeDeviceCapabilityGrant: unknown reason "${String(r.reason)}"`);
  }
}

function canonicalRevokeDeviceCapabilityGrant(r: RevokeDeviceCapabilityGrant): Bytes {
  validateRevokeDeviceCapabilityGrantFields(r);
  return new TextEncoder().encode(
    [
      TAG_REVOKE_DEVICE_CAPABILITY_GRANT,
      r.grantId,
      r.username,
      r.reason,
      r.issuedAt,
    ].join("|"),
  );
}

export function signRevokeDeviceCapabilityGrant(
  r: RevokeDeviceCapabilityGrant,
  irk: Keypair,
): Bytes {
  return ed.sign(canonicalRevokeDeviceCapabilityGrant(r), irk.privateKey);
}

export function verifyRevokeDeviceCapabilityGrant(
  r: RevokeDeviceCapabilityGrant,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRevokeDeviceCapabilityGrant(r), irkPub);
  } catch {
    return false;
  }
}
