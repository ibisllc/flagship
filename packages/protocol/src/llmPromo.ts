/**
 * LLM promo-key issue — the phone-signed request to mint a one-shot scoped
 * provider key (`flagship/llm-promo-issue/v1`).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tag, field
 * order, and guards are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// LLM promo-key issue
//
// Phone-signed request from a user to mint a one-shot scoped LLM API
// key. The Worker checks tier + daily/lifetime caps + asks the
// upstream provider for a scoped key, returns it sealed against the
// phone's pre-shared pubkey so the box receives it without the
// Worker storing the plaintext.
// ──────────────────────────────────────────────────────────────────────

export type LlmProvider = "anthropic" | "openai" | "google";

export interface LlmPromoIssueRequest {
  username: string;
  serverFqdn: string;          // which box will use the key
  provider: LlmProvider;
  /** Hint for daily token cap; .com clamps to tier-allowed max. */
  desiredDailyInputTokenCap: number;
  desiredDailyOutputTokenCap: number;
  issuedAt: number;
}

const TAG_LLM_PROMO_ISSUE = "flagship/llm-promo-issue/v1";

function canonicalLlmPromoIssue(r: LlmPromoIssueRequest): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("serverFqdn", r.serverFqdn);
  return new TextEncoder().encode(
    [
      TAG_LLM_PROMO_ISSUE,
      r.username,
      r.serverFqdn,
      r.provider,
      r.desiredDailyInputTokenCap,
      r.desiredDailyOutputTokenCap,
      r.issuedAt,
    ].join("|"),
  );
}

export function signLlmPromoIssue(r: LlmPromoIssueRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalLlmPromoIssue(r), irk.privateKey);
}

export function verifyLlmPromoIssue(r: LlmPromoIssueRequest, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalLlmPromoIssue(r), irkPub);
  } catch {
    return false;
  }
}
