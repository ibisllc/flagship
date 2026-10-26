/**
 * Architecture v2 milestone 3: the PQ half of a release endorsement. DRAFT, pending Q01 external
 * cryptographic review. Spec: docs/architecture-v2/pq-suites.md §12; runbook
 * docs/runbooks/pq-release-key.md; vectors test-vectors/release-endorsement-v2/; Rust twin
 * rust/crates/flagship-crypto/src/release.rs.
 *
 * A release stays endorsed by the maintainers `ReleaseEndorsement` (v1, the YubiKey's Ed25519
 * signature over `maintainers/release/v1|...`). v2 adds a companion signed with the hybrid suite
 * under `<release Ed25519 key> || <release ML-DSA-65 key>`:
 *
 *   flagship/release-endorsement/v2|<releaseId>|<semverTag>|<commitHash>|<previousReleaseId>
 *     |<previousCommitHash>|<intermediateMerkleRoot>|<v1Digest>|<signedBy>|<keyId>
 *
 * `v1Digest` is SHA-256 of the v1 canonical bytes, so the companion covers every byte the
 * classical signature covers. The ML-DSA key is bound to the Ed25519 release key with a
 * `flagship/pq-key-binding/v1` (role `release-key`), and the binding's key id is pinned in code
 * (`releasePqPin.ts`), never read from `.maintainers/` alone: that folder may come from an
 * unverified fetched ref.
 *
 * Once the pin names a key, an endorsement is a valid update target only when the v1 signature
 * AND the hybrid companion verify. Endorsements on the chain that ends at the pin's
 * `requirePqAfter` marker stay valid as lineage (a later endorsement may name them as its
 * predecessor) but are never offered or applied.
 *
 * The release ML-DSA key is a software key stored encrypted to the owner's YubiKeys; the honest
 * label is `RELEASE_PQ_LABEL`.
 */
import { canonicalReleaseEndorsement, type ReleaseEndorsement } from "@ibisllc/maintainers";
import { sha256 } from "@noble/hashes/sha2.js";
import { GENESIS_DIGEST, type PolicyState } from "./assurancePolicy.js";
import { ed25519VerifyStrict, hybridSignExternal, pqKeyId, SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 } from "./pqHybrid.js";
import {
  canonicalPqKeyBindingV2,
  pqBindingPublicKey,
  PqTrustError,
  pqKeyBindingFromWire,
  TAG_PQ_KEY_BINDING_V2,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  type PqKeyBindingWire,
  type PqTrustErrorCode,
  type VerifiedPqKeyBinding,
} from "./pqTrust.js";
import { RELEASE_PQ_PIN } from "./releasePqPin.js";
import type { Bytes } from "./types.js";

export const TAG_RELEASE_ENDORSEMENT_V2 = "flagship/release-endorsement/v2";
export const RELEASE_PQ_BINDING_ROLE = "release-key" as const;
export const RELEASE_PQ_BINDING_SUBJECT = "flagship-release";
export const RELEASE_PQ_SUITE = "hybrid-ed25519-mldsa65/v1" as const;
export const RELEASE_PQ_KIND = "ReleaseEndorsementPq" as const;
export const RELEASE_PQ_LABEL = "PQ release signature (software key, YubiKey-encrypted at rest)";
export const RELEASE_PQ_CLAIM = "pending external review";

export interface ReleasePqPin {
  version: 1;
  /** `pqKeyId(0x0002, ed25519 || mldsa65)` of each accepted release key, lowercase hex. */
  keyIds: readonly string[];
  /**
   * The newest endorsement signed before the PQ key existed. It and the endorsements it chains
   * back to stay valid for lineage only. Null: every endorsement needs the PQ companion.
   */
  requirePqAfter: { releaseId: string; commitHash: string } | null;
}

export interface ReleaseEndorsementPqWire {
  kind: typeof RELEASE_PQ_KIND;
  version: 2;
  releaseId: string;
  commitHash: string;
  v1Digest: string;
  keyId: string;
  suite: string;
  signature: string;
}

export type ReleasePqErrorCode =
  | "pq-missing"
  | "pq-malformed"
  | "pq-mismatch"
  | "pq-key-not-pinned"
  | "v1-malformed"
  | "v1-signature"
  | PqTrustErrorCode;

export class ReleasePqError extends Error {
  readonly code: ReleasePqErrorCode;
  constructor(code: ReleasePqErrorCode) {
    super(code);
    this.name = "ReleasePqError";
    this.code = code;
  }
}

const fail = (code: ReleasePqErrorCode): never => {
  throw new ReleasePqError(code);
};

const HEX32 = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})*$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The synthetic scope the release gate runs under: strict, enforced, always. */
export const RELEASE_STRICT_POLICY: PolicyState = Object.freeze({
  scope: { kind: "installation", id: "flagship-release" },
  profile: "strict",
  rollout: "enforced",
  generation: 1,
  headDigest: GENESIS_DIGEST,
  enforcedEver: true,
}) as PolicyState;

export function releasePqPinConfigured(pin: ReleasePqPin = RELEASE_PQ_PIN): boolean {
  return Array.isArray(pin?.keyIds) && pin.keyIds.length > 0;
}

function unsigned(e: ReleaseEndorsement): Omit<ReleaseEndorsement, "signatures"> {
  const { signatures: _s, ...rest } = e;
  return rest;
}

/** SHA-256 of the v1 canonical bytes (`maintainers/release/v1|...`), lowercase hex. */
export function releaseEndorsementV1Digest(e: ReleaseEndorsement): string {
  let bytes: Bytes;
  try {
    bytes = canonicalReleaseEndorsement(unsigned(e));
  } catch {
    return fail("v1-malformed");
  }
  return toHex(sha256(bytes));
}

/** The statement the hybrid key signs. */
export function canonicalReleaseEndorsementV2(e: ReleaseEndorsement, keyIdHex: string): Bytes {
  const v1Digest = releaseEndorsementV1Digest(e);
  if (!HEX32.test(keyIdHex)) fail("pq-malformed");
  return new TextEncoder().encode(
    [
      TAG_RELEASE_ENDORSEMENT_V2,
      e.releaseId,
      e.semverTag,
      e.commitHash,
      e.previousReleaseId ?? "",
      e.previousCommitHash ?? "",
      e.intermediateMerkleRoot,
      v1Digest,
      e.signedBy,
      keyIdHex,
    ].join("|"),
  );
}

/** Parses the companion's wire shape strictly. */
export function releaseEndorsementPqFromWire(w: unknown): ReleaseEndorsementPqWire {
  if (typeof w !== "object" || w === null || Array.isArray(w)) return fail("pq-malformed");
  const o = w as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "commitHash,keyId,kind,releaseId,signature,suite,v1Digest,version") fail("pq-malformed");
  if (o.kind !== RELEASE_PQ_KIND || o.version !== 2) fail("pq-malformed");
  if (typeof o.releaseId !== "string" || o.releaseId.length === 0 || o.releaseId.length > 128) fail("pq-malformed");
  if (typeof o.commitHash !== "string" || !COMMIT.test(o.commitHash)) fail("pq-malformed");
  if (typeof o.v1Digest !== "string" || !HEX32.test(o.v1Digest)) fail("pq-malformed");
  if (typeof o.keyId !== "string" || !HEX32.test(o.keyId)) fail("pq-malformed");
  if (typeof o.suite !== "string" || o.suite.length > 64) fail("pq-malformed");
  if (typeof o.signature !== "string" || o.signature.length > 2 * 65536 || !HEX.test(o.signature)) fail("pq-malformed");
  return o as unknown as ReleaseEndorsementPqWire;
}

/**
 * Verifies the release-key bindings against the pin. Only a binding whose hybrid key id the pin
 * names is considered; the pin fixes both halves, so the binding's own Ed25519 key is trusted.
 */
export function verifyReleasePqBindings(
  wires: readonly unknown[],
  pin: ReleasePqPin,
  now: number,
): { bindings: VerifiedPqKeyBinding[]; errors: { keyId: string | null; code: string }[] } {
  const bindings: VerifiedPqKeyBinding[] = [];
  const errors: { keyId: string | null; code: string }[] = [];
  const pinned = new Set(pin.keyIds.map((k) => k.toLowerCase()));
  for (const raw of wires) {
    let keyId: string | null = null;
    try {
      const w = pqKeyBindingFromWire(raw);
      keyId = toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pqBindingPublicKey(w)));
      if (!pinned.has(keyId)) {
        errors.push({ keyId, code: "pq-key-not-pinned" });
        continue;
      }
      bindings.push(
        verifyPqKeyBinding(w, {
          role: RELEASE_PQ_BINDING_ROLE,
          subjectId: RELEASE_PQ_BINDING_SUBJECT,
          ed25519PubHex: w.ed25519PubHex,
          now,
        }),
      );
    } catch (e) {
      errors.push({ keyId, code: e instanceof PqTrustError ? e.code : "binding-malformed" });
    }
  }
  return { bindings, errors };
}

/**
 * Verifies one endorsement's v1 signature and its PQ companion, in this order: the companion
 * is present and well formed; it names this endorsement (release id, commit, v1 digest); its key
 * id is pinned and has a verified binding; the v1 signer is the binding's Ed25519 key and its v1
 * signature verifies (strict Ed25519); the critical-signature gate under a strict, enforced
 * policy over the v2 statement. Returns the key id that verified.
 */
export function verifyReleaseEndorsementPq(
  e: ReleaseEndorsement,
  wire: unknown,
  ctx: { pin: ReleasePqPin; bindings: readonly VerifiedPqKeyBinding[] },
): { keyId: string } {
  if (wire === undefined || wire === null) fail("pq-missing");
  const w = releaseEndorsementPqFromWire(wire);
  const v1Digest = releaseEndorsementV1Digest(e);
  if (w.releaseId !== e.releaseId || w.commitHash !== String(e.commitHash).toLowerCase() || w.v1Digest !== v1Digest) {
    fail("pq-mismatch");
  }
  if (!ctx.pin.keyIds.map((k) => k.toLowerCase()).includes(w.keyId)) fail("pq-key-not-pinned");
  const binding = ctx.bindings.find((b) => b.keyIdHex === w.keyId);
  if (!binding) return fail("no-binding");
  const signedBy = String(e.signedBy ?? "").toLowerCase();
  if (signedBy !== binding.ed25519PubHex) fail("binding-key-mismatch");
  const entry = Array.isArray(e.signatures)
    ? e.signatures.find((s) => typeof s?.pubkey === "string" && s.pubkey.toLowerCase() === signedBy)
    : undefined;
  if (!entry || typeof entry.sig !== "string" || !/^[0-9a-f]{128}$/i.test(entry.sig)) fail("v1-signature");
  if (!ed25519VerifyStrict(fromHex(entry!.sig.toLowerCase()), canonicalReleaseEndorsement(unsigned(e)), fromHex(signedBy))) {
    fail("v1-signature");
  }
  try {
    verifyCriticalSignature({
      message: canonicalReleaseEndorsementV2(e, w.keyId),
      expectedPurpose: TAG_RELEASE_ENDORSEMENT_V2,
      envelope: { suite: w.suite as "hybrid-ed25519-mldsa65/v1", signature: w.signature },
      signerEd25519PubHex: signedBy,
      binding,
      policy: RELEASE_STRICT_POLICY,
    });
  } catch (err) {
    if (err instanceof PqTrustError) fail(err.code);
    throw err;
  }
  return { keyId: w.keyId };
}

export interface ReleasePqClassification<E extends ReleaseEndorsement = ReleaseEndorsement> {
  /** True when the pin names at least one key, so the companion is required. */
  pinned: boolean;
  /** May be offered and applied. Without a pin: every endorsement given. */
  eligible: E[];
  /** Valid only as predecessors (on the chain ending at `requirePqAfter`). */
  lineageOnly: E[];
  refused: { endorsement: E; code: ReleasePqErrorCode }[];
  bindingErrors: { keyId: string | null; code: string }[];
}

/**
 * Splits endorsements that already passed the v1 chain check (oldest first) by the PQ rule.
 * Each endorsement may have several companions; one that verifies is enough.
 */
export function classifyReleaseEndorsements<E extends ReleaseEndorsement>(
  endorsements: readonly E[],
  companions: readonly unknown[],
  bindingWires: readonly unknown[],
  opts: { pin?: ReleasePqPin; now: number },
): ReleasePqClassification<E> {
  const pin = opts.pin ?? RELEASE_PQ_PIN;
  if (!releasePqPinConfigured(pin)) {
    return { pinned: false, eligible: [...endorsements], lineageOnly: [], refused: [], bindingErrors: [] };
  }
  const { bindings, errors } = verifyReleasePqBindings(bindingWires, pin, opts.now);
  const byRelease = new Map<string, unknown[]>();
  for (const c of companions) {
    const id = typeof c === "object" && c !== null ? (c as { releaseId?: unknown }).releaseId : undefined;
    if (typeof id !== "string") continue;
    byRelease.set(id, [...(byRelease.get(id) ?? []), c]);
  }
  const legacy = legacySet(endorsements, pin);
  const out: ReleasePqClassification<E> = { pinned: true, eligible: [], lineageOnly: [], refused: [], bindingErrors: errors };
  for (const e of endorsements) {
    let code: ReleasePqErrorCode = "pq-missing";
    let ok = false;
    for (const c of byRelease.get(e.releaseId) ?? []) {
      try {
        verifyReleaseEndorsementPq(e, c, { pin, bindings });
        ok = true;
        break;
      } catch (err) {
        code = err instanceof ReleasePqError ? err.code : "pq-malformed";
      }
    }
    if (ok) out.eligible.push(e);
    else if (legacy.has(e.releaseId)) out.lineageOnly.push(e);
    else out.refused.push({ endorsement: e, code });
  }
  return out;
}

/** The marker endorsement and every one it chains back to through `previousReleaseId`. */
function legacySet(endorsements: readonly ReleaseEndorsement[], pin: ReleasePqPin): Set<string> {
  const out = new Set<string>();
  const marker = pin.requirePqAfter;
  if (!marker) return out;
  const byId = new Map(endorsements.map((e) => [e.releaseId, e]));
  let e = byId.get(marker.releaseId);
  if (!e || String(e.commitHash).toLowerCase() !== marker.commitHash.toLowerCase()) return out;
  while (e && !out.has(e.releaseId)) {
    out.add(e.releaseId);
    e = e.previousReleaseId ? byId.get(e.previousReleaseId) : undefined;
  }
  return out;
}

// ── signing (scripts/pq-release-key.mjs, scripts/endorse-release.mjs) ──

export type ExternalEd25519Signer = (m: Bytes) => Promise<Bytes>;

/** The release-key binding: the YubiKey signs M' with Ed25519, the in-memory seed with ML-DSA. */
export async function signReleasePqBinding(
  args: { ed25519PubHex: string; mldsaPubHex: string; issuedAt: number },
  ed25519Sign: ExternalEd25519Signer,
  mldsaSeed: Bytes,
  opts: { deterministic?: boolean } = {},
): Promise<PqKeyBindingWire> {
  const s = {
    role: RELEASE_PQ_BINDING_ROLE,
    subjectId: RELEASE_PQ_BINDING_SUBJECT,
    ed25519PubHex: args.ed25519PubHex.toLowerCase(),
    mldsaPubHex: args.mldsaPubHex.toLowerCase(),
    issuedAt: args.issuedAt,
  };
  // The compact v2 statement: the Ed25519 half runs on a YubiKey, whose PIV applet takes about 3 KB of message.
  const msg = canonicalPqKeyBindingV2(s);
  const sig = await hybridSignExternal(pqBindingPublicKey(s), TAG_PQ_KEY_BINDING_V2, msg, ed25519Sign, mldsaSeed, opts);
  return { v: 2, ...s, signature: toHex(sig) };
}

/** The companion for a v1 endorsement already signed by the same Ed25519 key. */
export async function signReleaseEndorsementPq(
  e: ReleaseEndorsement,
  key: { ed25519PubHex: string; mldsaPubHex: string },
  ed25519Sign: ExternalEd25519Signer,
  mldsaSeed: Bytes,
  opts: { deterministic?: boolean } = {},
): Promise<ReleaseEndorsementPqWire> {
  if (String(e.signedBy).toLowerCase() !== key.ed25519PubHex.toLowerCase()) fail("binding-key-mismatch");
  const pk = pqBindingPublicKey({ ed25519PubHex: key.ed25519PubHex.toLowerCase(), mldsaPubHex: key.mldsaPubHex.toLowerCase() });
  const keyId = toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk));
  const msg = canonicalReleaseEndorsementV2(e, keyId);
  const sig = await hybridSignExternal(pk, TAG_RELEASE_ENDORSEMENT_V2, msg, ed25519Sign, mldsaSeed, opts);
  return {
    kind: RELEASE_PQ_KIND,
    version: 2,
    releaseId: e.releaseId,
    commitHash: String(e.commitHash).toLowerCase(),
    v1Digest: releaseEndorsementV1Digest(e),
    keyId,
    suite: RELEASE_PQ_SUITE,
    signature: toHex(sig),
  };
}

/** `pqKeyId(0x0002, ed25519 || mldsa65)`, hex. */
export function releasePqKeyId(ed25519PubHex: string, mldsaPubHex: string): string {
  return toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pqBindingPublicKey({ ed25519PubHex, mldsaPubHex })));
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
