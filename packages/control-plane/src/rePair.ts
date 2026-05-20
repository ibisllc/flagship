import {
  verifyRePairInitiate,
  verifyRePairObject,
  type RePairInitiate,
  type RePairObject,
} from "@flagship/protocol";
import type {
  PendingRePairStorage,
  PushTokenStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";
import { computeDevicesEtag } from "./usersDevices.js";

/**
 * Recovery re-pair endpoints (J.3).
 *
 * Three-step protocol:
 *   1. POST /api/users/:username/re-pair          (NEW IRK signed)
 *      Records a pending row with completes_at = now + grace.
 *   2. POST /api/users/:username/re-pair/object   (OLD IRK signed)
 *      Marks the row objected; no swap will happen.
 *   3. POST /api/users/:username/re-pair/complete (NEW IRK signed)
 *      Atomically swaps the username's IRK pubkey iff:
 *        - completes_at <= now
 *        - objected_at IS NULL
 *
 * The 24h grace lets a user whose old device is still online cancel
 * an unauthorized takeover. Membership re-attach (J.4) is a daemon-
 * side concern and lives outside this handler — it walks installed
 * apps after a swap and emits per-app phone alerts for review.
 *
 * **Concurrency guarantees (SQL CAS at every mutation):**
 *
 *   - `pending_re_pairs` has `username` as PRIMARY KEY, so two
 *     concurrent INITIATEs race-safely — one row wins, the other
 *     returns 409 ("re-pair already pending").
 *   - `usernames.swapIrkPub(...)` is a conditional UPDATE that
 *     matches on `(username, current irk_pub_hex)` and returns
 *     `meta.changes > 0`. Two concurrent COMPLETEs both call this;
 *     only one matches the precondition. The loser sees the row
 *     already moved, returns 409, and tidies up the pending row.
 *   - The Replace-device UI flow on the client also passes the
 *     observed devices ETag as `If-Match`, so any client whose
 *     view of the device list is stale gets a 412 from the next
 *     commit (A3) before even reaching the rotation. Belt + braces.
 */

/**
 * v1.1 baseline grace — kept exported so existing callers + tests
 * still reference a single canonical multi-device value. Phase 2 of
 * the v1.2 cascade lets `handleInitiateRePair` widen this to
 * `RE_PAIR_SINGLE_GRACE_MS` (7 days) when the target account is
 * single-device. The multi-device path stays at 24h on purpose:
 * a TOTP proof is required before the grace even starts, so a
 * shorter waiting period is the right trade-off for that mode.
 */
export const RE_PAIR_GRACE_MS = 24 * 60 * 60_000;

/** v1.2 — 7-day grace for single-device accounts. Wide enough that a
 * user on vacation / asleep / without their device doesn't miss the
 * objection window. See docs/v1.2-security-cascade.md §"Re-pair J.3
 * grace extension". */
export const RE_PAIR_SINGLE_GRACE_MS = 7 * 24 * 60 * 60_000;

/** v1.2 — 14-day quarantine on a freshly-admitted device's revoke-
 *  others power. The legitimate owner's existing devices remain at
 *  quarantineUntil=0 and can revoke a quarantined device immediately;
 *  the new device cannot lock out other devices until this window
 *  has elapsed. See docs/v1.2-security-cascade.md §"14-day quarantine
 *  on revoke-others power". */
export const RE_PAIR_QUARANTINE_MS = 14 * 24 * 60 * 60_000;

export interface RePairDeps {
  usernames: UsernameStorage;
  pendingRePairs: PendingRePairStorage;
  /**
   * Optional dep. When wired AND the caller supplies an `ifMatch`
   * value to handleInitiateRePair, the handler validates that the
   * supplied ETag still matches the current devices list — closes
   * the "another device registered between fetch-list and submit-
   * rotate" race. Older callers without the dep degrade to the
   * existing un-fenced behavior.
   *
   * v1.2 Phase 2 — also used by the quarantine check when the body
   * carries a `callerTokenId`: the handler reads the row and rejects
   * with 403 if `quarantineUntil > now`. New devices admitted to a
   * multi-device account can't kick out other devices for 14 days.
   */
  pushTokens?: PushTokenStorage;
  graceMs?: number;
  /**
   * v1.2 — explicit override for the single-device grace. Tests
   * inject a smaller value so the swap-after-grace assertion doesn't
   * have to wait 7 days. Production callers leave this unset and the
   * handler uses RE_PAIR_SINGLE_GRACE_MS.
   */
  singleDeviceGraceMs?: number;
  quarantineMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

export async function handleInitiateRePair(
  deps: RePairDeps,
  username: string,
  body: unknown,
  /**
   * If-Match header value the client sent over the devices ETag it
   * had cached when it initiated. Optional for backwards-compat:
   *   - absent  → behaviour unchanged (old clients still work)
   *   - present → must match the current /api/users/:u/devices ETag,
   *               else 412 Precondition Failed.
   * Both the deps.pushTokens AND this param must be set for the
   * check to fire.
   */
  ifMatch?: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const multiGraceMs = deps.graceMs ?? RE_PAIR_GRACE_MS;
  const singleGraceMs = deps.singleDeviceGraceMs ?? RE_PAIR_SINGLE_GRACE_MS;
  const quarantineMs = deps.quarantineMs ?? RE_PAIR_QUARANTINE_MS;

  const b = body as {
    request?: Record<string, unknown>;
    signature?: unknown;
    /**
     * v1.2 Phase 2 — out-of-canonical-bytes proof for multi-device
     * recovery. Not part of the signed envelope (codes are
     * ephemeral). Phase 2 only checks structural presence;
     * Phase 3 replaces this with real `verifyTotp` + atomic
     * recovery-code redemption.
     */
    totpProof?: unknown;
    /**
     * v1.2 Phase 2 — when an existing device initiates the re-pair
     * (impersonation-attempt path) it sends its own push tokenId so
     * the Worker can reject if that device is itself quarantined.
     * Absent on the genuine "lost device → new device claims back"
     * J.3 path (the recovering device has no push_tokens row yet).
     */
    callerTokenId?: unknown;
  };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.newIrkPub !== "string" ||
    typeof r.oldIrkPub !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  // Optional ETag fence: only fires when the client opted in AND
  // the deps include pushTokens. We compute the devices snapshot
  // inline (same code path as the listing handler) so a renamed
  // device or a new push token between fetch + initiate forces the
  // client to refresh.
  if (ifMatch !== undefined && deps.pushTokens) {
    const rows = await deps.pushTokens.listByUser(r.username);
    const currentEtag = await computeDevicesEtag(
      rows
        .map((p) => ({
          tokenId: p.tokenId,
          tokenPrefix: p.tokenId.slice(0, 8),
          label: p.label || `Untitled ${p.platform}`,
          platform: p.platform,
          addedAt: p.registeredAt,
          lastSeenAt: p.lastSeenAt,
        }))
        .sort((a, b) => a.addedAt - b.addedAt || a.tokenId.localeCompare(b.tokenId)),
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

  // v1.2 Phase 2 — quarantine gate on the CALLER's push_token row.
  // Only fires when the body identifies a caller (existing-device
  // initiation) AND the deps include pushTokens. The new-IRK / lost-
  // device J.3 path leaves callerTokenId unset, so the gate is a
  // no-op for genuine recovery — the gate exists only to stop a
  // freshly-admitted (quarantined) device from kicking out a
  // legitimate sibling via the re-pair endpoint.
  if (
    typeof b?.callerTokenId === "string" &&
    b.callerTokenId.length > 0 &&
    deps.pushTokens
  ) {
    const callerRow = await deps.pushTokens.get(b.callerTokenId);
    if (callerRow && (callerRow.quarantineUntil ?? 0) > now()) {
      return {
        status: 403,
        body: {
          reason: "quarantine",
          until: new Date(callerRow.quarantineUntil ?? 0).toISOString(),
          hint: "use a device you've had for longer",
        },
      };
    }
  }

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };

  // The body's oldIrkPub MUST match the current row — otherwise an
  // attacker could initiate against a stale snapshot of the IRK.
  if (userRec.irkPubHex.toLowerCase() !== r.oldIrkPub.toLowerCase()) {
    return { status: 403, body: { error: "oldIrkPub does not match the current registered IRK" } };
  }
  // No-op when the new IRK already equals the registered one — nothing to swap.
  if (userRec.irkPubHex.toLowerCase() === r.newIrkPub.toLowerCase()) {
    return { status: 400, body: { error: "newIrkPub equals current IRK" } };
  }

  // v1.2 Phase 2 — account-type discriminator drives the grace +
  // TOTP-required flags. Absent / 'demo' falls through as 'single'
  // (the demo path lives in demo_users + never gets accountType
  // stamped on usernames, but treating an accidentally-set 'demo'
  // value as 'single' is the safe default — single is the more
  // restrictive recovery mode, not less).
  const accountType = userRec.accountType ?? "single";
  const isMultiDevice = accountType === "multi";
  const graceMs = isMultiDevice ? multiGraceMs : singleGraceMs;
  const totpRequired = isMultiDevice;

  // v1.2 Phase 2 — when multi-device, the body MUST carry a
  // structurally-valid totpProof beside the signed envelope. Phase 3
  // replaces this presence check with `verifyTotp` (from the
  // `otpauth` library) + an atomic recovery-code redemption against
  // the stored argon2id-hashed codes. For now, the field's shape
  // shape gates the flow + the row is stamped `totp_proof_consumed`
  // so /complete (Phase 3) can refuse to swap unverified rows.
  let totpProofConsumed = false;
  if (totpRequired) {
    const proof = b?.totpProof as { code?: unknown; method?: unknown } | undefined;
    if (
      !proof ||
      typeof proof.code !== "string" ||
      proof.code.length === 0 ||
      (proof.method !== "totp" && proof.method !== "recovery")
    ) {
      return {
        status: 401,
        body: {
          error: "totpProof required for multi-device recovery",
          accountType: "multi",
        },
      };
    }
    // Phase 2 placeholder — structural-only validation. Phase 3
    // wires the real check.
    totpProofConsumed = true;
  }

  let newIrkPub: Uint8Array;
  let oldIrkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    newIrkPub = hexToBytes(r.newIrkPub);
    oldIrkPub = hexToBytes(r.oldIrkPub);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: RePairInitiate = {
    username: r.username,
    newIrkPub,
    oldIrkPub,
    issuedAt: r.issuedAt,
  };
  // The NEW IRK signs — that's the entity proving they hold the
  // recovered private key. .com verifies against the body's
  // newIrkPub (not the stored old one). totpProof is NOT in the
  // canonical bytes (see RePairInitiate jsdoc) so its presence /
  // absence doesn't affect signature verification.
  if (!verifyRePairInitiate(claim, sig, newIrkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const insert = await deps.pendingRePairs.initiate({
    username: r.username,
    newIrkPubHex: r.newIrkPub,
    oldIrkPubHex: r.oldIrkPub,
    initiatedAt: now(),
    completesAt: now() + graceMs,
    graceSeconds: Math.floor(graceMs / 1000),
    totpRequired,
    totpProofConsumed,
    // Bit 0 = T+0 fires immediately on initiate (the existing v1.1
    // push-on-rotation already covers this; we stamp the bit so the
    // cron scheduler doesn't re-fire it on its next sweep).
    alertsFiredBitmap: 1,
  });
  if (!insert.ok) return { status: 409, body: { error: insert.reason } };
  return {
    status: 200,
    body: {
      ok: true,
      completesAt: now() + graceMs,
      graceMs,
      // Phase 2 surfaces the account-type back to the client so the
      // mobile UI (Phase 4) can render the correct copy ("7-day
      // grace" vs "24h grace + TOTP"). Quarantine-on-admit length
      // is also returned so the new device can show the "you're
      // approved but can't kick others for N days" hint.
      accountType,
      totpRequired,
      quarantineMs,
    },
  };
}

export async function handleObjectRePair(
  deps: RePairDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.newIrkPub !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  const pending = await deps.pendingRePairs.get(r.username);
  if (!pending) return { status: 404, body: { error: "no pending re-pair" } };
  // newIrkPub in the body must match the pending row's newIrkPub —
  // defends against replaying an old objection against a fresh re-pair.
  if (pending.newIrkPubHex.toLowerCase() !== r.newIrkPub.toLowerCase()) {
    return { status: 409, body: { error: "newIrkPub does not match the pending re-pair" } };
  }

  let newIrkPub: Uint8Array;
  let sig: Uint8Array;
  let oldIrkPub: Uint8Array;
  try {
    newIrkPub = hexToBytes(r.newIrkPub);
    sig = hexToBytes(b.signature);
    oldIrkPub = hexToBytes(pending.oldIrkPubHex);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: RePairObject = { username: r.username, newIrkPub, issuedAt: r.issuedAt };
  // The OLD IRK signs (proving they still hold the displaced key).
  if (!verifyRePairObject(claim, sig, oldIrkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.pendingRePairs.object(r.username, now());
  return { status: 200, body: { ok: true, objected: true } };
}

export async function handleCompleteRePair(
  deps: RePairDeps,
  username: string,
): Promise<HandlerResponse> {
  // Public read — no signature gate. A successful complete is
  // idempotent: if we've already swapped, the pending row is gone
  // and we return 404; if we haven't, we check completion conditions
  // and either swap or return why we can't.
  const now = deps.now ?? (() => Date.now());
  const quarantineMs = deps.quarantineMs ?? RE_PAIR_QUARANTINE_MS;
  const pending = await deps.pendingRePairs.get(username);
  if (!pending) return { status: 404, body: { error: "no pending re-pair" } };
  if (pending.objectedAt) {
    return {
      status: 409,
      body: {
        error: "re-pair was objected by the old IRK",
        objectedAt: pending.objectedAt,
      },
    };
  }
  if (pending.completesAt > now()) {
    return {
      status: 425, // Too Early
      body: {
        error: "grace window has not elapsed",
        completesAt: pending.completesAt,
        secondsRemaining: Math.ceil((pending.completesAt - now()) / 1000),
      },
    };
  }
  const swapped = await deps.usernames.swapIrkPub(
    username,
    pending.oldIrkPubHex,
    pending.newIrkPubHex,
    now(),
  );
  if (!swapped) {
    // The current IRK already moved (concurrent rotation, or someone
    // else completed). Drop the row to keep state tidy.
    await deps.pendingRePairs.delete(username);
    return {
      status: 409,
      body: { error: "username's current IRK no longer matches the pending old IRK" },
    };
  }
  // v1.2 Phase 2 — stamp the 14-day quarantine on every push_token
  // row currently registered for this user. The re-paired account
  // is, by construction, in a state where the new IRK has just taken
  // over — any push_tokens that were re-registered AFTER the new IRK
  // signed the J.3 initiate envelope might be the new device's own
  // push tokens (in which case quarantining them is exactly right)
  // OR a leftover from the old device (in which case the quarantine
  // is moot — the old device's tokens will be revoked by the next
  // re-registration on the new IRK). Either way, this fail-safe
  // sets a 14-day floor.
  //
  // Pre-quarantine devices on a single-device migration path
  // (quarantineUntil=0 from the column default) stay at 0 here
  // because the docs spell out that pre-existing rows are
  // already-trusted; on a re-pair, we treat the swap event as the
  // moment the new device joins, so every active push_token gets a
  // fresh 14-day clock. Future Phase 4 UI ("Replace device") gives
  // the legitimate owner a clean affordance to lift it manually.
  if (deps.pushTokens) {
    const rows = await deps.pushTokens.listByUser(username);
    const until = now() + quarantineMs;
    for (const row of rows) {
      await deps.pushTokens.setQuarantineUntil(row.tokenId, until);
    }
  }
  await deps.pendingRePairs.delete(username);
  return {
    status: 200,
    body: {
      ok: true,
      newIrkPub: pending.newIrkPubHex,
      swappedAt: now(),
      quarantineUntil: now() + quarantineMs,
    },
  };
}

export async function handleGetRePair(
  deps: RePairDeps,
  username: string,
): Promise<HandlerResponse> {
  const pending = await deps.pendingRePairs.get(username);
  if (!pending) return { status: 200, body: { pending: null } };
  return {
    status: 200,
    body: {
      pending: {
        newIrkPub: pending.newIrkPubHex,
        oldIrkPub: pending.oldIrkPubHex,
        initiatedAt: pending.initiatedAt,
        completesAt: pending.completesAt,
        objectedAt: pending.objectedAt ?? null,
      },
    },
  };
}
