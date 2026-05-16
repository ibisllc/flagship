/**
 * Link-1 of the consumer CA-trust chain
 * (docs/maintainer-ca-endorsement.md §9). Every CA-signed artifact
 * (`UserPubKeyBinding`, `DemoDirective`) is accepted iff ALL four
 * links hold at the consumer's clock `now`:
 *
 *   1. pinned maintainer GENESIS pubkey(s)            — this module
 *   2. ca-track authority at now (verifyTrack(ca))    — chain port
 *   3. live CaEndorsement → authorizedCaKeys(now)     — chain port
 *   4. the artifact's own signature + TTL             — this module
 *
 * `MAINTAINER_GENESIS_PUBKEYS` is the link-1 anchor and is **empty
 * until the first real YubiKey genesis ceremony** bakes the real
 * pubkey in (ca-operations.md "Operation 0 — genesis"). While empty,
 * EVERY CA-signed artifact is rejected (fail closed). That is safe
 * pre-release: the demo account uses mock recovery, there are no real
 * users, nothing is shipped. A consumer MUST NOT fall back to a
 * previously-seen or env-provided CA key — the absence of a genesis
 * is a hard reject, never a downgrade.
 *
 * Links 2-3 are supplied by the consumer as a `CaTrustChain` (the
 * daemon and each client port `@maintainers/protocol`'s
 * `verifyTrack`/`verifyCaEndorsements`/`authorizedCaKeys` over the
 * pinned `.maintainers` snapshot — tasks #8/#9/#10). This module
 * stays free of `@maintainers/protocol` so it can ship to every
 * consumer (incl. the mobile mirrors) before that wiring lands; the
 * chain port is dependency-injected. When genesis is unconfigured the
 * port is never even consulted.
 */

import type { Bytes } from "./types.js";
import {
  verifyDemoDirective,
  verifyUserPubKeyBinding,
  type DemoDirective,
  type UserPubKeyBinding,
} from "./auth.js";

/**
 * Baked-in maintainer genesis pubkeys (lower-case hex Ed25519). EMPTY
 * until the real genesis ceremony — see the module doc. The real swap
 * is the documented pre-release step; do not populate this with a
 * placeholder in a shipped build.
 */
export const MAINTAINER_GENESIS_PUBKEYS: readonly string[] = Object.freeze([]);

export function maintainerGenesisConfigured(
  genesisPubkeys: readonly string[] = MAINTAINER_GENESIS_PUBKEYS,
): boolean {
  return genesisPubkeys.length > 0;
}

/**
 * Links 2-3, injected by the consumer. `authorizedCaKeys(now)` walks
 * pinned-genesis → ca-track → live CaEndorsement and returns the
 * operational CA pubkeys (lower-case hex) authorized at `now`. It is
 * NEVER called when link-1 (genesis) is unconfigured.
 */
export interface CaTrustChain {
  authorizedCaKeys(now: number): string[];
}

export type CaArtifactReject =
  | "genesis-unconfigured"
  | "no-authorized-ca-keys"
  | "artifact-expired"
  | "signature-unverified";

export type CaGateResult =
  | { ok: true; keys: string[] }
  | { ok: false; reason: CaArtifactReject };

/**
 * Resolve the operational CA keys a consumer may currently trust, or
 * fail closed. Empty/absent genesis ⇒ `genesis-unconfigured` and the
 * chain port is not consulted. An empty authorized set (lapsed/no
 * lease) ⇒ `no-authorized-ca-keys`. Either way: reject ALL CA
 * artifacts; never fall back to another key.
 */
export function authorizedCaKeysOrFailClosed(
  chain: CaTrustChain | null,
  now: number,
  genesisPubkeys: readonly string[] = MAINTAINER_GENESIS_PUBKEYS,
): CaGateResult {
  if (!maintainerGenesisConfigured(genesisPubkeys)) {
    return { ok: false, reason: "genesis-unconfigured" };
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
 * shipped (empty) genesis this always rejects `genesis-unconfigured`
 * — the only correct pre-release behavior.
 */
export function verifyCaSignedDemoDirective(
  d: DemoDirective,
  sig: Bytes,
  chain: CaTrustChain | null,
  now: number,
  genesisPubkeys: readonly string[] = MAINTAINER_GENESIS_PUBKEYS,
): { ok: true } | { ok: false; reason: CaArtifactReject } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, genesisPubkeys);
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
  genesisPubkeys: readonly string[] = MAINTAINER_GENESIS_PUBKEYS,
): { ok: true } | { ok: false; reason: CaArtifactReject } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, genesisPubkeys);
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
