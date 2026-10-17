/**
 * AccountKeyAttestation: `.com`'s CA signature saying a key is the current
 * sensitive key of a Flagship account (its admin root, or its IRK when the
 * account pins no admin root: the `authorizeSensitiveComOp` rule).
 *
 * It names no account. An account's own device fetches it about its own
 * account (`GET /api/users/<u>/account-key-attestation`) and hands it to
 * another account's server inside a sealed share acceptance
 * (docs/share-a-server.md §5.1), so that server can check "an admin device
 * of the joining account signed this" without asking `.com` anything about
 * who joined, and without learning the joining account's name.
 *
 *   flagship/account-key-attestation/v1|<keyKind>|<keyPubHex>|<issuedAt>|<expiresAt>
 *
 * A consumer accepts it through the same chain as every CA artifact: the
 * baked maintainer pin, the forward ca-track chain, the live CaEndorsement
 * lease, then the artifact's own signature and TTL. When the lease lapses
 * every attestation fails closed.
 */
import { ed } from "./edSync.js";
import {
  authorizedCaKeysOrFailClosed,
  MAINTAINER_PINNED_MANDATE_HASH,
  type CaArtifactReject,
  type CaTrustChain,
} from "./maintainerCa.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_ACCOUNT_KEY_ATTESTATION = "flagship/account-key-attestation/v1";

/** Long enough for the owner to confirm a share a week after it was accepted. */
export const ACCOUNT_KEY_ATTESTATION_TTL_MS = 14 * 24 * 3600_000;

export type AccountKeyKind = "admin-root" | "irk";
export const ACCOUNT_KEY_KINDS: readonly AccountKeyKind[] = ["admin-root", "irk"];

export interface AccountKeyAttestationBody {
  keyKind: AccountKeyKind;
  keyPubHex: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AccountKeyAttestation extends AccountKeyAttestationBody {
  kind: "AccountKeyAttestation";
  version: 1;
  /** lower-hex CA pubkey that signed. */
  signedBy: string;
  /** lower-hex Ed25519 signature over the canonical bytes. */
  signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function canonicalAccountKeyAttestation(b: AccountKeyAttestationBody): Bytes {
  if (!ACCOUNT_KEY_KINDS.includes(b.keyKind)) throw new Error(`${TAG_ACCOUNT_KEY_ATTESTATION}: bad keyKind`);
  if (typeof b.keyPubHex !== "string" || !HEX64.test(b.keyPubHex)) {
    throw new Error(`${TAG_ACCOUNT_KEY_ATTESTATION}: keyPubHex must be 64 lowercase hex`);
  }
  if (!isTime(b.issuedAt) || !isTime(b.expiresAt)) throw new Error(`${TAG_ACCOUNT_KEY_ATTESTATION}: bad time`);
  if (b.expiresAt <= b.issuedAt) throw new Error(`${TAG_ACCOUNT_KEY_ATTESTATION}: expires before it is issued`);
  return new TextEncoder().encode(
    [TAG_ACCOUNT_KEY_ATTESTATION, b.keyKind, b.keyPubHex, String(b.issuedAt), String(b.expiresAt)].join("|"),
  );
}

export function signAccountKeyAttestation(body: AccountKeyAttestationBody, ca: Keypair): AccountKeyAttestation {
  const sig = ed.sign(canonicalAccountKeyAttestation(body), ca.privateKey);
  return {
    kind: "AccountKeyAttestation",
    version: 1,
    keyKind: body.keyKind,
    keyPubHex: body.keyPubHex,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    signedBy: toHex(ca.publicKey),
    signature: toHex(sig),
  };
}

/** Shape-check an untrusted attestation (no signature check). */
export function parseAccountKeyAttestation(v: unknown): AccountKeyAttestation | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.kind !== "AccountKeyAttestation" || r.version !== 1) return null;
  if (r.keyKind !== "admin-root" && r.keyKind !== "irk") return null;
  if (typeof r.keyPubHex !== "string" || typeof r.signedBy !== "string" || typeof r.signature !== "string") return null;
  if (!HEX64.test(r.signedBy) || !HEX128.test(r.signature)) return null;
  if (!isTime(r.issuedAt) || !isTime(r.expiresAt)) return null;
  const a: AccountKeyAttestation = {
    kind: "AccountKeyAttestation",
    version: 1,
    keyKind: r.keyKind,
    keyPubHex: r.keyPubHex,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    signedBy: r.signedBy,
    signature: r.signature,
  };
  try {
    canonicalAccountKeyAttestation(a);
  } catch {
    return null;
  }
  return a;
}

/**
 * Links 1-4 for an AccountKeyAttestation at the consumer's clock `now`: the
 * signing key must be an operational CA key the chain authorizes now, and
 * `now` inside the attestation's TTL.
 */
export function verifyCaSignedAccountKeyAttestation(
  a: AccountKeyAttestation,
  chain: CaTrustChain | null,
  now: number,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true } | { ok: false; reason: CaArtifactReject } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!gate.ok) return gate;
  if (!(now >= a.issuedAt && now < a.expiresAt)) return { ok: false, reason: "artifact-expired" };
  let bytes: Bytes;
  try {
    bytes = canonicalAccountKeyAttestation(a);
  } catch {
    return { ok: false, reason: "signature-unverified" };
  }
  const sig = fromHex(a.signature);
  for (const k of gate.keys) {
    if (!HEX64.test(k)) continue;
    try {
      if (ed.verify(sig, bytes, fromHex(k))) return { ok: true };
    } catch {
      /* try the next key */
    }
  }
  return { ok: false, reason: "signature-unverified" };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
