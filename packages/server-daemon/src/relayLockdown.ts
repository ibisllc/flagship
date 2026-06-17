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
  type TrustException,
} from "@flagship/protocol";
import type { RelayTrustVerdict } from "./relayTrustVerifier.js";

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
      this.state = { lockedDown: false, certHash: null, reason: null, since: null };
      return this.current();
    }
    if (verdict.verified === undefined) {
      // No verdict (no blessing / chain unreachable). Never locks down.
      return this.current();
    }

    // verified === false.
    if (!this.enforce) {
      this.log(
        `[relay-trust] verdict FAILED reason=${verdict.reason} mode=observe ` +
          "(enforce off — NOT locking down)",
      );
      return this.current();
    }

    const certHash = verdict.hubKeyPub ? relayCertHash(verdict.hubKeyPub) : "unknown";

    // Owner exception check: a valid, device-key-signed TrustException for
    // THIS relay cert-hash lets the owner keep using the degraded relay.
    if (verdict.hubKeyPub && this.resolveExceptions) {
      try {
        const { exceptions, allowedDevicePubs } = await this.resolveExceptions(certHash);
        for (const exc of exceptions) {
          if (exc.certClass !== "relay" || exc.certHash !== certHash) continue;
          if (verifyTrustException(exc, allowedDevicePubs).ok) {
            this.log(
              `[relay-trust] verdict FAILED reason=${verdict.reason} but owner ` +
                `TrustException covers certHash=${certHash.slice(0, 16)}… — relaying allowed`,
            );
            // Honor the exception: do NOT lock down.
            this.state = {
              lockedDown: false,
              certHash: null,
              reason: null,
              since: null,
            };
            return this.current();
          }
        }
      } catch (e) {
        this.log(
          `[relay-trust] exception lookup error=${e instanceof Error ? e.message : String(e)} ` +
            "— proceeding to lockdown (fail-closed under enforce)",
        );
      }
    }

    // Lock down + SOS.
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
