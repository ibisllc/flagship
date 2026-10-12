import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCESS_LIST,
  accessListFromEgressHosts,
  accessListSha256,
  appAccessGrantCanonicalBytes,
  decideAccess,
  normalizeAccessList,
  parseAccessList,
  parseAppAccessGrant,
  signAppAccessGrant,
  verifyAppAccessGrant,
  withRule,
  type AccessAction,
  type AppAccessGrant,
} from "../src/appAccess.js";
import { signAppEgressGrant } from "../src/appEgress.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

interface Vectors {
  defaultList: string;
  normalize: Array<{ in: string; out: string }>;
  parse: Array<{ list: string; rules?: Array<{ line: number; action: string; target: string }>; errors?: Array<{ line: number; message: string }> }>;
  decide: Array<{ list: string; host: string; result: string; rule: number | null }>;
  withRule: Array<{ list: string; action: AccessAction; host: string; out: string }>;
  sign: {
    umkSeedHex: string;
    pub: string;
    cases: Array<AppAccessGrant & { list: string; canonical: string; signature: string }>;
  };
}

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-access/vectors.json"), "utf8"),
) as Vectors;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.sign.umkSeedHex) });

describe("app-access vectors (test-vectors/app-access/vectors.json)", () => {
  it.each(V.normalize.map((c, i) => [i, c] as const))("normalize #%i", (_i, c) => {
    expect(normalizeAccessList(c.in)).toBe(c.out);
    expect(normalizeAccessList(c.out)).toBe(c.out);
  });

  it.each(V.parse.map((c, i) => [i, c] as const))("parse #%i", (_i, c) => {
    const r = parseAccessList(c.list);
    expect(r.errors).toEqual(c.errors ?? []);
    if (c.rules) expect(r.rules).toEqual(c.rules);
  });

  it.each(V.decide.map((c, i) => [i, c] as const))("decide #%i", (_i, c) => {
    expect(decideAccess(c.list, c.host)).toEqual({ result: c.result, rule: c.rule });
    expect(decideAccess(parseAccessList(c.list).rules, c.host)).toEqual({ result: c.result, rule: c.rule });
  });

  it.each(V.withRule.map((c, i) => [i, c] as const))("withRule #%i", (_i, c) => {
    expect(withRule(c.list, c.action, c.host)).toBe(c.out);
    expect(parseAccessList(c.out).errors).toEqual([]);
  });

  it("defaultList is normalized, parses cleanly and denies everything", () => {
    expect(DEFAULT_ACCESS_LIST).toBe(V.defaultList);
    expect(normalizeAccessList(V.defaultList)).toBe(V.defaultList);
    expect(parseAccessList(V.defaultList)).toEqual({ rules: [], errors: [] });
    expect(decideAccess(V.defaultList, "api.github.com")).toEqual({ result: "deny", rule: null });
  });

  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.sign.pub);
  });

  it.each(V.sign.cases.map((c, i) => [i, c] as const))("sign #%i", (_i, c) => {
    expect(normalizeAccessList(c.list)).toBe(c.list);
    expect(accessListSha256(c.list)).toBe(c.listSha256);
    const g: AppAccessGrant = { serverDomain: c.serverDomain, serviceId: c.serviceId, listSha256: c.listSha256, issuedAt: c.issuedAt };
    expect(new TextDecoder().decode(appAccessGrantCanonicalBytes(g))).toBe(c.canonical);
    expect(hex(signAppAccessGrant(g, irk))).toBe(c.signature);
    expect(verifyAppAccessGrant(g, fromHex(c.signature), irk.publicKey)).toBe(true);
  });
});

describe("app-access beyond the vectors", () => {
  const base: AppAccessGrant = {
    serverDomain: "home.harry.flagship.services",
    serviceId: "harry-weather",
    listSha256: accessListSha256("allow a.com\n"),
    issuedAt: 1_700_000_000_000,
  };

  it("a signature covers exactly one box, service, list and time", () => {
    const sig = signAppAccessGrant(base, irk);
    expect(verifyAppAccessGrant(base, sig, irk.publicKey)).toBe(true);
    expect(verifyAppAccessGrant({ ...base, serverDomain: "media.harry.flagship.services" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppAccessGrant({ ...base, serviceId: "harry-notes" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppAccessGrant({ ...base, listSha256: accessListSha256("allow all\n") }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppAccessGrant({ ...base, issuedAt: base.issuedAt + 1 }, sig, irk.publicKey)).toBe(false);
    const other = deriveIRK({ seed: new Uint8Array(32).fill(0xff) });
    expect(verifyAppAccessGrant(base, sig, other.publicKey)).toBe(false);
  });

  it("never accepts a v1 egress signature", () => {
    const v1 = signAppEgressGrant({ serverDomain: base.serverDomain, serviceId: base.serviceId, hosts: ["a.com"], issuedAt: base.issuedAt }, irk);
    expect(verifyAppAccessGrant(base, v1, irk.publicKey)).toBe(false);
  });

  it("refuses malformed grants", () => {
    expect(parseAppAccessGrant(base)).toEqual(base);
    for (const bad of [
      { ...base, listSha256: base.listSha256.toUpperCase() },
      { ...base, listSha256: "abc" },
      { ...base, serviceId: "a|b" },
      { ...base, serverDomain: "" },
      { ...base, issuedAt: 1.5 },
      { ...base, issuedAt: "1" },
      null,
      [],
    ]) {
      expect(parseAppAccessGrant(bad)).toBeNull();
    }
  });

  it("caps a list at 200 rules, naming the first line over", () => {
    const lines = Array.from({ length: 201 }, (_, i) => `allow h${i}.example.com`);
    const r = parseAccessList(lines.join("\n"));
    expect(r.rules).toHaveLength(200);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(201);
  });

  it("explains other mistakes", () => {
    const msg = (l: string) => parseAccessList(l).errors[0]?.message;
    expect(msg("allow [::1]")).toBe("IP addresses can't be allowed or denied; use a host name");
    expect(msg("allow 2001:db8::1")).toBe("IP addresses can't be allowed or denied; use a host name");
    expect(msg("allow *.localhost")).toBe('"localhost" is not a public host name');
    expect(msg("allow intranet")).toBe('"intranet" is not a valid host name');
    expect(msg("allow *a.com")).toBe("a * may only start a host, as in *.example.com");
    expect(msg("deny all  # the default")).toBeUndefined();
    expect(msg("  allow a.com")).toBeUndefined();
  });

  it("withRule replaces only the exact target and refuses a bad one", () => {
    expect(withRule("allow *.a.com\nallow a.com\n", "deny", "a.com")).toBe("deny a.com\nallow *.a.com\n");
    expect(() => withRule("", "allow", "https://a.com")).toThrow("without http://");
  });

  it("decide counts rules, not lines", () => {
    expect(decideAccess("# c\n\ndeny a.com\n# c\nallow all\n", "b.com")).toEqual({ result: "allow", rule: 2 });
  });

  it("a v1 approval becomes sorted allow lines", () => {
    expect(accessListFromEgressHosts(["b.com", "*.a.com"])).toBe(`allow *.a.com\nallow b.com\n${DEFAULT_ACCESS_LIST}`);
    expect(accessListFromEgressHosts([])).toBe(DEFAULT_ACCESS_LIST);
  });
});
