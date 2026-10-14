import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalGossip,
  canonicalServerOrder,
  deriveCGK,
  deriveIRK,
  macGossip,
  parseSignedServerOrder,
  rankByServerOrder,
  signServerOrder,
  verifyServerOrder,
  type ServerOrder,
} from "../src/index.js";

const V = JSON.parse(
  readFileSync(new URL("../test-vectors/server-order/vectors.json", import.meta.url), "utf8"),
);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

describe("server order vectors", () => {
  const irk = deriveIRK({ seed: bytes(V.keys.umkSeedHex) });

  it("derives the pinned IRK and CGK", () => {
    expect(Buffer.from(irk.publicKey).toString("hex")).toBe(V.keys.irkPubHex);
    expect(Buffer.from(deriveCGK(bytes(V.keys.umkSeedHex))).toString("hex")).toBe(V.keys.cgkHex);
  });

  it("reproduces the canonical string and signature, and rejects a flipped one", () => {
    const order = V.order.fields as ServerOrder;
    expect(new TextDecoder().decode(canonicalServerOrder(order))).toBe(V.order.canonical);
    expect(signServerOrder(order, irk)).toBe(V.order.signatureHex);
    expect(verifyServerOrder(order, V.order.signatureHex, irk.publicKey)).toBe(true);
    expect(verifyServerOrder(order, V.order.reject.signatureHex, irk.publicKey)).toBe(false);
  });

  it("refuses every refuse case", () => {
    for (const r of V.refuse) expect(() => canonicalServerOrder(r.fields), r.why).toThrow();
  });

  it("parses the wire form and drops a malformed one", () => {
    expect(parseSignedServerOrder(V.order.wire)?.order.stks).toEqual(V.order.fields.stks);
    expect(parseSignedServerOrder({ order: { ...V.order.fields, stks: [] }, signature: V.order.signatureHex })).toBeNull();
    expect(parseSignedServerOrder({ order: V.order.fields })).toBeNull();
  });

  it("reproduces the gossip v2 canonical string and MAC", () => {
    expect(new TextDecoder().decode(canonicalGossip(V.gossip.fields))).toBe(V.gossip.canonical);
    expect(macGossip(V.gossip.fields, bytes(V.keys.cgkHex))).toBe(V.gossip.macHex);
  });
});

describe("rankByServerOrder", () => {
  it("lists ordered servers first, then the rest oldest first", () => {
    const s = (stk: string, birthDate: number, domain: string) => ({ stk, birthDate, domain });
    const all = [s("cc", 1, "c"), s("aa", 3, "a"), s("bb", 2, "b"), s("dd", 0, "d")];
    expect(rankByServerOrder(all, ["bb", "aa"]).map((x) => x.stk)).toEqual(["bb", "aa", "dd", "cc"]);
    expect(rankByServerOrder(all, null).map((x) => x.stk)).toEqual(["dd", "cc", "bb", "aa"]);
  });
});
