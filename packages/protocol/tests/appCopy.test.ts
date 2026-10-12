import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appCopyGrantCanonicalBytes,
  parseAppCopyGrant,
  signAppCopyGrant,
  verifyAppCopyGrant,
  type AppCopyGrant,
} from "../src/appCopy.js";
import { signAppDbWriteGrant } from "../src/appDbWrite.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

interface Vectors {
  umkSeedHex: string;
  pub: string;
  cases: Array<AppCopyGrant & { canonical: string; signature: string }>;
}

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-copy/vectors.json"), "utf8"),
) as Vectors;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

describe("app-copy vectors (test-vectors/app-copy/vectors.json)", () => {
  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });

  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    const g: AppCopyGrant = {
      sourceServer: c.sourceServer,
      targetServer: c.targetServer,
      serviceId: c.serviceId,
      issuedAt: c.issuedAt,
    };
    expect(new TextDecoder().decode(appCopyGrantCanonicalBytes(g))).toBe(c.canonical);
    expect(hex(signAppCopyGrant(g, irk))).toBe(c.signature);
    expect(verifyAppCopyGrant(g, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(parseAppCopyGrant(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });
});

describe("app-copy beyond the vectors", () => {
  const base: AppCopyGrant = {
    sourceServer: "home3.harry.flagship.services",
    targetServer: "leticia.harry.flagship.services",
    serviceId: "harry--notes",
    issuedAt: 1_700_000_000_000,
  };

  it("a signature covers exactly one source, target, service and time", () => {
    const sig = signAppCopyGrant(base, irk);
    expect(verifyAppCopyGrant(base, sig, irk.publicKey)).toBe(true);
    expect(verifyAppCopyGrant({ ...base, sourceServer: base.targetServer, targetServer: base.sourceServer }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppCopyGrant({ ...base, targetServer: "media.harry.flagship.services" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppCopyGrant({ ...base, serviceId: "harry--todo" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppCopyGrant({ ...base, issuedAt: base.issuedAt + 1 }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppCopyGrant(base, sig, deriveIRK({ seed: new Uint8Array(32).fill(0xff) }).publicKey)).toBe(false);
  });

  it("never accepts another order's signature", () => {
    const other = signAppDbWriteGrant(
      { serverDomain: base.targetServer, serviceId: base.serviceId, store: "default", sqlSha256: "0".repeat(64), issuedAt: base.issuedAt },
      irk,
    );
    expect(verifyAppCopyGrant(base, other, irk.publicKey)).toBe(false);
  });

  it("refuses malformed grants", () => {
    for (const bad of [
      { ...base, sourceServer: "" },
      { ...base, targetServer: "" },
      { ...base, serviceId: "" },
      { ...base, serviceId: "a|b" },
      { ...base, targetServer: "a\nb" },
      { ...base, issuedAt: -1 },
      { ...base, issuedAt: 1.5 },
      { ...base, issuedAt: "1" },
      { ...base, serviceId: undefined },
      null,
      [],
    ]) {
      expect(parseAppCopyGrant(bad)).toBeNull();
    }
  });
});
