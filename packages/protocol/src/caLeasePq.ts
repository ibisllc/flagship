/**
 * The PQ half of a CA endorsement lease (architecture v2; same rollout as the release
 * endorsement's v2 companion, pq-suites.md §12 and §16). DRAFT, pending Q01 review.
 *
 * A `CaEndorsement` (`@ibisllc/maintainers`) is signed by the ca-track holder's YubiKey Ed25519
 * key and gives a CA key authority for a window. Its companion is signed with the hybrid suite
 * under `<holder Ed25519> || <holder ML-DSA-65>`:
 *
 *   flagship/ca-lease/v2|<endorsementId>|<sha256 of the v1 canonical bytes>|<signedBy>|<keyId>
 *
 * The ML-DSA key is bound to the holder's Ed25519 key (`flagship/pq-key-binding/v1`, role
 * `release-key`, subject `flagship-ca-track`), and the binding's hybrid key id must be in the
 * code pin `CA_LEASE_PQ_PIN`. Empty pin: the leases count as before (today). Once the pin names a
 * key, a lease gives authority only with its verified companion, except the leases signed before
 * the cut-over, listed by v1 digest in the pin (`legacyLeases`): stripping the PQ half from a new
 * lease leaves it without authority. Companions and bindings live beside the leases in
 * `.maintainers/ca-pq/{bindings,endorsements}/` (and `bundle.json` for the Worker).
 * Vectors: test-vectors/ca-lease-pq/vectors.json.
 */
import { canonicalCaEndorsement, type CaEndorsement } from "@ibisllc/maintainers";
import { sha256 } from "@noble/hashes/sha2.js";
import { hybridSignExternal, hybridVerify, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 } from "./pqHybrid.js";
import { pqBindingPublicKey, pqKeyBindingFromWire, verifyPqKeyBinding, type VerifiedPqKeyBinding } from "./pqTrust.js";
import type { Bytes } from "./types.js";

export const TAG_CA_LEASE_V2 = "flagship/ca-lease/v2";
export const CA_LEASE_PQ_BINDING_SUBJECT = "flagship-ca-track";
export const CA_LEASE_PQ_KIND = "CaEndorsementPq" as const;

export interface CaLeasePqPin {
  version: 1;
  /** `pqKeyId(0x0002, ed25519 || mldsa65)` of each accepted ca-track key, lowercase hex. */
  keyIds: readonly string[];
  /** SHA-256 (hex) of the v1 canonical bytes of each lease signed before the cut-over. */
  legacyLeases: readonly string[];
}

// BEGIN CA_LEASE_PQ_PIN (generated)
export const CA_LEASE_PQ_PIN: CaLeasePqPin = Object.freeze({
  version: 1,
  keyIds: Object.freeze(["1c07f1ffe8e6e8b89d8b8c8c14544d6f065decfa67ea76ec50c30fadaadb9434"]) as readonly string[],
  legacyLeases: Object.freeze(["05992604e11f53b3ede67ac98c089faa8b45e23b6f543fdba1927a08df29f57f", "38d5ebb0d6ebf7742416076366ce3ef50c02273f91515224b2937c56e958c278", "6f11e97e0ce6fc6e77edf2aa2676c08fa2d73424803b5900cc22479194f4a363", "a1606216cf39cccc9d02e2d22d74874037da59f137bb065e55c9f6d9937f14a4"]) as readonly string[],
});
// END CA_LEASE_PQ_PIN

export interface CaLeasePqWire {
  kind: typeof CA_LEASE_PQ_KIND;
  version: 2;
  endorsementId: string;
  v1Digest: string;
  keyId: string;
  suite: string;
  signature: string;
}

/** The companions and bindings that travel with the leases. */
export interface CaLeasePqMaterial {
  bindings: readonly unknown[];
  endorsements: readonly unknown[];
}

const HEX32 = /^[0-9a-f]{64}$/;

export function caLeasePqPinConfigured(pin: CaLeasePqPin = CA_LEASE_PQ_PIN): boolean {
  return Array.isArray(pin?.keyIds) && pin.keyIds.length > 0;
}

function unsigned(e: CaEndorsement): Omit<CaEndorsement, "signatures"> {
  const { signatures: _s, ...rest } = e;
  return rest;
}

/** SHA-256 of the lease's v1 canonical bytes, hex; null for a lease that does not canonicalize. */
export function caLeaseV1Digest(e: CaEndorsement): string | null {
  try {
    return toHex(sha256(canonicalCaEndorsement(unsigned(e))));
  } catch {
    return null;
  }
}

export function canonicalCaLeaseV2(e: CaEndorsement, v1Digest: string, keyIdHex: string): Bytes {
  return new TextEncoder().encode([TAG_CA_LEASE_V2, e.endorsementId, v1Digest, String(e.signedBy).toLowerCase(), keyIdHex].join("|"));
}

function bindingsFor(wires: readonly unknown[], pin: CaLeasePqPin, now: number): Map<string, VerifiedPqKeyBinding> {
  const pinned = new Set(pin.keyIds.map((k) => k.toLowerCase()));
  const out = new Map<string, VerifiedPqKeyBinding>();
  for (const raw of wires) {
    try {
      const w = pqKeyBindingFromWire(raw);
      const keyId = toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pqBindingPublicKey(w)));
      if (!pinned.has(keyId)) continue;
      const b = verifyPqKeyBinding(w, { role: "release-key", subjectId: CA_LEASE_PQ_BINDING_SUBJECT, ed25519PubHex: w.ed25519PubHex, now });
      out.set(b.keyIdHex, b);
    } catch {
      // a binding that does not verify simply does not count
    }
  }
  return out;
}

function companionVerifies(e: CaEndorsement, digest: string, wire: unknown, bindings: ReadonlyMap<string, VerifiedPqKeyBinding>): boolean {
  if (!wire || typeof wire !== "object") return false;
  const w = wire as Partial<CaLeasePqWire>;
  if (w.kind !== CA_LEASE_PQ_KIND || w.version !== 2 || w.endorsementId !== e.endorsementId || w.v1Digest !== digest) return false;
  if (typeof w.keyId !== "string" || !HEX32.test(w.keyId) || typeof w.signature !== "string" || !/^(?:[0-9a-f]{2})+$/.test(w.signature)) return false;
  if (w.suite !== "hybrid-ed25519-mldsa65/v1") return false;
  const b = bindings.get(w.keyId);
  if (!b || b.ed25519PubHex !== String(e.signedBy).toLowerCase()) return false;
  try {
    hybridVerify(b.hybridPublicKey, TAG_CA_LEASE_V2, canonicalCaLeaseV2(e, digest, w.keyId), fromHex(w.signature));
    return true;
  } catch {
    return false;
  }
}

export interface CaLeasePqVerdict<E extends CaEndorsement> {
  pinned: boolean;
  /** The leases that may give authority (the classical checks still run on them downstream). */
  accepted: E[];
  refused: { endorsementId: string; code: "pq-missing" | "pq-invalid" | "lease-malformed" }[];
}

/** Splits leases by the PQ rule. Without a pin every lease passes through unchanged. */
export function gateCaLeasesPq<E extends CaEndorsement>(
  leases: readonly E[],
  material: CaLeasePqMaterial | null | undefined,
  opts: { pin?: CaLeasePqPin; now: number },
): CaLeasePqVerdict<E> {
  const pin = opts.pin ?? CA_LEASE_PQ_PIN;
  if (!caLeasePqPinConfigured(pin)) return { pinned: false, accepted: [...leases], refused: [] };
  const bindings = bindingsFor(material?.bindings ?? [], pin, opts.now);
  const companions = Array.isArray(material?.endorsements) ? material!.endorsements : [];
  const out: CaLeasePqVerdict<E> = { pinned: true, accepted: [], refused: [] };
  for (const e of leases) {
    const digest = caLeaseV1Digest(e);
    if (!digest) {
      out.refused.push({ endorsementId: String(e?.endorsementId), code: "lease-malformed" });
      continue;
    }
    if (pin.legacyLeases.includes(digest)) {
      out.accepted.push(e);
      continue;
    }
    const mine = companions.filter((c) => (c as { endorsementId?: unknown } | null)?.endorsementId === e.endorsementId);
    if (mine.some((c) => companionVerifies(e, digest, c, bindings))) out.accepted.push(e);
    else out.refused.push({ endorsementId: e.endorsementId, code: mine.length ? "pq-invalid" : "pq-missing" });
  }
  return out;
}

/** The companion for a lease the same Ed25519 key signed (the YubiKey signs M', the seed ML-DSA). */
export async function signCaLeasePq(
  e: CaEndorsement,
  key: { ed25519PubHex: string; mldsaPubHex: string },
  ed25519Sign: (m: Bytes) => Promise<Bytes>,
  mldsaSeed: Bytes,
  opts: { deterministic?: boolean } = {},
): Promise<CaLeasePqWire> {
  if (String(e.signedBy).toLowerCase() !== key.ed25519PubHex.toLowerCase()) throw new Error("the lease is signed by another key");
  const digest = caLeaseV1Digest(e);
  if (!digest) throw new Error("the lease does not canonicalize");
  const pk = pqBindingPublicKey({ ed25519PubHex: key.ed25519PubHex.toLowerCase(), mldsaPubHex: key.mldsaPubHex.toLowerCase() });
  const keyId = toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk));
  const sig = await hybridSignExternal(pk, TAG_CA_LEASE_V2, canonicalCaLeaseV2(e, digest, keyId), ed25519Sign, mldsaSeed, opts);
  return { kind: CA_LEASE_PQ_KIND, version: 2, endorsementId: e.endorsementId, v1Digest: digest, keyId, suite: "hybrid-ed25519-mldsa65/v1", signature: toHex(sig) };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
