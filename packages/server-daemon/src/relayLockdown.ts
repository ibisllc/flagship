/**
 * Relay-trust lockdown + SOS state machine (docs/maintainer-trust-
 * enforcement.md § "Box = fail-closed lockdown", task #5).
 *
 * The box verifies the relay blessing on every HELLO_ACK
 * (`RelayTrustVerifier`, OBSERVE). This controller is the ENFORCE half:
 *
 *   - When `FLAGSHIP_RELAY_TRUST_ENFORCE` is OFF (the DEFAULT), it NEVER
 *     locks down — `onVerdict` only logs. This is mandatory for deploy
 *     safety: no box has a validated blessing flow yet, so a fail-closed
 *     default would brick the live fleet.
 *
 *   - When ENFORCE is ON and a verdict is `false` (a blessing/hubSig was
 *     presented and FAILED) AND no valid owner `TrustException` covers the
 *     relay cert-hash, the box enters LOCKDOWN: it stops relaying user
 *     traffic (the caller wires `isRelayAllowed()` into the data path) but
 *     keeps the control/trust channel up so it can still receive a fresh
 *     blessing or an owner exception. It also emits an SOS to the owner.
 *
 * A verdict of `undefined` (no blessing presented / chain unreachable) is
 * NOT a failure — it never locks down, under either flag. Only a concrete
 * `verified === false` does.
 *
 * The cert-hash slug for a relay failure is `relayCertHash(hubKeyPub)`
 * (`@flagship/protocol`), matching the `TrustException.certHash` an owner
 * signs to accept that specific hub key.
 */

import {
  relayCertHash,
  verifyTrustException,
  type RelayVerdict,
  type TrustException,
} from "@flagship/protocol";
import type { RelayTrustVerdict } from "./relayTrustVerifier.js";

/**
 * The propagatable per-box relay-trust snapshot — the four fields the daemon
 * heartbeat signs into a `flagship/box-trust-status/v1` envelope so both ends
 * reflect "talking normally but this server appears unauthorized; an admin
 * approved an override to continue." Computed on EVERY verdict, independent of
 * the enforce flag — detection + propagation always run; only the data-plane
 * lockdown is gated.
 */
export interface RelayTrustSnapshot {
  relayVerdict: RelayVerdict;
  lockedDown: boolean;
  /** relay-class cert-hash of the failing hub key (only when untrusted). */
  failingCertHash: string | null;
  /** relay-class cert-hash an owner TrustException lifted (override active). */
  coveringExceptionCertHash: string | null;
}

export interface RelaySosEvent {
  certClass: "relay";
  /** sha256hex(utf8(hubKeyPub)) — the cert-hash the owner must accept. */
  certHash: string;
  /** lower-hex hub key the failing blessing covered (if known). */
  hubKeyPub?: string;
  reason: string;
  at: number;
}

export interface RelayLockdownState {
  lockedDown: boolean;
  /** The relay cert-hash that triggered lockdown, if any. */
  certHash: string | null;
  reason: string | null;
  since: number | null;
}

export interface RelayLockdownOptions {
  /**
   * Enforcement flag. Default FALSE (OBSERVE) — never locks down. Production
   * reads `process.env.FLAGSHIP_RELAY_TRUST_ENFORCE === "true"`; flipped only
   * after live validation. Mirrors the CA_ENDORSEMENT_ENFORCE pattern.
   */
  enforce?: boolean;
  /**
   * Resolve the owner-signed TrustExceptions that may cover a relay
   * cert-hash. Verified against the IRK-anchored device set (never a
   * `.com`-asserted roster). Returns the candidate exceptions + the
   * allowed device pubkeys to verify them against. Optional — absent ⇒ no
   * exceptions (lockdown proceeds on a fail under ENFORCE).
   */
  resolveTrustExceptions?: (certHash: string) => Promise<{
    exceptions: TrustException[];
    allowedDevicePubs: string[];
  }>;
  /**
   * Emit an SOS to the owner. Log-only by default (mirrors the vibe-code
   * W10 notify hook); production swaps in the .com push relay (STK-signed
   * `flagship/push-relay/v1`, category "trust-alert"), e2e-encrypted to the
   * phone. `.com` is an untrusted carrier — suppression is benign because a
   * locked-down box already appears offline.
   */
  sos?: (e: RelaySosEvent) => void;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Drives the lockdown state from relay-trust verdicts. Pure + injectable;
 * the caller wires `onVerdict` to the verifier and `isRelayAllowed` into
 * the tunnel data path.
 */
export class RelayLockdownController {
  private readonly enforce: boolean;
  private readonly resolveExceptions?: RelayLockdownOptions["resolveTrustExceptions"];
  private readonly sos: (e: RelaySosEvent) => void;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private state: RelayLockdownState = {
    lockedDown: false,
    certHash: null,
    reason: null,
    since: null,
  };
  // The propagatable trust snapshot, maintained on EVERY verdict regardless of
  // the enforce flag (detect+propagate always runs; only lockdown is gated).
  private lastRelayVerdict: RelayVerdict = "unknown";
  private lastFailingCertHash: string | null = null;
  private lastCoveringExceptionCertHash: string | null = null;

  constructor(opts: RelayLockdownOptions = {}) {
    this.enforce = opts.enforce ?? false;
    this.resolveExceptions = opts.resolveTrustExceptions;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((l) => console.log(l));
    this.sos =
      opts.sos ??
      ((e) =>
        this.log(
          `[relay-trust] SOS certClass=${e.certClass} certHash=${e.certHash.slice(0, 16)}… ` +
            `reason=${e.reason} → owner-notify hook fired (push fan-out wiring is operator-supplied)`,
        ));
  }

  /** Whether enforcement is armed (diagnostic). */
  isEnforcing(): boolean {
    return this.enforce;
  }

  /** Snapshot of the current lockdown state. */
  current(): RelayLockdownState {
    return { ...this.state };
  }

  /**
   * The propagatable per-box relay-trust snapshot for the signed
   * box-trust-status heartbeat. Maintained on every verdict, NOT gated by
   * enforce — so a box in OBSERVE still surfaces "untrusted" (and any covering
   * owner override) to the phone; only whether it stops relaying is gated.
   */
  trustStatus(): RelayTrustSnapshot {
    return {
      relayVerdict: this.lastRelayVerdict,
      lockedDown: this.state.lockedDown,
      failingCertHash:
        this.lastRelayVerdict === "untrusted" ? this.lastFailingCertHash : null,
      coveringExceptionCertHash: this.lastCoveringExceptionCertHash,
    };
  }

  /**
   * Whether the box may relay user traffic right now. Wire this into the
   * tunnel data path; under OBSERVE it is ALWAYS true.
   */
  isRelayAllowed(): boolean {
    return !this.state.lockedDown;
  }

  /**
   * Feed a relay-trust verdict. Returns the resulting lockdown state.
   *
   * - `verified === true`  → lift any prior lockdown (a fresh good blessing
   *   recovers the box without an owner exception).
   * - `verified === undefined` → no-op (no verdict reachable).
   * - `verified === false` → under ENFORCE only, lock down + SOS UNLESS a
   *   valid owner TrustException covers this relay cert-hash. Under OBSERVE,
   *   log only.
   */
  async onVerdict(verdict: RelayTrustVerdict): Promise<RelayLockdownState> {
    if (verdict.verified === true) {
      if (this.state.lockedDown) {
        this.log("[relay-trust] fresh valid blessing — lifting lockdown");
      }
      // A good blessing recovers the box AND clears the propagated warning.
      this.lastRelayVerdict = "trusted";
      this.lastFailingCertHash = null;
      this.lastCoveringExceptionCertHash = null;
      this.state = { lockedDown: false, certHash: null, reason: null, since: null };
      return this.current();
    }
    if (verdict.verified === undefined) {
      // No verdict reachable (no blessing presented / chain unreachable). A
      // network blip must stay fail-open — it never locks down AND never flips
      // a prior verdict, so the last known trust snapshot is preserved.
      return this.current();
    }

    // verified === false: a concrete failure. Record it for propagation FIRST
    // (independent of enforce), then resolve any covering owner exception, then
    // — only under enforce — decide the data-plane lockdown.
    const certHash = verdict.hubKeyPub ? relayCertHash(verdict.hubKeyPub) : "unknown";
    this.lastRelayVerdict = "untrusted";
    this.lastFailingCertHash = certHash;

    // Owner exception check: a valid, device-key-signed TrustException for THIS
    // relay cert-hash lets the owner keep using the degraded relay. Run ALWAYS
    // (even under OBSERVE) so a covering override propagates as the
    // "unauthorized but admin-overridden, continuing" state on both ends. The
    // ONE phone-signed exception for certHash X, fanned out to every box via
    // `.com`, is what satisfies all affected servers at once.
    const covered = await this.exceptionCovers(certHash, verdict.hubKeyPub, verdict.reason);
    this.lastCoveringExceptionCertHash = covered ? certHash : null;
    if (covered) {
      // Honor the exception: do NOT lock down (under either flag).
      if (this.state.lockedDown) {
        this.log("[relay-trust] owner exception now covers the failing cert — lifting lockdown");
      }
      this.state = { lockedDown: false, certHash: null, reason: null, since: null };
      return this.current();
    }

    if (!this.enforce) {
      // OBSERVE: still detected + propagated (snapshot is now untrusted,
      // uncovered) but the data plane keeps relaying.
      this.log(
        `[relay-trust] verdict FAILED reason=${verdict.reason} mode=observe ` +
          "(enforce off — NOT locking down; propagating untrusted)",
      );
      return this.current();
    }

    // ENFORCE + uncovered: lock down + SOS.
    if (!this.state.lockedDown) {
      this.state = {
        lockedDown: true,
        certHash,
        reason: verdict.reason,
        since: this.now(),
      };
      this.log(
        `[relay-trust] LOCKDOWN reason=${verdict.reason} certHash=${certHash.slice(0, 16)}… ` +
          "(relaying user traffic STOPPED; control channel kept up for recovery)",
      );
      this.sos({
        certClass: "relay",
        certHash,
        ...(verdict.hubKeyPub ? { hubKeyPub: verdict.hubKeyPub } : {}),
        reason: verdict.reason,
        at: this.now(),
      });
    }
    return this.current();
  }

  /**
   * Whether a valid owner TrustException covers the failing relay cert-hash.
   * Verified against the IRK-anchored device set (never a `.com`-asserted
   * roster). A lookup error is fail-CLOSED for coverage (returns false) so a
   * `.com` outage cannot manufacture an override — under ENFORCE this proceeds
   * to lockdown; under OBSERVE it merely propagates the uncovered failure.
   */
  private async exceptionCovers(
    certHash: string,
    hubKeyPub: string | undefined,
    reason: string,
  ): Promise<boolean> {
    if (!hubKeyPub || !this.resolveExceptions) return false;
    try {
      const { exceptions, allowedDevicePubs } = await this.resolveExceptions(certHash);
      for (const exc of exceptions) {
        if (exc.certClass !== "relay" || exc.certHash !== certHash) continue;
        if (verifyTrustException(exc, allowedDevicePubs).ok) {
          this.log(
            `[relay-trust] verdict FAILED reason=${reason} but owner ` +
              `TrustException covers certHash=${certHash.slice(0, 16)}… — relaying allowed`,
          );
          return true;
        }
      }
    } catch (e) {
      this.log(
        `[relay-trust] exception lookup error=${e instanceof Error ? e.message : String(e)} ` +
          "— treating as UNCOVERED (fail-closed)",
      );
    }
    return false;
  }

  /**
   * Manually clear lockdown — e.g. after an owner exception arrives
   * out-of-band. Idempotent.
   */
  clear(): void {
    this.state = { lockedDown: false, certHash: null, reason: null, since: null };
  }
}

/** Read the enforce flag from the environment (default OFF). */
export function relayTrustEnforceFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.FLAGSHIP_RELAY_TRUST_ENFORCE === "true";
}
