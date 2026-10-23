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
