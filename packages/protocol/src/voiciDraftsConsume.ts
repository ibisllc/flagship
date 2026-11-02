/**
 * An admin device removes the draft ops it published from `.com`'s drafts lane (docs/voici-and-messages.md §3, §5.2):
 *
 *   flagship/voici-drafts-consume/v1|<username>|<opIds sorted (code-unit order), joined by ",">|<issuedAt>
 *
 * Ed25519 by the account's sensitive key (admin root; the IRK only when the account pins none). opIds are 16 bytes
 * of lowercase hex, 1 to 200 of them, no repeats. Wire: {consume:{username, opIds, issuedAt}, signature}.
 */
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";
import { ed25519VerifyHex, isLowerHex } from "./webEnvelope.js";

export const TAG_VOICI_DRAFTS_CONSUME = "flagship/voici-drafts-consume/v1";
export const VOICI_DRAFTS_CONSUME_MAX = 200;

export interface VoiciDraftsConsume {
  username: string;
  opIds: string[];
  issuedAt: number;
}

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function canonicalVoiciDraftsConsume(c: VoiciDraftsConsume): Bytes {
  if (typeof c.username !== "string" || !USERNAME.test(c.username)) throw new Error(`${TAG_VOICI_DRAFTS_CONSUME}: bad username`);
  if (!Array.isArray(c.opIds) || c.opIds.length < 1 || c.opIds.length > VOICI_DRAFTS_CONSUME_MAX || !c.opIds.every((id) => isLowerHex(id, 16))) {
    throw new Error(`${TAG_VOICI_DRAFTS_CONSUME}: bad opIds`);
  }
  if (new Set(c.opIds).size !== c.opIds.length) throw new Error(`${TAG_VOICI_DRAFTS_CONSUME}: repeated opId`);
  if (typeof c.issuedAt !== "number" || !Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) throw new Error(`${TAG_VOICI_DRAFTS_CONSUME}: bad issuedAt`);
  const ids = [...c.opIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return new TextEncoder().encode([TAG_VOICI_DRAFTS_CONSUME, c.username, ids.join(","), String(c.issuedAt)].join("|"));
}

export function signVoiciDraftsConsume(c: VoiciDraftsConsume, sensitiveSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciDraftsConsume(c), sensitiveSeed));
}

export function verifyVoiciDraftsConsume(c: VoiciDraftsConsume, signature: string, sensitivePub: string): boolean {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciDraftsConsume(c), sensitivePub);
  } catch {
    return false;
  }
}
