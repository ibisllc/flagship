/**
 * Unified live-update channel — a single foreground long-poll ("hanging GET")
 * that delivers a user's pod / install / box-request state and returns the
 * moment anything meaningful changes. It collapses the many client pollers
 * (registered pods, pending orders, the Box Request Inbox) into one held
 * request.
 *
 *   GET /api/users/<username>/stream?cursor=<hex>
 *
 * The payload is a SUPERSET of `/pods` (the same `buildPodInventory`
 * projection) plus a `cursor` — a content hash of the user's *meaningful*
 * state. The client passes the last cursor it saw; if nothing changed the
 * request HOLDS (re-checking every `checkIntervalMs`, up to `maxHoldMs`) and
 * returns as soon as the cursor differs. On timeout with no change it returns
 * the current snapshot anyway (the client re-polls). It NEVER errors on
 * timeout — always 200 with the snapshot.
 *
 * Unauthenticated, exactly like `/pods` (keyed only on `:u`). Additive: `/pods`
 * stays the fallback for clients that can't hold a request.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "./hex.js";
import { ok, type HandlerResponseWithHeaders } from "./types.js";
import {
  buildPodInventory,
  type PodInventory,
  type PodInventoryDeps,
} from "./podInventory.js";

/** Default hold window: re-check the inventory at this cadence while holding. */
export const DEFAULT_STREAM_CHECK_INTERVAL_MS = 2_000;
/** Default hold ceiling: return the current snapshot after at most this long. */
export const DEFAULT_STREAM_MAX_HOLD_MS = 25_000;

/**
 * Compute the change-detection cursor for a pod inventory: a sha256 hex over a
 * CANONICAL projection of every field whose change should wake the stream —
 * and ONLY those. `fetchedAt` (and any other per-fetch timestamp) is
 * deliberately EXCLUDED, or the cursor would differ on every poll and the hold
 * loop would never hold.
 *
 * Everything is sorted deterministically before hashing so two identical
 * states always produce the same cursor regardless of storage iteration order.
 */
export function computePodInventoryCursor(inv: PodInventory): string {
  const pods = inv.pods
    .map((p) => {
      const apps = [...p.appsServed].sort().join(",");
      const reqs = [...p.pendingRequests]
        .map((r) => `${r.id}:${r.type}:${r.expiresAt}`)
        .sort()
        .join(",");
      return [
        p.serverDomain,
        p.lastReported ?? "",
        p.currentCert?.sha256 ?? "",
        p.currentCert?.validUntil ?? "",
        apps,
        reqs,
      ].join("|");
    })
    .sort();

  const pending = inv.pending
    .map((o) => [o.orderRef, o.phase ?? "", o.createdAt].join("|"))
    .sort();

  const projection = JSON.stringify({
    username: inv.username,
    pods,
    pending,
  });

  return bytesToHex(sha256(new TextEncoder().encode(`flagship/pod-cursor/v1|${projection}`)));
}

export interface UserStreamDeps extends PodInventoryDeps {
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep — tests pass a fake that advances a virtual clock and
   *  lets them mutate the underlying store between ticks. Defaults to a real
   *  setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Re-check cadence while holding. */
  checkIntervalMs?: number;
  /** Maximum hold duration before returning the current snapshot anyway. */
  maxHoldMs?: number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StreamPayload extends PodInventory {
  cursor: string;
}

/**
 * The hanging-GET handler. Returns `{ cursor, username, pods, pending,
 * fetchedAt }`.
 *
 * - No `cursor` (first connect) OR a `cursor` that already differs from the
 *   current state ⇒ return IMMEDIATELY.
 * - A `cursor` that EQUALS the current cursor (no change) ⇒ HOLD: sleep
 *   `checkIntervalMs`, rebuild, re-check; return as soon as the cursor differs,
 *   or after `maxHoldMs` return the (still-current) snapshot.
 *
 * Always 200; never errors on timeout.
 */
export async function handleUserStream(
  deps: UserStreamDeps,
  username: string,
  cursor: string | null | undefined,
): Promise<HandlerResponseWithHeaders<StreamPayload>> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_STREAM_CHECK_INTERVAL_MS;
  const maxHoldMs = deps.maxHoldMs ?? DEFAULT_STREAM_MAX_HOLD_MS;

  let inventory = await buildPodInventory(deps, username);
  let current = computePodInventoryCursor(inventory);

  // First connect, or the client's cursor is already stale ⇒ answer now.
  if (!cursor || cursor !== current) {
    return ok({ cursor: current, ...inventory });
  }

  // Cursor matches ⇒ hold until it changes or we hit the ceiling. Bound by a
  // wall-clock deadline (not a fixed tick count) so a slow rebuild can't make
  // the hold overrun maxHoldMs.
  const deadline = now() + maxHoldMs;
  while (now() < deadline) {
    await sleep(checkIntervalMs);
    inventory = await buildPodInventory(deps, username);
    current = computePodInventoryCursor(inventory);
    if (current !== cursor) break;
  }

  return ok({ cursor: current, ...inventory });
}
