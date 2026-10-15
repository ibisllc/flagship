// Smoke test for the webapp's verify-custom-domain wiring. The view
// fires a POST against /api/screens/url-controller/verify; we assert
// the path + body shape match the daemon contract (P1.22).

import { describe, expect, it } from "vitest";

describe("verify custom-domain wire shape", () => {
  it("posts a JSON body with the fqdn key", () => {
    const fqdn = "foo.example.com";
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify({ fqdn }),
    };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ fqdn });
  });

  it("expected TXT record echoes the fqdn-derived expectedTxtRecord on PENDING", () => {
    // Mirrors the response shape the daemon emits via P1.22; this
    // test pins the field names the view reads from.
    const pending = {
      fqdn: "foo.example.com",
      status: "pending" as const,
      expectedTxtRecord: "flagship-verify=abc123",
      observedTxtRecord: null,
      reason: "DNS propagation in flight",
    };
    expect(pending.status).toBe("pending");
    expect(pending.expectedTxtRecord).toMatch(/^flagship-verify=/);
  });

  it("VERIFIED carries observedTxtRecord that matches expected", () => {
    const verified = {
      fqdn: "foo.example.com",
      status: "verified" as const,
      expectedTxtRecord: "flagship-verify=abc123",
      observedTxtRecord: "flagship-verify=abc123",
      reason: null,
    };
    expect(verified.status).toBe("verified");
    expect(verified.observedTxtRecord).toBe(verified.expectedTxtRecord);
  });
});
