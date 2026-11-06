/**
 * The owner takes their voi.ci page down (docs/voici-and-messages.md §3.3 "Remove my page"):
 *
 *   flagship/voici-page-remove/v1|<username lowercase>|<pageId>|<seq>|<issuedAt ms>
 *
 * Ed25519 by the account's sensitive key (admin root; the IRK only when the account pins none), the same key a page
 * index names. `seq` climbs the publish ladder (stored seq + 1), so neither an old public index nor the removal itself
 * can be replayed; a later publish takes removal seq + 1 with the same pageId. issuedAt within VOICI_INDEX_SKEW_MS.
 *
 * Envelope (exact keys): {kind:"VoiciPageRemove", version:1, username, pageId, seq, issuedAt,
 * signerKind:"admin-root"|"irk", signerPub, signature}. Shared vectors: test-vectors/voici-page-remove/
 * (tools/voici-page-remove-vectors.ts).
 *
 * Check order (checkVoiciPageRemove): malformed, wrong-signer, bad-signature, wrong-page, stale, seq-conflict.
 */
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";
import { VOICI_INDEX_SKEW_MS, type VoiciSignerKind } from "./voiciPage.js";
import { ed25519VerifyHex, isLowerHex } from "./webEnvelope.js";

export const TAG_VOICI_PAGE_REMOVE = "flagship/voici-page-remove/v1";

export interface VoiciPageRemoveFields {
  username: string;
  pageId: string;
  seq: number;
  issuedAt: number;
}

export interface VoiciPageRemove extends VoiciPageRemoveFields {
  kind: "VoiciPageRemove";
  version: 1;
  signerKind: VoiciSignerKind;
  signerPub: string;
  signature: string;
}

export type VoiciPageRemoveRefusal = "malformed" | "wrong-page" | "seq-conflict" | "stale" | "bad-signature" | "wrong-signer";

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PAGE_ID = /^[0-9a-f]{32}$/;
const KEYS = ["kind", "version", "username", "pageId", "seq", "issuedAt", "signerKind", "signerPub", "signature"];
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function canonicalVoiciPageRemove(f: VoiciPageRemoveFields): Bytes {
  if (typeof f.username !== "string" || !USERNAME.test(f.username)) throw new Error(`${TAG_VOICI_PAGE_REMOVE}: bad username`);
  if (typeof f.pageId !== "string" || !PAGE_ID.test(f.pageId)) throw new Error(`${TAG_VOICI_PAGE_REMOVE}: bad pageId`);
  if (!isTime(f.seq) || f.seq < 1 || !isTime(f.issuedAt)) throw new Error(`${TAG_VOICI_PAGE_REMOVE}: bad seq/issuedAt`);
  return new TextEncoder().encode([TAG_VOICI_PAGE_REMOVE, f.username, f.pageId, String(f.seq), String(f.issuedAt)].join("|"));
}

/** Signs with the sensitive key's seed; `signerPub` is its public key. */
export function signVoiciPageRemove(fields: VoiciPageRemoveFields & { signerKind: VoiciSignerKind }, signerSeed: Bytes): VoiciPageRemove {
  const body = { username: fields.username, pageId: fields.pageId, seq: fields.seq, issuedAt: fields.issuedAt };
  return {
    kind: "VoiciPageRemove",
    version: 1,
    ...body,
    signerKind: fields.signerKind,
    signerPub: hex(ed.getPublicKey(signerSeed)),
    signature: hex(ed.sign(canonicalVoiciPageRemove(body), signerSeed)),
  };
}

/** Strict shape of an untrusted removal (JSON text or a parsed value); no signature check. */
export function parseVoiciPageRemove(input: unknown): VoiciPageRemove | null {
  let v = input;
  if (typeof input === "string") {
    if (input.length > 4096) return null;
    try {
      v = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const ks = Object.keys(r);
  if (ks.length !== KEYS.length || !KEYS.every((k) => k in r)) return null;
  if (r.kind !== "VoiciPageRemove" || r.version !== 1) return null;
  if (r.signerKind !== "admin-root" && r.signerKind !== "irk") return null;
  if (!isLowerHex(r.signerPub, 32) || !isLowerHex(r.signature, 64)) return null;
  const fields = { username: r.username, pageId: r.pageId, seq: r.seq, issuedAt: r.issuedAt } as VoiciPageRemoveFields;
  try {
    canonicalVoiciPageRemove(fields);
  } catch {
    return null;
  }
  return {
    kind: "VoiciPageRemove",
    version: 1,
    ...fields,
    signerKind: r.signerKind,
    signerPub: r.signerPub as string,
    signature: r.signature as string,
  };
}

/**
 * `.com`'s check. `parsed` may be the parse's result (null = malformed) or the raw input. The username must be the
 * one asked for (else malformed), the signer the account's current sensitive key, the pageId the stored page's,
 * issuedAt within the skew of `now`, and seq = storedSeq + 1.
 */
export function checkVoiciPageRemove(
  parsed: unknown,
  o: { username: string; sensitiveKind: VoiciSignerKind; sensitivePub: string; storedSeq: number; storedPageId: string | null; now: number },
): { ok: true; remove: VoiciPageRemove } | { ok: false; code: VoiciPageRemoveRefusal } {
  const r = parseVoiciPageRemove(parsed);
  if (!r || r.username !== o.username) return { ok: false, code: "malformed" };
  if (r.signerKind !== o.sensitiveKind || r.signerPub !== o.sensitivePub.toLowerCase()) return { ok: false, code: "wrong-signer" };
  if (!ed25519VerifyHex(r.signature, canonicalVoiciPageRemove(r), r.signerPub)) return { ok: false, code: "bad-signature" };
  if (o.storedPageId === null || r.pageId !== o.storedPageId) return { ok: false, code: "wrong-page" };
  if (Math.abs(r.issuedAt - o.now) > VOICI_INDEX_SKEW_MS) return { ok: false, code: "stale" };
  if (r.seq !== o.storedSeq + 1) return { ok: false, code: "seq-conflict" };
  return { ok: true, remove: r };
}
