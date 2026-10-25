/**
 * The owner's order to move one box between its container stacks
 * (docs/architecture-v2/engine-and-rust-path.md §4 and §7): `arch-v2` (Podman, and keyd, the
 * broker and core from the release's Rust programs) or back to `classic` (Docker and the TS
 * path). Signed with the sensitive-order key (the admin root where the box pins one), sent to
 * the box itself, and used once:
 *
 *   flagship/arch-v2-switch/v1|<serverDomain>|<target>|<nonce>|<issuedAt>
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_ARCH_V2_SWITCH = "flagship/arch-v2-switch/v1";

export type BoxStackTarget = "arch-v2" | "classic";

export interface ArchV2SwitchOrder {
  serverDomain: string;
  target: BoxStackTarget;
  /** 32 lowercase hex: the order is used once. */
  nonce: string;
  issuedAt: number;
}

export function canonicalArchV2SwitchOrder(o: ArchV2SwitchOrder): Bytes {
  legacyFieldGuard("serverDomain", o.serverDomain);
  if (o.target !== "arch-v2" && o.target !== "classic") throw new Error("unknown target stack");
  if (!/^[0-9a-f]{32}$/.test(o.nonce)) throw new Error("nonce must be 32 lowercase hex");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode([TAG_ARCH_V2_SWITCH, o.serverDomain.toLowerCase(), o.target, o.nonce, o.issuedAt].join("|"));
}

export function signArchV2SwitchOrder(o: ArchV2SwitchOrder, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalArchV2SwitchOrder(o));
}

export function verifyArchV2SwitchOrder(o: ArchV2SwitchOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalArchV2SwitchOrder(o), pub);
  } catch {
    return false;
  }
}

/** The order from untrusted JSON, or null when any field is missing or out of shape. */
export function parseArchV2SwitchOrder(raw: unknown): ArchV2SwitchOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.target !== "string" || typeof r.nonce !== "string" || typeof r.issuedAt !== "number") return null;
  const o: ArchV2SwitchOrder = { serverDomain: r.serverDomain, target: r.target as BoxStackTarget, nonce: r.nonce, issuedAt: r.issuedAt };
  try {
    canonicalArchV2SwitchOrder(o);
  } catch {
    return null;
  }
  return o;
}
