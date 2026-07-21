// POST /api/users/:username/wipe-restart
//
// v1.1 "nuclear option". The user has the OLD IRK and a recovered UMK
// but elects to bypass the 24h re-pair grace and immediately rotate:
//
//   - IRK pubkey on `users` (CAS on old value)
//   - WebAuthn recovery envelope (drop old, write new credentialId +
//     new wrappedUmkB64)
//   - audit row with kind="wipe-restart"
//
// All four writes happen via the storage layer's helpers so the
// concurrent-rotation race is resolved at the SQL layer (the CAS on
// `users.irk_pub_hex` fails fast). A second-tier defence is the
// optional `If-Match` ETag the client passes — same shape as the
// re-pair handler.
//
// Rate limit: 1 per hour per username. Implemented by reading the
// most-recent `wipe-restart` audit row; if `now - postedAt < 3600s`,
// return 429. This protects against a stolen recovery passkey being
// used to spam-rotate the account out from under the user before
// they can intervene from another device.
//
// Idempotency: the client supplies a 16-byte random `idempotencyKey`
// (32 hex chars). The Worker dedupes within a 5-minute window keyed
// by (username, idempotencyKey) — the first call's response is
// replayed verbatim. This is for "client got a timeout on the POST"
// flows — without it, a retry would double-rotate (a no-op on .com,
// because of the CAS, but the user would get a confusing 409).

import {
  verifyWipeRestart,
  type WipeRestart,
} from "@flagship/protocol";
import type {
  AccountDirectoryKeyGrantStorage,
  AccountProfileStorage,
  AuditEventStorage,
  DeviceCapabilityGrantStorage,
  DeviceManagedProfileStorage,
  DeviceSelfProfileStorage,
  PushTokenStorage,
  UsernameStorage,
  WebauthnRecoveryStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import { recordAuditEvent } from "./auditEvents.js";
import { computeDevicesEtag } from "./deviceDirectoryEtag.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface WipeRestartDeps {
  usernames: UsernameStorage;
  webauthnRecovery: WebauthnRecoveryStorage;
  auditEvents: AuditEventStorage;
  /** Optional. Required only for the ETag-fence path. */
  pushTokens?: PushTokenStorage;
  /**
   * v2 — when wired, wipe-restart ALSO revokes every active
   * DeviceCapabilityGrant on the username. This matches the
   * "nuclear option" framing: the old IRK is gone, every grant
   * signed under it is now meaningless (its signature won't verify
   * against the new cloud-root anyway), so the right safety move
   * is to mark them revoked atomically with the IRK rotation. The
   * graceful-vs-strict policy from W6 does NOT apply to wipe-restart
   * — wipe-restart IS the nuclear path by definition.
   *
   * Deploy-safe degrade: when the dep isn't wired the behavior
   * matches v1.1 (no grant accounting).
   */
  deviceCapabilityGrants?: DeviceCapabilityGrantStorage;
  /**
   * The encrypted account/device names are sealed under keys DERIVED FROM THE
   * UMK. Wipe-restart installs a NEW UMK, so every stored ciphertext becomes
   * permanently undecryptable the instant the rotation lands — no client will
   * ever read it again. Leaving it behind makes names fall back to opaque
   * forever while dead ciphertext accumulates against the account.
   *
   * When wired, wipe-restart deletes those records so the account comes back
   * cleanly unnamed and can be renamed under the new key. Same deploy-safe
   * degrade as the grant stores: absent dep ⇒ v1.1 behavior.
   */
  accountProfiles?: AccountProfileStorage;
  deviceSelfProfiles?: DeviceSelfProfileStorage;
  deviceManagedProfiles?: DeviceManagedProfileStorage;
  accountDirectoryKeyGrants?: AccountDirectoryKeyGrantStorage;
  maxAgeMs?: number;
  rateLimitMs?: number;
  idempotencyWindowMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;
const DEFAULT_RATE_LIMIT = 60 * 60_000;       // 1 per hour
const DEFAULT_IDEMPOTENCY_WINDOW = 5 * 60_000; // 5 minutes

/** In-memory idempotency cache. Keyed by `username:idempotencyKey`.
 *  Cleared by an internal GC sweep on every call so stale entries
 *  don't pile up across the Worker's lifetime. The store lives at
 *  module scope so independent invocations within the same isolate
 *  share it, which is what we want — duplicate POSTs from the same
 *  client within the window must collapse to the same response. */
interface IdempotentEntry {
  expiresAt: number;
  response: HandlerResponseWithHeaders;
}
const idempotencyCache = new Map<string, IdempotentEntry>();

function gcIdempotency(now: number): void {
  for (const [k, v] of idempotencyCache) {
    if (v.expiresAt <= now) idempotencyCache.delete(k);
  }
}

function base64DecodeBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  let s = "";
  for (const x of h) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function handleWipeRestart(
  deps: WipeRestartDeps,
  username: string,
  body: unknown,
  /** Optional `If-Match` ETag — when present, must match the current
   *  devices ETag; else 412. Pairs with the same fence used by the
   *  re-pair handler (A3). */
  ifMatch?: string,
): Promise<HandlerResponseWithHeaders> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const rateLimitMs = deps.rateLimitMs ?? DEFAULT_RATE_LIMIT;
  const idempotencyWindowMs = deps.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW;
  const t = now();
  gcIdempotency(t);

  const b = body as {
    request?: Record<string, unknown>;
    signature?: unknown;
    idempotencyKey?: unknown;
  };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.oldIrkPub !== "string" ||
    typeof r.newIrkPub !== "string" ||
    typeof r.newCredentialId !== "string" ||
    typeof r.newWrappedUmk !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string" ||
    typeof b?.idempotencyKey !== "string"
  ) {
    return malformed("malformed body");
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return forbidden("username / url mismatch");
  }
  if (!/^[0-9a-fA-F]{32}$/.test(b.idempotencyKey)) {
    return malformed("idempotencyKey must be 32 hex chars");
  }
  if (!/^[0-9a-fA-F]{16,512}$/.test(r.newCredentialId)) {
    return malformed("newCredentialId must be 8-256 hex bytes");
  }
  if (Math.abs(t - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  // Idempotency replay — same key in the window returns the prior response.
  const idemKey = `${r.username.toLowerCase()}:${b.idempotencyKey.toLowerCase()}`;
  const prior = idempotencyCache.get(idemKey);
  if (prior) return prior.response;

  // Optional ETag fence.
  if (ifMatch !== undefined && deps.pushTokens) {
    const rows = await deps.pushTokens.listByUser(r.username);
    const currentEtag = await computeDevicesEtag(
      rows
        .map((p) => ({
          deviceId: p.deviceId,
          platform: p.platform,
          addedAt: p.registeredAt,
        }))
        .sort((a, b) => a.addedAt - b.addedAt || a.deviceId.localeCompare(b.deviceId)),
    );
    if (currentEtag !== ifMatch) {
      return {
        status: 412,
        body: {
          error: "device list has shifted since you fetched it; refresh and retry",
          currentEtag,
        },
      };
    }
  }

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("unknown username");
  if (userRec.irkPubHex.toLowerCase() !== r.oldIrkPub.toLowerCase()) {
    return forbidden("oldIrkPub does not match the current registered IRK");
  }
  if (userRec.irkPubHex.toLowerCase() === r.newIrkPub.toLowerCase()) {
    return malformed("newIrkPub equals current IRK");
  }

  // Decode wrapped UMK (base64 → bytes) so we can hash + size-check.
  const wrappedBytes = base64DecodeBytes(r.newWrappedUmk);
  if (!wrappedBytes) return malformed("newWrappedUmk must be valid base64");
  if (wrappedBytes.length === 0 || wrappedBytes.length > 16 * 1024) {
    return malformed("newWrappedUmk must be 1..16384 bytes");
  }
  const wrappedHashHex = await sha256Hex(wrappedBytes);

  // Rate limit: scan the latest audit page for a recent wipe-restart row.
  // The audit list is descending by seq so the first matching row is the
  // freshest. We pull a small window (10) for cheap lookup.
  const recent = await deps.auditEvents.list(r.username.toLowerCase(), 0, 10);
  const lastWipe = recent.find((e) => e.eventKind === "wipe-restart");
  if (lastWipe && t - lastWipe.postedAt < rateLimitMs) {
    return {
      status: 429,
      body: {
        error: "wipe-restart rate-limited",
        retryAfterMs: rateLimitMs - (t - lastWipe.postedAt),
      },
    };
  }

  // Verify the OLD-IRK signature over the canonical bytes.
  let oldIrkPub: Uint8Array;
  let newIrkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    oldIrkPub = hexToBytes(r.oldIrkPub);
    newIrkPub = hexToBytes(r.newIrkPub);
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: WipeRestart = {
    username: r.username,
    oldIrkPub,
    newIrkPub,
    newCredentialIdHex: r.newCredentialId,
    newWrappedUmkHashHex: wrappedHashHex,
    issuedAt: r.issuedAt,
  };
  if (!verifyWipeRestart(claim, sig, oldIrkPub)) {
    return forbidden("invalid signature");
  }

  // Mutation sequence. We do these as four ordered writes rather than
  // a true single transaction because D1's transaction primitive
  // doesn't span storage adapters; the CAS on swapIrkPub is the
  // atomicity barrier — if it fails, neither the envelope nor the
  // audit row gets written.
  //
  // 1. CAS-swap the IRK.
  const swapped = await deps.usernames.swapIrkPub(
    r.username,
    r.oldIrkPub,
    r.newIrkPub,
    t,
  );
  if (!swapped) {
    return conflict("username's current IRK no longer matches; a concurrent rotation won");
  }
  // 2. Replace the recovery envelope. upsert() handles drop-old + write-new.
  await deps.webauthnRecovery.upsert({
    username: r.username,
    credentialIdHex: r.newCredentialId,
    wrappedUmkB64: r.newWrappedUmk,
    irkPubHex: r.newIrkPub,
    createdAt: t,
    updatedAt: t,
  });
  // 2b. v2 — revoke every active DeviceCapabilityGrant on the cloud.
  //     Their signatures (made by the OLD IRK that just got rotated
  //     out) no longer verify under the cloud root, so leaving them
  //     active would just produce confusing "invalid grant" errors
  //     on the family-device side. Explicit revocation is cleaner.
  //     Best-effort: a failure here MUST NOT crash the wipe-restart
  //     flow (the IRK has already rotated; the audit row needs to
  //     land regardless). Each grant gets its own revoke call so a
  //     transient storage hiccup doesn't fail-stop the loop.
  let revokedGrantIds: string[] = [];
  if (deps.deviceCapabilityGrants) {
    try {
      const grants = await deps.deviceCapabilityGrants.listForUser(r.username);
      for (const g of grants) {
        if (g.revokedAt !== null) continue;
        try {
          await deps.deviceCapabilityGrants.revoke(g.grantId, t);
          revokedGrantIds.push(g.grantId);
        } catch {
          // swallow — the grant's old-IRK signature is dead anyway.
        }
      }
    } catch {
      // Same. The cloud is still wiped at the IRK level; family
      // devices will be forced to re-onboard.
    }
  }

  // 2b. Drop the UMK-derived encrypted names. The new UMK derives different
  //     keys, so the stored ciphertext is cryptographically dead — keeping it
  //     would only guarantee every name renders opaque forever. Best-effort,
  //     exactly like the grant revocation above: the IRK has already rotated
  //     and the audit row must land regardless.
  let clearedProfiles = 0;
  for (const store of [
    deps.accountProfiles,
    deps.deviceSelfProfiles,
    deps.deviceManagedProfiles,
    // Directory-key grants seal the OLD directory key to a device; after the
    // rotation they hand out a key that decrypts nothing.
    deps.accountDirectoryKeyGrants,
  ]) {
    if (!store) continue;
    try {
      clearedProfiles += await store.purgeForAccount(r.username);
    } catch {
      // Same rationale as the grant loop: never fail-stop the rotation.
    }
  }

  // 3. Append the audit row.
  const audit = await recordAuditEvent(
    { auditEvents: deps.auditEvents },
    {
      username: r.username,
      eventKind: "wipe-restart",
      detail: `Wiped & restarted account from ${r.newIrkPub.slice(0, 8)}…`,
      devicePrefix: r.newIrkPub.slice(0, 8),
      postedAt: t,
    },
  );

  // 4. Compute a fresh ETag the client can pin its next call on.
  //    Devices list is unchanged on the .com side (push-tokens
  //    survive — they're a separate trust dimension and the client
  //    is expected to fan out a peer-detection signal to retire
  //    orphans), so the ETag computation reads what's in the table now.
  let freshEtag: string | undefined;
  if (deps.pushTokens) {
    const rows = await deps.pushTokens.listByUser(r.username);
    freshEtag = await computeDevicesEtag(
      rows
        .map((p) => ({
          deviceId: p.deviceId,
          platform: p.platform,
          addedAt: p.registeredAt,
        }))
        .sort((a, b) => a.addedAt - b.addedAt || a.deviceId.localeCompare(b.deviceId)),
    );
  }

  const response: HandlerResponseWithHeaders = ok(
    {
      ok: true,
      auditSeq: audit.seq,
      newIrkPub: r.newIrkPub,
      // v2 — surfaces every grant we just revoked so the client UI
      // can render "These family devices need to re-onboard" with
      // concrete counts. Empty array on legacy / no-grants accounts.
      revokedGrantIds,
      ...(freshEtag ? { etag: freshEtag } : {}),
    },
    freshEtag ? { etag: freshEtag, "cache-control": "private, no-cache" } : undefined,
  );
  idempotencyCache.set(idemKey, {
    expiresAt: t + idempotencyWindowMs,
    response,
  });
  return response;
}

/** Test-only hook to clear the module-scope idempotency cache between
 *  cases. Not exported through the package barrel. */
export function _resetWipeRestartIdempotencyForTests(): void {
  idempotencyCache.clear();
}
