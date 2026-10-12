import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  apiKeyScopeAllows,
  appApiKeyGrantCanonicalBytes,
  formatAppApiKey,
  parseAppApiKey,
  parseAppApiKeyGrant,
  signAppApiKeyGrant,
  verifyAppApiKeyGrant,
  type AppApiKeyGrant,
} from "../src/appApiKey.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

interface Vectors {
  umkSeedHex: string;
  pub: string;
  cases: Array<AppApiKeyGrant & { canonical: string; signature: string }>;
}

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-api-key/vectors.json"), "utf8"),
) as Vectors;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });
const grantOf = (c: Vectors["cases"][number]): AppApiKeyGrant => ({
  serverDomain: c.serverDomain,
  serviceId: c.serviceId,
  keyId: c.keyId,
  scope: c.scope,
  expiresAt: c.expiresAt,
  issuedAt: c.issuedAt,
});

describe("app-api-key vectors (test-vectors/app-api-key/vectors.json)", () => {
  it("the signing key is the IRK derived from the UMK seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });

  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i: canonical, signature, verify", (_i, c) => {
    const g = grantOf(c);
    expect(new TextDecoder().decode(appApiKeyGrantCanonicalBytes(g))).toBe(c.canonical);
    expect(hex(signAppApiKeyGrant(g, irk))).toBe(c.signature);
    expect(verifyAppApiKeyGrant(g, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(parseAppApiKeyGrant(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });

  it("any changed field fails verification", () => {
    const c = V.cases[0]!;
    const sig = fromHex(c.signature);
    const g = grantOf(c);
    for (const bad of [
      { ...g, serverDomain: "home.mallory.flagship.services" },
      { ...g, serviceId: "harry-other" },
      { ...g, keyId: "fedcba9876543210" },
      { ...g, scope: "read" as const },
      { ...g, expiresAt: 1 },
      { ...g, issuedAt: g.issuedAt + 1 },
    ]) {
      expect(verifyAppApiKeyGrant(bad, sig, irk.publicKey)).toBe(false);
    }
  });
});

describe("app-api-key shapes", () => {
  const base: AppApiKeyGrant = {
    serverDomain: "home.harry.flagship.services",
    serviceId: "harry-weather",
    keyId: "0123456789abcdef",
    scope: "read",
    expiresAt: 0,
    issuedAt: 1,
  };

  it("rejects malformed grants", () => {
    for (const bad of [
      null,
      [],
      { ...base, keyId: "0123456789ABCDEF" },
      { ...base, keyId: "0123" },
      { ...base, scope: "admin" },
      { ...base, expiresAt: -1 },
      { ...base, issuedAt: 1.5 },
      { ...base, serviceId: "a|b" },
      { ...base, serverDomain: "" },
    ]) {
      expect(parseAppApiKeyGrant(bad)).toBeNull();
    }
    expect(verifyAppApiKeyGrant({ ...base, scope: "admin" as never }, new Uint8Array(64), irk.publicKey)).toBe(false);
  });

  it("formats and parses fsk_ keys", () => {
    const secret = "A".repeat(42) + "_";
    const key = formatAppApiKey("0123456789abcdef", secret);
    expect(parseAppApiKey(key)).toEqual({ keyId: "0123456789abcdef", secret });
    expect(parseAppApiKey(key + "x")).toBeNull();
    expect(parseAppApiKey("fsk_0123456789ABCDEF_" + secret)).toBeNull();
    expect(parseAppApiKey("fsk_0123456789abcdef_" + "A".repeat(42) + "=")).toBeNull();
  });

  it("read allows GET/HEAD/OPTIONS only; write allows everything", () => {
    for (const m of ["GET", "head", "OPTIONS"]) expect(apiKeyScopeAllows("read", m)).toBe(true);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(apiKeyScopeAllows("read", m)).toBe(false);
      expect(apiKeyScopeAllows("write", m)).toBe(true);
    }
  });
});
