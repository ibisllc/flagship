/**
 * Per-operation consent for an AI run that spends the owner's key or credits (SECURITY-HARDENING-PLAN.md
 * 18.12). The box shows an honest estimate (a range, in tokens, with the provider and who pays), the owner
 * signs `flagship/ai-repair-consent/v1` naming the most the run may use, and the box checks that signature,
 * that it matches this build, provider and cost source, that it covers the current estimate and that it has
 * not been used. No consent, no run; a run never starts on a stored "yes".
 */
import { verifyAiRepairConsent, type AiCostSource, type AiOperation } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { SensitiveAuthority } from "../egress/approvals.js";

export interface AiCostEstimate {
  provider: string;
  source: AiCostSource;
  operation: AiOperation;
  lowTokens: number;
  highTokens: number;
  unit: "tokens";
}

export interface ConsentInput {
  issuedAt: number;
  provider: string;
  source: string;
  highTokens: number;
  signature: string;
}

/**
 * A range, not a promise. A run sends the project's files once and then once more per tool round as the
 * conversation grows, so the high end allows several rounds; it is capped at one large context window.
 */
export function estimateAiTokens(workspaceBytes: number): { lowTokens: number; highTokens: number } {
  const input = Math.ceil(Math.max(0, workspaceBytes) / 4);
  const low = input + 8_000;
  return { lowTokens: low, highTokens: Math.min(Math.max(low * 6, low + 1), 2_000_000) };
}

/** `tokenBudget`: the signed `highTokens`, the most the run may use; absent when no consent was needed. */
export type ConsentVerdict = { ok: true; tokenBudget?: number } | { ok: false; status: 428; reason: "consent-required"; estimate: AiCostEstimate } | { ok: false; status: 403; reason: string; estimate: AiCostEstimate };

export class AdaptConsentGate {
  private readonly used = new Set<string>();

  constructor(
    private readonly o: {
      serverDomain: string;
      authority: () => SensitiveAuthority;
      /** Provider name and who pays, from the build's stored credential; null when there is none. */
      costOf: (buildId: string) => { provider: string; source: AiCostSource } | null;
      /** The size of what the run would read. */
      workspaceBytes: (buildId: string) => number;
      now?: () => number;
      maxSkewMs?: number;
    },
  ) {}

  estimate(buildId: string, operation: AiOperation): AiCostEstimate | null {
    const c = this.o.costOf(buildId);
    if (!c) return null;
    return { ...c, operation, ...estimateAiTokens(this.o.workspaceBytes(buildId)), unit: "tokens" };
  }

  check(buildId: string, operation: AiOperation, consent: ConsentInput | undefined): ConsentVerdict {
    const est = this.estimate(buildId, operation);
    if (!est) return { ok: true }; // no credential: the run itself will refuse
    if (!consent) return { ok: false, status: 428, reason: "consent-required", estimate: est };
    const now = (this.o.now ?? (() => Date.now()))();
    const refuse = (reason: string): ConsentVerdict => ({ ok: false, status: 403, reason, estimate: est });
    if (typeof consent.signature !== "string" || !/^[0-9a-f]{128}$/i.test(consent.signature)) return refuse("a signed consent is required");
    if (!Number.isSafeInteger(consent.issuedAt) || Math.abs(now - consent.issuedAt) > (this.o.maxSkewMs ?? 10 * 60_000)) return refuse("that consent is stale");
    if (consent.provider !== est.provider || consent.source !== est.source) return refuse("the provider changed since you agreed");
    if (!Number.isSafeInteger(consent.highTokens) || consent.highTokens < est.highTokens) return refuse("the estimate grew since you agreed");
    const a = this.o.authority();
    let ok = false;
    try {
      ok = authorizeSensitiveOrder({
        ownerIrkPub: a.ownerIrkPub,
        ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
        username: a.username,
        ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
        order: { serverDomain: this.o.serverDomain, buildId, operation, provider: est.provider, source: est.source, highTokens: consent.highTokens, issuedAt: consent.issuedAt },
        signature: Uint8Array.from(Buffer.from(consent.signature, "hex")),
        verify: verifyAiRepairConsent,
      });
    } catch {
      ok = false;
    }
    if (!ok) return refuse("that consent was not signed by the owner");
    const key = `${buildId}|${operation}|${consent.issuedAt}`;
    if (this.used.has(key)) return refuse("that consent was already used");
    this.used.add(key);
    if (this.used.size > 2048) this.used.delete(this.used.values().next().value!);
    return { ok: true, tokenBudget: consent.highTokens };
  }
}
