import { readFile, writeFile } from "node:fs/promises";
import {
  openPairingOrderEnvelope,
  openSealedFromEd25519Recipient,
} from "@flagship/protocol";

/**
 * Box-side claim of the secret-free-recipe PAIRING delivery — the twin of
 * swkDepositConsumer.ts, for the paired-session token.
 *
 * The DEFAULT recipe carries NO pairing material (no `pairingKeyPrivHex`). The
 * box boots, registers, and the owner's phone — reading the box's IDENTITY pub
 * from `/pods` post-registration — seals an owner-IRK-signed `add-paired-session`
 * order to the box's identity X25519 key and deposits it into the EXISTING `.com`
 * `purpose:"pairing"` mailbox lane. Because the phone now deposits AFTER the box
 * boots (the old create-time deposit existed before boot, so a one-shot at boot
 * sufficed), the daemon must POLL the lane on the heartbeat cadence until it
 * claims one — exactly like the SWK consumer.
 *
 * Box side, per poll:
 *   - public consume-once GET on `.../pairing-deposit` (no session at boot; the
 *     blob is sealed to the box identity, so a public read reveals only ciphertext)
 *   - unseal with the box identity key → the plaintext `{request, signature}` JSON
 *   - verify the owner-IRK signature under the config-pinned owner IRK AND that the
 *     order names THIS box (`openPairingOrderEnvelope`) — `.com` is never a trust
 *     anchor (I1–I3)
 *   - add the session LOCALLY; mark + stop polling
 *
 * A forged / wrong-box / wrong-owner / un-openable deposit is rejected and we KEEP
 * polling (never brick, never persist garbage). Idempotent via the paired-session
 * store's `has(token)` plus a local marker.
 */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const HEX = /^[0-9a-f]+$/;

/** Minimal view of the paired-session store this consumer needs. */
export interface PairingSessionSink {
  has(token: string): boolean;
  add(token: string, label: string): Promise<void>;
}

/** Records that a pairing claim already ran (idempotency). */
export interface PairingClaimMarkerStore {
  has(): Promise<boolean>;
  mark(token: string): Promise<void>;
}

/** Default file-backed marker (a small JSON sentinel under the data dir). */
export function filePairingMarkerStore(markerPath: string): PairingClaimMarkerStore {
  return {
    async has() {
      try {
        await readFile(markerPath, "utf-8");
        return true;
      } catch {
        return false;
      }
    },
    async mark(token) {
      await writeFile(
        markerPath,
        JSON.stringify({ claimedAt: Date.now(), tokenPrefix: token.slice(0, 8) }),
        { mode: 0o600 },
      );
    },
  };
}

export interface ClaimPairingDepositOptions {
  /** This box's canonical FQDN. */
  serverFqdn: string;
  /** The config-pinned owner IRK pubkey — the only trust anchor. */
  ownerIrkPub: Uint8Array;
  /** The box's Ed25519 identity SEED (its 32-byte private key) — unseals the blob. */
  boxIdentityPriv: Uint8Array;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /** Where the claimed session lands. */
  pairedSessions: PairingSessionSink;
  /** Idempotency marker store. */
  markerStore: PairingClaimMarkerStore;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

export type PairingClaimOutcome =
  | { claimed: false; reason: "already-claimed" | "no-deposit" | "rejected" | "error" }
  | { claimed: true; token: string };

/**
 * One poll: claim a deposited pairing delivery, unseal + verify it, and (on
 * success) add the session + mark. Never throws — returns an outcome.
 */
export async function claimPairingDeposit(
  opts: ClaimPairingDepositOptions,
): Promise<PairingClaimOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});

  // Belt-and-suspenders: if a prior poll already claimed, never do it again.
  try {
    if (await opts.markerStore.has()) return { claimed: false, reason: "already-claimed" };
  } catch {
    /* a missing/unreadable marker is treated as "not yet claimed" */
  }

  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverFqdn)}/pairing-deposit`;

  let sealedHex: string | undefined;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { claimed: false, reason: "no-deposit" };
    if (!res.ok) {
      log(`[pairing-deposit] GET ${res.status}; ignoring`);
      return { claimed: false, reason: "error" };
    }
    const body = (await res.json()) as { sealed?: unknown };
    sealedHex = typeof body?.sealed === "string" ? body.sealed : undefined;
  } catch (e) {
    log(`[pairing-deposit] GET failed: ${(e as Error).message}`);
    return { claimed: false, reason: "error" };
  }

  if (typeof sealedHex !== "string" || sealedHex.length === 0 || !HEX.test(sealedHex.toLowerCase())) {
    log("[pairing-deposit] deposit missing/invalid carrier; ignoring");
    return { claimed: false, reason: "rejected" };
  }

  // Unseal with the box identity key → the plaintext {request, signature} JSON.
  let json: string;
  try {
    const plain = openSealedFromEd25519Recipient(hexToBytes(sealedHex.toLowerCase()), opts.boxIdentityPriv);
    json = new TextDecoder().decode(plain);
  } catch {
    log("[pairing-deposit] could not unseal with the box identity key; keep polling");
    return { claimed: false, reason: "rejected" };
  }

  const order = openPairingOrderEnvelope({
    json,
    ownerIrkPub: opts.ownerIrkPub,
    expectedServerId: opts.serverFqdn,
  });
  if (!order) {
    log("[pairing-deposit] deposit rejected (signature/shape/wrong-box); keep polling");
    return { claimed: false, reason: "rejected" };
  }

  // Idempotent: if the session is already present, just mark + stop.
  if (opts.pairedSessions.has(order.token)) {
    try {
      await opts.markerStore.mark(order.token);
    } catch {
      /* best-effort */
    }
    return { claimed: true, token: order.token };
  }

  try {
    await opts.pairedSessions.add(order.token, order.label);
  } catch (e) {
    log(`[pairing-deposit] add session failed (${(e as Error).message}); keep polling`);
    return { claimed: false, reason: "error" };
  }
  try {
    await opts.markerStore.mark(order.token);
  } catch (e) {
    log(`[pairing-deposit] failed to write claim marker: ${(e as Error).message}`);
  }
  log("[pairing-deposit] verified owner-IRK pairing order — paired (no manual tap)");
  return { claimed: true, token: order.token };
}

export interface PairingDepositPoller {
  pollOnce(): Promise<PairingClaimOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the pairing lane on the daemon heartbeat cadence (default 5 min). Stops
 * itself after a successful claim or an already-claimed result. The timer is
 * unref'd so it never keeps the process alive; the first tick fires immediately so
 * a box with a deposit already waiting pairs without a poll-interval delay.
 */
export function buildPairingDepositPoller(
  opts: ClaimPairingDepositOptions & { intervalMs?: number },
): PairingDepositPoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<PairingClaimOutcome> {
    const out = await claimPairingDeposit(opts);
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
      void pollOnce().catch(() => {});
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}

// ──────────────────────────────────────────────────────────────────────
// OFFLINE-EMBED path. The advanced/embed recipe carries the owner-IRK-signed
// `add-paired-session` order in PLAINTEXT (`{request, signature}` JSON) as an
// unsigned `pairingOrder` recipe sibling — exactly like `swkHex`. The box reads
// it at boot, verifies the owner-IRK signature under the config-pinned owner IRK,
// and adds the session LOCALLY with NO `.com` call. Idempotent (a marker keeps a
// reboot from double-adding; the store's `has(token)` is the primary guard).
// ──────────────────────────────────────────────────────────────────────

export interface AddEmbeddedPairingOptions {
  /** The plaintext `{request, signature}` JSON from the recipe's `pairingOrder` sibling. */
  embeddedJson: string;
  /** This box's canonical FQDN — the order must name THIS box. */
  serverFqdn: string;
  /** The config-pinned owner IRK pubkey — the only trust anchor. */
  ownerIrkPub: Uint8Array;
  /** Where the session lands. */
  pairedSessions: PairingSessionSink;
  /** Idempotency marker store. */
  markerStore: PairingClaimMarkerStore;
  onLog?: (m: string) => void;
}

export type EmbeddedPairingOutcome =
  | { added: false; reason: "already-claimed" | "rejected" | "error" }
  | { added: true; token: string };

/**
 * Add the recipe-embedded pairing session locally. Verifies the owner-IRK
 * signature + that the order names THIS box, then adds the session. Never throws.
 */
export async function addEmbeddedPairing(
  opts: AddEmbeddedPairingOptions,
): Promise<EmbeddedPairingOutcome> {
  const log = opts.onLog ?? (() => {});

  try {
    if (await opts.markerStore.has()) return { added: false, reason: "already-claimed" };
  } catch {
    /* missing/unreadable marker ⇒ not yet claimed */
  }

  const order = openPairingOrderEnvelope({
    json: opts.embeddedJson,
    ownerIrkPub: opts.ownerIrkPub,
    expectedServerId: opts.serverFqdn,
  });
  if (!order) {
    log("[pairing-embed] embedded order rejected (signature/shape/wrong-box) — ignored");
    return { added: false, reason: "rejected" };
  }

  if (opts.pairedSessions.has(order.token)) {
    try {
      await opts.markerStore.mark(order.token);
    } catch {
      /* best-effort */
    }
    return { added: true, token: order.token };
  }

  try {
    await opts.pairedSessions.add(order.token, order.label);
  } catch (e) {
    log(`[pairing-embed] add session failed (${(e as Error).message})`);
    return { added: false, reason: "error" };
  }
  try {
    await opts.markerStore.mark(order.token);
  } catch (e) {
    log(`[pairing-embed] failed to write claim marker: ${(e as Error).message}`);
  }
  log("[pairing-embed] verified owner-IRK embedded pairing order — paired offline (no .com)");
  return { added: true, token: order.token };
}
