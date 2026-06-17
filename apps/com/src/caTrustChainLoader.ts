/**
 * Worker-side construction of the #30 maintainer→CA `CaTrustChain`.
 *
 * The Cloudflare Worker has NO filesystem, so the daemon's
 * `releaseVerifier` (fs-based) cannot run here. Instead this module
 * `import`s the committed ca-track mandate chain + the committed
 * `CaEndorsement` bundle as bundled JSON (esbuild inlines both into the
 * Worker script — a few KB) and runs the REAL `@ibisllc/maintainers`
 * verifier over them, exactly the same algorithm the daemon runs:
 *
 *   verifyMandateChainFromPin(BAKED_PIN, caTrackMandates)   // links 1-2
 *     → verifyCaEndorsements(endorsements, chain, now)       // link 3
 *       (wrapped as a CaTrustChain via authorizedCaKeys)
 *
 * This is NOT a weakened shortcut: the Worker does not "trust a
 * pre-verified endorsement" or "only check the lease TTL + signature".
 * It re-derives the forward-from-pin ca-track authority and resolves
 * the live lease itself, every request, from the SAME baked
 * `MAINTAINER_PINNED_MANDATE_HASH` every other surface bakes. A
 * forked/tampered chain or a forged endorsement yields `[]` authorized
 * keys ⇒ the protocol chokepoint fail-closes.
 *
 * The pin lives in `@flagship/protocol`; the verifier in
 * `@ibisllc/maintainers`; this module only glues them to the JSON the
 * repo commits under `.maintainers/`.
 */

import {
  authorizedCaKeys,
  verifyMandateChainFromPin,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import {
  MAINTAINER_PINNED_MANDATE_HASH,
  type CaTrustChain,
} from "@flagship/protocol";

// Bundled at build time by esbuild/wrangler (resolveJsonModule).
// Path: apps/com/src → repo root `.maintainers/`.
// The ca-track ORIGIN mandate (the pin anchors exactly this file's
// canonical bytes — see Gate B / docs/ca-operations.md).
import caOriginMandate from "../../../.maintainers/tracks/ca/mandates/20260519T120808-706880c9.json";
// The committed CaEndorsement leases. Starts `[]`; the human ceremony
// appends (see docs/ca-operations.md "CaEndorsement ceremony runbook").
import caEndorsementsBundle from "../../../.maintainers/ca-endorsements/bundle.json";

/**
 * The committed ca-track mandate log, oldest-first (canonical-log
 * order). Today this is the single ORIGIN mandate; successor mandates
 * (added by future ceremonies) extend this array — keep it
 * filename-sorted, exactly the daemon's `readStoreFromDisk` convention.
 */
const CA_TRACK_MANDATES: Mandate[] = [caOriginMandate as Mandate];

const CA_ENDORSEMENTS: CaEndorsement[] = caEndorsementsBundle as CaEndorsement[];

/**
 * Build the #30 `CaTrustChain` the control-plane handlers consult. The
 * forward chain is verified ONCE at module load (the mandate JSON is
 * static for the lifetime of a deployed bundle); the live-lease
 * resolution (`authorizedCaKeys`) is re-run per request at the caller's
 * `now`, so a lease that expires between two requests is correctly
 * dropped without a redeploy. Pure functions over injected JSON — no
 * I/O, Worker-safe.
 */
export function workerCaTrustChain(
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): CaTrustChain {
  const verifiedChain = verifyMandateChainFromPin(
    pinnedMandateHash,
    CA_TRACK_MANDATES,
  );
  return {
    authorizedCaKeys(now: number): string[] {
      return authorizedCaKeys(CA_ENDORSEMENTS, verifiedChain, new Date(now));
    },
  };
}

/**
 * Read the deploy-safe ENFORCE switch. Default (unset / not exactly
 * "true") ⇒ OBSERVE — the gate logs its verdict but signing proceeds
 * byte-for-byte as today. A human flips this to the literal string
 * `"true"` ONLY after a valid CaEndorsement is committed and verified
 * (docs/ca-operations.md). This is the single, documented control.
 */
export function caEnforceFromEnv(
  env: Record<string, string | undefined>,
): boolean {
  return env.CA_ENDORSEMENT_ENFORCE === "true";
}

/**
 * OPS-3 — the `notAfter` (ms) of every committed CA endorsement whose
 * authority resolves at `now` (i.e. the leases `authorizedCaKeys` would
 * return a key for). Drives the CA-lease lapse warning + the
 * `/api/admin/ca-lease-status` endpoint. Reuses the SAME committed bundle
 * + verified chain the gate consults, so it can never disagree with the
 * authority the signing path enforces.
 */
/**
 * The PUBLIC maintainer-trust material a client needs to verify, for
 * itself, that `.com` is maintainer-blessed: the baked pin, the ca-track
 * mandate log, and the committed CaEndorsement bundle. All of this is
 * already public (it lives in the repo under `.maintainers/`); serving it
 * is not a trust grant — a client re-derives `verifyMandateChainFromPin →
 * authorizedCaKeys(clientNow)` against its OWN baked pin and confirms the
 * served CA pubkey is in the resulting set. A rogue `.com` cannot forge a
 * chain that hashes to the baked pin, so this endpoint is safe even when
 * `.com` is the suspected party.
 */
export function caTrustChainPublicMaterial(): {
  pinnedMandateHash: string;
  mandates: readonly Mandate[];
  caEndorsements: readonly CaEndorsement[];
} {
  return {
    pinnedMandateHash: MAINTAINER_PINNED_MANDATE_HASH,
    mandates: CA_TRACK_MANDATES,
    caEndorsements: CA_ENDORSEMENTS,
  };
}

export function activeCaLeaseNotAfterMs(now: number): number[] {
  const verifiedChain = verifyMandateChainFromPin(
    MAINTAINER_PINNED_MANDATE_HASH,
    CA_TRACK_MANDATES,
  );
  // An endorsement contributes authority iff its caPubkey is among the
  // keys authorizedCaKeys resolves at `now` AND it is itself live
  // (notBefore <= now < notAfter). We filter the committed endorsements
  // by the resolved key set, then surface their notAfter timestamps.
  const liveKeys = new Set(
    authorizedCaKeys(CA_ENDORSEMENTS, verifiedChain, new Date(now)),
  );
  const out: number[] = [];
  for (const e of CA_ENDORSEMENTS) {
    if (!liveKeys.has(e.caPubkey)) continue;
    const notAfter = Date.parse(e.notAfter);
    const notBefore = Date.parse(e.notBefore);
    if (Number.isNaN(notAfter)) continue;
    if (!Number.isNaN(notBefore) && now < notBefore) continue;
    // Skip a lease past its OWN window. A still-live sibling lease can
    // re-authorize the same caPubkey (e.g. a backdated renewal committed
    // alongside the lapsed original) — so the key is in `liveKeys` — but
    // the EXPIRED lease's notAfter must not be reported, or the soonest-
    // expiry is the past date and the status/cron false-alarm "expired"
    // while the authority is actually live.
    if (now >= notAfter) continue;
    out.push(notAfter);
  }
  return out;
}
