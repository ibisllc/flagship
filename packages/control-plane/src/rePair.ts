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

export const RE_PAIR_GRACE_MS = 24 * 60 * 60_000;

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
   */
  pushTokens?: PushTokenStorage;
  graceMs?: number;
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
  const graceMs = deps.graceMs ?? RE_PAIR_GRACE_MS;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
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
  // newIrkPub (not the stored old one).
  if (!verifyRePairInitiate(claim, sig, newIrkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const insert = await deps.pendingRePairs.initiate({
    username: r.username,
    newIrkPubHex: r.newIrkPub,
    oldIrkPubHex: r.oldIrkPub,
    initiatedAt: now(),
    completesAt: now() + graceMs,
  });
  if (!insert.ok) return { status: 409, body: { error: insert.reason } };
  return {
    status: 200,
    body: {
      ok: true,
      completesAt: now() + graceMs,
      graceMs,
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
  await deps.pendingRePairs.delete(username);
  return {
    status: 200,
    body: {
      ok: true,
      newIrkPub: pending.newIrkPubHex,
      swappedAt: now(),
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
