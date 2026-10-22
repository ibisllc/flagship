/**
 * PlanAttestation: `.com`'s CA signature over an account's plan, so a box can
 * check that the account is Pro without trusting the network path or `.com`'s
 * word in a plain JSON reply (docs/service-access-gating.md, "Separate lists per
 * server (Pro)").
 *
 * `.com` signs `{ username, tier, paidUntil, issuedAt, expiresAt }` with the
 * same hot CA key that signs directory attestations and the relay blessing. A
 * box accepts it through the same chain: the baked maintainer pin, the forward
 * ca-track chain, the live CaEndorsement lease, then the artifact's own
 * signature and TTL. A rogue relay or a forged reply can't make one, and when
 * the CA lease lapses every attestation fails closed (the box then treats the
 * plan as unknown, never as lapsed).
 *
 *   flagship/plan-attestation/v1|<username>|<tier>|<paidUntil>|<issuedAt>|<expiresAt>
 *
 * `tier` is the effective tier at `issuedAt` (`free`, `hobby` = Pro, `maker` =
 * Pro Max; a lapsed subscription is `free`). `paidUntil` is the end of the paid
 * period in epoch ms, 0 for free.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import {
  authorizedCaKeysOrFailClosed,
  MAINTAINER_PINNED_MANDATE_HASH,
  type CaArtifactReject,
  type CaTrustChain,
} from "./maintainerCa.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_PLAN_ATTESTATION = "flagship/plan-attestation/v1";

/** Re-fetched every few hours; a day and a bit gives slack. */
export const PLAN_ATTESTATION_TTL_MS = 26 * 60 * 60_000;

export const PLAN_TIERS = ["free", "hobby", "maker"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/** Pro and Pro Max both count as Pro. */
export function isProTier(tier: string): boolean {
  return tier === "hobby" || tier === "maker";
}

export interface PlanAttestationBody {
  username: string;
  tier: PlanTier;
  paidUntil: number;
  issuedAt: number;
  expiresAt: number;
}

export interface PlanAttestation extends PlanAttestationBody {
  kind: "PlanAttestation";
  version: 1;
  /** lower-hex CA pubkey that signed. */
  signedBy: string;
  signatures: { pubkey: string; sig: string }[];
}

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function hexToBytes(h: string): Bytes {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function canonicalPlanAttestation(b: PlanAttestationBody): Bytes {
  if (!USERNAME_RE.test(b.username)) throw new Error(`${TAG_PLAN_ATTESTATION}: bad username`);
  legacyFieldGuard("username", b.username);
  if (!(PLAN_TIERS as readonly string[]).includes(b.tier)) throw new Error(`${TAG_PLAN_ATTESTATION}: bad tier`);
  for (const [k, v] of [
    ["paidUntil", b.paidUntil],
    ["issuedAt", b.issuedAt],
    ["expiresAt", b.expiresAt],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${TAG_PLAN_ATTESTATION}: bad ${k}`);
  }
  if (b.expiresAt <= b.issuedAt) throw new Error(`${TAG_PLAN_ATTESTATION}: expires before it is issued`);
  return new TextEncoder().encode(
    [TAG_PLAN_ATTESTATION, b.username, b.tier, String(b.paidUntil), String(b.issuedAt), String(b.expiresAt)].join("|"),
  );
}

export function signPlanAttestation(body: PlanAttestationBody, caKeypair: Keypair): PlanAttestation {
  const sig = ed.sign(canonicalPlanAttestation(body), caKeypair.privateKey);
  const signedBy = bytesToHex(caKeypair.publicKey);
  return {
    kind: "PlanAttestation",
    version: 1,
    username: body.username,
    tier: body.tier,
    paidUntil: body.paidUntil,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    signedBy,
    signatures: [{ pubkey: signedBy, sig: bytesToHex(sig) }],
  };
}

/** Shape-check an untrusted attestation (no signature check). */
export function parsePlanAttestation(v: unknown): PlanAttestation | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.kind !== "PlanAttestation" || r.version !== 1) return null;
  if (typeof r.username !== "string" || typeof r.tier !== "string" || typeof r.signedBy !== "string") return null;
  if (typeof r.paidUntil !== "number" || typeof r.issuedAt !== "number" || typeof r.expiresAt !== "number") return null;
  if (!Array.isArray(r.signatures)) return null;
  const signatures: { pubkey: string; sig: string }[] = [];
  for (const s of r.signatures) {
    const e = s as Record<string, unknown> | null;
    if (!e || typeof e.pubkey !== "string" || typeof e.sig !== "string") return null;
    signatures.push({ pubkey: e.pubkey, sig: e.sig });
  }
  const a: PlanAttestation = {
    kind: "PlanAttestation",
    version: 1,
    username: r.username,
    tier: r.tier as PlanTier,
    paidUntil: r.paidUntil,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    signedBy: r.signedBy,
    signatures,
  };
  try {
    canonicalPlanAttestation(a);
  } catch {
    return null;
  }
  return a;
}

/**
 * The links 1-4 chokepoint for a PlanAttestation, exactly like
 * `verifyCaSignedServiceBlessing`: the baked pin, an authorized CA key at
 * `now`, the TTL, and a signature by `signedBy` (which must be authorized).
 */
export function verifyCaSignedPlanAttestation(
  a: PlanAttestation,
  chain: CaTrustChain | null,
  now: number,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true } | { ok: false; reason: CaArtifactReject } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!gate.ok) return gate;
  if (!(now >= a.issuedAt && now < a.expiresAt)) return { ok: false, reason: "artifact-expired" };
  let msg: Bytes;
  try {
    msg = canonicalPlanAttestation(a);
  } catch {
    return { ok: false, reason: "signature-unverified" };
  }
  const authorized = new Set(gate.keys.map((k) => k.toLowerCase()));
  const signedBy = a.signedBy.toLowerCase();
  for (const entry of a.signatures) {
    const pub = entry.pubkey.toLowerCase();
    if (!authorized.has(pub) || pub !== signedBy) continue;
    try {
      if (ed.verify(hexToBytes(entry.sig), msg, hexToBytes(pub))) return { ok: true };
    } catch {
      /* try the next */
    }
  }
  return { ok: false, reason: "signature-unverified" };
}
