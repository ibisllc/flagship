import { describe, expect, it } from "vitest";
import { nobleAead, pbBrickCrypt, pbMerkleLevels, pbMerkleRoot } from "@flagship/protocol";
import { brickCrypt, merkleLevels, merkleRoot, nodeAead } from "../src/peerNet/fastCrypto.js";

describe("peer-backup fast crypto matches the protocol's", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode("ab".repeat(16));
  const data = crypto.getRandomValues(new Uint8Array(8192));

  it("AES-GCM both ways", () => {
    const a = nodeAead.seal(key, nonce, aad, data);
    expect(a).toEqual(nobleAead.seal(key, nonce, aad, data));
    expect(nobleAead.open(key, nonce, aad, a)).toEqual(data);
    expect(nodeAead.open(key, nonce, aad, a)).toEqual(data);
    const bad = a.slice();
    bad[3] = bad[3]! ^ 1;
    expect(() => nodeAead.open(key, nonce, aad, bad)).toThrow();
  });

  it("AES-CTR bricks", () => {
    expect(brickCrypt(key, data)).toEqual(pbBrickCrypt(key, data));
  });

  it("Merkle trees", () => {
    expect(merkleRoot(data, 256)).toEqual(pbMerkleRoot(data, 256));
    expect(merkleLevels(data, 1024).map((l) => l.map((x) => Buffer.from(x).toString("hex")))).toEqual(
      pbMerkleLevels(data, 1024).map((l) => l.map((x) => Buffer.from(x).toString("hex"))),
    );
  });
});
