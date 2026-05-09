import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("/webapp PWA static surface", () => {
  it("serves /webapp/manifest.json with the right shape", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/manifest.json" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.start_url).toBe("/webapp/");
    expect(body.scope).toBe("/webapp/");
    expect(body.display).toBe("standalone");
  });

  it("serves /webapp/index.html and links the manifest + service worker", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('rel="manifest"');
    expect(r.body).toContain("/webapp/service-worker.js");
  });

  it("serves /webapp/service-worker.js with the correct scope hooks", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/service-worker.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("flagship-webapp-shell-");
    expect(r.body).toContain("self.addEventListener");
  });

  it("/webapp/app.js loads and dispatches to view modules", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    // The split entry imports each view's init function and the
    // router. Detailed identity logic lives in views/* + keystore.js.
    expect(r.body).toContain('from "./keystore.js"');
    expect(r.body).toContain('from "./views/bootstrap.js"');
    expect(r.body).toContain('from "./views/unlock.js"');
    expect(r.body).toContain('from "./views/home.js"');
    expect(r.body).toContain('from "./views/pair.js"');
    expect(r.body).toContain('from "./views/settings.js"');
  });

  it("/webapp/views/bootstrap.js holds the bootstrapNewIdentity wiring", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/bootstrap.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("bootstrapNewIdentity");
  });

  it("/webapp/lib/state.js holds deriveIrkFromSeed (session-scoped)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/state.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("deriveIrkFromSeed");
  });

  it("/webapp/keystore.js exposes the wrap/unwrap surface used by app.js", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/keystore.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export async function bootstrapNewIdentity");
    expect(r.body).toContain("export async function unlockUmk");
    expect(r.body).toContain("export async function deriveIrkFromSeed");
    expect(r.body).toContain("export async function deriveBakFromSeed");
  });

  it("/webapp/lib/api.js exposes screensFetch + podBaseUrl/sessionToken setters", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/api.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export async function screensFetch");
    expect(r.body).toContain("export function setPodBaseUrl");
    expect(r.body).toContain("export function setSessionToken");
    expect(r.body).toContain("x-flagship-session");
  });

  it("/webapp/lib/podPair.js signs an add-paired-session order with the IRK", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/podPair.js" });
    expect(r.statusCode).toBe(200);
    // Same canonical-bytes tag the pod's auth.ts uses to verify.
    expect(r.body).toContain("flagship/order/add-paired-session/v1");
    // POSTs to the daemon's orders endpoint.
    expect(r.body).toContain("/api/orders-from-user");
    expect(r.body).toContain("signWithIrk");
  });

  it("each P2 view module is reachable as a static asset", async () => {
    const app = buildServer();
    for (const path of [
      "/webapp/views/server-detail.js",
      "/webapp/views/apps-list.js",
      "/webapp/views/app-detail.js",
      "/webapp/views/paired-sessions.js",
      "/webapp/views/tier-status.js",
      "/webapp/views/pod-pair.js",
      "/webapp/views/marketplace.js",
      "/webapp/views/vibe-code.js",
      "/webapp/views/unlock-approvals.js",
      "/webapp/views/recovery.js",
    ]) {
      const r = await app.inject({ method: "GET", url: path });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("registerView");
    }
  });

  it("each /api/screens/* endpoint name appears in exactly one view", async () => {
    // BFF discipline: one endpoint per view. This isn't a perfect
    // assertion (fancier views might call helper endpoints) but it
    // catches the most common drift.
    const app = buildServer();
    const want = [
      ["/api/screens/server-detail", "/webapp/views/server-detail.js"],
      ["/api/screens/apps-list", "/webapp/views/apps-list.js"],
      ["/api/screens/app-detail/", "/webapp/views/app-detail.js"],
      ["/api/screens/paired-sessions/list", "/webapp/views/paired-sessions.js"],
      ["/api/screens/tier-status", "/webapp/views/tier-status.js"],
      ["/api/screens/marketplace-browse", "/webapp/views/marketplace.js"],
      ["/api/screens/vibe-code/start", "/webapp/views/vibe-code.js"],
      ["/api/screens/unlock-approvals/pending", "/webapp/views/unlock-approvals.js"],
    ];
    for (const [endpoint, view] of want) {
      const r = await app.inject({ method: "GET", url: view });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain(endpoint);
    }
  });

  it("/webapp/lib/installApp.js signs canonical install-app + uninstall-app envelopes", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/installApp.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("flagship/install-app/v1");
    expect(r.body).toContain("flagship/uninstall-app/v1");
    expect(r.body).toContain("/api/marketplace/");
    expect(r.body).toContain("/api/apps");
  });

  it("never accidentally serves /webapp resources from the root scope", async () => {
    const app = buildServer();
    // Confirm the marketing root is NOT a manifest
    const r = await app.inject({ method: "GET", url: "/manifest.json" });
    expect(r.statusCode).toBe(404);
  });
});
