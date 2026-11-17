// The outbound proxy's fallback lane (docs/outbound-proxy.md "Failure
// handling"). When the owner's proxy fails and the box may not go direct, the
// box still reaches `.com` through the private relay to report the failure
// and to pick up an owner-signed order that fixes or clears the proxy. Each
// lane call is signed with the box's STK over its method, path, time and body.

import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";

export const TAG_BOX_PROXY_LANE = "flagship/box-proxy-lane/v1";
export const BOX_PROXY_LANE_AUTH_SCHEME = "Flagship-Box-Lane-v1";
export const BOX_PROXY_LANE_MAX_SKEW_MS = 10 * 60_000;
/** How long an order left in the lane stays usable (the box polls every few minutes). */
export const BOX_PROXY_LANE_ORDER_TTL_MS = 7 * 24 * 3_600_000;

export type BoxProxyAlertState = "ok" | "failing" | "fallback";
export type BoxProxyFailureCode = "unreachable" | "auth" | "refused" | "protocol";
export const BOX_PROXY_FAILURE_CODES: readonly BoxProxyFailureCode[] = ["unreachable", "auth", "refused", "protocol"];

export interface BoxProxyAlertReport {
  state: BoxProxyAlertState;
  /** Why, when not ok. */
  code?: BoxProxyFailureCode;
  /** When the box entered this state (ms). */
  since: number;
}

const te = new TextEncoder();
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function boxProxyLaneBytes(domain: string, method: string, path: string, ts: number, body: Bytes): Uint8Array {
  return te.encode(`${TAG_BOX_PROXY_LANE}|${domain.toLowerCase()}|${method.toUpperCase()}|${path}|${ts}|${hexOf(sha256(body))}`);
}

/** The `authorization` header value for one lane call. */
export function boxProxyLaneAuth(domain: string, method: string, path: string, ts: number, body: Bytes, stkPriv: Bytes): string {
  return `${BOX_PROXY_LANE_AUTH_SCHEME} ${ts}.${hexOf(ed.sign(boxProxyLaneBytes(domain, method, path, ts, body), stkPriv))}`;
}

export function verifyBoxProxyLaneAuth(
  header: string | null,
  domain: string,
  method: string,
  path: string,
  body: Bytes,
  stkPub: Bytes,
  now: number,
): boolean {
  const m = new RegExp(`^${BOX_PROXY_LANE_AUTH_SCHEME} (\\d{1,16})\\.([0-9a-f]{128})$`).exec(header ?? "");
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > BOX_PROXY_LANE_MAX_SKEW_MS) return false;
  const sig = Uint8Array.from(m[2]!.match(/../g)!.map((h) => parseInt(h, 16)));
  try {
    return ed.verify(sig, boxProxyLaneBytes(domain, method, path, ts, body), stkPub);
  } catch {
    return false;
  }
}

export function parseBoxProxyAlertReport(v: unknown): BoxProxyAlertReport | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.state !== "ok" && o.state !== "failing" && o.state !== "fallback") return null;
  if (typeof o.since !== "number" || !Number.isSafeInteger(o.since) || o.since < 0) return null;
  if (o.state === "ok") return { state: "ok", since: o.since };
  const code = BOX_PROXY_FAILURE_CODES.includes(o.code as BoxProxyFailureCode) ? (o.code as BoxProxyFailureCode) : "unreachable";
  return { state: o.state, code, since: o.since };
}
