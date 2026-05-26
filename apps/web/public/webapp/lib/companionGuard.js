// P14 — Companion-profile write guard.
//
// Signing helpers (releaseServer, revokeServer, replaceDeviceCeremony,
// wipeRestartCeremony, installService, ...) call requireOwnerProfile()
// BEFORE pulling the UMK from the session. If the active profile is a
// companion (kind === "companion"), this throws a tagged Error the
// router catches and surfaces as a toast — "Companion sessions can't
// sign. Open your owner app to approve this change."
//
// Wave 9 will add the write-relay: a companion-initiated signed write
// will queue on the pod and the owner approves it asynchronously.
// Today the contract is simpler: companions are strictly read-only,
// signing is gated, and the error message tells the user where to go.

import { get as profileGet } from "./profilesStore.js";

export const COMPANION_WRITE_ERROR_CODE = "companion-write-not-allowed";

export class CompanionWriteError extends Error {
  constructor(message = "Companion sessions can't sign — open your owner app to approve this") {
    super(message);
    this.name = "CompanionWriteError";
    this.code = COMPANION_WRITE_ERROR_CODE;
  }
}

/**
 * Return true when the active profile is a companion. Default-false on
 * any read failure — better to attempt the write and let the server
 * surface a 403 than to block an owner mid-flight due to a transient
 * localStorage hiccup.
 */
export function isCompanionProfile() {
  try {
    return profileGet("kind") === "companion";
  } catch {
    return false;
  }
}

/**
 * Refuse to proceed when the active profile is a companion. Used as a
 * one-liner at the top of every signing path (releaseServer.js etc.).
 *
 * Companions DO hold a valid paired-session token (the BFF accepts
 * their reads), but the seed needed to sign was never persisted in
 * this browser. Calling crypto.subtle.sign with a missing seed would
 * surface as a cryptic "umk required" — this guard surfaces the
 * actual reason ("you're docked, not signed in") at the right layer.
 */
export function requireOwnerProfile() {
  if (isCompanionProfile()) throw new CompanionWriteError();
}
