import { readFile, writeFile } from "node:fs/promises";
import {
  carrierHexToCgkDelivery,
  openAndVerifyCgkDelivery,
} from "@flagship/protocol";

/**
 * Box-side claim of the post-boot CGK (Cloud Gossip Key) delivery (Phase 6) —
 * the EXACT twin of swkDepositConsumer, only the lane + payload differ.
 *
 * The DEFAULT recipe carries NO CGK, so per-service leadership gossip stays
 * DISABLED on a real box (no brick — the box simply never gossips). The owner's
 * phone seals the per-cloud CGK to the box's OWN identity (the registered STK)
 * and IRK-signs the wrapper, depositing it into the `.com` `purpose:"cgk"` mailbox
 * lane. This module is the box's consumer: while the box has NO CGK, it polls that
 * lane on the daemon heartbeat cadence, RE-VERIFIES the delivery under the
 * config-pinned owner IRK (`.com` is never a trust anchor — I1–I3), UNSEALS the
 * CGK with the box identity key, persists it to /var/flagship/cgk.hex, and triggers
 * a daemon restart so the next boot resolves the CGK from disk and wires gossip.
 *
 * Safety / self-healing (identical to the SWK consumer):
 *   - Runs ONLY when the box has no CGK yet (the caller gates on this). A box that
 *     already has a CGK never polls — the recipe-embedded path is untouched.
 *   - The carrier is SEALED for the box identity, so a public consume-once GET
 *     reveals only ciphertext (`.com`/a relay holds no key).
 *   - We persist ONLY when the owner-IRK signature verifies AND the delivery names
 *     OUR box AND the seal opens to a 32-byte CGK. A forged / wrong-box / wrong-
 *     owner / junk delivery is rejected and we KEEP polling — never brick, never
 *     persist garbage.
 *   - Idempotent: a local marker records a successful claim, so a re-poll (or a
 *     reboot before the restart lands) never re-claims. `.com`'s consume-once is
 *     the primary guard; the marker is belt-and-suspenders.
 */

const HEX = /^[0-9a-f]+$/;

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Decode + verify the deposited CGK-delivery carrier hex into the raw 32-byte
 * CGK (hex). Returns null on ANY defect — the caller maps that to "ignore, keep
 * polling". Never throws.
 *
 * Verifies, in order: the carrier parses to a `{delivery, signature}`; the
 * delivery names THIS box; the owner-IRK signature verifies; the seal opens with
 * the box identity key to a 32-byte CGK.
 */
export function decodeAndVerifyCgkCarrier(args: {
  sealedHex: string;
  ownerIrkPub: Uint8Array;
  /** Custodian-backed unseal (opens a blob sealed to the box identity). */
  unsealToBox: (blob: Uint8Array) => Uint8Array;
  serverDomain: string;
}): string | null {
  const parsed = carrierHexToCgkDelivery(args.sealedHex);
  if (!parsed) return null;
  const cgk = openAndVerifyCgkDelivery({
    delivery: parsed.delivery,
    signature: parsed.signature,
    ownerIrkPub: args.ownerIrkPub,
    unsealToBox: args.unsealToBox,
    serverDomain: args.serverDomain,
  });
  if (!cgk || cgk.length !== 32) return null;
  return bytesToHex(cgk);
}

/** Records that a CGK claim already ran (idempotency). */
export interface CgkClaimMarkerStore {
  has(): Promise<boolean>;
  mark(cgkHex: string): Promise<void>;
}

/** Default file-backed marker (a small JSON sentinel under the data dir). */
export function fileCgkMarkerStore(markerPath: string): CgkClaimMarkerStore {
  return {
    async has() {
      try {
        await readFile(markerPath, "utf-8");
        return true;
      } catch {
        return false;
      }
    },
    async mark(cgkHex) {
      await writeFile(
        markerPath,
        JSON.stringify({ claimedAt: Date.now(), cgkPrefix: cgkHex.slice(0, 8) }),
        { mode: 0o600 },
      );
    },
  };
}

export interface ClaimCgkDepositOptions {
  /** This box's canonical FQDN. */
  serverDomain: string;
  /** The config-pinned owner IRK pubkey — the only trust anchor. */
  ownerIrkPub: Uint8Array;
  /** Custodian-backed unseal — opens the CGK carrier sealed to the box identity. */
  unsealToBox: (blob: Uint8Array) => Uint8Array;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /**
   * Persist the claimed CGK hex (best-effort, 0600) so the next boot resolves it
   * from /var/flagship/cgk.hex. Injected so the claim logic is testable; the
   * daemon wires `persistCgkHex`.
   */
  persistCgk: (cgkHex: string) => Promise<void>;
  /**
   * Restart the daemon so `wireGossip` enables on the next boot (systemd re-fires
   * under Restart=on-failure). Injected; the daemon wires `process.exit`.
   */
  restart: () => void;
  /** Idempotency marker store. */
  markerStore: CgkClaimMarkerStore;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

export type CgkClaimOutcome =
  | { claimed: false; reason: "already-claimed" | "no-deposit" | "rejected" | "error" }
  | { claimed: true; cgkHex: string };

/**
 * One poll: claim a deposited CGK delivery, verify + unseal it, and (on success)
 * persist + mark + restart. Never throws — returns an outcome.
 */
export async function claimCgkDeposit(opts: ClaimCgkDepositOptions): Promise<CgkClaimOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});

  // Belt-and-suspenders: if a prior poll already claimed, never do it again.
  try {
    if (await opts.markerStore.has()) return { claimed: false, reason: "already-claimed" };
  } catch {
    /* a missing/unreadable marker is treated as "not yet claimed" */
  }

  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/cgk-deposit`;

  let sealedHex: string | undefined;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { claimed: false, reason: "no-deposit" };
    if (!res.ok) {
      log(`[cgk-deposit] GET ${res.status}; ignoring`);
      return { claimed: false, reason: "error" };
    }
    const body = (await res.json()) as { sealed?: string };
    sealedHex = body?.sealed;
  } catch (e) {
    log(`[cgk-deposit] GET failed: ${(e as Error).message}`);
    return { claimed: false, reason: "error" };
  }

  if (typeof sealedHex !== "string" || sealedHex.length === 0 || !HEX.test(sealedHex.toLowerCase())) {
    log("[cgk-deposit] deposit missing/invalid carrier; ignoring");
    return { claimed: false, reason: "rejected" };
  }

  const cgkHex = decodeAndVerifyCgkCarrier({
    sealedHex,
    ownerIrkPub: opts.ownerIrkPub,
    unsealToBox: opts.unsealToBox,
    serverDomain: opts.serverDomain,
  });
  if (!cgkHex) {
    // A delivery that doesn't verify/unseal under OUR keys: a relay can't forge
    // it, so this is junk or for a different box. Drop it + keep polling.
    log("[cgk-deposit] deposit rejected (signature/unseal failed); keep polling");
    return { claimed: false, reason: "rejected" };
  }

  log("[cgk-deposit] verified owner-IRK CGK delivery; persisting + restarting to enable gossip");
  try {
    await opts.persistCgk(cgkHex);
  } catch (e) {
    // If we couldn't persist, do NOT mark/restart — we'd lose the (now-consumed)
    // deposit. Surface the error and keep polling; but the GET already consumed
    // the row, so a redeposit is needed. Best-effort: report it loudly.
    log(`[cgk-deposit] persist failed (${(e as Error).message}); will keep polling`);
    return { claimed: false, reason: "error" };
  }
  try {
    await opts.markerStore.mark(cgkHex);
  } catch (e) {
    log(`[cgk-deposit] failed to write claim marker: ${(e as Error).message}`);
  }
  // Restart so the resolution order picks up cgk.hex and gossip wires.
  opts.restart();
  return { claimed: true, cgkHex };
}

export interface CgkDepositPoller {
  pollOnce(): Promise<CgkClaimOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the cgk lane on the daemon heartbeat cadence (default 5 min). Stops itself
 * after a successful claim (the restart is imminent) or after an already-claimed
 * result. Mirrors buildSwkDepositPoller's shape; the timer is unref'd so it never
 * keeps the process alive on its own. The first tick fires immediately so a box
 * with a deposit already waiting enables gossip without a poll-interval delay.
 */
export function buildCgkDepositPoller(
  opts: ClaimCgkDepositOptions & { intervalMs?: number },
): CgkDepositPoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<CgkClaimOutcome> {
    const out = await claimCgkDeposit(opts);
    if (out.claimed || (!out.claimed && out.reason === "already-claimed")) stop();
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
      // Immediate first tick (a deposit may already be waiting), then on cadence.
      void pollOnce().catch(() => {});
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}
