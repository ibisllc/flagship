import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OrgAuthorityError,
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  canonicalOrgSeatRoles,
  checkOrgAuthorityShape,
  orgBylawsThreshold,
  orgFounderRemovalOf,
  orgOverturnThreshold,
  type OrgAuthorityRecord,
} from "../src/orgAuthority.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "test-vectors", "org-authority", "vectors.json"), "utf8"));
const binding = (name: string) => V.keys[name].binding;

const base = (): OrgAuthorityRecord => ({
  orgId: V.orgId,
  version: 0,
  prevHash: "0".repeat(64),
  admins: [
    { seatId: V.keys["A founder"].seatId, kind: "admin", binding: binding("A founder") },
    { seatId: V.keys["B admin"].seatId, kind: "admin", binding: binding("B admin") },
    { seatId: V.keys["C admin"].seatId, kind: "admin", binding: binding("C admin") },
  ],
  bylaws: { overturnSeats: "*", overturnK: 0, vetoK: 1 },
  founderSeatId: V.keys["A founder"].seatId,
  kGov: 2,
  kGrant: 1,
  kDestroy: 2,
  kSite: 2,
  issuedAt: 1,
});

const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof OrgAuthorityError ? e.code : `other: ${String(e)}`;
  }
};

describe("org authority record shape", () => {
  it("accepts the base record", () => expect(code(() => checkOrgAuthorityShape(base()))).toBe("ok"));
  it("keeps k_gov and k_destroy at two once there are two admins", () => {
    expect(code(() => checkOrgAuthorityShape({ ...base(), kGov: 1 }))).toBe("thresholds");
    expect(code(() => checkOrgAuthorityShape({ ...base(), kDestroy: 1 }))).toBe("thresholds");
  });
  it("refuses a threshold above the admins", () => expect(code(() => checkOrgAuthorityShape({ ...base(), kSite: 4 }))).toBe("thresholds"));
  it("needs the founder to be an admin", () => {
    expect(code(() => checkOrgAuthorityShape({ ...base(), founderSeatId: "ff".repeat(16) }))).toBe("founder");
  });
  it("refuses a seat listed twice", () => {
    const r = base();
    expect(code(() => checkOrgAuthorityShape({ ...r, admins: [...r.admins, r.admins[0]!] }))).toBe("malformed");
  });
  it("refuses an overturn set naming a seat outside the record", () => {
    expect(code(() => checkOrgAuthorityShape({ ...base(), bylaws: { overturnSeats: ["ee".repeat(16)], overturnK: 1, vetoK: 1 } }))).toBe("bylaws");
  });
  it("majority and the strictest ceremony", () => {
    expect(orgOverturnThreshold(base())).toBe(2);
    expect(orgBylawsThreshold(base())).toBe(2);
    expect(orgBylawsThreshold({ ...base(), kDestroy: 3 })).toBe(3);
  });
  it("the founder cannot use the removal path on itself", () => {
    expect(code(() => orgFounderRemovalOf(base(), V.keys["A founder"].seatId, 2))).toBe("founder");
  });
  it("a removal clamps thresholds to what remains", () => {
    const r = orgFounderRemovalOf({ ...base(), kGov: 3, kSite: 3 }, V.keys["C admin"].seatId, 2);
    expect(r.kGov).toBe(2);
    expect(r.kSite).toBe(2);
  });
});

describe("seats", () => {
  it("an invite or grant needs the pseudonym's digest", () => {
    const invite = { orgId: V.orgId, seatId: "61".repeat(16), labelSha256: "", rolesHash: "00".repeat(32), oarVersion: 0, issuedAt: 1, expiresAt: 2 };
    expect(code(() => canonicalOrgSeatInvite(invite))).toBe("label-missing");
    const grant = { ...invite, memberKeyId: "11".repeat(32), adminKeyId: "", expiresAt: 3 };
    expect(code(() => canonicalOrgSeatGrant(grant))).toBe("label-missing");
  });
  it("roles refuse separators, duplicates and a role twice", () => {
    expect(code(() => canonicalOrgSeatRoles([{ role: "server-admin", servers: ["a|b"] }]))).toBe("malformed");
    expect(code(() => canonicalOrgSeatRoles([{ role: "service-admin", apps: ["x", "x"] }]))).toBe("malformed");
    expect(code(() => canonicalOrgSeatRoles([{ role: "member" }, { role: "member" }]))).toBe("malformed");
    expect(code(() => canonicalOrgSeatRoles([]))).toBe("malformed");
  });
});
