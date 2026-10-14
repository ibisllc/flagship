import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseSignedServerOrder,
  verifyServerOrder,
  type AdminGrantView,
  type ServerOrder,
  type SignedServerOrder,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { writeFileDurable } from "./durableFile.js";

/**
 * The owner's server order as this box holds it (docs/server-order.md).
 *
 * Orders reach a box from `.com` (the daemon-status reply) and from siblings
 * (their gossip frames). Neither is trusted: an order is adopted only when it
 * verifies under the box's pinned sensitive-order authority (admin root when
 * pinned, else the owner IRK), names this account, and is newer than the one
 * held. The held order survives restarts in `server-order.json`.
 *
 * Never throws: a junk, forged, stale or unpersistable order is ignored.
 */
export interface ServerOrderHolder {
  /** Hydrate from disk (call once at boot). */
  load(): Promise<void>;
  /** The held order, or null. */
  current(): SignedServerOrder | null;
  /** Position of `stkHex` in the held order (0 = first), or null when unlisted. */
  rankOf(stkHex: string): number | null;
  /** Verify + adopt `raw` (a `{order, signature}`) when newer. True when adopted. */
  offer(raw: unknown, source: string): Promise<boolean>;
}

export interface ServerOrderHolderOptions {
  path: string;
  /** This box's account. */
  user: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  activeGrants?: readonly AdminGrantView[];
  onAdopt?: (order: SignedServerOrder) => void;
  onLog?: (m: string) => void;
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function sigBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function buildServerOrderHolder(opts: ServerOrderHolderOptions): ServerOrderHolder {
  const log = opts.onLog ?? (() => {});
  let held: SignedServerOrder | null = null;
  let ranks = new Map<string, number>();

  const adopt = (o: SignedServerOrder) => {
    held = o;
    ranks = new Map(o.order.stks.map((s, i) => [s, i]));
  };

  const verified = (raw: unknown): SignedServerOrder | null => {
    const signed = parseSignedServerOrder(raw);
    if (!signed) return null;
    if (signed.order.user.toLowerCase() !== opts.user.toLowerCase()) return null;
    if (!/^[0-9a-f]{128}$/.test(signed.signature)) return null;
    const ok = authorizeSensitiveOrder<ServerOrder>({
      order: signed.order,
      signature: sigBytes(signed.signature),
      verify: (o, sig, pub) => verifyServerOrder(o, hex(sig), pub),
      ownerIrkPub: opts.ownerIrkPub,
      ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
      username: opts.user,
      ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
    });
    return ok ? signed : null;
  };

  return {
    async load() {
      try {
        const o = verified(JSON.parse(await readFile(opts.path, "utf-8")));
        if (o && (!held || o.order.issuedAt > held.order.issuedAt)) adopt(o);
      } catch {
        /* missing or corrupt ⇒ no order yet */
      }
    },
    current: () => held,
    rankOf: (stkHex) => ranks.get(stkHex.toLowerCase()) ?? null,
    async offer(raw, source) {
      try {
        if (!raw) return false;
        const o = verified(raw);
        if (!o) {
          log(`[server-order] ignoring an order from ${source} that doesn't verify`);
          return false;
        }
        if (held && o.order.issuedAt <= held.order.issuedAt) return false;
        try {
          await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 });
          await writeFileDurable(opts.path, `${JSON.stringify(o)}\n`);
        } catch (e) {
          log(`[server-order] couldn't save the order (${(e as Error).message}); using it in memory`);
        }
        adopt(o);
        log(`[server-order] adopted the order of ${o.order.issuedAt} from ${source} (${o.order.stks.length} servers)`);
        opts.onAdopt?.(o);
        return true;
      } catch {
        return false;
      }
    },
  };
}
