import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * v2 relay protocol — hero-QR markup + script assertions.
 *
 * Differences from v1:
 *  - QR is visible at every viewport (no ≥1024px gate).
 *  - No POST /api/build-relay/sessions; sid + keys are client-derived.
 *  - No "Tap to start"; QR auto-renders on load with a placeholder
 *    mosaic, then swaps to the live QR.
 *  - Match code is derived locally from ECDH; not on the wire.
 */

describe("hero-QR — v2 relay surface", () => {
  it("ships the bare QR markup on /", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="heroQr"');
    expect(r.body).toContain('id="heroQrCanvas"');
    expect(r.body).toContain('id="heroQrDigits"');
    // The v2 markup has no eyebrow/status/caption/start nodes anymore —
    // the QR + match-code digits are the entire surface.
    expect(r.body).not.toContain('id="heroQrStart"');
    expect(r.body).not.toContain('id="heroQrCaption"');
  });

  it("loads the hero-QR script defer-style and the script is served", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toMatch(/src="\/heroQr\.js"\s+defer/);

    const js = await app.inject({ method: "GET", url: "/heroQr.js" });
    expect(js.statusCode).toBe(200);
    // v2 markers:
    expect(js.body).toContain("/qr-pipe");
    expect(js.body).toContain("X25519");
    expect(js.body).toContain("AES-GCM");
    expect(js.body).toContain("peer-hello");
    expect(js.body).toContain("peer-deliver");
    // The match code is derived locally — no server-issued value.
    expect(js.body).toContain("matchCodeFromBytes");
    // Placeholder must paint immediately (memory: feedback-qr-placeholder).
    expect(js.body).toContain("renderPlaceholderMosaic");
  });

  it("v1 wire shape is gone (no POST endpoint, no /build-relay path)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/heroQr.js" });
    expect(r.body).not.toContain("/api/build-relay/sessions");
    expect(r.body).not.toContain("/build-relay/");
  });

  it("the page still works without JS (progressive enhancement)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toContain("Your stuff,");
    // The new primary CTAs point to /#install-ios + /#install-android.
    expect(r.body).toMatch(/href="#install-ios"/);
    expect(r.body).toMatch(/href="#install-android"/);
    expect(r.body).toMatch(/src="\/heroQr\.js"\s+defer/);
  });
});
