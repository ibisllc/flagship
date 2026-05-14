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

  /**
   * DO-duration gate: the v2 hero MUST NOT open the relay WebSocket on
   * load. A drive-by visitor — a crawler, a Slack/Twitter link unfurl,
   * a user who lands and scrolls past the hero — must cost zero
   * Durable Object duration. The WS opens only after the user
   * demonstrates intent: viewport dwell or an explicit click.
   *
   * These assertions verify that the gate exists in the deployed
   * script. They're source-level (no jsdom in the repo); behavioral
   * coverage will land with the e2e rig (apps/web/e2e).
   */
  describe("DO-duration gate (P0 — lazy WS open)", () => {
    it("init does NOT call openSocket directly — only prepareSession", async () => {
      const app = buildServer();
      const js = await app.inject({ method: "GET", url: "/heroQr.js" });
      // The init function must hand off to prepareSession; the legacy
      // `void renew("init")` (which auto-opened the WS) must be gone.
      expect(js.body).toContain('void prepareSession("init")');
      expect(js.body).not.toMatch(/void renew\(/);
    });

    it("prepareSession opens the WS only when already engaged", async () => {
      const app = buildServer();
      const js = await app.inject({ method: "GET", url: "/heroQr.js" });
      // The guard inside prepareSession that gates the WS open. If
      // this is removed, every page load opens a WS again.
      expect(js.body).toMatch(/if \(engaged\)\s+openSocketAndArmRenewal/);
    });

    it("uses IntersectionObserver for viewport-dwell engagement", async () => {
      const app = buildServer();
      const js = await app.inject({ method: "GET", url: "/heroQr.js" });
      expect(js.body).toContain("IntersectionObserver");
      expect(js.body).toContain("ENGAGE_DELAY_MS");
      expect(js.body).toContain("ENGAGE_THRESHOLD");
      // Dwell timer fires `engage("viewport-dwell")` — the canonical
      // viewport path. Removing this branch turns the gate off.
      expect(js.body).toContain('engage("viewport-dwell")');
    });

    it("treats explicit user gestures on the card as engagement", async () => {
      const app = buildServer();
      const js = await app.inject({ method: "GET", url: "/heroQr.js" });
      // pointerdown + click are both wired so mouse, touch, pen, and
      // keyboard activation (Enter/Space → click) all qualify.
      expect(js.body).toMatch(/addEventListener\("pointerdown",\s*onUserIntent/);
      expect(js.body).toMatch(/addEventListener\("click",\s*onUserIntent/);
      expect(js.body).toContain('engage("user-intent")');
    });

    it("closes the WS on tab hide and re-arms engagement", async () => {
      const app = buildServer();
      const js = await app.inject({ method: "GET", url: "/heroQr.js" });
      expect(js.body).toContain('document.addEventListener("visibilitychange"');
      expect(js.body).toContain("onVisibilityChange");
      // Tab-hidden path tears the WS down and re-arms the IO gate so
      // returning to the tab requires fresh intent.
      expect(js.body).toMatch(/visibilityState === "hidden"/);
      expect(js.body).toMatch(/closeWs\("tab-hidden"\)/);
    });

    it("pre-emptive renewal is gated on engagement (no 4-min idle DO churn)", async () => {
      const app = buildServer();
      const js = await app.inject({ method: "GET", url: "/heroQr.js" });
      // The 4-min pre-expire timer used to spawn a new DO every cycle
      // regardless of user attention. The new guard short-circuits
      // when the user has disengaged.
      expect(js.body).toMatch(/renewTimer = setTimeout\([^]*if \(!engaged\) return/);
    });

    it("exposes the engaged state on the test harness window", async () => {
      const app = buildServer();
      const js = await app.inject({ method: "GET", url: "/heroQr.js" });
      // Future e2e tests assert on these to verify the gate is closed
      // in normal conditions and opens on engagement.
      expect(js.body).toContain("engaged: () =>");
      expect(js.body).toContain("wsState: () =>");
    });
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
