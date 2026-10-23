/**
 * What gossip does with the cloud gossip key: seal and open frames, and MAC a frame's canonical
 * bytes. Under flagship-keyd each is a keyd operation and the CGK never enters this process;
 * the raw-key form is for boxes without keyd and for tests.
 */
import { canonicalGossip, macGossip, openGossip, sealGossip, type Bytes, type GossipAnnouncement } from "@flagship/protocol";
import type { GossipOps } from "../keyCustodian.js";

export interface GossipCrypto {
  seal(pt: Bytes): Bytes;
  open(blob: Bytes): Bytes;
  /** HMAC-SHA256 of a frame's canonical bytes under the CGK, lowercase hex. */
  mac(a: GossipAnnouncement): string;
}

export function gossipCryptoFromCgk(cgk: Bytes): GossipCrypto {
  return {
    seal: (pt) => sealGossip(pt, cgk),
    open: (blob) => openGossip(blob, cgk),
    mac: (a) => macGossip(a, cgk),
  };
}

export function gossipCryptoFromOps(ops: Pick<GossipOps, "sealGossip" | "openGossip" | "gossipMac">): GossipCrypto {
  return {
    seal: (pt) => ops.sealGossip(pt),
    open: (blob) => ops.openGossip(blob),
    mac: (a) => ops.gossipMac(canonicalGossip(a)),
  };
}

export function asGossipCrypto(k: Bytes | GossipCrypto): GossipCrypto {
  return k instanceof Uint8Array ? gossipCryptoFromCgk(k) : k;
}

/** Constant-time check of a frame's MAC; never throws (a malformed frame is just false). */
export function verifyFrameMac(c: GossipCrypto, a: GossipAnnouncement, mac: unknown): boolean {
  try {
    const want = c.mac(a);
    if (typeof mac !== "string" || mac.length !== want.length) return false;
    const got = mac.toLowerCase();
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
