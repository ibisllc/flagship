import { describe, expect, it } from "vitest";
import {
  buildCaaIssueValue,
  buildUserZoneCaaRecords,
  buildUserZoneCaRestrictionCaaRecords,
  caaRecordRdata,
  expectedCertSans,
} from "../src/caaPin.js";

const ACCT = "https://acme-v02.api.letsencrypt.org/acme/acct/123";

describe("buildCaaIssueValue", () => {
  it("emits the RFC 8657 issue value with defaults (letsencrypt.org + dns-01)", () => {
    expect(buildCaaIssueValue({ accountUri: ACCT })).toBe(
      "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/123; validationmethods=dns-01",
    );
  });

  it("honours a custom caDomain", () => {
    expect(buildCaaIssueValue({ caDomain: "pki.goog", accountUri: ACCT })).toBe(
      "pki.goog; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/123; validationmethods=dns-01",
    );
  });

  it("comma-joins multiple validation methods", () => {
    expect(
      buildCaaIssueValue({ accountUri: ACCT, validationMethods: ["dns-01", "http-01"] }),
    ).toBe(
      "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/123; validationmethods=dns-01,http-01",
    );
  });

  it("keeps a fixed parameter order (caDomain, accounturi, validationmethods)", () => {
    const v = buildCaaIssueValue({ accountUri: ACCT });
    expect(v.indexOf("accounturi=")).toBeLessThan(v.indexOf("validationmethods="));
    expect(v.startsWith("letsencrypt.org;")).toBe(true);
  });

  it("throws when accountUri is missing (pinning is the whole point)", () => {
    expect(() => buildCaaIssueValue({ accountUri: "" })).toThrow(/accountUri is required/);
  });
});

describe("buildUserZoneCaaRecords", () => {
  it("emits one issue record, at the user zone only (CAA climbs; no *. copy)", () => {
    const recs = buildUserZoneCaaRecords("alice.flagship.services", { accountUri: ACCT });
    expect(recs).toEqual([
      {
        name: "alice.flagship.services",
        type: "CAA",
        flags: 0,
        tag: "issue",
        value: `letsencrypt.org; accounturi=${ACCT}; validationmethods=dns-01`,
      },
    ]);
  });

  it("threads custom options through to the value", () => {
    const recs = buildUserZoneCaaRecords("eve.flagship.services", {
      caDomain: "pki.goog",
      accountUri: ACCT,
      validationMethods: ["dns-01", "http-01"],
    });
    for (const r of recs) {
      expect(r.value).toBe(
        `pki.goog; accounturi=${ACCT}; validationmethods=dns-01,http-01`,
      );
    }
  });
});

describe("buildUserZoneCaRestrictionCaaRecords (PHASE 1 — no account pinning)", () => {
  it("emits exactly issue + issuewild, at the user-zone node only", () => {
    const recs = buildUserZoneCaRestrictionCaaRecords("alice.flagship.services");
    expect(recs).toEqual([
      { name: "alice.flagship.services", type: "CAA", flags: 0, tag: "issue", value: "letsencrypt.org" },
      { name: "alice.flagship.services", type: "CAA", flags: 0, tag: "issuewild", value: "letsencrypt.org" },
    ]);
  });

  it("never writes a *.<user> CAA (it only repeats the climbed one and rides the account wildcard)", () => {
    const recs = buildUserZoneCaRestrictionCaaRecords("alice.flagship.services", { iodef: "mailto:a@b.c" });
    expect(recs.some((r) => r.name.startsWith("*."))).toBe(false);
  });

  it("carries NO accounturi (that is PHASE 2)", () => {
    const recs = buildUserZoneCaRestrictionCaaRecords("bob.flagship.services");
    for (const r of recs) {
      expect(r.value).not.toContain("accounturi");
      expect(r.value).not.toContain(";");
    }
  });

  it("honours a custom caDomain and an opt-in iodef", () => {
    const recs = buildUserZoneCaRestrictionCaaRecords("eve.flagship.services", {
      caDomain: "pki.goog",
      iodef: "mailto:abuse@example.com",
    });
    expect(recs.find((r) => r.tag === "issue")!.value).toBe("pki.goog");
    expect(recs.find((r) => r.tag === "issuewild")!.value).toBe("pki.goog");
    expect(recs.find((r) => r.tag === "iodef")!.value).toBe("mailto:abuse@example.com");
    expect(recs).toHaveLength(3);
  });

  it("omits iodef unless asked (Let's Encrypt ignores it; it would cost a record per account)", () => {
    expect(buildUserZoneCaRestrictionCaaRecords("eve.flagship.services").some((r) => r.tag === "iodef")).toBe(false);
    expect(buildUserZoneCaRestrictionCaaRecords("eve.flagship.services", { iodef: "" })).toHaveLength(2);
  });
});

describe("caaRecordRdata", () => {
  it("renders the zone-file presentation form", () => {
    const recs = buildUserZoneCaRestrictionCaaRecords("alice.flagship.services", { iodef: "mailto:security@flagshipserver.com" });
    expect(caaRecordRdata(recs[0]!)).toBe('0 issue "letsencrypt.org"');
    expect(caaRecordRdata(recs[1]!)).toBe('0 issuewild "letsencrypt.org"');
    expect(caaRecordRdata(recs[2]!)).toBe('0 iodef "mailto:security@flagshipserver.com"');
  });
});

describe("expectedCertSans (cert model A′ — per-box wildcard)", () => {
  it("is exactly [<server>.<user>.<apex>, *.<server>.<user>.<apex>] — the only legit SAN set for a box", () => {
    expect(expectedCertSans("home.alice.flagship.services")).toEqual([
      "home.alice.flagship.services",
      "*.home.alice.flagship.services",
    ]);
  });

  it("never includes the old-style user-zone SAN pair — that shape is alarm-worthy in CT", () => {
    const sans = expectedCertSans("home.alice.flagship.services");
    expect(sans).toHaveLength(2);
    expect(sans).not.toContain("alice.flagship.services");
    expect(sans).not.toContain("*.alice.flagship.services");
    // Both SANs are scoped to the box's own subdomain.
    for (const s of sans) {
      expect(s.endsWith("home.alice.flagship.services")).toBe(true);
    }
  });
});
