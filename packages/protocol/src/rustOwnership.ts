/**
 * The owner's order to move app ownership on one arch-v2 box between the TypeScript daemon and the
 * Rust components (docs/architecture-v2/broker-runtime-core.md §11): who reconciles the apps
 * (`shadow`: the daemon does, core only computes and logs its diff; `rust`: core decides every
 * container effect) and who carries app traffic (`ts`: the daemon's proxy; `rust`: the ingress's).
 * Signed with the sensitive-order key (the admin root where the box pins one), used once:
 *
 *   flagship/rust-ownership/v1|<serverDomain>|<reconciler>|<proxy>|<nonce>|<issuedAt>
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_RUST_OWNERSHIP = "flagship/rust-ownership/v1";

export type ReconcilerOwner = "shadow" | "rust";
export type ProxyOwner = "ts" | "rust";

export interface RustOwnershipOrder {
  serverDomain: string;
  reconciler: ReconcilerOwner;
  proxy: ProxyOwner;
  /** 32 lowercase hex: the order is used once. */
  nonce: string;
  issuedAt: number;
}

export function canonicalRustOwnershipOrder(o: RustOwnershipOrder): Bytes {
  legacyFieldGuard("serverDomain", o.serverDomain);
  if (o.reconciler !== "shadow" && o.reconciler !== "rust") throw new Error("unknown reconciler owner");
  if (o.proxy !== "ts" && o.proxy !== "rust") throw new Error("unknown proxy owner");
  if (!/^[0-9a-f]{32}$/.test(o.nonce)) throw new Error("nonce must be 32 lowercase hex");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode([TAG_RUST_OWNERSHIP, o.serverDomain.toLowerCase(), o.reconciler, o.proxy, o.nonce, o.issuedAt].join("|"));
}

export function signRustOwnershipOrder(o: RustOwnershipOrder, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalRustOwnershipOrder(o));
}

export function verifyRustOwnershipOrder(o: RustOwnershipOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRustOwnershipOrder(o), pub);
  } catch {
    return false;
  }
}

/** The order from untrusted JSON, or null when any field is missing or out of shape. */
export function parseRustOwnershipOrder(raw: unknown): RustOwnershipOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.reconciler !== "string" || typeof r.proxy !== "string" || typeof r.nonce !== "string" || typeof r.issuedAt !== "number") return null;
  const o: RustOwnershipOrder = { serverDomain: r.serverDomain, reconciler: r.reconciler as ReconcilerOwner, proxy: r.proxy as ProxyOwner, nonce: r.nonce, issuedAt: r.issuedAt };
  try {
    canonicalRustOwnershipOrder(o);
  } catch {
    return null;
  }
  return o;
}
