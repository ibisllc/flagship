import { readFile, writeFile } from "node:fs/promises";
import {
  carrierHexToSwkDelivery,
  openAndVerifySwkDelivery,
} from "@flagship/protocol";

/**
 * Box-side claim of the secret-free-recipe SWK delivery
 * (docs/recipe-delivery-and-remote-install.md).
 *
 * The DEFAULT recipe carries NO Service Workload Key. The box boots
 * platform-less, registers, and attests its identity; the owner's phone then
 * seals the SWK to the box's OWN identity (the registered STK — generated at
 * first boot) and IRK-signs the wrapper, depositing it into the `.com`
 * `purpose:"swk"` mailbox lane. This module is the box's consumer: while the box
 * has NO SWK, it polls that lane on the daemon heartbeat cadence, RE-VERIFIES the
 * delivery under the config-pinned owner IRK (`.com` is never a trust anchor —
 * I1–I3), UNSEALS the SWK with the box identity key, persists it to
 * /var/flagship/swk.hex, and triggers a daemon restart so the next boot resolves
 * the SWK from disk and constructs the service platform.
 *
 * Safety / self-healing:
 *   - Runs ONLY when the box has no SWK yet (the caller gates on this). A box
 *     that already has an SWK never polls — the recipe-embedded path is untouched.
 *   - The carrier is SEALED for the box identity, so a public consume-once GET
 *     reveals only ciphertext (`.com`/a relay holds no key).
 *   - We persist ONLY when the owner-IRK signature verifies AND the delivery
 *     names OUR box AND the seal opens to a 32-byte SWK. A forged / wrong-box /
 *     wrong-owner / junk delivery is rejected and we KEEP polling — never brick,
 *     never persist garbage.
 *   - Idempotent: `.com` consumes each deposit once and the poller stops after a
 *     durable claim. The local marker is audit-only; while `swk.hex` is absent it
 *     must never block a fresh replacement deposit.
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

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Decode + verify the deposited SWK-delivery carrier hex into the raw 32-byte
 * SWK (hex). Returns null on ANY defect — the caller maps that to "ignore, keep
 * polling". Never throws.
 *
 * Verifies, in order: the carrier parses to a `{delivery, signature}`; the
 * delivery names THIS box; the owner-IRK signature verifies; the seal opens with
 * the box identity key to a 32-byte SWK.
 */
export function decodeAndVerifySwkCarrier(args: {
  sealedHex: string;
  ownerIrkPub: Uint8Array;
  /** Custodian-backed unseal (opens a blob sealed to the box identity). */
  unsealToBox: (blob: Uint8Array) => Uint8Array;
  serverDomain: string;
}): string | null {
  const parsed = carrierHexToSwkDelivery(args.sealedHex);
  if (!parsed) return null;
  const swk = openAndVerifySwkDelivery({
    delivery: parsed.delivery,
    signature: parsed.signature,
    ownerIrkPub: args.ownerIrkPub,
    unsealToBox: args.unsealToBox,
    serverDomain: args.serverDomain,
  });
  if (!swk || swk.length !== 32) return null;
  return bytesToHex(swk);
}

/** Records that an SWK claim ran. The marker is audit-only: this consumer is
 * constructed only while the SWK file is absent, so a marker in that state is
 * evidence of an interrupted/failed prior claim, not proof the key is durable. */
export interface SwkClaimMarkerStore {
  has(): Promise<boolean>;
  mark(swkHex: string): Promise<void>;
}

/** Default file-backed marker (a small JSON sentinel under the data dir). */
export function fileSwkMarkerStore(markerPath: string): SwkClaimMarkerStore {
  return {
    async has() {
      try {
        await readFile(markerPath, "utf-8");
        return true;
      } catch {
        return false;
      }
    },
    async mark(swkHex) {
      await writeFile(
        markerPath,
        JSON.stringify({ claimedAt: Date.now(), swkPrefix: swkHex.slice(0, 8) }),
        { mode: 0o600 },
      );
    },
  };
}

export interface ClaimSwkDepositOptions {
  /** This box's canonical FQDN. */
  serverDomain: string;
  /** The config-pinned owner IRK pubkey — the only trust anchor. */
  ownerIrkPub: Uint8Array;
  /** Custodian-backed unseal — opens the SWK carrier sealed to the box identity. */
  unsealToBox: (blob: Uint8Array) => Uint8Array;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /**
   * Persist the claimed SWK hex (best-effort, 0600) so the next boot resolves it
   * from /var/flagship/swk.hex. Injected so the claim logic is testable; the
   * daemon wires `persistSwkHex`.
   */
  persistSwk: (swkHex: string) => Promise<void>;
  /**
   * Restart the daemon so `servicePlatform` constructs on the next boot. The
   * daemon wires this to `process.exit(0)`, so the systemd unit MUST be
   * `Restart=always` — under `on-failure` a clean exit(0) is treated as success
   * and NOT restarted, stranding the box the instant it consumes its SWK.
   */
  restart: () => void;
  /** Audit marker store. */
  markerStore: SwkClaimMarkerStore;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

export type SwkClaimOutcome =
  | { claimed: false; reason: "no-deposit" | "rejected" | "error" }
  | { claimed: true; swkHex: string };

/**
 * One poll: claim a deposited SWK delivery, verify + unseal it, and (on success)
 * persist + mark + restart. Never throws — returns an outcome.
 */
export async function claimSwkDeposit(opts: ClaimSwkDepositOptions): Promise<SwkClaimOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});

  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/swk-deposit`;

  let sealedHex: string | undefined;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { claimed: false, reason: "no-deposit" };
    if (!res.ok) {
      log(`[swk-deposit] GET ${res.status}; ignoring`);
      return { claimed: false, reason: "error" };
    }
    const body = (await res.json()) as { sealed?: string };
    sealedHex = body?.sealed;
  } catch (e) {
    log(`[swk-deposit] GET failed: ${(e as Error).message}`);
    return { claimed: false, reason: "error" };
  }

  if (typeof sealedHex !== "string" || sealedHex.length === 0 || !HEX.test(sealedHex.toLowerCase())) {
    log("[swk-deposit] deposit missing/invalid carrier; ignoring");
    return { claimed: false, reason: "rejected" };
  }

  const swkHex = decodeAndVerifySwkCarrier({
    sealedHex,
    ownerIrkPub: opts.ownerIrkPub,
    unsealToBox: opts.unsealToBox,
    serverDomain: opts.serverDomain,
  });
  if (!swkHex) {
    // A delivery that doesn't verify/unseal under OUR keys: a relay can't forge
    // it, so this is junk or for a different box. Drop it + keep polling.
    log("[swk-deposit] deposit rejected (signature/unseal failed); keep polling");
    return { claimed: false, reason: "rejected" };
  }

  log("[swk-deposit] verified owner-IRK SWK delivery; persisting + restarting to enable the platform");
  try {
    await opts.persistSwk(swkHex);
  } catch (e) {
    // If we couldn't persist, do NOT mark/restart — we'd lose the (now-consumed)
    // deposit. Surface the error and keep polling; but the GET already consumed
    // the row, so a redeposit is needed. Best-effort: report it loudly.
    log(`[swk-deposit] persist failed (${(e as Error).message}); will keep polling`);
    return { claimed: false, reason: "error" };
  }
  try {
    await opts.markerStore.mark(swkHex);
  } catch (e) {
    log(`[swk-deposit] failed to write claim marker: ${(e as Error).message}`);
  }
  // Restart so the resolution order picks up swk.hex and the platform wires.
  opts.restart();
  return { claimed: true, swkHex };
}

export interface SwkDepositPoller {
  pollOnce(): Promise<SwkClaimOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the swk lane on the daemon heartbeat cadence (default 5 min). Stops itself
 * after a successful claim (the restart is imminent). Mirrors
 * buildSelfDeletePoller's shape; the timer is unref'd so it never
 * keeps the process alive on its own. The first tick fires immediately so a box
 * with a deposit already waiting comes online without a poll-interval delay.
 */
export function buildSwkDepositPoller(
  opts: ClaimSwkDepositOptions & { intervalMs?: number },
): SwkDepositPoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<SwkClaimOutcome> {
    const out = await claimSwkDeposit(opts);
    if (out.claimed) stop();
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
