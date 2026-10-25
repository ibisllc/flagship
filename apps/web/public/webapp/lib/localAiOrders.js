// Local AI orders (docs/architecture-v2/local-ai.md §4), signed with the sensitive-order key and
// sent to the box: an app may call the server's own model within daily quotas, and one fine-tuning
// job on one app's staged sample data. Wire parity with packages/protocol/src/localAi.ts; pinned by
// packages/protocol/test-vectors/local-ai/vectors.json.
//
//   flagship/local-ai-app-grant/v1|<serverDomain lowercase>|<serviceId>|<requestsPerDay>|<tokensPerDay>|<maxTokensPerRequest>|<issuedAt>
//   flagship/local-ai-train/v1|<serverDomain lowercase>|<serviceId>|<jobId>|<baseModel>|<epochs>|<issuedAt>

export const LOCAL_AI_APP_GRANT_TAG = "flagship/local-ai-app-grant/v1";
export const LOCAL_AI_TRAIN_TAG = "flagship/local-ai-train/v1";
export const LOCAL_AI_PROVIDER = "flagship-local";
/** What the apps send for "On this server": the box ignores the key and uses its own endpoint. */
export const LOCAL_AI_CREDENTIAL = Object.freeze({ provider: LOCAL_AI_PROVIDER, apiKey: "local" });

export const LOCAL_AI_LIMITS = Object.freeze({ requestsPerDay: 100000, tokensPerDay: 100000000, maxTokensPerRequest: 32768, epochs: 20 });
export const DEFAULT_APP_GRANT = Object.freeze({ requestsPerDay: 500, tokensPerDay: 200000, maxTokensPerRequest: 1024 });

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const JOB_ID = /^[0-9a-f]{16}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

function domain(d) {
  if (typeof d !== "string" || d.length === 0 || d.length > 253 || /[|\x00-\x1f\x7f]/.test(d)) throw new Error("serverDomain");
  return d.toLowerCase();
}
const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

export function canonicalLocalAiAppGrant(g) {
  const serverDomain = domain(g.serverDomain);
  if (typeof g.serviceId !== "string" || !SERVICE_ID.test(g.serviceId)) throw new Error("serviceId");
  if (!intIn(g.requestsPerDay, 0, LOCAL_AI_LIMITS.requestsPerDay)) throw new Error("requestsPerDay");
  if (!intIn(g.tokensPerDay, 0, LOCAL_AI_LIMITS.tokensPerDay)) throw new Error("tokensPerDay");
  if (!intIn(g.maxTokensPerRequest, 0, LOCAL_AI_LIMITS.maxTokensPerRequest)) throw new Error("maxTokensPerRequest");
  const revoke = g.requestsPerDay === 0;
  if (revoke !== (g.tokensPerDay === 0) || revoke !== (g.maxTokensPerRequest === 0)) throw new Error("quotas");
  if (!intIn(g.issuedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error("issuedAt");
  return new TextEncoder().encode(
    [LOCAL_AI_APP_GRANT_TAG, serverDomain, g.serviceId, g.requestsPerDay, g.tokensPerDay, g.maxTokensPerRequest, g.issuedAt].join("|"),
  );
}

export function canonicalLocalAiTrainOrder(o) {
  const serverDomain = domain(o.serverDomain);
  if (typeof o.serviceId !== "string" || !SERVICE_ID.test(o.serviceId)) throw new Error("serviceId");
  if (typeof o.jobId !== "string" || !JOB_ID.test(o.jobId)) throw new Error("jobId");
  if (typeof o.baseModel !== "string" || !MODEL_ID.test(o.baseModel)) throw new Error("baseModel");
  if (!intIn(o.epochs, 1, LOCAL_AI_LIMITS.epochs)) throw new Error("epochs");
  if (!intIn(o.issuedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error("issuedAt");
  return new TextEncoder().encode([LOCAL_AI_TRAIN_TAG, serverDomain, o.serviceId, o.jobId, o.baseModel, o.epochs, o.issuedAt].join("|"));
}

const toHex = (sig) => Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");

/** `{order, signature}` for POST /api/screens/local-ai/apps/grant. `sign(bytes)` returns 64 bytes. */
export async function appGrantBody(g, sign) {
  const order = {
    serverDomain: g.serverDomain,
    serviceId: g.serviceId,
    requestsPerDay: g.requestsPerDay,
    tokensPerDay: g.tokensPerDay,
    maxTokensPerRequest: g.maxTokensPerRequest,
    issuedAt: g.issuedAt,
  };
  return { order, signature: toHex(await sign(canonicalLocalAiAppGrant(order))) };
}

/** `{order, signature}` for POST /api/screens/local-ai/train. */
export async function trainOrderBody(o, sign) {
  const order = { serverDomain: o.serverDomain, serviceId: o.serviceId, jobId: o.jobId, baseModel: o.baseModel, epochs: o.epochs, issuedAt: o.issuedAt };
  return { order, signature: toHex(await sign(canonicalLocalAiTrainOrder(order))) };
}

/** A fresh job id: 16 random lowercase hex. */
export function newJobId(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return toHex(rand(8));
}

/** A withdrawal: every quota 0. */
export function withdrawal(serverDomain, serviceId, issuedAt) {
  return { serverDomain, serviceId, requestsPerDay: 0, tokensPerDay: 0, maxTokensPerRequest: 0, issuedAt };
}
