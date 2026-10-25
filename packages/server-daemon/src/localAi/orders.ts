/**
 * The owner's signed local-AI orders as the box checks them: the sensitive-order key (admin root
 * when the account pins one, else the IRK) through the same gate as every sensitive order, this
 * server's name, a fresh `issuedAt`, nothing but the order's own fields. Text a model or an app
 * wrote can never become one: only a signature the box verifies authorizes anything.
 */
import {
  verifyLocalAiAppGrant,
  verifyLocalAiTrainOrder,
  type LocalAiAppGrant,
  type LocalAiTrainOrder,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { SensitiveAuthority } from "../egress/approvals.js";

export type SensitiveOrderAuthority = SensitiveAuthority;

export const MAX_ORDER_SKEW_MS = 10 * 60_000;

export function authorizeSensitiveOrderSafe<T>(a: SensitiveOrderAuthority, order: T, signatureHex: string, verify: (o: T, sig: Uint8Array, pub: Uint8Array) => boolean): boolean {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  try {
    return authorizeSensitiveOrder({
      ownerIrkPub: a.ownerIrkPub,
      ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
      username: a.username,
      ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
      order,
      signature: Uint8Array.from(Buffer.from(signatureHex, "hex")),
      verify,
    });
  } catch {
    return false;
  }
}

const GRANT_KEYS = ["serverDomain", "serviceId", "requestsPerDay", "tokensPerDay", "maxTokensPerRequest", "issuedAt"];
const TRAIN_KEYS = ["serverDomain", "serviceId", "jobId", "baseModel", "epochs", "issuedAt"];

export type OrderVerdict<T> = { ok: true; order: T } | { ok: false; status: 400 | 403; error: string };

function exactKeys(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const k = Object.keys(v);
  return k.length === keys.length && keys.every((x) => k.includes(x));
}

function common(order: Record<string, unknown>, serverDomain: string, now: number): string | null {
  if (typeof order.serverDomain !== "string" || order.serverDomain.toLowerCase() !== serverDomain.toLowerCase()) return "That order is for another server.";
  if (!Number.isSafeInteger(order.issuedAt) || Math.abs(now - (order.issuedAt as number)) > MAX_ORDER_SKEW_MS) return "That order is stale. Try again.";
  return null;
}

export function checkAppGrant(body: unknown, serverDomain: string, authority: SensitiveOrderAuthority, now: number): OrderVerdict<LocalAiAppGrant> & { signature?: string } {
  const b = body as { order?: unknown; signature?: unknown } | null;
  if (!b || typeof b !== "object" || !exactKeys(b, ["order", "signature"]) || !exactKeys(b.order, GRANT_KEYS)) {
    return { ok: false, status: 400, error: "Send {order, signature} with exactly the grant's fields." };
  }
  const o = b.order as Record<string, unknown>;
  const why = common(o, serverDomain, now);
  if (why) return { ok: false, status: 403, error: why };
  const order = o as unknown as LocalAiAppGrant;
  if (!authorizeSensitiveOrderSafe(authority, order, String(b.signature), verifyLocalAiAppGrant)) {
    return { ok: false, status: 403, error: "That order was not signed by the owner." };
  }
  return { ok: true, order, signature: String(b.signature).toLowerCase() };
}

export function checkTrainOrder(body: unknown, serverDomain: string, authority: SensitiveOrderAuthority, now: number): OrderVerdict<LocalAiTrainOrder> {
  const b = body as { order?: unknown; signature?: unknown } | null;
  if (!b || typeof b !== "object" || !exactKeys(b, ["order", "signature"]) || !exactKeys(b.order, TRAIN_KEYS)) {
    return { ok: false, status: 400, error: "Send {order, signature} with exactly the training order's fields." };
  }
  const o = b.order as Record<string, unknown>;
  const why = common(o, serverDomain, now);
  if (why) return { ok: false, status: 403, error: why };
  const order = o as unknown as LocalAiTrainOrder;
  if (!authorizeSensitiveOrderSafe(authority, order, String(b.signature), verifyLocalAiTrainOrder)) {
    return { ok: false, status: 403, error: "That order was not signed by the owner." };
  }
  return { ok: true, order };
}
