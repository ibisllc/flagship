import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { badEd25519Key } from "../src/edKey.js";

const V = JSON.parse(
  readFileSync(new URL("../../protocol/test-vectors/ed25519-low-order/vectors.json", import.meta.url), "utf8"),
) as { rejectPublicKeysHex: string[]; honest: { publicKeyHex: string } };

describe("badEd25519Key: .com never stores a key anyone can sign under", () => {
  it("refuses every vector key with 400 bad-public-key", () => {
    for (const k of V.rejectPublicKeysHex) {
      expect(badEd25519Key(V.honest.publicKeyHex, k), k).toMatchObject({ status: 400, body: { code: "bad-public-key" } });
    }
  });

  it("passes honest keys and absent optional keys", () => {
    expect(badEd25519Key(V.honest.publicKeyHex, undefined)).toBeNull();
    for (let i = 0; i < 16; i++) expect(badEd25519Key(Buffer.from(ed.getPublicKey(ed.utils.randomPrivateKey())).toString("hex"))).toBeNull();
  });
});
