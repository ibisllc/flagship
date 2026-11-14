import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalCertificateOrder,
  canonicalDirectNameOrder,
  directLabelOf,
  directNameKind,
  directNameOrderProblem,
  parseDirectNameOrder,
  signDirectNameOrder,
  verifyDirectNameOrder,
  type DirectNameOrder,
} from "../src/index.js";

const V = JSON.parse(readFileSync(join(__dirname, "../test-vectors/direct-name/vectors.json"), "utf8"));
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const adminPub = unhex(V.keys.adminRootPubHex);
const irkPub = unhex(V.keys.irkPubHex);

describe("direct-name vectors", () => {
  it("builds the canonical bytes and verifies under the admin root only", () => {
    for (const k of ["follow", "owned", "off"] as const) {
      const c = V[k];
      expect(text(canonicalDirectNameOrder(c.fields))).toBe(c.canonical);
      expect(verifyDirectNameOrder(c.fields, unhex(c.signatureHex), adminPub)).toBe(true);
      expect(verifyDirectNameOrder(c.fields, unhex(c.signatureHex), irkPub)).toBe(false);
    }
  });

  it("refuses bad orders with their reason and never verifies them", () => {
    const sig = unhex(V.follow.signatureHex);
    for (const r of V.refused) {
      expect(directNameOrderProblem(r.fields), r.name).toBe(r.problem);
      expect(verifyDirectNameOrder(r.fields, sig, adminPub), r.name).toBe(false);
    }
  });

  it("classifies labels", () => {
    for (const k of V.kinds) expect(directNameKind(k.label)?.kind ?? null, k.label).toBe(k.kind);
  });
});

describe("direct-name orders", () => {
  const seed = unhex(V.keys.adminRootSeedHex);
  const key = { privateKey: seed, publicKey: adminPub };

  it("signs only a well-formed order", () => {
    const bad: DirectNameOrder = { ...V.follow.fields, addresses: ["10.0.0.1"] };
    expect(() => signDirectNameOrder(bad, key)).toThrow(/private-address/);
    expect(verifyDirectNameOrder(V.follow.fields, signDirectNameOrder(V.follow.fields, key), adminPub)).toBe(true);
  });

  it("a signature binds the name, the box, the addresses and the CAA choice", () => {
    const sig = unhex(V.owned.signatureHex);
    const o: DirectNameOrder = V.owned.fields;
    expect(verifyDirectNameOrder({ ...o, name: "other--plucky-avocet.fshp.app" }, sig, adminPub)).toBe(false);
    expect(verifyDirectNameOrder({ ...o, serverDomain: "home2.plucky-avocet.flagship.services" }, sig, adminPub)).toBe(false);
    expect(verifyDirectNameOrder({ ...o, addresses: ["81.2.69.143"] }, sig, adminPub)).toBe(false);
    expect(verifyDirectNameOrder({ ...o, caa: "pin" }, sig, adminPub)).toBe(false);
    expect(verifyDirectNameOrder({ ...o, addresses: [...o.addresses].reverse() }, sig, adminPub)).toBe(true);
  });

  it("parses exactly the order's fields", () => {
    expect(parseDirectNameOrder(V.follow.fields)).toEqual(V.follow.fields);
    expect(parseDirectNameOrder({ ...V.follow.fields, extra: 1 })).toBeNull();
    expect(parseDirectNameOrder({ ...V.follow.fields, caa: "maybe" })).toBeNull();
    expect(directLabelOf("a.b.fshp.app")).toBeNull();
    expect(directLabelOf("game--plucky-avocet.fshp.app")).toBe("game--plucky-avocet");
  });

  it("the certificate order takes the direct class", () => {
    const o = { class: "direct" as const, device: "ab".repeat(32), regGen: 1, csrSha256: "cd".repeat(32), requestId: "ef".repeat(16), issuedAt: 1 };
    expect(text(canonicalCertificateOrder(o))).toMatch(/^flagship\/certificate-order\/v1\|direct\|/);
    expect(() => canonicalCertificateOrder({ ...o, regGen: 0 })).toThrow();
  });
});
