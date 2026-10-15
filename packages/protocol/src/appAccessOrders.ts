/**
 * Admin-only orders over one app's access (docs/service-access-gating.md,
 * "Account members, ranks and who may change them").
 *
 * They name the app (its `serviceRef`, the same on every server of the
 * account), never one server, so the same order holds wherever the app runs.
 * Each is signed by the box's sensitive-order key (the admin root, or a device
 * with an admin-root-signed `admin` grant; the owner IRK only on a box with no
 * admin root) and is applied only when its `issuedAt` is newer than the last
 * order applied to the same target ("latest order wins").
 *
 *   flagship/app-rank/v1|<serviceRef>|<target>|<rank>|<issuedAt>
 *   flagship/service-access-mode/v2|<serviceRef>|<open|restricted>|<issuedAt>
 *   flagship/service-allow-remove/v2|<serviceRef>|<aid hex>|<issuedAt>
 *
 * `test-vectors/app-access-orders/vectors.json` is the cross-platform reference.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_APP_RANK = "flagship/app-rank/v1";
export const TAG_SERVICE_ACCESS_MODE_V2 = "flagship/service-access-mode/v2";
export const TAG_SERVICE_ALLOW_REMOVE_V2 = "flagship/service-allow-remove/v2";

/** Ranks an order can set, lowest first, then `refused` (device and share targets only). */
export const APP_RANK_VALUES = ["member", "manager", "master", "refused"] as const;
export type AppRankValue = (typeof APP_RANK_VALUES)[number];

const SERVICE_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DEVICE_TARGET_RE = /^device:([0-9a-f]{64})$/;
const SHARE_TARGET_RE = /^share:([0-9a-f]{32})$/;
const AID_TARGET_RE = /^aid:([0-9a-f]{64})$/;
const INVITE_TARGET_RE = /^invite:([A-Za-z0-9._-]{1,128})$/;
const GRANT_TARGET_RE = /^grant:([A-Za-z0-9._-]{1,128})\/([0-9a-f]{64})$/;

export type AppRankTarget =
  | { kind: "device"; pub: string }
  | { kind: "share"; shareId: string }
  | { kind: "aid"; aid: string }
  | { kind: "invite"; inviteId: string }
  | { kind: "grant"; inviteId: string; aid: string };

export function appRankTargetDevice(pubHex: string): string {
  return `device:${pubHex.toLowerCase()}`;
}
export function appRankTargetShare(shareId: string): string {
  return `share:${shareId.toLowerCase()}`;
}

/** The parsed target, or null when malformed. */
export function parseAppRankTarget(t: string): AppRankTarget | null {
  let m: RegExpExecArray | null;
  if ((m = DEVICE_TARGET_RE.exec(t))) return { kind: "device", pub: m[1]! };
  if ((m = SHARE_TARGET_RE.exec(t))) return { kind: "share", shareId: m[1]! };
  if ((m = AID_TARGET_RE.exec(t))) return { kind: "aid", aid: m[1]! };
  if ((m = INVITE_TARGET_RE.exec(t))) return { kind: "invite", inviteId: m[1]! };
  if ((m = GRANT_TARGET_RE.exec(t))) return { kind: "grant", inviteId: m[1]!, aid: m[2]! };
  return null;
}

function checkServiceRef(tag: string, ref: string): void {
  if (!SERVICE_REF_RE.test(ref)) throw new Error(`${tag}: bad serviceRef`);
  legacyFieldGuard("serviceRef", ref);
}

function checkIssuedAt(tag: string, at: number): void {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error(`${tag}: bad issuedAt`);
}

// ── app-rank/v1 ──────────────────────────────────────────────────────

export interface AppRankOrder {
  serviceRef: string;
  target: string;
  rank: string;
  issuedAt: number;
}

export function appRankCanonicalBytes(o: AppRankOrder): Bytes {
  checkServiceRef(TAG_APP_RANK, o.serviceRef);
  const target = parseAppRankTarget(o.target);
  if (!target) throw new Error(`${TAG_APP_RANK}: bad target`);
  if (!(APP_RANK_VALUES as readonly string[]).includes(o.rank)) throw new Error(`${TAG_APP_RANK}: bad rank`);
  if (o.rank === "refused" && target.kind !== "device" && target.kind !== "share") {
    throw new Error(`${TAG_APP_RANK}: only a device or a co-manager can be refused`);
  }
  checkIssuedAt(TAG_APP_RANK, o.issuedAt);
  return new TextEncoder().encode([TAG_APP_RANK, o.serviceRef, o.target, o.rank, String(o.issuedAt)].join("|"));
}

export function signAppRank(o: AppRankOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appRankCanonicalBytes(o));
}

/** Never throws: a malformed order simply fails. */
export function verifyAppRank(o: AppRankOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appRankCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON order (no signature check). */
export function parseAppRankOrder(v: unknown): AppRankOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serviceRef !== "string" || typeof r.target !== "string" || typeof r.rank !== "string") return null;
  if (typeof r.issuedAt !== "number") return null;
  const o: AppRankOrder = { serviceRef: r.serviceRef, target: r.target, rank: r.rank, issuedAt: r.issuedAt };
  try {
    appRankCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}

// ── service-access-mode/v2 ───────────────────────────────────────────

export interface ServiceAccessModeOrder {
  serviceRef: string;
  mode: "open" | "restricted";
  issuedAt: number;
}

export function serviceAccessModeV2CanonicalBytes(o: ServiceAccessModeOrder): Bytes {
  checkServiceRef(TAG_SERVICE_ACCESS_MODE_V2, o.serviceRef);
  if (o.mode !== "open" && o.mode !== "restricted") throw new Error(`${TAG_SERVICE_ACCESS_MODE_V2}: bad mode`);
  checkIssuedAt(TAG_SERVICE_ACCESS_MODE_V2, o.issuedAt);
  return new TextEncoder().encode([TAG_SERVICE_ACCESS_MODE_V2, o.serviceRef, o.mode, String(o.issuedAt)].join("|"));
}

export function signServiceAccessModeV2(o: ServiceAccessModeOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(serviceAccessModeV2CanonicalBytes(o));
}

export function verifyServiceAccessModeV2(o: ServiceAccessModeOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, serviceAccessModeV2CanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

export function parseServiceAccessModeV2(v: unknown): ServiceAccessModeOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serviceRef !== "string" || (r.mode !== "open" && r.mode !== "restricted")) return null;
  if (typeof r.issuedAt !== "number" || "serverId" in r) return null;
  const o: ServiceAccessModeOrder = { serviceRef: r.serviceRef, mode: r.mode, issuedAt: r.issuedAt };
  try {
    serviceAccessModeV2CanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}

// ── service-allow-remove/v2 ──────────────────────────────────────────

export interface ServiceAllowRemoveOrder {
  serviceRef: string;
  /** Lower-hex 32-byte id to drop from the app's allow-list. */
  aid: string;
  issuedAt: number;
}

export function serviceAllowRemoveV2CanonicalBytes(o: ServiceAllowRemoveOrder): Bytes {
  checkServiceRef(TAG_SERVICE_ALLOW_REMOVE_V2, o.serviceRef);
  if (!HEX64_RE.test(o.aid)) throw new Error(`${TAG_SERVICE_ALLOW_REMOVE_V2}: aid must be 64 lowercase hex`);
  checkIssuedAt(TAG_SERVICE_ALLOW_REMOVE_V2, o.issuedAt);
  return new TextEncoder().encode([TAG_SERVICE_ALLOW_REMOVE_V2, o.serviceRef, o.aid, String(o.issuedAt)].join("|"));
}

export function signServiceAllowRemoveV2(o: ServiceAllowRemoveOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(serviceAllowRemoveV2CanonicalBytes(o));
}

export function verifyServiceAllowRemoveV2(o: ServiceAllowRemoveOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, serviceAllowRemoveV2CanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

export function parseServiceAllowRemoveV2(v: unknown): ServiceAllowRemoveOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serviceRef !== "string" || typeof r.aid !== "string" || typeof r.issuedAt !== "number") return null;
  if ("serverId" in r) return null;
  const o: ServiceAllowRemoveOrder = { serviceRef: r.serviceRef, aid: r.aid, issuedAt: r.issuedAt };
  try {
    serviceAllowRemoveV2CanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}
