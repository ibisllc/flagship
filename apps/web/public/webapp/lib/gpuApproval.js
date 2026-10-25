// The owner's GPU approval for one app installation on one box, which flagship-gpud verifies itself,
// and its withdrawal. Signed with the sensitive-order key (the admin root, else the IRK on an account
// without one). Wire parity with packages/protocol/src/gpuApproval.ts; pinned by
// packages/protocol/test-vectors/gpu-approval/vectors.json.
//
//   flagship/gpu-approval/v1|<server>|<appId>|<installationId>|<generation>|<backend>|<maxCount>
//     |<caps sorted, comma-joined>|<policies sorted, comma-joined>|<isolation>|<secrecy 1|0>
//     |<trustDomain or empty>|<ownerConsent or empty>|<issuedAt>
//   flagship/gpu-approval-withdraw/v1|<server>|<appId>|<installationId>|<generation>|<issuedAt>
//
// MIRRORS: iOS GpuApprovalOrders.swift, Android GpuApprovalOrders.kt.

export const TAG_GPU_APPROVAL = "flagship/gpu-approval/v1";
export const TAG_GPU_APPROVAL_WITHDRAW = "flagship/gpu-approval-withdraw/v1";

export const GPU_BACKENDS = ["nvidia-cuda", "amd-rocm", "intel-level-zero"];
export const GPU_CAPABILITIES = ["compute", "graphics", "video-encode", "video-decode"];
export const GPU_POLICIES = ["exclusive", "partition", "cooperative"];
export const GPU_ISOLATIONS = ["gvisor-nvproxy", "vm-passthrough"];
/** The trust domain an owner's approval of cooperative sharing names: the account's own apps. */
export const COOPERATIVE_TRUST_DOMAIN = "owner-apps";

const SERVER = /^[a-z0-9.-]{1,253}$/;
const FIELD = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_GANG = 16;
const enc = new TextEncoder();
const toHex = (sig) => Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");

function sortedSet(items, allowed, what) {
  if (!Array.isArray(items) || items.length === 0) throw new Error(`gpu-approval: no ${what}`);
  for (const i of items) if (!allowed.includes(i)) throw new Error(`gpu-approval: unknown ${what}`);
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",");
}

function ids(server, appId, installationId, generation, issuedAt) {
  if (!SERVER.test(server)) throw new Error("gpu-approval: bad serverDomain");
  if (!FIELD.test(appId) || !FIELD.test(installationId)) throw new Error("gpu-approval: bad app installation");
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("gpu-approval: bad generation");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("gpu-approval: bad issuedAt");
}

/** The bytes the owner signs to approve request `r` (the box's listing shape) on `server`. */
export function gpuApprovalCanonical(server, r, issuedAt) {
  ids(server, r.appId, r.installationId, r.generation, issuedAt);
  if (!Number.isSafeInteger(r.maxCount) || r.maxCount < 1 || r.maxCount > MAX_GANG) throw new Error("gpu-approval: maxCount is 1 to 16");
  if (!GPU_BACKENDS.includes(r.backend)) throw new Error("gpu-approval: unknown backend");
  if (!GPU_ISOLATIONS.includes(r.isolation)) throw new Error("gpu-approval: unknown isolation");
  const opt = (v, what) => {
    if (v == null) return "";
    if (!FIELD.test(v)) throw new Error(`gpu-approval: bad ${what}`);
    return v;
  };
  return enc.encode(
    [
      TAG_GPU_APPROVAL,
      server,
      r.appId,
      r.installationId,
      String(r.generation),
      r.backend,
      String(r.maxCount),
      sortedSet(r.caps, GPU_CAPABILITIES, "capability"),
      sortedSet(r.policies, GPU_POLICIES, "policy"),
      r.isolation,
      r.secrecy ? "1" : "0",
      opt(r.trustDomain, "trust domain"),
      opt(r.ownerConsent, "consent"),
      String(issuedAt),
    ].join("|"),
  );
}

export function gpuApprovalWithdrawCanonical(server, { appId, installationId, generation, issuedAt }) {
  ids(server, appId, installationId, generation, issuedAt);
  return enc.encode([TAG_GPU_APPROVAL_WITHDRAW, server, appId, installationId, String(generation), String(issuedAt)].join("|"));
}

/**
 * The terms the owner signs for a listed request. The box lists a request with no trust domain or
 * consent; sharing a GPU between apps (cooperative) needs both, so the owner's approval names the
 * account's own apps as the trust domain and records this approval as the consent.
 */
export function ownerTerms(r, issuedAt) {
  if (!(r?.policies ?? []).includes("cooperative")) return r;
  return { ...r, trustDomain: r.trustDomain ?? COOPERATIVE_TRUST_DOMAIN, ownerConsent: r.ownerConsent ?? `owner-consent-${issuedAt}` };
}

/** `POST /api/screens/accelerators/approvals`: the listed terms, issuedAt and the signature. */
export async function gpuApprovalBody(server, request, issuedAt, sign) {
  const r = ownerTerms(request, issuedAt);
  const sig = await sign(gpuApprovalCanonical(server, r, issuedAt));
  return {
    server,
    appId: r.appId,
    installationId: r.installationId,
    generation: r.generation,
    backend: r.backend,
    maxCount: r.maxCount,
    caps: r.caps,
    policies: r.policies,
    isolation: r.isolation,
    secrecy: r.secrecy,
    trustDomain: r.trustDomain ?? null,
    ownerConsent: r.ownerConsent ?? null,
    issuedAt,
    signature: toHex(sig),
  };
}

/** `POST /api/screens/accelerators/approvals/withdraw`. */
export async function gpuApprovalWithdrawBody(server, r, issuedAt, sign) {
  const w = { appId: r.appId, installationId: r.installationId, generation: r.generation, issuedAt };
  return { ...w, signature: toHex(await sign(gpuApprovalWithdrawCanonical(server, w))) };
}
