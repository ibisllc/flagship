// `flagship/ai-repair-consent/v1`: the owner's consent to ONE AI run that spends their key or Flagship
// Inference credits, signed with the sensitive-order key and sent with the adapt request after the box's
// estimate was shown (HTTP 428 {code:"ai-consent", estimate}). Wire parity with
// packages/protocol/src/aiRepairConsent.ts; pinned by packages/protocol/test-vectors/ai-repair-consent/vectors.json.
//
//   flagship/ai-repair-consent/v1|<serverDomain lowercase>|<buildId>|<operation>|<provider>|<source>|<highTokens>|<issuedAt>

export const AI_REPAIR_CONSENT_TAG = "flagship/ai-repair-consent/v1";

const clean = (s) => typeof s === "string" && s.length > 0 && !/[|\x00-\x1f\x7f]/.test(s);

export function canonicalAiRepairConsent(c) {
  if (!clean(c.serverDomain)) throw new Error("serverDomain");
  if (!clean(c.provider)) throw new Error("provider");
  if (!/^[0-9a-f]{16}$/.test(c.buildId)) throw new Error("buildId");
  if (!["adapt", "repair", "sync"].includes(c.operation)) throw new Error("operation");
  if (c.source !== "byok" && c.source !== "promo") throw new Error("source");
  if (!Number.isSafeInteger(c.highTokens) || c.highTokens < 1) throw new Error("highTokens");
  if (!Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) throw new Error("issuedAt");
  return new TextEncoder().encode([AI_REPAIR_CONSENT_TAG, c.serverDomain.toLowerCase(), c.buildId, c.operation, c.provider, c.source, c.highTokens, c.issuedAt].join("|"));
}

/** The `consent` object of the adapt request; `sign(bytes)` returns the 64-byte signature. */
export async function aiConsentBody(c, sign) {
  const sig = await sign(canonicalAiRepairConsent(c));
  return {
    issuedAt: c.issuedAt,
    provider: c.provider,
    source: c.source,
    highTokens: c.highTokens,
    signature: Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
