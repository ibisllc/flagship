/**
 * Link-1 of the consumer CA-trust chain
 * (docs/maintainer-ca-endorsement.md §9). Every CA-signed artifact
 * (`UserPubKeyBinding`, `DemoDirective`) is accepted iff ALL four
 * links hold at the consumer's clock `now`:
 *
 *   1. the baked pinned-Mandate canonical hash                — this module
 *   2. ca-track authority at now (verify FORWARD from the pin) — chain port
 *   3. live CaEndorsement → operational CA keys at now         — chain port
 *   4. the artifact's own signature + TTL                      — this module
 *
 * #30 GENERALISED to the LOCKED Phase-2 v2 trust model (see flagship
 * `docs/v1-launch-program.md` "Phase-2 DESIGN DECISION — LOCKED v2"):
 *
 *   L1 — a pinned `Mandate` is an INDEPENDENT trust anchor; "genesis" is
 *   merely "the first pin". The baked link-1 value is therefore the
 *   **canonical hash of the pinned mandate** (`mandatePinHash`, sha256
 *   of `canonicalMandate`), NOT a maintainer-pubkey list. The chain
 *   port (link-2/3, supplied by the consumer) verifies the mandate log
 *   FORWARD from that pin. Multiple pinned roots coexist forever — an
 *   old build pinned at M₀ and a newer build pinned at a later, more
 *   co-signed Mᵢ are each independently valid; nothing walks back to a
 *   privileged "genesis". This same hash is re-baked per surface
 *   (this TS const for daemon+webapp; the iOS/Android ports hardcode the
 *   identical value into their own source — #10).
 *
 * `MAINTAINER_PINNED_MANDATE_HASH` is the link-1 anchor. The invariant
 * is: while it is the **empty string** EVERY CA-signed artifact is
 * rejected (fail closed) — a consumer MUST NOT fall back to a
 * previously-seen or env-provided pin; the absence of a baked pin is a
 * hard reject, never a downgrade. Gate B (the first real YubiKey
 * ceremony, ca-operations.md "Operation 0") is now COMPLETE: the const
 * is POPULATED with the canonical hash of the committed `ca` ORIGIN
 * mandate in `.maintainers/`, so the chain port is now consulted and the
 * trust chain verifies FORWARD from that live pin. The empty-⇒-fail-
 * closed invariant above still holds and is still exercised by tests
 * that pass an explicit empty pin.
 *
 * Links 2-3 are supplied by the consumer as a `CaTrustChain` (the daemon
 * and each client port `@ibisllc/maintainers`'s
 * `verifyMandateChainFromPin`/`currentAuthority` +
 * `authorizedCaKeys` over the pinned `.maintainers` snapshot — tasks
 * #8/#9/#10). This module stays free of `@ibisllc/maintainers` so it
 * can ship to every consumer (incl. the mobile mirrors) before that
 * wiring lands; the chain port is dependency-injected and closes over
 * the baked pin itself. When the pin is unconfigured the port is never
 * even consulted.
 */

import type { Bytes } from "./types.js";
import {
  verifyDemoDirective,
  verifyUserPubKeyBinding,
  type DemoDirective,
  type UserPubKeyBinding,
} from "./auth.js";

/**
 * Baked-in pinned-Mandate canonical hash (lower-case hex sha256 of the
 * pinned `Mandate`'s `canonicalMandate` bytes — see
 * `@ibisllc/maintainers` `mandatePinHash`). POPULATED by the real Gate-B
 * ceremony (2026-05-19) with the canonical hash of the committed `ca`
 * ORIGIN mandate in `.maintainers/` — see the module doc. While this is
 * the empty string the surface fail-closes (rejects every CA artifact);
 * it is now the live anchor. Re-baked per surface to the SAME value
 * (#30 generalised; the iOS/Android ports hardcode the identical value
 * — #10).
 */
export const MAINTAINER_PINNED_MANDATE_HASH =
  "5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae";

export function maintainerPinConfigured(
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): boolean {
  return typeof pinnedMandateHash === "string" && pinnedMandateHash.length > 0;
}

/**
 * Links 2-3, injected by the consumer. `authorizedCaKeys(now)` verifies
 * the ca-track mandate log FORWARD from the baked pin the port closes
 * over, then resolves the live `CaEndorsement` lease, and returns the
 * operational CA pubkeys (lower-case hex) authorized at `now` — or `[]`.
 * It is NEVER called when link-1 (the baked pin) is unconfigured.
 */
export interface CaTrustChain {
  authorizedCaKeys(now: number): string[];
}

export type CaArtifactReject =
  | "pin-unconfigured"
  | "no-authorized-ca-keys"
  | "artifact-expired"
  | "signature-unverified";

export type CaGateResult =
  | { ok: true; keys: string[] }
  | { ok: false; reason: CaArtifactReject };

/**
 * Resolve the operational CA keys a consumer may currently trust, or
 * fail closed. Empty/absent pin ⇒ `pin-unconfigured` and the chain port
 * is not consulted. An empty authorized set (lapsed/no lease, or a
 * pin-not-in-log forward-verify failure) ⇒ `no-authorized-ca-keys`.
 * Either way: reject ALL CA artifacts; never fall back to another key.
 */
export function authorizedCaKeysOrFailClosed(
  chain: CaTrustChain | null,
  now: number,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): CaGateResult {
  if (!maintainerPinConfigured(pinnedMandateHash)) {
    return { ok: false, reason: "pin-unconfigured" };
  }
  if (!chain) return { ok: false, reason: "no-authorized-ca-keys" };
  const keys = chain.authorizedCaKeys(now);
  if (!keys || keys.length === 0) {
    return { ok: false, reason: "no-authorized-ca-keys" };
  }
  return { ok: true, keys };
}

function hexToBytes(h: string): Bytes {
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

function withinTtl(issuedAt: number, expiresAt: number, now: number): boolean {
  return now >= issuedAt && now < expiresAt;
}

/**
 * The single chokepoint a consumer calls instead of
 * `verifyDemoDirective` + a raw `caPub`. Enforces links 1-4. With the
 * shipped (empty) pin this always rejects `pin-unconfigured` — the only
 * correct pre-release behavior.
 */
export function verifyCaSignedDemoDirective(
  d: DemoDirective,
  sig: Bytes,
  chain: CaTrustChain | null,
  now: number,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true } | { ok: false; reason: CaArtifactReject } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!gate.ok) return gate;
  if (!withinTtl(d.issuedAt, d.expiresAt, now)) {
    return { ok: false, reason: "artifact-expired" };
  }
  for (const k of gate.keys) {
    let caPub: Bytes;
    try {
      caPub = hexToBytes(k);
    } catch {
      continue;
    }
    if (verifyDemoDirective(d, sig, caPub)) return { ok: true };
  }
  return { ok: false, reason: "signature-unverified" };
}

/** Link-1-4 chokepoint for `UserPubKeyBinding` (directory attestation). */
export function verifyCaSignedUserPubKeyBinding(
  b: UserPubKeyBinding,
  sig: Bytes,
  chain: CaTrustChain | null,
  now: number,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true } | { ok: false; reason: CaArtifactReject } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!gate.ok) return gate;
  if (!withinTtl(b.issuedAt, b.expiresAt, now)) {
    return { ok: false, reason: "artifact-expired" };
  }
  for (const k of gate.keys) {
    let caPub: Bytes;
    try {
      caPub = hexToBytes(k);
    } catch {
      continue;
    }
    if (verifyUserPubKeyBinding(b, sig, caPub)) return { ok: true };
  }
  return { ok: false, reason: "signature-unverified" };
}
