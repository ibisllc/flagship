/**
 * ServiceBlessing — `.com`'s CA-signature over the `.services` relay hub's
 * OWN key (the "relay blessing", docs/maintainer-trust-enforcement.md §
 * "The relay blessing").
 *
 * The `.services` Fly app self-generates a keypair and persists it, then
 * asks `.com` to bless its pubkey. `.com` signs a short-lived
 * `ServiceBlessing{ hubKeyPub, hubHost, nonce, issuedAt, expiresAt }` with
 * its live HOT CA key (re-requested ~daily). A box's daemon verifies the
 * blessing — `pin → forward chain → CA key authorized now → not expired` —
 * BEFORE relaying through the hub. An operator evicts a rogue Fly by
 * telling `.com` to stop blessing it; the blessing then expires within a
 * day.
 *
 * This mirrors `verifyCaSignedUserPubKeyBinding` EXACTLY: the same
 * `CaTrustChain` injection (links 2-3), the same fail-closed gate, the
 * same per-key signature trial over the authorized set, plus a TTL check.
 * The only difference is the envelope shape + the canonical tag.
 *
 * Canonical tag: `flagship/service-blessing/v1`
 * Field order:   hubKeyPub | hubHost | nonce | issuedAt | expiresAt
 */

import { legacyFieldGuard } from "./auth.js";
import { ed } from "./edSync.js";
import {
  authorizedCaKeysOrFailClosed,
  MAINTAINER_PINNED_MANDATE_HASH,
  type CaArtifactReject,
  type CaTrustChain,
} from "./maintainerCa.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_SERVICE_BLESSING = "flagship/service-blessing/v1";

/** Hub blessings are re-minted ~daily; ~26h gives slack past 24h. */
export const SERVICE_BLESSING_DEFAULT_TTL_MS = 26 * 60 * 60_000;

export interface ServiceBlessing {
  kind: "ServiceBlessing";
  version: 1;
  /** lower-hex Ed25519 pubkey the `.services` hub self-generated. */
  hubKeyPub: string;
  /** the hub host this blessing is scoped to, e.g. `flagship.services`. */
  hubHost: string;
  /** anti-replay nonce minted by `.com` per blessing. */
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** lower-hex CA pubkey that signed (the served hot key); echoed for UX. */
  signedBy: string;
  signatures: { pubkey: string; sig: string }[];
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

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function canonicalServiceBlessing(
  b: Pick<
    ServiceBlessing,
    "hubKeyPub" | "hubHost" | "nonce" | "issuedAt" | "expiresAt"
  >,
): Bytes {
  legacyFieldGuard("hubKeyPub", b.hubKeyPub);
  legacyFieldGuard("hubHost", b.hubHost);
  legacyFieldGuard("nonce", b.nonce);
  return new TextEncoder().encode(
    [
      TAG_SERVICE_BLESSING,
      b.hubKeyPub,
      b.hubHost,
      b.nonce,
      b.issuedAt,
      b.expiresAt,
    ].join("|"),
  );
}

/**
 * Mint a signed ServiceBlessing with the CA hot keypair. `signedBy` is set
 * to the signing pubkey; one signature is attached (a CA hot key is a
 * single-signer authority).
 */
export function signServiceBlessing(
  unsigned: Pick<
    ServiceBlessing,
    "hubKeyPub" | "hubHost" | "nonce" | "issuedAt" | "expiresAt"
  >,
  caKeypair: Keypair,
): ServiceBlessing {
  const sig = ed.sign(canonicalServiceBlessing(unsigned), caKeypair.privateKey);
  const signedBy = bytesToHex(caKeypair.publicKey);
  return {
    kind: "ServiceBlessing",
    version: 1,
    hubKeyPub: unsigned.hubKeyPub,
    hubHost: unsigned.hubHost,
    nonce: unsigned.nonce,
    issuedAt: unsigned.issuedAt,
    expiresAt: unsigned.expiresAt,
    signedBy,
    signatures: [{ pubkey: signedBy, sig: bytesToHex(sig) }],
  };
}

function withinTtl(issuedAt: number, expiresAt: number, now: number): boolean {
  return now >= issuedAt && now < expiresAt;
}

/**
 * The link-1-4 chokepoint for a ServiceBlessing — the relay equivalent of
 * `verifyCaSignedUserPubKeyBinding`. The blessing is accepted iff:
 *   1. the baked pin is configured,
 *   2. the injected chain authorizes at least one CA key at `now`,
 *   3. the blessing is within its TTL at `now`, and
 *   4. `signedBy` is one of those authorized keys AND a matching
 *      signature over the canonical bytes verifies under it.
 *
 * `signedBy` MUST appear in `signatures` and be an authorized key — this
 * forecloses attaching an authorized co-signature while claiming a
 * different signer.
 */
export function verifyCaSignedServiceBlessing(
  b: ServiceBlessing,
  chain: CaTrustChain | null,
  now: number,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true } | { ok: false; reason: CaArtifactReject } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!gate.ok) return gate;
  if (!withinTtl(b.issuedAt, b.expiresAt, now)) {
    return { ok: false, reason: "artifact-expired" };
  }
  let msg: Bytes;
  try {
    msg = canonicalServiceBlessing(b);
  } catch {
    return { ok: false, reason: "signature-unverified" };
  }
  const authorized = new Set(gate.keys.map((k) => k.toLowerCase()));
  for (const entry of b.signatures) {
    const pub = entry.pubkey.toLowerCase();
    if (!authorized.has(pub)) continue;
    if (pub !== (b.signedBy ?? "").toLowerCase()) continue;
    let pubBytes: Bytes;
    let sigBytes: Bytes;
    try {
      pubBytes = hexToBytes(pub);
      sigBytes = hexToBytes(entry.sig);
    } catch {
      continue;
    }
    try {
      if (ed.verify(sigBytes, msg, pubBytes)) return { ok: true };
    } catch {
      /* try next */
    }
  }
  return { ok: false, reason: "signature-unverified" };
}
