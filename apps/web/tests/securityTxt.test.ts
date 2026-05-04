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
});
