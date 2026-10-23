import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalServerWildcardGrant, serverWildcardGrantBody } from "../public/webapp/lib/serverWildcardGrant.js";

const v = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/server-wildcard-grant/vectors.json"), "utf8"));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

describe("web server-wildcard-grant", () => {
  it("matches the shared vector, and a grant for another server, key or time fails the signature", () => {
    for (const g of v.grants) {
      const bytes = canonicalServerWildcardGrant(g.grant);
      expect(new TextDecoder().decode(bytes)).toBe(g.canonical);
      expect(ed25519.verify(hex(g.signatureHex), bytes, hex(v.pubHex))).toBe(true);
    }
    for (const c of v.invalid) expect(ed25519.verify(hex(v.grants[0].signatureHex), canonicalServerWildcardGrant(c.grant), hex(v.pubHex)), c.name).toBe(false);
  });
  it("refuses the malformed grants", () => {
    for (const r of v.refused) expect(() => canonicalServerWildcardGrant(r.grant), r.name).toThrow();
  });
  it("builds the body the box checks", async () => {
    expect(await serverWildcardGrantBody(v.grants[0].grant, () => hex(v.grants[0].signatureHex))).toEqual({ issuedAt: v.grants[0].grant.issuedAt, signature: v.grants[0].signatureHex });
  });
});
