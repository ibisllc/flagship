/**
 * Link-4 of the consumer CA-trust chain, daemon side
 * (docs/maintainer-ca-endorsement.md §9; tasks #8/#9/#10).
 * **LOCKED Phase-2 v2 model.**
 *
 * `@flagship/protocol`'s `maintainerCa.ts` ships the #30 chokepoint
 * (`verifyCaSigned{DemoDirective,UserPubKeyBinding}`) with the chain
 * port — links 2-3 — *dependency-injected* as a `CaTrustChain`, so that
 * module can ship to every consumer (incl. the mobile mirrors) without
 * taking a `@maintainers/protocol` dependency. This module is the
 * daemon's concrete port: it adapts `@maintainers/protocol`'s
 * `authorizedCaKeys` (links 2-3: verify the ca-track mandate log
 * FORWARD from the baked pin, then resolve the live `CaEndorsement`
 * lease at `now`) to the `CaTrustChain` interface.
 *
 * The one impedance mismatch it bridges: `CaTrustChain.authorizedCaKeys`
 * takes epoch-ms (`number`); `@maintainers/protocol` takes a `Date`.
 * The verified ca-track chain comes from the daemon's on-disk verifier
 * (`verifiedTrackFromFolder` in releaseVerifier.ts), which already
 * anchored it at the baked pin. The CaEndorsement set is an explicit
 * argument (the on-disk `ca-endorsements/` convention is consumed by
 * the caller, not invented here).
 *
 * While `MAINTAINER_PINNED_MANDATE_HASH` is empty the #30 chokepoint
 * fail-closes (`pin-unconfigured`) and never calls this port; the port
 * itself also yields `[]` (the pin-anchored chain has no valid
 * mandates) — fail-closed at two independent layers. Real keys flow
 * only once Gate B bakes the pinned-mandate hash in.
 */

import {
  authorizedCaKeys,
  type CaEndorsement,
  type VerifiedChain,
} from "@maintainers/protocol";
import type { CaTrustChain } from "@flagship/protocol";

/**
 * Build a `CaTrustChain` (#30 links 2-3) from a verify-forward-from-pin
 * ca-track chain + the live CaEndorsement set.
 *
 * `authorizedCaKeys(now)` returns the operational CA pubkeys (lower hex)
 * a consumer may currently accept CA-signed artifacts under, or `[]` —
 * which the #30 chokepoint treats as `no-authorized-ca-keys` (fail
 * closed; never a fall-back to a previously-seen key). An empty/forked
 * baked pin makes `caChain.validMandates` empty ⇒ no ca authority at
 * `now` ⇒ `[]`.
 */
export function makeCaTrustChain(
  caChain: VerifiedChain,
  caEndorsements: CaEndorsement[],
  opts: { clockSkewMs?: number } = {},
): CaTrustChain {
  return {
    authorizedCaKeys(now: number): string[] {
      return authorizedCaKeys(caEndorsements, caChain, new Date(now), opts);
    },
  };
}
