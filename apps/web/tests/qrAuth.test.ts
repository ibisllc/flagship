import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("QR auth flow", () => {
  it("starts a session and returns a deeplink payload", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "POST", url: "/api/qr/start" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.qrPayload).toMatch(/^flagship:\/\/qr\//);
    expect(body.ttlSeconds).toBeGreaterThan(0);
  });

  it("status reports 'pending' until the phone responds", async () => {
    const app = buildServer();
    const start = JSON.parse((await app.inject({ method: "POST", url: "/api/qr/start" })).body);
    const status = await app.inject({
      method: "GET",
      url: `/api/qr/${start.sessionId}/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body).status).toBe("pending");
  });

  it("respond approved transitions the session", async () => {
    const app = buildServer();
    const start = JSON.parse((await app.inject({ method: "POST", url: "/api/qr/start" })).body);
    const respond = await app.inject({
      method: "POST",
      url: `/api/qr/${start.sessionId}/respond`,
      payload: { approved: true },
    });
    expect(respond.statusCode).toBe(200);
    expect(JSON.parse(respond.body).status).toBe("approved");
  });

  it("rejects double-respond with 409", async () => {
    const app = buildServer();
    const start = JSON.parse((await app.inject({ method: "POST", url: "/api/qr/start" })).body);
    await app.inject({
      method: "POST",
      url: `/api/qr/${start.sessionId}/respond`,
      payload: { approved: true },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/qr/${start.sessionId}/respond`,
      payload: { approved: false },
    });
    expect(second.statusCode).toBe(409);
  });

  it("returns 404 for unknown session", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/qr/deadbeefdeadbeef/status" });
    expect(res.statusCode).toBe(404);
  });
});
