/**
 * Authenticated time (SECURITY-HARDENING-PLAN.md 18.5, N07): `.com`'s CA signs "it is now T" for
 * one caller's nonce. A box that wants a time it can hold a deadline to asks with a fresh random
 * nonce and anchors to the answer, so a hostile network, a local clock change or a replayed
 * response cannot move it.
 *
 *   flagship/auth-time/v1|<nonceHex>|<nowMs>
 *
 * Accepted through the same chain as every CA artifact (baked maintainer pin, ca-track chain, live
 * CaEndorsement lease). The chain is asked at the stamp's own time: the nonce stops replays, so a
 * stamp can only be as old as the request that fetched it, and the box needs no trusted clock to
 * verify the one thing that gives it one.
 */
import { ed } from "./edSync.js";
import { authorizedCaKeysOrFailClosed, MAINTAINER_PINNED_MANDATE_HASH, type CaArtifactReject, type CaTrustChain } from "./maintainerCa.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_AUTH_TIME = "flagship/auth-time/v1";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export interface AuthTimeStamp {
  kind: "AuthTime";
  version: 1;
  nonceHex: string;
  nowMs: number;
  signedBy: string;
  signature: string;
}

export function canonicalAuthTime(nonceHex: string, nowMs: number): Bytes {
  if (!HEX32.test(nonceHex)) throw new Error(`${TAG_AUTH_TIME}: nonce must be 32 lowercase hex`);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error(`${TAG_AUTH_TIME}: bad time`);
  return new TextEncoder().encode([TAG_AUTH_TIME, nonceHex, String(nowMs)].join("|"));
}

export function signAuthTime(nonceHex: string, nowMs: number, ca: Keypair): AuthTimeStamp {
  return {
    kind: "AuthTime",
    version: 1,
    nonceHex,
    nowMs,
    signedBy: toHex(ca.publicKey),
    signature: toHex(ed.sign(canonicalAuthTime(nonceHex, nowMs), ca.privateKey)),
  };
}

export function parseAuthTime(v: unknown): AuthTimeStamp | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.kind !== "AuthTime" || r.version !== 1) return null;
  if (typeof r.nonceHex !== "string" || typeof r.nowMs !== "number" || typeof r.signedBy !== "string" || typeof r.signature !== "string") return null;
  if (!HEX64.test(r.signedBy) || !HEX128.test(r.signature)) return null;
  const a: AuthTimeStamp = { kind: "AuthTime", version: 1, nonceHex: r.nonceHex, nowMs: r.nowMs, signedBy: r.signedBy, signature: r.signature };
  try {
    canonicalAuthTime(a.nonceHex, a.nowMs);
  } catch {
    return null;
  }
  return a;
}

/** The stamp answers THIS request (same nonce) and is signed by a CA key the chain authorizes at its own time. */
export function verifyAuthTime(
  a: AuthTimeStamp,
  expectedNonceHex: string,
  chain: CaTrustChain | null,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true } | { ok: false; reason: CaArtifactReject | "wrong-nonce" } {
  if (a.nonceHex !== expectedNonceHex) return { ok: false, reason: "wrong-nonce" };
  const gate = authorizedCaKeysOrFailClosed(chain, a.nowMs, pinnedMandateHash);
  if (!gate.ok) return gate;
  const bytes = canonicalAuthTime(a.nonceHex, a.nowMs);
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
