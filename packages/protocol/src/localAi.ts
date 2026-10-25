/**
 * Local inference on the owner's own server (AI01/AI02, docs/architecture-v2/local-ai.md).
 *
 * Two owner orders, each signed with the sensitive-order key (admin root when held, else the IRK),
 * because each one widens what something on the box may do:
 *
 *   flagship/local-ai-app-grant/v1|<serverDomain>|<serviceId>|<requestsPerDay>|<tokensPerDay>|<maxTokensPerRequest>|<issuedAt>
 *
 *     lets one app (whose manifest declares `localAi.inference`) call the box-local model, within
 *     these quotas. `requestsPerDay` 0 (and the other two 0) withdraws it. The app only ever sends
 *     its own data: the endpoint is its own, nothing else is mounted or reachable through it.
 *
 *   flagship/local-ai-train/v1|<serverDomain>|<serviceId>|<jobId>|<baseModel>|<epochs>|<issuedAt>
 *
 *     starts one fine-tuning job on that app's STAGED SAMPLE data (its private test copy's files),
 *     never the live app's data, from a base model in the box's pinned catalog. The box derives the
 *     dataset from `serviceId`; the order cannot name a volume or a path.
 *
 * `serverDomain` is lowercased; every text field refuses `|` and control characters.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_LOCAL_AI_APP_GRANT = "flagship/local-ai-app-grant/v1";
export const TAG_LOCAL_AI_TRAIN = "flagship/local-ai-train/v1";

/** The provider name the apps send for "On this server"; the box resolves the endpoint itself. */
export const LOCAL_AI_PROVIDER = "flagship-local";

export const LOCAL_AI_LIMITS = {
  requestsPerDay: 100_000,
  tokensPerDay: 100_000_000,
  maxTokensPerRequest: 32_768,
  epochs: 20,
} as const;

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const JOB_ID = /^[0-9a-f]{16}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export interface LocalAiAppGrant {
  serverDomain: string;
  serviceId: string;
  requestsPerDay: number;
  tokensPerDay: number;
  maxTokensPerRequest: number;
  issuedAt: number;
}

export interface LocalAiTrainOrder {
  serverDomain: string;
  serviceId: string;
  jobId: string;
  baseModel: string;
  epochs: number;
  issuedAt: number;
}

function domain(d: unknown): string {
  if (typeof d !== "string" || d.length === 0 || d.length > 253 || /[\x00-\x1f\x7f]/.test(d)) throw new Error("bad serverDomain");
  legacyFieldGuard("serverDomain", d);
  return d.toLowerCase();
}

function intIn(v: unknown, min: number, max: number): v is number {
  return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
}

export function canonicalLocalAiAppGrant(g: LocalAiAppGrant): Bytes {
  const serverDomain = domain(g.serverDomain);
  if (typeof g.serviceId !== "string" || !SERVICE_ID.test(g.serviceId)) throw new Error("bad serviceId");
  if (!intIn(g.requestsPerDay, 0, LOCAL_AI_LIMITS.requestsPerDay)) throw new Error("bad requestsPerDay");
  if (!intIn(g.tokensPerDay, 0, LOCAL_AI_LIMITS.tokensPerDay)) throw new Error("bad tokensPerDay");
  if (!intIn(g.maxTokensPerRequest, 0, LOCAL_AI_LIMITS.maxTokensPerRequest)) throw new Error("bad maxTokensPerRequest");
  const revoke = g.requestsPerDay === 0;
  if (revoke !== (g.tokensPerDay === 0) || revoke !== (g.maxTokensPerRequest === 0)) {
    throw new Error("a withdrawal sets every quota to 0; a grant sets every quota above 0");
  }
  if (!intIn(g.issuedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error("bad issuedAt");
  return new TextEncoder().encode(
    [TAG_LOCAL_AI_APP_GRANT, serverDomain, g.serviceId, g.requestsPerDay, g.tokensPerDay, g.maxTokensPerRequest, g.issuedAt].join("|"),
  );
}

export function signLocalAiAppGrant(g: LocalAiAppGrant, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalLocalAiAppGrant(g));
}

export function verifyLocalAiAppGrant(g: LocalAiAppGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalLocalAiAppGrant(g), pub);
  } catch {
    return false;
  }
}

export function canonicalLocalAiTrainOrder(o: LocalAiTrainOrder): Bytes {
  const serverDomain = domain(o.serverDomain);
  if (typeof o.serviceId !== "string" || !SERVICE_ID.test(o.serviceId)) throw new Error("bad serviceId");
  if (typeof o.jobId !== "string" || !JOB_ID.test(o.jobId)) throw new Error("jobId must be 16 lowercase hex");
  if (typeof o.baseModel !== "string" || !MODEL_ID.test(o.baseModel)) throw new Error("bad baseModel");
  if (!intIn(o.epochs, 1, LOCAL_AI_LIMITS.epochs)) throw new Error("bad epochs");
  if (!intIn(o.issuedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error("bad issuedAt");
  return new TextEncoder().encode(
    [TAG_LOCAL_AI_TRAIN, serverDomain, o.serviceId, o.jobId, o.baseModel, o.epochs, o.issuedAt].join("|"),
  );
}

export function signLocalAiTrainOrder(o: LocalAiTrainOrder, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalLocalAiTrainOrder(o));
}

export function verifyLocalAiTrainOrder(o: LocalAiTrainOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalLocalAiTrainOrder(o), pub);
  } catch {
    return false;
  }
}
