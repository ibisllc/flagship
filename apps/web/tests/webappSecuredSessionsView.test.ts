// Web-experience gating — webapp view wiring (docs/service-access-gating.md).
//
// Structure-level tests over the EXACT static assets the production webapp
// loads (served via the Fastify app), mirroring serviceAccessView.test.ts: the
// "Process URL" authorize view + the "Open secured sessions" list view register,
// wire the right lib surface, and the shell (index.html + app.js) declares,
// links, and inits them. The dist is what the production webapp loads, so a
// structure-level test catches wiring regressions early.

import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("web-experience gating — Process-URL authorize view", () => {
  it("/views/access-authorize.js registers + drives the paste→confirm→authorize flow", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/access-authorize.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-access-authorize")');
    // Parse the pasted flagship://access link, then authorize.
    expect(r.body).toContain("parseAccessDeepLink");
    expect(r.body).toContain("authorizeKnock");
    // Identity comes from the in-page AID (gated behind the in-memory UMK).
    expect(r.body).toContain("deriveAccountIdFromSeed");
    expect(r.body).toContain("signWithAccountId");
    // On success the SecuredSession is persisted locally.
    expect(r.body).toContain("saveSecuredSession");
    // The "Process URL" affordance + confirm copy.
    expect(r.body).toContain("Process URL");
    expect(r.body).toContain("Authorize this site?");
  });

  it("/views/secured-sessions.js registers + lists / refreshes / stops sessions", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/secured-sessions.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-secured-sessions")');
    expect(r.body).toContain("listSecuredSessions");
    expect(r.body).toContain("removeSecuredSession");
    // Per-row liveness re-check (debounced) + stop (close).
    expect(r.body).toContain("canCheckStatus");
    expect(r.body).toContain("sessionStatus");
    expect(r.body).toContain("closeSession");
    // 429 keeps the last-known status rather than clobbering it.
    expect(r.body).toContain('"429"');
  });

  it("/lib/serviceInvite.js exposes the knock crypto-mirror + web-gating wire surface", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/serviceInvite.js" });
    expect(r.statusCode).toBe(200);
    // Canonical-bytes tag MUST match @flagship/protocol.
    expect(r.body).toContain('"flagship/service-knock/v1"');
    expect(r.body).toContain("canonicalKnockBytes");
    expect(r.body).toContain("signKnockAuthorization");
    expect(r.body).toContain("parseAccessDeepLink");
    // The box endpoints (authorize / session status / close).
    expect(r.body).toContain("/api/service-access/knock/authorize");
    expect(r.body).toContain("/api/service-access/session/status");
    expect(r.body).toContain("/api/service-access/session/close");
  });

  it("/lib/securedSessions.js exposes the store + the >=60s status debounce", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/securedSessions.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("listSecuredSessions");
    expect(r.body).toContain("saveSecuredSession");
    expect(r.body).toContain("removeSecuredSession");
    expect(r.body).toContain("clearSecuredSessions");
    expect(r.body).toContain("canCheckStatus");
    expect(r.body).toContain("STATUS_DEBOUNCE_MS");
  });

  it("index.html declares both sections + the Settings entry rows", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="view-access-authorize"');
    expect(r.body).toContain('id="view-secured-sessions"');
    expect(r.body).toContain('id="secured-sessions-content"');
    expect(r.body).toContain('id="access-authorize-content"');
    // Settings → "Open secured sessions" + "Process URL".
    expect(r.body).toContain('id="settings-tab-secured-sessions"');
    expect(r.body).toContain('id="settings-tab-process-url"');
    expect(r.body).toContain("Open secured sessions");
    expect(r.body).toContain("Process URL");
  });

  it("app.js imports, inits, IA-maps, and row-wires the two views", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("./views/secured-sessions.js");
    expect(r.body).toContain("./views/access-authorize.js");
    expect(r.body).toContain("initSecuredSessionsView()");
    expect(r.body).toContain("initAccessAuthorizeView()");
    expect(r.body).toContain('"view-secured-sessions": "settings"');
    expect(r.body).toContain('"view-access-authorize": "settings"');
    expect(r.body).toContain('wire("settings-tab-secured-sessions", enterSecuredSessions)');
    expect(r.body).toContain('wire("settings-tab-process-url"');
  });
});
