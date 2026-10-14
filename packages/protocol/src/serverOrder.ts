// The owner's server order (docs/server-order.md).
//
// The owner ranks their servers; the first one that is up leads, and the
// role passes down the list as servers go down (and back up as they return).
// The order is a sensitive order: signed by the admin master root when one is
// pinned, else the account IRK. `.com` keeps the newest per account and hands
// it to the apps (`/pods`) and the boxes (the daemon-status reply); boxes
// re-verify it and pass it to each other on their gossip frames.

import { ed } from "./edSync.js";
import { hex, validateNoSepCtrl, type MsgSigner, resolveMsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_SERVER_ORDER = "flagship/server-order/v1";
export const SERVER_ORDER_MAX = 64;

export interface ServerOrder {
  user: string;
  /** The servers' STK public keys, lowercase hex, first = leader. */
  stks: string[];
  issuedAt: number;
  /** 32 random bytes, lowercase hex. */
  nonce: string;
}

/** A signed order as it travels: `/pods`, the heartbeat reply, gossip frames. */
export interface SignedServerOrder {
  order: ServerOrder;
  signature: string;
}

export function canonicalServerOrder(o: ServerOrder): Bytes {
  validateNoSepCtrl("user", o.user);
  if (!Array.isArray(o.stks) || o.stks.length === 0 || o.stks.length > SERVER_ORDER_MAX) {
    throw new Error(`stks must list 1..${SERVER_ORDER_MAX} servers`);
  }
  const seen = new Set<string>();
  for (const s of o.stks) {
    if (typeof s !== "string" || !/^[0-9a-f]{64}$/.test(s)) throw new Error("each stk must be 32-byte lowercase hex");
    if (seen.has(s)) throw new Error("stks must not repeat");
    seen.add(s);
  }
  if (!/^[0-9a-f]{64}$/.test(o.nonce)) throw new Error("nonce must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt <= 0) throw new Error("issuedAt must be positive");
  return new TextEncoder().encode(
    [TAG_SERVER_ORDER, o.user.toLowerCase(), o.stks.join(","), o.issuedAt, o.nonce].join("|"),
  );
}

export function signServerOrder(o: ServerOrder, signer: MsgSigner): string {
  return hex(resolveMsgSigner(signer)(canonicalServerOrder(o)));
}

export function verifyServerOrder(o: ServerOrder, signatureHex: string, pub: Bytes): boolean {
  try {
    if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
    return ed.verify(sig, canonicalServerOrder(o), pub);
  } catch {
    return false;
  }
}

/** Parse an untrusted `{order, signature}` into its typed shape, or null. Does not verify. */
export function parseSignedServerOrder(raw: unknown): SignedServerOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { order?: Partial<ServerOrder>; signature?: unknown };
  const o = r.order;
  if (
    !o || typeof o.user !== "string" || !Array.isArray(o.stks) ||
    !o.stks.every((s) => typeof s === "string") ||
    typeof o.issuedAt !== "number" || typeof o.nonce !== "string" ||
    typeof r.signature !== "string"
  ) return null;
  const order: ServerOrder = { user: o.user, stks: [...o.stks], issuedAt: o.issuedAt, nonce: o.nonce };
  try {
    canonicalServerOrder(order);
  } catch {
    return null;
  }
  return { order, signature: r.signature.toLowerCase() };
}

/**
 * Rank every server by the order: listed servers in list order, then the
 * rest by age (oldest first), then by domain. Returns the input sorted.
 */
export function rankByServerOrder<T extends { stk: string; birthDate: number; domain: string }>(
  servers: readonly T[],
  stks: readonly string[] | null | undefined,
): T[] {
  const pos = new Map((stks ?? []).map((s, i) => [s.toLowerCase(), i]));
  const rank = (s: T) => pos.get(s.stk.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
  return [...servers].sort((a, b) =>
    rank(a) - rank(b) || a.birthDate - b.birthDate || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0),
  );
}
