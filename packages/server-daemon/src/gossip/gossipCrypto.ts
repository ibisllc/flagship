import { canonicalGossip, macGossip, openGossip, sealGossip, type GossipAnnouncement } from "@flagship/protocol";

/**
 * What gossip does with the account's gossip key (CGK). Under flagship-keyd the key never enters
 * the daemon: keyd seals, opens and MACs, so gossip takes these operations instead of key bytes.
 */
export interface GossipCrypto {
  seal(plaintext: Uint8Array): Uint8Array;
  /** Throws on a frame that does not open (wrong key, tampered). */
  open(blob: Uint8Array): Uint8Array;
  /** The CGK-HMAC of the announcement's canonical bytes, lowercase hex. */
  mac(a: GossipAnnouncement): string;
}

/** For tests and boxes that hold the key in process. */
export function gossipCryptoFromKey(cgk: Uint8Array): GossipCrypto {
  return {
    seal: (pt) => sealGossip(pt, cgk),
    open: (blob) => openGossip(blob, cgk),
    mac: (a) => macGossip(a, cgk),
  };
}

/** Over the key custodian (keyd or in-process): `macGossip` takes the canonical bytes. */
export function gossipCryptoFromOps(ops: {
  sealGossip(pt: Uint8Array): Uint8Array;
  openGossip(blob: Uint8Array): Uint8Array;
  macGossip(canonical: Uint8Array): string;
}): GossipCrypto {
  return {
    seal: (pt) => ops.sealGossip(pt),
    open: (blob) => ops.openGossip(blob),
    mac: (a) => ops.macGossip(canonicalGossip(a)),
  };
}

/** Constant-time check of a received MAC. Never throws. */
export function verifyGossipCryptoMac(c: GossipCrypto, a: GossipAnnouncement, mac: unknown): boolean {
  try {
    const expected = c.mac(a);
    if (typeof mac !== "string" || mac.length !== expected.length) return false;
    const got = mac.toLowerCase();
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
 * What gossip does with the cloud gossip key: seal and open frames, and MAC a frame's canonical
 * bytes. Under flagship-keyd each is a keyd operation and the CGK never enters this process;
 * the raw-key form is for boxes without keyd and for tests.
import { canonicalGossip, macGossip, openGossip, sealGossip, type Bytes, type GossipAnnouncement } from "@flagship/protocol";
import type { GossipOps } from "../keyCustodian.js";
  seal(pt: Bytes): Bytes;
  open(blob: Bytes): Bytes;
  /** HMAC-SHA256 of a frame's canonical bytes under the CGK, lowercase hex. */
export function gossipCryptoFromCgk(cgk: Bytes): GossipCrypto {
export function gossipCryptoFromOps(ops: Pick<GossipOps, "sealGossip" | "openGossip" | "gossipMac">): GossipCrypto {
    mac: (a) => ops.gossipMac(canonicalGossip(a)),
export function asGossipCrypto(k: Bytes | GossipCrypto): GossipCrypto {
  return k instanceof Uint8Array ? gossipCryptoFromCgk(k) : k;
/** Constant-time check of a frame's MAC; never throws (a malformed frame is just false). */
export function verifyFrameMac(c: GossipCrypto, a: GossipAnnouncement, mac: unknown): boolean {
    const want = c.mac(a);
    if (typeof mac !== "string" || mac.length !== want.length) return false;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
