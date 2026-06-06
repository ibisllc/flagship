// N-BOX-5 — first-valid-claim latch + 30-second session-lock window,
// driven by a pure state machine so the boot-path wiring stays simple.
//
// Lifecycle (mirrors the diagram in `docs/nfc-box-pairing.md § state
// machine`):
//
//   UNPAIRED  ── phone reads PAIR ────────►  SESSION_LOCKED (30 s)
//   UNPAIRED  ── 30 s with no read ───────►  (rotate keys + nonce, stay UNPAIRED)
//   SESSION_LOCKED ── valid claim w/ sessionId ─►  PAIRED  (latched, persist)
//   SESSION_LOCKED ── 30 s with no valid claim ──►  UNPAIRED  (rotate)
//   SESSION_LOCKED ── second-claim (any) ──►  ignored (first-claim-wins)
//   PAIRED     ── BoxUnpair envelope verified ──►  UNPAIRED  (Q4 rebind-only)
//
// This module is intentionally pure — it does NOT call into crypto or
// persistence. Callers feed it `now()`, the latched sessionId, and
// incoming claim attempts; it returns transition verdicts that the
// daemon then acts on (rotate keys, mark PAIRED, persist STK).

export type BoxPairState = "UNPAIRED" | "SESSION_LOCKED" | "PAIRED";

/** Window during which a session-locked box accepts ONE matching claim. */
export const SESSION_LOCK_MS = 30_000;

export interface PairStateSnapshot {
  state: BoxPairState;
  /** Set in SESSION_LOCKED + PAIRED; null in UNPAIRED. */
  sessionId: string | null;
  /** Wall-clock ms when the session lock expires (only in SESSION_LOCKED). */
  lockExpiresAt: number | null;
  /** Wall-clock ms when latched into PAIRED (only in PAIRED). */
  pairedAt: number | null;
}

export interface ClaimAttempt {
  /** Hex sessionId carried in the claim — must match the latched value. */
  sessionId: string;
  at: number;
}

export type ClaimVerdict =
  | { ok: true; latched: true; pairedAt: number }
  | { ok: false; reason: "no-session-locked" | "session-id-mismatch" | "session-expired" | "already-paired" };

export interface ReadPairVerdict {
  ok: boolean;
  newSnapshot: PairStateSnapshot;
  /** True iff the box should rotate its keypair (UNPAIRED rolled back). */
  rotateKeys: boolean;
}

/**
 * Pure functional core. Callers hold the snapshot in their own store
 * (`packages/server-daemon/src/...`) and run their state by piping it
 * through these functions.
 */
export function initialSnapshot(): PairStateSnapshot {
  return { state: "UNPAIRED", sessionId: null, lockExpiresAt: null, pairedAt: null };
}

/**
 * The phone tapped (read PAIR). Latch the sessionId for SESSION_LOCK_MS.
 *
 * If the box is already PAIRED or SESSION_LOCKED, the tap is ignored
 * (a tapped-paired box does not re-emit; a tapped-locked box keeps the
 * current lock — first-tap-wins for the lock too).
 */
export function applyPairRead(
  snapshot: PairStateSnapshot,
  sessionIdHex: string,
  at: number,
): ReadPairVerdict {
  if (snapshot.state === "PAIRED") {
    return { ok: false, newSnapshot: snapshot, rotateKeys: false };
  }
  if (snapshot.state === "SESSION_LOCKED") {
    // Already locked. If the existing lock has expired, treat this as
    // a fresh tap (the caller should rotate keys first).
    if (snapshot.lockExpiresAt !== null && at >= snapshot.lockExpiresAt) {
      return {
        ok: true,
        newSnapshot: {
          state: "SESSION_LOCKED",
          sessionId: sessionIdHex,
          lockExpiresAt: at + SESSION_LOCK_MS,
          pairedAt: null,
        },
        rotateKeys: true,
      };
    }
    // Existing lock still active — keep it.
    return { ok: false, newSnapshot: snapshot, rotateKeys: false };
  }
  // UNPAIRED → SESSION_LOCKED.
  return {
    ok: true,
    newSnapshot: {
      state: "SESSION_LOCKED",
      sessionId: sessionIdHex,
      lockExpiresAt: at + SESSION_LOCK_MS,
      pairedAt: null,
    },
    rotateKeys: false,
  };
}

/**
 * Process an incoming claim. First valid claim wins; subsequent claims
 * (even with the right sessionId) are rejected with `already-paired`.
 */
export function applyClaim(
  snapshot: PairStateSnapshot,
  claim: ClaimAttempt,
): { verdict: ClaimVerdict; newSnapshot: PairStateSnapshot } {
  if (snapshot.state === "PAIRED") {
    return {
      verdict: { ok: false, reason: "already-paired" },
      newSnapshot: snapshot,
    };
  }
  if (snapshot.state === "UNPAIRED") {
    return {
      verdict: { ok: false, reason: "no-session-locked" },
      newSnapshot: snapshot,
    };
  }
  // SESSION_LOCKED
  if (snapshot.lockExpiresAt !== null && claim.at >= snapshot.lockExpiresAt) {
    return {
      verdict: { ok: false, reason: "session-expired" },
      newSnapshot: snapshot,
    };
  }
  if (snapshot.sessionId !== claim.sessionId) {
    return {
      verdict: { ok: false, reason: "session-id-mismatch" },
      newSnapshot: snapshot,
    };
  }
  return {
    verdict: { ok: true, latched: true, pairedAt: claim.at },
    newSnapshot: {
      state: "PAIRED",
      sessionId: snapshot.sessionId,
      lockExpiresAt: null,
      pairedAt: claim.at,
    },
  };
}

/**
 * Owner-signed BoxUnpair envelope verified out-of-band — rebind to
 * UNPAIRED. Per Q4: rebind only; the caller does NOT wipe LUKS data
 * here (separate physical-button + wipe-verification flow).
 */
export function applyUnpair(snapshot: PairStateSnapshot): PairStateSnapshot {
  if (snapshot.state === "UNPAIRED") return snapshot;
  return initialSnapshot();
}

/**
 * Heartbeat tick — call periodically (e.g. once per second) from the
 * daemon. Returns `rotateKeys: true` if the session lock expired
 * without a successful claim, signalling the caller to regenerate
 * STK/ephemeral/nonce/sessionId and re-emit PAIR.
 */
export function tick(
  snapshot: PairStateSnapshot,
  at: number,
): { newSnapshot: PairStateSnapshot; rotateKeys: boolean } {
  if (
    snapshot.state === "SESSION_LOCKED" &&
    snapshot.lockExpiresAt !== null &&
    at >= snapshot.lockExpiresAt
  ) {
    return { newSnapshot: initialSnapshot(), rotateKeys: true };
  }
  return { newSnapshot: snapshot, rotateKeys: false };
}
