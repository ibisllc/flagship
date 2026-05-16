/**
 * Custom-domain cert: lead-pod ACME + sibling-only replication
 * (#79B / Phase 4 C4.1c).
 *
 * The fleet model (project_external_domains): a user's custom (external)
 * domain gets ONE cert, minted by the LEAD pod via ACME TLS-ALPN-01
 * over the existing SNI-passthrough chain, then replicated — cert AND
 * private key — to the user's OTHER pods so failover is instant and
 * Let's Encrypt rate limits never sit in the critical path. Siblings
 * NEVER ACME a custom domain themselves; they only receive.
 *
 * THE ONE SECURITY RULE: the cert + private key leave this pod over
 * the authenticated sibling-sync channel ONLY — NEVER peerBackup /
 * peerLink. peerBackup is a stranger storage mesh; the user's TLS
 * private key reaching it would let an unrelated party terminate TLS
 * for the user's domain. This is enforced three ways:
 *
 *   1. Type: the replication seam is {@link SiblingCertSender}, whose
 *      sole method is `pushCustomDomainCert`. PeerBackupClient's shape
 *      is `put/get/challenge` — structurally unassignable here, so a
 *      cross-wire is a compile error, not a runtime hope.
 *   2. This module imports nothing from ../peerBackup or ../peerLink,
 *      and a guard test asserts those modules never import this one
 *      nor name CustomDomainCert.
 *   3. The bundle is signed by the issuing pod's STK identity and the
 *      receiver re-verifies it under a pod identity the sibling-sync
 *      layer already authenticated as a member of this user's fleet —
 *      so even a channel-auth bug can't make a sibling install a cert
 *      a non-fleet pod produced.
 */

import {
  signCustomDomainCert,
  verifyCustomDomainCert,
  type Bytes,
  type CustomDomainCert,
  type Keypair,
} from "@flagship/protocol";
import type { AcmeIssuer, EncryptedCertStore } from "../acme.js";
import type { CertManager } from "../certManager.js";

/** Disk-store key namespace so a custom cert never collides with the
 *  pod's own flagship.services cert entry. */
function storeKey(fqdn: string): string {
  return `custom:${fqdn.toLowerCase()}`;
}

/**
 * The ONLY way a custom-domain cert+key leaves this pod. Implemented
 * over the authenticated sibling-sync channel. Deliberately a single
 * narrow method whose shape shares nothing with PeerBackupClient.
 */
export interface SiblingCertSender {
  pushCustomDomainCert(bundle: CustomDomainCert, signature: Bytes): void;
}

/**
 * Fresher-wins store of replicated bundles, keyed by fqdn. A strictly
 * greater `issuedAt` replaces (mirrors AppGrantStore.applyIfFresher) —
 * a stale bundle can never blank a live newer cert.
 */
export class CustomDomainCertStore {
  private byFqdn = new Map<string, { bundle: CustomDomainCert; signature: Bytes }>();

  get(fqdn: string): { bundle: CustomDomainCert; signature: Bytes } | undefined {
    return this.byFqdn.get(fqdn.toLowerCase());
  }

  list(): Array<{ bundle: CustomDomainCert; signature: Bytes }> {
    return [...this.byFqdn.values()];
  }

  /** Returns true iff the incoming bundle was strictly fresher and
   *  was therefore stored. */
  applyIfFresher(entry: { bundle: CustomDomainCert; signature: Bytes }): boolean {
    const key = entry.bundle.fqdn.toLowerCase();
    const cur = this.byFqdn.get(key);
    if (cur && entry.bundle.issuedAt <= cur.bundle.issuedAt) return false;
    this.byFqdn.set(key, entry);
    return true;
  }
}

export interface EnsureLeadCustomCertDeps {
  /** "lead" pods ACME + replicate; "sibling" pods are receive-only. */
  role: "lead" | "sibling";
  fqdn: string;
  username: string;
  issuer: AcmeIssuer;
  certManager: CertManager;
  /** Optional encrypted on-disk persistence (survives reboot). */
  certStore: EncryptedCertStore | null;
  /** The issuing pod's STK identity keypair (NOT the user's IRK — the
   *  cert is born on the pod; no IRK is present here). */
  signer: Keypair;
  /** Sibling-sync replication seam. NEVER a peerBackup transport. */
  sender: SiblingCertSender;
  /** Renew once the cert has < this many ms left. Default 60d (LE is
   *  90d, so renew at ~30d old) — matches CertManager.needsRenewal. */
  renewalWindowMs?: number;
  now?: () => number;
}

/**
 * Lead-pod path: ensure a fresh cert exists for `fqdn`, minting via
 * ACME (TLS-ALPN-01, since a custom FQDN is non-wildcard) if missing
 * or near expiry, installing it for that exact SNI, persisting it, and
 * replicating the signed bundle to the user's other pods. A sibling
 * call is a deliberate no-op (it must not race the lead into LE's
 * duplicate-cert / failed-validation rate limits).
 */
export async function ensureLeadCustomDomainCert(
  deps: EnsureLeadCustomCertDeps,
): Promise<{ issued: boolean; reason?: string }> {
  if (deps.role !== "lead") return { issued: false, reason: "not the lead pod (receive-only)" };
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.renewalWindowMs ?? 60 * 24 * 60 * 60 * 1000;
  if (!deps.certManager.customNeedsRenewal(deps.fqdn, windowMs, now())) {
    return { issued: false, reason: "custom cert still fresh" };
  }
  const result = await deps.issuer.issue([deps.fqdn]);
  deps.certManager.installCustom(
    deps.fqdn,
    { certPem: result.certPem, privateKeyPem: result.privateKeyPem },
    result.notAfter,
  );
  deps.certStore?.put(
    storeKey(deps.fqdn),
    result.certPem,
    result.privateKeyPem,
    [deps.fqdn],
    result.notAfter,
  );
  const bundle: CustomDomainCert = {
    username: deps.username,
    fqdn: deps.fqdn.toLowerCase(),
    certPem: result.certPem,
    privateKeyPem: result.privateKeyPem,
    notAfter: result.notAfter,
    issuedAt: now(),
  };
  const signature = await signCustomDomainCert(bundle, deps.signer);
  deps.sender.pushCustomDomainCert(bundle, signature);
  return { issued: true };
}

export interface ReceiveCustomCertDeps {
  bundle: CustomDomainCert;
  signature: Bytes;
  /** Pod identity pubkey the sibling-sync layer already authenticated
   *  as a member of THIS user's fleet (IRK→PodIdentityBinding in the
   *  sync hello). The second, independent trust factor. */
  signerPodIdentityPub: Bytes;
  store: CustomDomainCertStore;
  certManager: CertManager;
  certStore: EncryptedCertStore | null;
}

/**
 * Sibling receive path. Fail-closed: the bundle's own signature must
 * verify under the fleet-authenticated pod identity, and it only
 * replaces a strictly-fresher local copy, before it ever touches the
 * serving plane or disk.
 */
export async function receiveCustomDomainCert(
  deps: ReceiveCustomCertDeps,
): Promise<{ applied: boolean; reason?: string }> {
  const ok = await verifyCustomDomainCert(
    deps.bundle,
    deps.signature,
    deps.signerPodIdentityPub,
  );
  if (!ok) {
    return { applied: false, reason: "signature does not verify under the fleet pod identity" };
  }
  if (!deps.store.applyIfFresher({ bundle: deps.bundle, signature: deps.signature })) {
    return { applied: false, reason: "have an equal-or-fresher copy" };
  }
  deps.certManager.installCustom(
    deps.bundle.fqdn,
    { certPem: deps.bundle.certPem, privateKeyPem: deps.bundle.privateKeyPem },
    deps.bundle.notAfter,
  );
  deps.certStore?.put(
    storeKey(deps.bundle.fqdn),
    deps.bundle.certPem,
    deps.bundle.privateKeyPem,
    [deps.bundle.fqdn],
    deps.bundle.notAfter,
  );
  return { applied: true };
}
