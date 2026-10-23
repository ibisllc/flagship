/**
 * The owner's consent to ONE AI operation that spends their own provider key or Flagship Inference credits
 * (SECURITY-HARDENING-PLAN.md 18.12): adapting an imported repo, repairing a build, or reconciling an
 * upstream update. It is signed with the sensitive-order key, so a stolen paired session cannot start a
 * costly run, and it names the provider and the most the run may use, so the person has seen the cost
 * before the work starts:
 *
 *   flagship/ai-repair-consent/v1|<serverDomain>|<buildId>|<operation>|<provider>|<source>|<highTokens>|<issuedAt>
 *
 * `source` is `byok` (their own key: the provider bills them) or `promo` (Flagship Inference credits).
 * `highTokens` is the upper estimate the box showed; the box refuses a consent smaller than its own current
 * upper estimate, and a consent is used once.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_AI_REPAIR_CONSENT = "flagship/ai-repair-consent/v1";

export type AiOperation = "adapt" | "repair" | "sync";
export type AiCostSource = "byok" | "promo";

export interface AiRepairConsent {
  serverDomain: string;
  buildId: string;
  operation: AiOperation;
  provider: string;
  source: AiCostSource;
  highTokens: number;
  issuedAt: number;
}

export function canonicalAiRepairConsent(c: AiRepairConsent): Bytes {
  legacyFieldGuard("serverDomain", c.serverDomain);
  legacyFieldGuard("provider", c.provider);
  if (!/^[0-9a-f]{16}$/.test(c.buildId)) throw new Error("buildId must be 16 lowercase hex");
  if (!["adapt", "repair", "sync"].includes(c.operation)) throw new Error("unknown operation");
  if (c.source !== "byok" && c.source !== "promo") throw new Error("unknown cost source");
  if (!Number.isSafeInteger(c.highTokens) || c.highTokens < 1) throw new Error("bad highTokens");
  if (!Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode(
    [TAG_AI_REPAIR_CONSENT, c.serverDomain.toLowerCase(), c.buildId, c.operation, c.provider, c.source, c.highTokens, c.issuedAt].join("|"),
  );
}

export function signAiRepairConsent(c: AiRepairConsent, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalAiRepairConsent(c));
}

export function verifyAiRepairConsent(c: AiRepairConsent, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalAiRepairConsent(c), pub);
  } catch {
    return false;
  }
}
