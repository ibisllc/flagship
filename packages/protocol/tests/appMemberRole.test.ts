import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  appMemberRoleCanonicalBytes,
  appMemberRoleTargetAid,
  appMemberRoleTargetInvite,
  parseAppMemberRoleOrder,
  parseAppMemberRoleTarget,
  signAppMemberRole,
  verifyAppMemberRole,
  type AppMemberRoleOrder,
} from "../src/appMemberRole.js";
import { signAppDbWriteGrant } from "../src/appDbWrite.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

interface Vectors {
  umkSeedHex: string;
  pub: string;
  cases: Array<AppMemberRoleOrder & { canonical: string; signature: string }>;
  invalid: Array<AppMemberRoleOrder & { why: string }>;
}

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-member-role/vectors.json"), "utf8"),
) as Vectors;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });
const strip = (c: AppMemberRoleOrder): AppMemberRoleOrder => ({
  serverDomain: c.serverDomain,
  serviceId: c.serviceId,
  target: c.target,
  role: c.role,
  issuedAt: c.issuedAt,
});

describe("app-member-role vectors (test-vectors/app-member-role/vectors.json)", () => {
  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });

  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    const o = strip(c);
    expect(new TextDecoder().decode(appMemberRoleCanonicalBytes(o))).toBe(c.canonical);
    expect(hex(signAppMemberRole(o, irk))).toBe(c.signature);
    expect(verifyAppMemberRole(o, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(parseAppMemberRoleOrder(JSON.parse(JSON.stringify(o)))).toEqual(o);
  });

  it.each(V.invalid.map((c) => [c.why, c] as const))("refuses: %s", (_why, c) => {
    const o = strip(c);
    expect(() => appMemberRoleCanonicalBytes(o)).toThrow();
    expect(parseAppMemberRoleOrder(o)).toBeNull();
  });
});

describe("app-member-role beyond the vectors", () => {
  const base: AppMemberRoleOrder = {
    serverDomain: "home.harry.flagship.services",
    serviceId: "harry-weather",
    target: appMemberRoleTargetAid("AB".repeat(32)),
    role: "admin",
    issuedAt: 1_700_000_000_000,
  };

  it("builds and reads targets", () => {
    expect(base.target).toBe(`aid:${"ab".repeat(32)}`);
    expect(parseAppMemberRoleTarget(base.target)).toEqual({ kind: "aid", id: "ab".repeat(32) });
    expect(parseAppMemberRoleTarget(appMemberRoleTargetInvite("inv-1"))).toEqual({ kind: "invite", id: "inv-1" });
    expect(parseAppMemberRoleTarget("invite:")).toBeNull();
  });

  it("a signature covers exactly one box, app, target, role and time", () => {
    const sig = signAppMemberRole(base, irk);
    expect(verifyAppMemberRole(base, sig, irk.publicKey)).toBe(true);
    expect(verifyAppMemberRole({ ...base, serverDomain: "media.harry.flagship.services" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppMemberRole({ ...base, serviceId: "harry-notes" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppMemberRole({ ...base, target: `aid:${"cd".repeat(32)}` }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppMemberRole({ ...base, role: "viewer" }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppMemberRole({ ...base, issuedAt: base.issuedAt + 1 }, sig, irk.publicKey)).toBe(false);
    expect(verifyAppMemberRole(base, sig, deriveIRK({ seed: new Uint8Array(32).fill(0xff) }).publicKey)).toBe(false);
  });

  it("never accepts another order's signature", () => {
    const other = signAppDbWriteGrant(
      { serverDomain: base.serverDomain, serviceId: base.serviceId, store: "default", sqlSha256: "ab".repeat(32), issuedAt: base.issuedAt },
      irk,
    );
    expect(verifyAppMemberRole(base, other, irk.publicKey)).toBe(false);
  });

  it("verify never throws on a malformed order", () => {
    expect(verifyAppMemberRole({ ...base, role: "owner" }, new Uint8Array(64), irk.publicKey)).toBe(false);
  });
});
