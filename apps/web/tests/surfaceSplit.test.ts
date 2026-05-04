import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * The control plane runs as one of three modes:
 *   - "com"      → identity surface only
 *   - "services" → traffic + peer surface only
 *   - "both"     → dev/test default
 *
 * These tests assert which routes exist where so a misconfigured deploy
 * fails loud locally instead of silently doing the wrong thing in prod.
 */

async function probe(app: ReturnType<typeof buildServer>, method: string, url: string) {
  return app.inject({ method, url, payload: {} });
}

describe("surface = 'com' — identity routes only", () => {
  const com = () => buildServer({ surface: "com" });

  it("/api/health reports surface: com and service: flagshipserver.com", async () => {
    const r = await com().inject({ method: "GET", url: "/api/health" });
    const body = JSON.parse(r.body);
    expect(body.surface).toBe("com");
    expect(body.service).toBe("flagshipserver.com");
  });

  it("serves the marketing root + /webapp + /deck (static surface lives on .com)", async () => {
    const app = com();
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/webapp/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/deck/" })).statusCode).toBe(200);
  });

  it("hosts identity routes: /api/build-image, /api/desktop/pair/start, /api/push/dispatch", async () => {
    const app = com();
    // 400 (malformed body) is the success signal here — the route exists.
    expect((await probe(app, "POST", "/api/build-image")).statusCode).not.toBe(404);
    expect((await probe(app, "POST", "/api/desktop/pair/start")).statusCode).not.toBe(404);
    expect((await probe(app, "POST", "/api/push/dispatch")).statusCode).not.toBe(404);
  });

  it("does NOT host traffic routes: /api/peer-backup/announce", async () => {
    const r = await probe(com(), "POST", "/api/peer-backup/announce");
    expect(r.statusCode).toBe(404);
  });
});

describe("surface = 'services' — traffic + peer routes only", () => {
  const services = () => buildServer({ surface: "services" });

  it("/api/health reports surface: services and service: flagship.services", async () => {
    const r = await services().inject({ method: "GET", url: "/api/health" });
    const body = JSON.parse(r.body);
    expect(body.surface).toBe("services");
    expect(body.service).toBe("flagship.services");
  });

  it("hosts /api/peer-backup/* matchmaker routes", async () => {
    const app = services();
    expect((await probe(app, "POST", "/api/peer-backup/announce")).statusCode).not.toBe(404);
    expect((await probe(app, "POST", "/api/peer-backup/request-peers")).statusCode).not.toBe(404);
    expect((await probe(app, "POST", "/api/peer-backup/peer-confirm")).statusCode).not.toBe(404);
  });

  it("does NOT host marketing pages (no /webapp, no /, no /deck)", async () => {
    const app = services();
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/webapp/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/deck/" })).statusCode).toBe(404);
  });

  it("does NOT host identity routes (no /api/build-image, no /api/push/*, no /api/desktop/*)", async () => {
    const app = services();
    expect((await probe(app, "POST", "/api/build-image")).statusCode).toBe(404);
    expect((await probe(app, "POST", "/api/push/dispatch")).statusCode).toBe(404);
    expect((await probe(app, "POST", "/api/desktop/pair/start")).statusCode).toBe(404);
    expect((await probe(app, "POST", "/api/llm-promo/issue/start")).statusCode).toBe(404);
  });
});

describe("surface = 'both' (default, dev/test)", () => {
  const both = () => buildServer();

  it("hosts both identity AND peer routes", async () => {
    const app = both();
    expect((await probe(app, "POST", "/api/build-image")).statusCode).not.toBe(404);
    expect((await probe(app, "POST", "/api/peer-backup/announce")).statusCode).not.toBe(404);
    expect((await app.inject({ method: "GET", url: "/webapp/" })).statusCode).toBe(200);
  });
});
