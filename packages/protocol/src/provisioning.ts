/**
 * Provisioning observability domain — the named PHASE checkpoints a box
 * pushes during provisioning (incl. the ACME sub-phases) and the
 * identity-signed `ProvisionEvent` envelope.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; the phase
 * lists, tag, field order, and guard are unchanged, so canonical bytes and
 * signatures remain byte-identical. (Imported by `provisionProgress.ts`.)
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

/**
 * Demo-server provisioning observability — a named PHASE checkpoint the
 * box pushes to .com so the phone (and debug tooling) can see exactly
 * which step provisioning is on rather than a black box.
 *
 * The phase sequence is two segments:
 *   - cloud-init bootstrap:  boot → cloned → deps → built → identity
 *     (the existing /api/server/register stamps `registered`).
 *   - daemon:                tunnel-online → [ACME sub-phases] →
 *                            cert-issued → ready.
 *   - any step may end at:    failed { phase, error }.
 *
 * The ACME sub-phases between `tunnel-online` and `cert-issued` make the
 * cert handshake a glass box. The daemon requests a SAN bundle that needs
 * BOTH a TLS-ALPN-01 challenge (the apex/user-zone name) AND DNS-01
 * challenges (the wildcards), so a stall can be in either path. The
 * sub-phases pinpoint WHICH step is stuck from the phone + a public `dig`,
 * with NO box access:
 *   - `acme-order`           order created with LE; authorizations fetched.
 *   - `dns01-publish-attempt` POSTing the signed TXT claim to .com.
 *   - `dns01-publish-ok`     .com accepted the claim + wrote the TXT.
 *   - `dns01-propagation-wait` waiting for the TXT to propagate before
 *                            telling LE to validate (LE caches NXDOMAIN).
 *   - `tlsalpn-served`       the TLS-ALPN-01 challenge cert is presented.
 *   - `acme-validating`      LE is validating the challenges.
 * On a stuck cert the LAST sub-phase the box reached is the failure
 * locus: stuck at `dns01-publish-attempt` ⇒ the .com publish call is
 * failing; reached `dns01-publish-ok` but the public `dig` shows no TXT
 * ⇒ a CF/broker write gap; stuck at `acme-validating` after both
 * challenges set up ⇒ LE can't reach the box (TLS-ALPN-01) or the TXT
 * (DNS-01).
 *
 * Two emission channels share this phase vocabulary:
 *   - Pre-daemon (bootstrap) events authenticate with the auth-code
 *     serial the box already holds — a low-stakes DISPLAY signal, not a
 *     security boundary, validated only against a `provisioning` row.
 *   - Daemon events are Ed25519-signed by the server identity (same key
 *     as daemon-status), so the canonical bytes + sign/verify below are
 *     the daemon's channel.
 */
export const PROVISION_PHASES = [
  "boot",
  "cloned",
  "deps",
  "built",
  "identity",
  "registered",
  "tunnel-online",
  // ---- ACME sub-phases (daemon channel) ----
  "acme-order",
  "dns01-publish-attempt",
  "dns01-publish-ok",
  "dns01-propagation-wait",
  "tlsalpn-served",
  "acme-validating",
  // ------------------------------------------
  "cert-issued",
  "ready",
  "failed",
] as const;

export type ProvisionPhase = (typeof PROVISION_PHASES)[number];

/** The fine-grained ACME sub-phases, in the order the issuer reaches
 *  them. Exported so the daemon's issuer-observability shim and the
 *  control-plane phase-title maps stay in lockstep with this list. */
export const ACME_PROVISION_SUBPHASES = [
  "acme-order",
  "dns01-publish-attempt",
  "dns01-publish-ok",
  "dns01-propagation-wait",
  "tlsalpn-served",
  "acme-validating",
] as const;

export type AcmeProvisionSubphase = (typeof ACME_PROVISION_SUBPHASES)[number];

/** Daemon-emitted phases — the ones signed by the server identity. The
 *  bootstrap emits the earlier (auth-code-serial-authenticated) phases. */
export const DAEMON_PROVISION_PHASES = [
  "tunnel-online",
  ...ACME_PROVISION_SUBPHASES,
  "cert-issued",
  "ready",
  "failed",
] as const;

export function isProvisionPhase(s: string): s is ProvisionPhase {
  return (PROVISION_PHASES as readonly string[]).includes(s);
}

export interface ProvisionEvent {
  serverDomain: ServerId;
  phase: ProvisionPhase;
  /** Free-text failure detail; only meaningful when `phase === "failed"`. */
  error: string;
  issuedAt: number;
}

const TAG_PROVISION_EVENT = "flagship/provision-event/v1";

function canonicalProvisionEvent(e: ProvisionEvent): Bytes {
  legacyFieldGuard("error", e.error);
  return new TextEncoder().encode(
    [
      TAG_PROVISION_EVENT,
      e.serverDomain,
      e.phase,
      e.error,
      e.issuedAt,
    ].join("|"),
  );
}

export function signProvisionEvent(e: ProvisionEvent, identity: Keypair): Bytes {
  return ed.sign(canonicalProvisionEvent(e), identity.privateKey);
}

export function verifyProvisionEvent(
  e: ProvisionEvent,
  sig: Bytes,
  identityPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalProvisionEvent(e), identityPub);
  } catch {
    return false;
  }
}
