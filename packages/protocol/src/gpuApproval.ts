/**
 * The owner's approval of an app's GPU use, `flagship/gpu-approval/v2`, which flagship-gpud checks
 * itself (rust/crates/flagship-gpu/src/owner_approval.rs), so the unprivileged daemon can't widen
 * what an app may do with a GPU. Signed by the sensitive-order key (the admin root when the account
 * pins one, else the owner IRK) for one box; gpud reads both from keyd's root-written pins. v2 also
 * binds what the claim carries (container, userspace image, run-time limit, share): gpud refuses a
 * claim that asks for anything else. v1 is no longer accepted anywhere.
 *
 * Canonical bytes (one line):
 *   flagship/gpu-approval/v2|<serverDomain>|<appId>|<installationId>|<generation>|<backend>|<maxCount>
 *   |<capabilities sorted, comma-joined>|<policies sorted, comma-joined>|<isolation>|<secrecy 1|0>
 *   |<trustDomain or empty>|<ownerConsent or empty>|<container>|<userspace or empty>
 *   |<maxRuntimeMs or empty>|<computePercent:memoryMib or empty>|<issuedAt ms>
 * Vectors: test-vectors/gpu-approval/vectors.json (TS, webapp, Swift, Kotlin and Rust).
 */
import { ed } from "./edSync.js";
import { resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_GPU_APPROVAL = "flagship/gpu-approval/v2";

export const GPU_BACKENDS = ["nvidia-cuda", "amd-rocm", "intel-level-zero"] as const;
export const GPU_CAPABILITIES = ["compute", "graphics", "video-encode", "video-decode"] as const;
export const GPU_POLICIES = ["exclusive", "partition", "cooperative"] as const;
export const GPU_ISOLATIONS = ["gvisor-nvproxy", "vm-passthrough"] as const;

export interface GpuApprovalTerms {
  app: { appId: string; installationId: string; generation: number };
  backend: (typeof GPU_BACKENDS)[number];
  maxCount: number;
  capabilities: (typeof GPU_CAPABILITIES)[number][];
  policies: (typeof GPU_POLICIES)[number][];
  isolation: (typeof GPU_ISOLATIONS)[number];
  secrecy: boolean;
  trustDomain: string | null;
  ownerConsent: string | null;
  /** The one container the claim may run in (`flagship-<appId>` for an app). */
  container: string;
  /** A catalog userspace image purpose; null: gpud's first approved one. */
  userspace: string | null;
  maxRuntimeMs: number | null;
  /** Cooperative sharing's limits on the device. */
  share: { computePercent: number; memoryMib: number } | null;
}

const SERVER = /^[a-z0-9.-]{1,253}$/;
const FIELD = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_GANG = 16;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function sortedSet(items: readonly string[], allowed: readonly string[], what: string): string {
  if (items.length === 0) throw new Error(`gpu-approval: no ${what}`);
  for (const i of items) if (!allowed.includes(i)) throw new Error(`gpu-approval: unknown ${what} ${JSON.stringify(i)}`);
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",");
}

function container(c: string): string {
  if (typeof c !== "string" || !CONTAINER.test(c)) throw new Error("gpu-approval: bad container");
  return c;
}

function maxRuntime(ms: number | null): string {
  if (ms === null) return "";
  if (!Number.isSafeInteger(ms) || ms < 1) throw new Error("gpu-approval: bad maxRuntimeMs");
  return String(ms);
}

function share(s: { computePercent: number; memoryMib: number } | null): string {
  if (s === null) return "";
  if (!Number.isSafeInteger(s.computePercent) || s.computePercent < 1 || s.computePercent > 100) throw new Error("gpu-approval: a compute share is 1 to 100 percent");
  if (!Number.isSafeInteger(s.memoryMib) || s.memoryMib < 1) throw new Error("gpu-approval: bad share memory");
  return `${s.computePercent}:${s.memoryMib}`;
}

export function gpuApprovalCanonicalBytes(serverDomain: string, a: GpuApprovalTerms, issuedAt: number): Bytes {
  if (!SERVER.test(serverDomain)) throw new Error("gpu-approval: bad serverDomain");
  if (!FIELD.test(a.app.appId) || !FIELD.test(a.app.installationId)) throw new Error("gpu-approval: bad app installation");
  if (!Number.isSafeInteger(a.app.generation) || a.app.generation < 0) throw new Error("gpu-approval: bad generation");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("gpu-approval: bad issuedAt");
  if (!Number.isSafeInteger(a.maxCount) || a.maxCount < 1 || a.maxCount > MAX_GANG) throw new Error("gpu-approval: maxCount is 1 to 16");
  if (!(GPU_BACKENDS as readonly string[]).includes(a.backend)) throw new Error("gpu-approval: unknown backend");
  if (!(GPU_ISOLATIONS as readonly string[]).includes(a.isolation)) throw new Error("gpu-approval: unknown isolation");
  const opt = (v: string | null, what: string) => {
    if (v === null) return "";
    if (!FIELD.test(v)) throw new Error(`gpu-approval: bad ${what}`);
    return v;
  };
  return new TextEncoder().encode(
    [
      TAG_GPU_APPROVAL,
      serverDomain,
      a.app.appId,
      a.app.installationId,
      String(a.app.generation),
      a.backend,
      String(a.maxCount),
      sortedSet(a.capabilities, GPU_CAPABILITIES, "capability"),
      sortedSet(a.policies, GPU_POLICIES, "policy"),
      a.isolation,
      a.secrecy ? "1" : "0",
      opt(a.trustDomain, "trust domain"),
      opt(a.ownerConsent, "consent"),
      container(a.container),
      opt(a.userspace, "userspace"),
      maxRuntime(a.maxRuntimeMs),
      share(a.share),
      String(issuedAt),
    ].join("|"),
  );
}

export function signGpuApproval(serverDomain: string, a: GpuApprovalTerms, issuedAt: number, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(gpuApprovalCanonicalBytes(serverDomain, a, issuedAt));
}

/** Never throws: a malformed approval simply fails. */
export function verifyGpuApproval(serverDomain: string, a: GpuApprovalTerms, issuedAt: number, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, gpuApprovalCanonicalBytes(serverDomain, a, issuedAt), pub);
  } catch {
    return false;
  }
}

/**
 * The owner withdraws a GPU approval, `flagship/gpu-approval-withdraw/v1`, signed by the same key:
 *   flagship/gpu-approval-withdraw/v1|<serverDomain>|<appId>|<installationId>|<generation>|<issuedAt>
 */
export const TAG_GPU_APPROVAL_WITHDRAW = "flagship/gpu-approval-withdraw/v1";

export interface GpuApprovalWithdraw {
  appId: string;
  installationId: string;
  generation: number;
  issuedAt: number;
}

export function gpuApprovalWithdrawCanonicalBytes(serverDomain: string, w: GpuApprovalWithdraw): Bytes {
  if (!SERVER.test(serverDomain)) throw new Error("gpu-approval-withdraw: bad serverDomain");
  if (!FIELD.test(w.appId) || !FIELD.test(w.installationId)) throw new Error("gpu-approval-withdraw: bad app installation");
  if (!Number.isSafeInteger(w.generation) || w.generation < 0) throw new Error("gpu-approval-withdraw: bad generation");
  if (!Number.isSafeInteger(w.issuedAt) || w.issuedAt < 0) throw new Error("gpu-approval-withdraw: bad issuedAt");
  return new TextEncoder().encode([TAG_GPU_APPROVAL_WITHDRAW, serverDomain, w.appId, w.installationId, String(w.generation), String(w.issuedAt)].join("|"));
}

export function signGpuApprovalWithdraw(serverDomain: string, w: GpuApprovalWithdraw, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(gpuApprovalWithdrawCanonicalBytes(serverDomain, w));
}

/** Never throws: a malformed withdrawal simply fails. */
export function verifyGpuApprovalWithdraw(serverDomain: string, w: GpuApprovalWithdraw, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, gpuApprovalWithdrawCanonicalBytes(serverDomain, w), pub);
  } catch {
    return false;
  }
}
