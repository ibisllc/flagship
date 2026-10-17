/**
 * node:crypto versions of the peer-backup primitives that touch whole bricks
 * (AES-GCM envelopes, AES-CTR bricks, Merkle trees). Byte-identical to the
 * pure-JS ones in @flagship/protocol (tests/peerNetFastCrypto.test.ts), and
 * fast enough for multi-megabyte bricks on a small box.
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import type { PbAead } from "@flagship/protocol";

export const nodeAead: PbAead = {
  seal(key, nonce, aad, pt) {
    const c = createCipheriv("aes-256-gcm", key, nonce);
    c.setAAD(aad);
    const out = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
  open(key, nonce, aad, ct) {
    if (ct.length < 16) throw new Error("ciphertext too short");
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAAD(aad);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
};

const ZERO_IV = Buffer.alloc(16);

/** AES-256-CTR with IV 0, as pbBrickCrypt. */
export function brickCrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-256-ctr", key, ZERO_IV);
  const out = Buffer.concat([c.update(data), c.final()]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

const LEAF = Buffer.from([0]);
const NODE = Buffer.from([1]);

/** As pbMerkleLevels. */
export function merkleLevels(brick: Uint8Array, leafBytes: number): Uint8Array[][] {
  const count = brick.length / leafBytes;
  if (!Number.isInteger(count) || count < 1 || (count & (count - 1)) !== 0) throw new Error("a brick must be a power-of-two number of leaves");
  const leaves: Uint8Array[] = [];
  for (let o = 0; o < brick.length; o += leafBytes) {
    leaves.push(new Uint8Array(createHash("sha256").update(LEAF).update(brick.subarray(o, o + leafBytes)).digest()));
  }
  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(new Uint8Array(createHash("sha256").update(NODE).update(prev[i]!).update(prev[i + 1]!).digest()));
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(brick: Uint8Array, leafBytes: number): Uint8Array {
  const l = merkleLevels(brick, leafBytes);
  return l[l.length - 1]![0]!;
}
