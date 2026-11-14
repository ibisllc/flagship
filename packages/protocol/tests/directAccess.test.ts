import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalDirectAccessOrder,
  canonicalDirectAddressUpdate,
  canonicalIp,
  canonicalLanHintV2,
  checkDirectAddressUpdate,
  checkLanHintV2,
  directAccessOrderProblem,
  directAccessOrderSha256,
  directOrderAllows,
  ed,
  formatPrefix,
  isPublicAddress,
  parseDirectAccessOrder,
  parsePrefix,
  prefixContains,
  signDirectAccessOrder,
  verifyDirectAccessOrder,
  type DirectAccessOrder,
  type DirectAddressUpdate,
  type LanHintV2,
} from "../src/index.js";

const V = JSON.parse(readFileSync(join(__dirname, "../test-vectors/direct-access/vectors.json"), "utf8"));
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const adminPub = unhex(V.keys.adminRootPubHex);
const irkPub = unhex(V.keys.irkPubHex);
const stkPub = unhex(V.keys.stkPubHex);
const order: DirectAccessOrder = V.order.fields;

describe("direct-access vectors", () => {
  it("canonicalises and classifies addresses", () => {
    for (const c of V.addresses.canonical) expect(canonicalIp(c.input), c.input).toBe(c.canonical);
    for (const a of V.addresses.public) expect(isPublicAddress(a), a).toBe(true);
    for (const a of V.addresses.notPublic) expect(isPublicAddress(a), a).toBe(false);
  });

  it("parses prefixes", () => {
    for (const p of V.prefixes.valid) expect(formatPrefix(parsePrefix(p.input)!)).toBe(p.canonical);
    for (const p of V.prefixes.invalid) expect(parsePrefix(p), p).toBeNull();
    for (const c of V.prefixes.contains) expect(prefixContains(parsePrefix(c.prefix)!, c.address)).toBe(c.inside);
  });

  it("pins the order bytes, hash and admin-root signature", () => {
    expect(text(canonicalDirectAccessOrder(order))).toBe(V.order.canonical);
    expect(directAccessOrderSha256(order)).toBe(V.order.sha256);
    expect(verifyDirectAccessOrder(order, unhex(V.order.signatureHex), adminPub)).toBe(true);
    expect(verifyDirectAccessOrder(order, unhex(V.order.signatureHex), irkPub)).toBe(false);
    expect(text(canonicalDirectAccessOrder(V.order.off.fields))).toBe(V.order.off.canonical);
    expect(verifyDirectAccessOrder(V.order.off.fields, unhex(V.order.off.signatureHex), adminPub)).toBe(true);
  });

  it("refuses every bad order, and never verifies one even when signed", () => {
    const seed = unhex(V.keys.adminRootSeedHex);
    for (const r of V.order.refused) {
      expect(directAccessOrderProblem(r.fields), r.name).toBe(r.problem);
      expect(() => signDirectAccessOrder(r.fields, { privateKey: seed, publicKey: adminPub })).toThrow();
      let forced: Uint8Array | null = null;
      try {
        forced = ed.sign(canonicalDirectAccessOrder(r.fields), seed);
      } catch {
        forced = null;
      }
      if (forced) expect(verifyDirectAccessOrder(r.fields, forced, adminPub), r.name).toBe(false);
    }
  });

  it("checks address updates against the order", () => {
    expect(text(canonicalDirectAddressUpdate(V.addressUpdate.fields))).toBe(V.addressUpdate.canonical);
    for (const c of V.addressUpdate.cases) {
      const r = checkDirectAddressUpdate(c.fields as DirectAddressUpdate, unhex(c.signatureHex), stkPub, c.order ?? order, {
        serverDomain: order.serverDomain,
        now: V.addressUpdate.now,
      });
      expect(r.ok ? null : r.reason, c.name).toBe(c.reason);
    }
  });

  it("checks v2 hints against the order", () => {
    expect(text(canonicalLanHintV2(V.hintV2.fields))).toBe(V.hintV2.canonical);
    for (const c of V.hintV2.cases) {
      const r = checkLanHintV2(
        c.fields as LanHintV2,
        unhex(c.signatureHex),
        stkPub,
        { serverDomain: V.hintV2.fields.serverDomain, certSha256: V.hintV2.fields.certSha256, now: V.hintV2.now },
        c.withOrder ? (c.order ?? order) : null,
      );
      if (c.reason) expect(r.ok ? "accepted" : r.reason, c.name).toBe(c.reason);
      else expect(r.ok && r.useDirect, c.name).toBe(c.useDirect);
    }
  });
});

describe("direct-access order", () => {
  it("binds the server, so another box's address update fails against it", () => {
    const other = { ...order, serverDomain: "home.someone-else.flagship.services" };
    expect(directAccessOrderSha256(other)).not.toBe(directAccessOrderSha256(order));
  });

  it("allows only listed addresses and addresses inside its prefixes", () => {
    expect(directOrderAllows(order, "81.2.69.142")).toBe(true);
    expect(directOrderAllows(order, "81.2.69.143")).toBe(false);
    expect(directOrderAllows(order, "2a02:8010:6400:ffff::1")).toBe(true);
    expect(directOrderAllows(order, "2A02:8010:6400:ffff::1")).toBe(false);
    expect(directOrderAllows({ ...order, enabled: false }, "81.2.69.142")).toBe(false);
  });

  it("parses only the exact shape", () => {
    expect(parseDirectAccessOrder(order)).toEqual(order);
    expect(parseDirectAccessOrder({ ...order, extra: 1 })).toBeNull();
    expect(parseDirectAccessOrder({ ...order, addresses: [1] })).toBeNull();
    expect(parseDirectAccessOrder(null)).toBeNull();
  });

  it("an unsigned or forged order never verifies", () => {
    expect(verifyDirectAccessOrder(order, new Uint8Array(64), adminPub)).toBe(false);
    const forged = { ...order, addresses: [...order.addresses, "8.8.8.8"] };
    expect(verifyDirectAccessOrder(forged, unhex(V.order.signatureHex), adminPub)).toBe(false);
  });
});
