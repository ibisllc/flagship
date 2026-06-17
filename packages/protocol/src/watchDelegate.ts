/**
 * Watch-delegate-key domain — the opt-in, IRK-attested boot-approval
 * delegate key (quick-approve from the Apple Watch / Wear) + its revoke.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; the scope list,
 * tags, field order, and validators are unchanged, so canonical bytes and
 * signatures remain byte-identical.
 */
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// WatchDelegateKey — opt-in quick-approve from the Watch
// (design: docs/watch-delegate-key-design.md)
//
// A SEPARATE, IRK-attested signing key that lets the owner approve a
// server BOOT from the Apple Watch / Wear without a fresh phone biometric
// prompt. The delegate key lives in the phone's secure element under a
// laxer access policy (.userPresence, NOT .biometryCurrentSet), so a
// Watch-driven sign succeeds while the phone is merely unlocked — the IRK
// itself stays fully biometric-gated for every destructive operation.
//
// SCOPED to boot-approval ONLY: the cloud + the box's
// boot.flagshipserver.com handler accept a delegate signature for a boot
// approval and NOTHING else (revoke / wipe / replace stay IRK-only), so a
// compromised delegate key has the smallest possible blast radius. The
// envelope is IRK-signed (tying the delegate's authority back to the
// user's master identity), short-TTL (7d, renewable), and independently
// revocable via RevokeWatchDelegate.
//
// Shape deliberately parallels DeviceCapabilityGrant above: '|'-joined
// positional canonical bytes, every field rejects '|' + control bytes,
// scopes sorted by a fixed index list, and a SHA-256-hex id (the D1 key +
// revocation handle).
// ──────────────────────────────────────────────────────────────────────

/**
 * What a watch delegate may do. v1 is boot-approval ONLY — the type leaves
 * room to widen later, but the cloud + box MUST reject any delegate-signed
 * payload outside this set.
 */
export type DelegateScope = "boot-approval";

export const DELEGATE_SCOPES: readonly DelegateScope[] = ["boot-approval"] as const;

const DELEGATE_SCOPE_INDEX: ReadonlyMap<DelegateScope, number> = new Map(
  DELEGATE_SCOPES.map((s, i) => [s, i] as const),
);

export interface WatchDelegateKey {
  /** Fresh v4 UUID; consumers reject duplicates within the active window. */
  grantId: string;
  /** Username at issuance time. */
  username: string;
  /** The watch-delegate's Ed25519 pubkey (32 bytes) — held in the phone SE
   *  under .userPresence and published to the watch over WCSession. */
  delegatePubKey: Bytes;
  /** Authorized scopes — MUST be ["boot-approval"] for v1. */
  scopes: DelegateScope[];
  /** ms since epoch. */
  issuedAt: number;
  /** ms since epoch; SHOULD be issuedAt + 7*24*3600*1000 (7d) by convention. */
  expiresAt: number;
}

const TAG_WATCH_DELEGATE_KEY = "flagship/watch-delegate-key/v1";

function validateWatchDelegateKeyFields(g: WatchDelegateKey): void {
  const fields: Array<[string, string]> = [
    ["grantId", g.grantId],
    ["username", g.username],
  ];
  for (const [name, value] of fields) {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c)
        throw new Error(`WatchDelegateKey field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) {
        throw new Error(
          `WatchDelegateKey field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
        );
      }
    }
  }
  if (g.expiresAt <= g.issuedAt) {
    throw new Error("WatchDelegateKey: expiresAt must be strictly after issuedAt");
  }
  if (g.scopes.length === 0) {
    throw new Error("WatchDelegateKey: scopes must have at least one entry");
  }
  const seen = new Set<DelegateScope>();
  for (const s of g.scopes) {
    if (!DELEGATE_SCOPE_INDEX.has(s)) {
      throw new Error(`WatchDelegateKey: unknown scope "${String(s)}"`);
    }
    if (seen.has(s)) {
      throw new Error(`WatchDelegateKey: duplicate scope "${s}"`);
    }
    seen.add(s);
  }
  if (g.delegatePubKey.length !== 32) {
    throw new Error(
      `WatchDelegateKey: delegatePubKey must be 32 bytes, got ${g.delegatePubKey.length}`,
    );
  }
}

function canonicalWatchDelegateKey(g: WatchDelegateKey): Bytes {
  validateWatchDelegateKeyFields(g);
  const sortedScopes = [...g.scopes]
    .sort((a, b) => (DELEGATE_SCOPE_INDEX.get(a) ?? 0) - (DELEGATE_SCOPE_INDEX.get(b) ?? 0))
    .join(",");
  return new TextEncoder().encode(
    [
      TAG_WATCH_DELEGATE_KEY,
      g.grantId,
      g.username,
      hex(g.delegatePubKey),
      sortedScopes,
      g.issuedAt,
      g.expiresAt,
    ].join("|"),
  );
}

export function signWatchDelegateKey(g: WatchDelegateKey, irk: Keypair): Bytes {
  return ed.sign(canonicalWatchDelegateKey(g), irk.privateKey);
}

export function verifyWatchDelegateKey(g: WatchDelegateKey, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalWatchDelegateKey(g), irkPub);
  } catch {
    return false;
  }
}

/**
 * SHA-256 hex of the canonical bytes — a content fingerprint of the envelope.
 * NOTE: this is NOT the storage key. The D1 primary key (and revocation
 * handle) is the envelope's own `grantId` (a fresh v4 UUID), mirroring
 * device_capability_grants. This helper exists for integrity checks / dedup.
 */
export async function watchDelegateKeyId(g: WatchDelegateKey): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", canonicalWatchDelegateKey(g));
  return hex(new Uint8Array(digest));
}

/**
 * Pure scope-membership check. Consumers MUST ALSO verifyWatchDelegateKey,
 * confirm now < expiresAt, and confirm the delegate is not revoked — this is
 * the permission half ONLY. Boot approvals check scope "boot-approval".
 */
export function watchDelegateAuthorizesScope(g: WatchDelegateKey, scope: DelegateScope): boolean {
  return g.scopes.includes(scope);
}

export interface RevokeWatchDelegate {
  /** grantId of the WatchDelegateKey being revoked. */
  grantId: string;
  /** Username at issuance time of the parent grant. */
  username: string;
  /** ms since epoch. */
  issuedAt: number;
}

const TAG_REVOKE_WATCH_DELEGATE = "flagship/revoke-watch-delegate/v1";

function validateRevokeWatchDelegateFields(r: RevokeWatchDelegate): void {
  const fields: Array<[string, string]> = [
    ["grantId", r.grantId],
    ["username", r.username],
  ];
  for (const [name, value] of fields) {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 0x7c)
        throw new Error(`RevokeWatchDelegate field "${name}" contains separator '|'`);
      if (c <= 0x1f || c === 0x7f) {
        throw new Error(
          `RevokeWatchDelegate field "${name}" contains control char 0x${c.toString(16)} at index ${i}`,
        );
      }
    }
  }
}

function canonicalRevokeWatchDelegate(r: RevokeWatchDelegate): Bytes {
  validateRevokeWatchDelegateFields(r);
  return new TextEncoder().encode(
    [TAG_REVOKE_WATCH_DELEGATE, r.grantId, r.username, r.issuedAt].join("|"),
  );
}

export function signRevokeWatchDelegate(r: RevokeWatchDelegate, irk: Keypair): Bytes {
  return ed.sign(canonicalRevokeWatchDelegate(r), irk.privateKey);
}

export function verifyRevokeWatchDelegate(
  r: RevokeWatchDelegate,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalRevokeWatchDelegate(r), irkPub);
  } catch {
    return false;
  }
}
