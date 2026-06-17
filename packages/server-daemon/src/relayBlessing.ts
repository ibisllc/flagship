/**
 * `shouldRelayThroughHub` — the box's pure pre-connect gate over a
 * `.services` relay blessing (docs/maintainer-trust-enforcement.md §
 * "The relay blessing").
 *
 * Before connecting to the tunnel hub, the daemon verifies the
 * `ServiceBlessing` the hub presents — `pin → forward ca-track chain →
 * CA key authorized now → blessing not expired` — exactly the chain the
 * `.com` directory attestation uses, via `makeCaTrustChain`
 * (`caTrustChain.ts`). A pass means the relay holds a `.com`-blessed key;
 * a fail means lockdown + a relay-class SOS.
 *
 * This module is DELIBERATELY pure + side-effect-free. It is NOT wired
 * into the live tunnel connect path here: the connect/lockdown state
 * machine, the `.services` self-key generation, and the SOS emit all need
 * supervised live-tunnel integration (a box on metal, a real hub
 * presenting/challenging the blessing). Wiring it prematurely against
 * today's expired `.com` lease would lock down every box. See the spec's
 * "Sequencing constraint": enforcement ships only after the lease is
 * re-established + exposed. TODO(live-integration): call this from the
 * tunnel client's pre-connect step and drive lockdown/SOS on `!ok`.
 */

import {
  verifyCaSignedServiceBlessing,
  type CaTrustChain,
  type ServiceBlessing,
} from "@flagship/protocol";

export type RelayGateReason =
  | "ok"
  | "pin-unconfigured"
  | "no-authorized-ca-keys"
  | "artifact-expired"
  | "signature-unverified";

export interface RelayGateResult {
  ok: boolean;
  reason: RelayGateReason;
}

/**
 * Decide whether the box may relay through a hub presenting `blessing`.
 *
 * @param blessing the ServiceBlessing the hub presented (or the box
 *                 challenged out of it).
 * @param chain    the box's maintainer CaTrustChain (links 2-3), built via
 *                 `makeCaTrustChain(verifiedCaChain, caEndorsements)`. A
 *                 `null` chain fails closed (no authorized keys).
 * @param pinnedHash the box's baked `MAINTAINER_PINNED_MANDATE_HASH`.
 * @param now      epoch ms (the box's clock).
 */
export function shouldRelayThroughHub(
  blessing: ServiceBlessing,
  chain: CaTrustChain | null,
  pinnedHash: string,
  now: number,
): RelayGateResult {
  const verdict = verifyCaSignedServiceBlessing(blessing, chain, now, pinnedHash);
  if (verdict.ok) return { ok: true, reason: "ok" };
  return { ok: false, reason: verdict.reason };
}
