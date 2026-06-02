import { describe, expect, it } from "vitest";
import {
  buildCaaIssueValue,
  buildUserZoneCaaRecords,
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
  it("emits one issue record for the zone apex and one for the wildcard", () => {
    const recs = buildUserZoneCaaRecords("alice.flagship.services", { accountUri: ACCT });
    expect(recs).toEqual([
      {
        name: "alice.flagship.services",
        type: "CAA",
        flags: 0,
        tag: "issue",
        value: `letsencrypt.org; accounturi=${ACCT}; validationmethods=dns-01`,
      },
      {
        name: "*.alice.flagship.services",
        type: "CAA",
        flags: 0,
        tag: "issue",
        value: `letsencrypt.org; accounturi=${ACCT}; validationmethods=dns-01`,
      },
    ]);
  });

  it("both records carry the identical pinned value", () => {
    const recs = buildUserZoneCaaRecords("bob.flagship.services", { accountUri: ACCT });
    expect(recs).toHaveLength(2);
    expect(recs[0]!.value).toBe(recs[1]!.value);
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

describe("expectedCertSans", () => {
  it("is exactly [<user>.<apex>, *.<user>.<apex>] — the only legit SAN set", () => {
    expect(expectedCertSans("alice", "flagship.services")).toEqual([
      "alice.flagship.services",
      "*.alice.flagship.services",
    ]);
  });

  it("never includes a deeper (two-label) SAN — that shape is alarm-worthy in CT", () => {
    const sans = expectedCertSans("alice", "flagship.services");
    expect(sans).toHaveLength(2);
    expect(sans.some((s) => s.includes(".alice.flagship.services") && s.startsWith("*.") === false)).toBe(false);
    // No `<app>.<box>.<user>` two-label-deep form ever appears.
    for (const s of sans) {
      const beforeApex = s.replace(".flagship.services", "");
      expect(beforeApex === "alice" || beforeApex === "*.alice").toBe(true);
    }
  });
});
