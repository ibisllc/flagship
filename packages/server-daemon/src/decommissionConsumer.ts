import { readFile, writeFile } from "node:fs/promises";
import {
  verifyServerDecommission,
  type DiskDisposition,
  type ServerDecommission,
} from "@flagship/protocol";

/**
 * Box-side consumer of the graceful-decommission order
 * (docs/server-replacement-graceful-decommission.md §10 + §9).
 *
 * When the owner replaces a server, `.com` stores an owner-IRK-signed
 * `ServerDecommission` order in the eviction lane (one per retired STK for a
 * `podCanonical`) and revokes the retiring instance's routing entitlement. This
 * module is the retiring box's consumer: it polls its own order on the daemon
 * heartbeat cadence, RE-VERIFIES it under the config-pinned owner IRK (`.com` is
 * never a trust anchor — invariants I1–I4), checks the order names ITS OWN STK
 * (I2 — replay-safe), and then runs the whole closeout:
 *   - optional final peer-backup flush at `backupEpoch` (§9 barrier);
 *   - release routing (drop the tunnel);
 *   - apply the signed `diskDisposition` (§6a):
 *       keep                → lock + power off (no wipe)
 *       wipe-now            → wipe content + key-scrub, then lock + power off
 *       wipe-after-handoff  → go idle; on the successor-restored confirm, wipe +
 *                             power off; on TIMEOUT, power off WITHOUT wiping (the
 *                             FAIL-SAFE: the data survives as the fallback).
 *
 * Mirrors `selfDeleteConsumer` (the proven shape) but the action is a power-off,
 * not always a wipe; the wipe is a SIGNED parameter, not the unconditional
 * account-death content-wipe.
 *
 * Safety (the part that matters):
 *   - We act ONLY when the signature verifies under OUR owner IRK AND the order
 *     names OUR STK. A forged / wrong-account / wrong-STK / junk order is ignored
 *     (best-effort — NEVER a crash, NEVER an act-on-unverified-input).
 *   - `wipe-after-handoff`'s timeout fails SAFE (power off, keep the data).
 *   - Idempotent: a local marker (`/var/flagship/decommissioned`) records that the
 *     closeout ran, so a re-poll (or a reboot mid-closeout) never re-fires.
 *   - Every side-effect (fetch, backup flush, routing release, wipe, power, the
 *     handoff-confirm poll, the marker store, the clock) is INJECTED so the whole
 *     verify + STK-gate + disposition logic is unit-testable without a real box.
 */

const HEX = /^[0-9a-f]+$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isDiskDisposition(v: unknown): v is DiskDisposition {
  return v === "keep" || v === "wipe-after-handoff" || v === "wipe-now";
}

/**
 * Decode the `orderJson` carrier into a VERIFIED `ServerDecommission`. Throws
 * with a specific reason on any defect — the caller maps that to "ignore, don't
 * act". Verifies, in order: the JSON has the expected fields; the signature is
 * valid hex; the signature verifies under the OWNER IRK (never anything `.com`
 * asserts). It does NOT check the STK match — that is the caller's I2 gate, which
 * needs THIS box's STK (decode just yields the trustworthy order).
 */
export function decodeAndVerifyDecommissionOrder(args: {
  orderJson: string;
  orderSignatureHex: string;
  ownerIrkPub: Uint8Array;
}): ServerDecommission {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.orderJson);
  } catch (e) {
    throw new Error(`decommission order is not valid JSON: ${(e as Error).message}`);
  }
  const p = parsed as Partial<ServerDecommission>;
  if (
    typeof p.podCanonical !== "string" ||
    typeof p.retiredStkPubHex !== "string" ||
    typeof p.finalBackup !== "boolean" ||
    !isDiskDisposition(p.diskDisposition) ||
    typeof p.backupEpoch !== "number" ||
    typeof p.nonce !== "string" ||
    typeof p.issuedAt !== "number"
  ) {
    throw new Error("decommission order is missing required fields");
  }
  const sigHex = args.orderSignatureHex.toLowerCase();
  if (!HEX.test(sigHex) || sigHex.length % 2 !== 0) {
    throw new Error("decommission signature is not valid hex");
  }
  let sig: Uint8Array;
  try {
    sig = hexToBytes(sigHex);
  } catch {
    throw new Error("decommission signature is not valid hex");
  }
  const order: ServerDecommission = {
    podCanonical: p.podCanonical,
    retiredStkPubHex: p.retiredStkPubHex,
    finalBackup: p.finalBackup,
    diskDisposition: p.diskDisposition,
    backupEpoch: p.backupEpoch,
    nonce: p.nonce,
    issuedAt: p.issuedAt,
  };
  if (!verifyServerDecommission(order, sig, args.ownerIrkPub)) {
    throw new Error("decommission signature does not verify under the owner IRK");
  }
  return order;
}

/** Records that the decommission closeout already ran, so it never re-fires. */
export interface DecommissionMarkerStore {
  has(): Promise<boolean>;
  mark(order: ServerDecommission): Promise<void>;
}

/** Default file-backed marker (a small JSON sentinel, default `/var/flagship/decommissioned`). */
export function fileMarkerStore(markerPath = "/var/flagship/decommissioned"): DecommissionMarkerStore {
  return {
    async has() {
      try {
        await readFile(markerPath, "utf-8");
        return true;
      } catch {
        return false;
      }
    },
    async mark(order) {
      await writeFile(
        markerPath,
        JSON.stringify({
          decommissionedAt: order.issuedAt,
          retiredStkPubHex: order.retiredStkPubHex,
          diskDisposition: order.diskDisposition,
        }),
        { mode: 0o600 },
      );
    },
  };
}

export interface RunDecommissionOptions {
  /** This box's canonical FQDN (`<server>.<user>.flagship.services`). */
  serverDomain: string;
  /** This box's STK pubkey (hex) — the order must name it (I2). */
  myStkHex: string;
  /** The owner IRK pubkey (config-pinned) — the order is verified against THIS. */
  ownerIrkPub: Uint8Array;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;

  /**
   * Final peer-backup flush at the order's `backupEpoch` (only when
   * `finalBackup` is true). Injected so the consumer is testable; the daemon
   * wires the real BackupLoop flush. Best-effort.
   */
  backupFlush: (epoch: number) => Promise<void>;
  /**
   * Drop the tunnel / stop serving (release routing). Injected; the daemon wires
   * `runtime.close()`. Best-effort — a failure here must not block the power-off.
   */
  releaseRouting: () => Promise<void>;
  /**
   * The destructive content wipe (+ key-scrub). Injected; the daemon wires
   * `realWipeContent`. Only invoked for `wipe-now` / a confirmed
   * `wipe-after-handoff`. Best-effort.
   */
  wipeContent: () => Promise<void>;
  /**
   * Lock (suppress auto-unlock) + power off. Injected; the daemon wires
   * `executeLockAndPower`. Every disposition converges here.
   */
  lockAndPower: () => Promise<void>;
  /**
   * `wipe-after-handoff` ONLY: wait (bounded) for `.com` to confirm the
   * replacement restored successfully (a successor `new_acked` / a later epoch in
   * the eviction chain). Resolves `true` if confirmed within the window, `false`
   * on timeout. Injected (the poll + the timeout) so the fail-safe is testable.
   */
  awaitHandoffConfirm?: () => Promise<boolean>;

  /** Idempotency marker store (default file-backed at `/var/flagship/decommissioned`). */
  markerStore: DecommissionMarkerStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (m: string) => void;
}

export type DecommissionOutcome =
  | {
      decommissioned: false;
      reason: "already-done" | "no-order" | "rejected" | "wrong-stk" | "error";
    }
  | { decommissioned: true; disposition: DiskDisposition; wiped: boolean };

/**
 * One poll: claim this box's decommission order, verify it (I1), gate on the STK
 * (I2), and on success run the whole closeout. Never throws — returns an outcome.
 */
export async function runDecommissionConsumer(
  opts: RunDecommissionOptions,
): Promise<DecommissionOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});

  // 1. Idempotency: if a prior closeout already ran, never do it again.
  try {
    if (await opts.markerStore.has()) {
      return { decommissioned: false, reason: "already-done" };
    }
  } catch {
    /* a missing/unreadable marker is treated as "not yet decommissioned" */
  }

  // 2. Fetch this box's own order (keyed by OUR STK).
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url =
    `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/decommission` +
    `?stk=${encodeURIComponent(opts.myStkHex.toLowerCase())}`;

  let orderJson: string | undefined;
  let orderSignatureHex: string | undefined;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { decommissioned: false, reason: "no-order" };
    if (!res.ok) {
      log(`[decommission] GET ${res.status}; ignoring`);
      return { decommissioned: false, reason: "error" };
    }
    const body = (await res.json()) as { orderJson?: string; orderSignatureHex?: string };
    orderJson = body?.orderJson;
    orderSignatureHex = body?.orderSignatureHex;
  } catch (e) {
    log(`[decommission] GET failed: ${(e as Error).message}`);
    return { decommissioned: false, reason: "error" };
  }

  if (typeof orderJson !== "string" || typeof orderSignatureHex !== "string") {
    log("[decommission] order missing carrier fields; ignoring");
    return { decommissioned: false, reason: "rejected" };
  }

  // 3. Decode + VERIFY under our config-pinned owner IRK (I1). Bad sig / junk /
  //    wrong-account ⇒ reject, never act.
  let order: ServerDecommission;
  try {
    order = decodeAndVerifyDecommissionOrder({
      orderJson,
      orderSignatureHex,
      ownerIrkPub: opts.ownerIrkPub,
    });
  } catch (e) {
    log(`[decommission] order rejected: ${(e as Error).message}`);
    return { decommissioned: false, reason: "rejected" };
  }

  // 4. STK gate (I2): proceed ONLY if the order names THIS instance. A different
  //    STK ⇒ this order is for a predecessor, not me ⇒ ignore (a replayed old
  //    order can never retire the new box).
  if (order.retiredStkPubHex.toLowerCase() !== opts.myStkHex.toLowerCase()) {
    log(
      `[decommission] order names STK ${order.retiredStkPubHex}, not this instance ${opts.myStkHex}; ignoring`,
    );
    return { decommissioned: false, reason: "wrong-stk" };
  }

  log(
    `[decommission] verified owner-IRK order for ${opts.serverDomain} ` +
      `(disposition=${order.diskDisposition}, finalBackup=${order.finalBackup}, epoch=${order.backupEpoch})`,
  );

  // 5. Final peer-backup flush (§9 barrier) BEFORE releasing routing — the
  //    deposit rides the box's STK/namespace, not routing, so this is safe even
  //    though routing is already revoked (I3). Report epoch-complete so the
  //    successor's barrier clears. Best-effort throughout.
  if (order.finalBackup) {
    try {
      await opts.backupFlush(order.backupEpoch);
      log(`[decommission] final backup flushed at epoch ${order.backupEpoch}`);
    } catch (e) {
      log(`[decommission] backupFlush failed (continuing): ${(e as Error).message}`);
    }
    try {
      await postBest(fetchImpl, `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/decommission/epoch-complete`, {
        stk: opts.myStkHex.toLowerCase(),
      });
    } catch (e) {
      log(`[decommission] epoch-complete report failed (continuing): ${(e as Error).message}`);
    }
  }

  // 6. Release routing (drop the tunnel) — all dispositions stop serving now.
  try {
    await opts.releaseRouting();
    log("[decommission] routing released (tunnel dropped)");
  } catch (e) {
    log(`[decommission] releaseRouting failed (continuing): ${(e as Error).message}`);
  }

  // 7. Apply the SIGNED disk disposition (§6a).
  let wiped = false;
  if (order.diskDisposition === "wipe-now") {
    wiped = await safeWipe(opts, log);
  } else if (order.diskDisposition === "wipe-after-handoff") {
    // Go idle (de-routed, powered, data intact); wait (bounded) for the
    // replacement-restored confirm. FAIL-SAFE: on timeout (or no poll injected),
    // power off WITHOUT wiping — keep the data as the fallback.
    let confirmed = false;
    if (opts.awaitHandoffConfirm) {
      try {
        confirmed = await opts.awaitHandoffConfirm();
      } catch (e) {
        log(`[decommission] handoff-confirm poll failed (treating as timeout): ${(e as Error).message}`);
        confirmed = false;
      }
    }
    if (confirmed) {
      log("[decommission] replacement restore CONFIRMED; wiping then powering off");
      wiped = await safeWipe(opts, log);
    } else {
      log("[decommission] handoff confirm TIMED OUT; powering off WITHOUT wiping (data preserved as fallback)");
    }
  } else {
    // keep — power off, data intact.
    log("[decommission] disposition=keep; powering off with data intact");
  }

  // 8. Write the idempotency marker BEFORE the power-off (best-effort) so a
  //    re-poll never re-fires. A marker-write failure must not loop — it is
  //    logged and we proceed (the power-off is the terminal act anyway).
  try {
    await opts.markerStore.mark(order);
  } catch (e) {
    log(`[decommission] failed to write marker (continuing): ${(e as Error).message}`);
  }

  // 9. Ack consume (advisory GC) — best-effort.
  try {
    await postBest(fetchImpl, `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/decommission/ack-old`, {
      stk: opts.myStkHex.toLowerCase(),
    });
  } catch (e) {
    log(`[decommission] ack-old failed (continuing): ${(e as Error).message}`);
  }

  // 10. The terminal act: lock + power off (every disposition converges here).
  try {
    await opts.lockAndPower();
  } catch (e) {
    log(`[decommission] lockAndPower failed: ${(e as Error).message}`);
  }

  return { decommissioned: true, disposition: order.diskDisposition, wiped };
}

/** Run the injected wipe best-effort; returns whether it ran without throwing. */
async function safeWipe(opts: RunDecommissionOptions, log: (m: string) => void): Promise<boolean> {
  try {
    await opts.wipeContent();
    return true;
  } catch (e) {
    // The wipe is best-effort; we still power off (a partial wipe is acceptable —
    // the box is being retired and will be reburned). Report it as not-wiped so a
    // caller can distinguish, but never throw.
    log(`[decommission] wipeContent failed (continuing to power-off): ${(e as Error).message}`);
    return false;
  }
}

/** Fire-and-forget best-effort POST of a small JSON body; never throws. */
async function postBest(fetchImpl: typeof fetch, url: string, body: unknown): Promise<void> {
  await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface DecommissionPoller {
  pollOnce(): Promise<DecommissionOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the decommission lane on the daemon heartbeat cadence (default 5 min).
 * Stops itself after a successful closeout (the box is powering off — nothing
 * more to do) or after an already-done result. Mirrors buildSelfDeletePoller's
 * start/stop shape; the timer is unref'd so it never keeps the process alive.
 */
export function buildDecommissionPoller(
  opts: RunDecommissionOptions & { intervalMs?: number },
): DecommissionPoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<DecommissionOutcome> {
    const out = await runDecommissionConsumer(opts);
    if (out.decommissioned || (!out.decommissioned && out.reason === "already-done")) {
      stop();
    }
    return out;
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}

/**
 * The production "replacement restored" confirm poll for `wipe-after-handoff`.
 * Polls `GET /api/server/:domain/eviction-chain` a bounded number of times,
 * looking for evidence the SUCCESSOR is up: a chain entry for a DIFFERENT STK
 * that has flushed its own epoch (`epochCompleteAt != null`) — i.e. the new box
 * restored and is running. Resolves `true` on first such evidence, `false` once
 * the attempt budget is exhausted (the fail-safe timeout). Never throws.
 *
 * Injected into the consumer as `awaitHandoffConfirm`; broken out here so the
 * daemon wires the real `.com` poll and tests inject a deterministic predicate.
 */
export async function pollReplacementRestored(args: {
  serverDomain: string;
  myStkHex: string;
  controlPlaneBaseUrl: string;
  /** Max number of polls before giving up (the timeout). */
  maxAttempts: number;
  /** Delay between polls (ms). */
  intervalMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (m: string) => void;
}): Promise<boolean> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = args.onLog ?? (() => {});
  const base = args.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(args.serverDomain)}/eviction-chain`;
  const myStk = args.myStkHex.toLowerCase();

  for (let attempt = 0; attempt < args.maxAttempts; attempt++) {
    if (attempt > 0) await sleep(args.intervalMs);
    try {
      const res = await fetchImpl(url, { method: "GET" });
      if (res.ok) {
        const body = (await res.json()) as {
          evictions?: Array<{ orderJson?: string; epochCompleteAt?: number | null }>;
        };
        for (const ev of body?.evictions ?? []) {
          if (ev.epochCompleteAt == null) continue;
          // A completed epoch on a row whose retired STK is NOT us means a LATER
          // tenant flushed — the successor restored and is running.
          let stk = "";
          try {
            stk = String((JSON.parse(ev.orderJson ?? "{}") as ServerDecommission).retiredStkPubHex ?? "").toLowerCase();
          } catch {
            /* unparseable row — ignore it */
          }
          if (stk && stk !== myStk) {
            log("[decommission] eviction-chain shows a restored successor; handoff confirmed");
            return true;
          }
        }
      }
    } catch (e) {
      log(`[decommission] eviction-chain poll failed (will retry): ${(e as Error).message}`);
    }
  }
  return false;
}
