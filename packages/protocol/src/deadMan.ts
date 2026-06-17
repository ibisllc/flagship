/**
 * Dead-man heartbeat-lock domain — the opt-in, per-server policy +
 * manual keep-unlocked affirmation (lock-and-poweroff spec).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tags, field
 * order, and the lockout-mode enum guard are unchanged, so canonical bytes
 * and signatures remain byte-identical.
 */
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

/**
 * Enum-style guard for the dead-man lockout action — same poweroff
 * vocabulary as `PowerOffMode`, named distinctly so the policy field
 * reads at its call site.
 */
export type DeadManLockoutMode = "off" | "restart";
function deadManLockoutToken(mode: DeadManLockoutMode): string {
  if (mode !== "off" && mode !== "restart") {
    throw new Error(`invalid dead-man lockout mode: ${String(mode)}`);
  }
  return mode;
}

const TAG_SET_DEADMAN_POLICY = "flagship/set-deadman-policy/v1";
const TAG_DEADMAN_AFFIRM = "flagship/deadman-affirm/v1";

/**
 * Dead-man heartbeat-lock policy (lock-and-poweroff spec §"Dead-man
 * heartbeat-lock"). An opt-in, per-server, IRK-signed policy persisted
 * on the box. Signed so neither `.com` nor a relay can weaken it (e.g.
 * silently disable the lock or stretch the window) — the box verifies
 * against its config-pinned owner IRK pubkey before persisting.
 *
 * When enabled, the daemon enforces a dead-man lease: the owner must
 * periodically affirm (biometric/IRK-signed `DeadManAffirmation`) within
 * `windowMs`; on lapse past `graceMs` with no affirmation, the daemon
 * suppresses the silent auto-unlock and runs the host power action per
 * `lockoutMode`. `enabled=false` stops enforcement.
 */
export interface SetDeadManPolicy {
  serverId: ServerId;
  enabled: boolean;
  /** Affirmation window in ms — each affirmation sets expiry = now + windowMs. */
  windowMs: number;
  /** Extra grace past the window before the lockout fires. */
  graceMs: number;
  /** Host action on lapse: poweroff ("off", default rubber-hose posture) or reboot ("restart"). */
  lockoutMode: DeadManLockoutMode;
  issuedAt: number;
}

/**
 * Manual keep-unlocked affirmation — a biometric/IRK-signed renewal that
 * extends the dead-man lease. Modeled as a DISTINCT renewal from the
 * silent auto-unlock renewer (which the box must never use to renew the
 * dead-man lease): only this owner-IRK-signed, replay-windowed envelope
 * resets `deadManLeaseExpiry = now + windowMs`. Because signing requires
 * the owner IRK (biometric on the phone), a stolen/unattended phone
 * cannot renew it.
 *
 * `nonce` is fresh per affirmation; the daemon refuses a replayed nonce
 * and an `issuedAt` outside its replay window.
 */
export interface DeadManAffirmation {
  serverId: ServerId;
  /** Fresh 16+ byte nonce; the daemon rejects a replayed value. */
  nonce: Bytes;
  issuedAt: number;
}

function canonicalSetDeadManPolicy(r: SetDeadManPolicy): Bytes {
  return new TextEncoder().encode(
    [
      TAG_SET_DEADMAN_POLICY,
      r.serverId,
      r.enabled ? "1" : "0",
      r.windowMs,
      r.graceMs,
      deadManLockoutToken(r.lockoutMode),
      r.issuedAt,
    ].join("|"),
  );
}

function canonicalDeadManAffirmation(r: DeadManAffirmation): Bytes {
  return new TextEncoder().encode(
    [TAG_DEADMAN_AFFIRM, r.serverId, hex(r.nonce), r.issuedAt].join("|"),
  );
}

export function signSetDeadManPolicy(r: SetDeadManPolicy, irk: Keypair): Bytes {
  return ed.sign(canonicalSetDeadManPolicy(r), irk.privateKey);
}
export function verifySetDeadManPolicy(r: SetDeadManPolicy, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalSetDeadManPolicy(r), irkPub);
  } catch {
    return false;
  }
}

export function signDeadManAffirmation(r: DeadManAffirmation, irk: Keypair): Bytes {
  return ed.sign(canonicalDeadManAffirmation(r), irk.privateKey);
}
export function verifyDeadManAffirmation(r: DeadManAffirmation, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalDeadManAffirmation(r), irkPub);
  } catch {
    return false;
  }
}
