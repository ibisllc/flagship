/**
 * Link-4 of the consumer CA-trust chain, daemon side
 * (docs/maintainer-ca-endorsement.md §9; tasks #8/#9/#10).
 *
 * `@flagship/protocol`'s `maintainerCa.ts` ships the #30 chokepoint
 * (`verifyCaSigned{DemoDirective,UserPubKeyBinding}`) with the chain
 * port — links 2-3 — *dependency-injected* as a `CaTrustChain`, so
 * that module can ship to every consumer (incl. the mobile mirrors)
 * without taking a `@maintainers/protocol` dependency. This module is
 * the daemon's concrete port: it adapts `@maintainers/protocol`'s
 * `authorizedCaKeys` (links 2-3 over the pinned `.maintainers`
 * snapshot) to the `CaTrustChain` interface.
 *
 * Two impedance mismatches it bridges, nothing more:
 *   - clock: `CaTrustChain.authorizedCaKeys(now)` takes epoch-ms
 *     (`number`); `@maintainers/protocol` takes a `Date`.
 *   - inputs: the maintainers fn needs the verified ca-track, its
 *     approval rule, and the live CaEndorsement set. The first two
 *     come from the daemon's existing on-disk verifier
 *     (`verifiedTrackFromFolder` in releaseVerifier.ts). The
 *     CaEndorsement set is taken as an explicit argument — there is
 *     deliberately NO on-disk CaEndorsement convention yet (the
 *     maintainers store reader only knows `endorsements/` =
 *     ReleaseEndorsement; a ca-endorsement directory convention is
 *     genuine upstream-undefined work, NOT invented here).
 *
 * While `MAINTAINER_PINNED_MANDATE_HASH` is empty the #30 chokepoint
 * fail-closes (`pin-unconfigured`) and never calls this port at
 * all — so this wire is correctly inert until the real Gate-B
 * ceremony bakes the pinned-mandate hash in. It is built + unit-tested
 * now so that step is the only remaining flip. (The verify-forward-
 * from-pin migration of this port itself is c4.4.)
 */

import {
  authorizedCaKeys,
  type ApprovalRule,
  type CaEndorsement,
  type VerifiedTrack,
} from "@maintainers/protocol";
import type { CaTrustChain } from "@flagship/protocol";

/**
 * Build a `CaTrustChain` (#30 links 2-3) from a verified ca-class
 * track + its approval rule + the live CaEndorsement set.
 *
 * `authorizedCaKeys(now)` returns the operational CA pubkeys (lower
 * hex) a consumer may currently accept CA-signed artifacts under, or
 * `[]` — which the #30 chokepoint treats as `no-authorized-ca-keys`
 * (fail closed; never a fall-back to a previously-seen key).
 */
export function makeCaTrustChain(
  caTrack: VerifiedTrack,
  approvalRule: ApprovalRule,
  caEndorsements: CaEndorsement[],
  opts: { clockSkewMs?: number } = {},
): CaTrustChain {
  return {
    authorizedCaKeys(now: number): string[] {
      return authorizedCaKeys(
        caEndorsements,
        caTrack,
        approvalRule,
        new Date(now),
        opts,
      );
    },
  };
}
