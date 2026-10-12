import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appDbSqlSha256,
  appDbWriteGrantCanonicalBytes,
  parseAppDbWriteGrant,
  signAppDbWriteGrant,
  verifyAppDbWriteGrant,
  type AppDbWriteGrant,
} from "../src/appDbWrite.js";
import { signAppAccessGrant } from "../src/appAccess.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

interface Vectors {
  umkSeedHex: string;
  pub: string;
  cases: Array<AppDbWriteGrant & { sql: string; canonical: string; signature: string }>;
}

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-db-write/vectors.json"), "utf8"),
) as Vectors;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

describe("app-db-write vectors (test-vectors/app-db-write/vectors.json)", () => {
  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });

  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    expect(appDbSqlSha256(c.sql)).toBe(c.sqlSha256);
    const g: AppDbWriteGrant = {
      serverDomain: c.serverDomain,
      serviceId: c.serviceId,
      store: c.store,
      sqlSha256: c.sqlSha256,
      issuedAt: c.issuedAt,
    };
    expect(new TextDecoder().decode(appDbWriteGrantCanonicalBytes(g))).toBe(c.canonical);
    expect(hex(signAppDbWriteGrant(g, irk))).toBe(c.signature);
    expect(verifyAppDbWriteGrant(g, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(parseAppDbWriteGrant(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });
});

describe("app-db-write beyond the vectors", () => {
  const base: AppDbWriteGrant = {
    serverDomain: "home.harry.flagship.services",
    serviceId: "harry-weather",
    store: "default",
    sqlSha256: appDbSqlSha256("DELETE FROM items;"),
    issuedAt: 1_700_000_000_000,
  };

  it("a signature covers exactly one box, service, store, statement and time", () => {
    const sig = signAppDbWriteGrant(base, irk);
    expect(verifyAppDbWriteGrant(base, sig, irk.publicKey)).toBe(true);
    expect(verifyAppDbWriteGrant({ ...base, serverDomain: "media.harry.flagship.services" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppDbWriteGrant({ ...base, serviceId: "harry-notes" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppDbWriteGrant({ ...base, store: "levels" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppDbWriteGrant({ ...base, sqlSha256: appDbSqlSha256("DELETE FROM items; ") }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppDbWriteGrant({ ...base, issuedAt: base.issuedAt + 1 }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppDbWriteGrant(base, sig, deriveIRK({ seed: new Uint8Array(32).fill(0xff) }).publicKey)).toBe(false);
  });

  it("never accepts another order's signature over the same fields", () => {
    const other = signAppAccessGrant(
      { serverDomain: base.serverDomain, serviceId: base.serviceId, listSha256: base.sqlSha256, issuedAt: base.issuedAt },
      irk,
    );
    expect(verifyAppDbWriteGrant(base, other, irk.publicKey)).toBe(false);
  });

  it("refuses malformed grants", () => {
    for (const bad of [
      { ...base, sqlSha256: base.sqlSha256.toUpperCase() },
      { ...base, sqlSha256: "abc" },
      { ...base, store: "" },
      { ...base, store: "a|b" },
      { ...base, serviceId: "a\nb" },
      { ...base, serverDomain: "" },
      { ...base, issuedAt: -1 },
      { ...base, issuedAt: 1.5 },
      { ...base, issuedAt: "1" },
      { ...base, store: undefined },
      null,
      [],
    ]) {
      expect(parseAppDbWriteGrant(bad)).toBeNull();
    }
  });
});
