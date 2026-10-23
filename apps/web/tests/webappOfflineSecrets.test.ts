import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed, verifyOfflineSecrets } from "@flagship/protocol";
// @ts-expect-error plain browser module
import { canonicalOfflineSecretsBytes, signOfflineSecrets, swkCommitment } from "../public/webapp/lib/offlineSecrets.js";

const vectors = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/offline-secrets/vectors.json", import.meta.url), "utf8"));

describe("the webapp's offline-secrets commitment", () => {
  it("builds the same canonical bytes as the shared vectors", () => {
    const good = vectors.cases[0].sibling;
    expect(new TextDecoder().decode(canonicalOfflineSecretsBytes(good))).toBe(vectors.canonicalOfGood);
  });

  it("commits to a key the way the protocol does", async () => {
    expect(await swkCommitment(vectors.cases[0].swkHex)).toBe(vectors.cases[0].sibling.swkSha256Hex);
  });

  it("signs something the builder and the box accept, and nothing else", async () => {
    const seed = Uint8Array.from(Buffer.from(vectors.userSeedHex, "hex"));
    const order = { ...vectors.order, userPub: Uint8Array.from(Buffer.from(vectors.order.userPub, "hex")) };
    const signWithIrk = async (_umk: unknown, bytes: Uint8Array) => Buffer.from(ed.sign(bytes, seed)).toString("hex");
    const sibling = await signOfflineSecrets({ serverDomain: order.serverDomain, serial: order.serial, swkHex: vectors.cases[0].swkHex, issuedAt: order.issuedAt + 1000, umk: null }, signWithIrk);
    expect(verifyOfflineSecrets(sibling, vectors.cases[0].swkHex, order)).toEqual({ ok: true });
    expect(verifyOfflineSecrets(sibling, "11".repeat(32), order)).toEqual({ ok: false, reason: "wrong-secret" });
  });

  it("refuses to sign a malformed commitment", async () => {
    await expect(signOfflineSecrets({ serverDomain: "a|b", serial: "s", swkHex: "00".repeat(32), issuedAt: 1, umk: null }, async () => "00")).rejects.toThrow(/bad serverDomain/);
    expect(() => canonicalOfflineSecretsBytes({ serverDomain: "a", serial: "s", swkSha256Hex: "xyz", issuedAt: 1 })).toThrow();
  });
});
