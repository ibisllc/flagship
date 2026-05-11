import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/.well-known/security.txt (RFC 9116)", () => {
  it("is served and contains the required Contact + Expires fields", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Contact: mailto:security@flagshipserver.com");
    expect(r.body).toContain("Expires:");
    expect(r.body).toContain("Canonical:");
  });

  it("Expires is a valid RFC 3339 timestamp in the future", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    const m = r.body.match(/Expires: (.+)/);
    expect(m).not.toBeNull();
    const t = Date.parse(m![1]!.trim());
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThan(Date.now());
  });

  it("Policy field points at the disclosure page (RFC 9116 optional but expected for v1 launch)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    expect(r.body).toContain("Policy: https://flagshipserver.com/security/disclosure.html");
  });
});

describe("/security/disclosure.html (bounty + coordinated disclosure)", () => {
  it("is served and lists scope + payouts + SLA", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/security/disclosure.html" });
    expect(r.statusCode).toBe(200);
    // Scope (in + out) — both the in-scope marker and the explicit out-of-scope items.
    expect(r.body).toContain("In scope");
    expect(r.body).toContain("Out of scope");
    expect(r.body).toContain("@flagship/protocol");
    // Payout table — at least the four severity tiers labelled.
    expect(r.body).toContain("Critical");
    expect(r.body).toContain("High");
    expect(r.body).toContain("Medium");
    expect(r.body).toContain("Low");
    // SLA — initial ack window posted up front.
    expect(r.body).toContain("Initial acknowledgement");
    // Safe harbor language present.
    expect(r.body).toContain("Safe-harbor");
  });
});
