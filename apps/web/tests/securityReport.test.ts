import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerSecurityReport, type SecurityReport } from "../src/routes/securityReport.js";

function makeApp(opts: Parameters<typeof registerSecurityReport>[1] = {}) {
  const app = Fastify({ logger: false });
  registerSecurityReport(app, opts);
  return app;
}

const goodPayload = {
  email: "researcher@example.com",
  severity: "high",
  component: "Server daemon",
  summary: "BootCoordinator reuses nonces under TTL boundary",
  details: "Reproduced by waiting until just before TTL expiry and submitting a stale signature; the coordinator accepted it once.",
};

describe("POST /api/security/report", () => {
  it("accepts a well-formed report and returns a reference id", async () => {
    const captured: SecurityReport[] = [];
    const app = makeApp({ sink: (r) => void captured.push(r) });
    const res = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: goodPayload,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.reportId).toMatch(/^FLG-[0-9A-F]{16}$/);
    expect(body.status).toBe("received");
    expect(captured.length).toBe(1);
    expect(captured[0]!.summary).toContain("nonces");
    expect(captured[0]!.email).toBe("researcher@example.com");
  });

  it("accepts anonymous reports (no email)", async () => {
    const app = makeApp({ sink: () => {} });
    const { email: _drop, ...anon } = goodPayload;
    const res = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: anon,
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects missing summary with 400", async () => {
    const app = makeApp({ sink: () => {} });
    const res = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: { ...goodPayload, summary: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing details with 400", async () => {
    const app = makeApp({ sink: () => {} });
    const res = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: { ...goodPayload, details: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects malformed email with 400", async () => {
    const app = makeApp({ sink: () => {} });
    const res = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: { ...goodPayload, email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("clamps severity to a valid enum (defaults to 'high')", async () => {
    const captured: SecurityReport[] = [];
    const app = makeApp({ sink: (r) => void captured.push(r) });
    const res = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: { ...goodPayload, severity: "EXTREMELY_CRITICAL_PLEASE_PANIC" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured[0]!.severity).toBe("high");
  });

  it("rate-limits the same IP after the configured threshold", async () => {
    const app = makeApp({ sink: () => {}, rateLimit: { perIpPerHour: 2 } });
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: "POST",
        url: "/api/security/report",
        payload: goodPayload,
        remoteAddress: "10.0.0.42",
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: goodPayload,
      remoteAddress: "10.0.0.42",
    });
    expect(limited.statusCode).toBe(429);
  });

  it("rate-limit window expires (sliding window)", async () => {
    let now = 1_000_000;
    const app = makeApp({
      sink: () => {},
      rateLimit: { perIpPerHour: 1 },
      now: () => now,
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: goodPayload,
      remoteAddress: "10.0.0.7",
    });
    expect(first.statusCode).toBe(200);
    const blocked = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: goodPayload,
      remoteAddress: "10.0.0.7",
    });
    expect(blocked.statusCode).toBe(429);
    now += 61 * 60_000; // past the 1h window
    const allowed = await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: goodPayload,
      remoteAddress: "10.0.0.7",
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("records the source IP via X-Forwarded-For when present", async () => {
    const captured: SecurityReport[] = [];
    const app = makeApp({ sink: (r) => void captured.push(r) });
    await app.inject({
      method: "POST",
      url: "/api/security/report",
      payload: goodPayload,
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(captured[0]!.remoteAddr).toBe("203.0.113.5");
  });
});
