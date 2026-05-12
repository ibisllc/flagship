import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("hero-QR — large-screens-only build-relay surface (#94)", () => {
  it("ships the QR card markup on /", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="heroQr"');
    expect(r.body).toContain('id="heroQrCanvas"');
    expect(r.body).toContain('id="heroQrStart"');
    expect(r.body).toContain('id="heroQrDigits"');
    expect(r.body).toContain('id="heroQrCaption"');
    expect(r.body).toContain('id="heroQrStatus"');
  });

  it("ships the specified caption and match-code label", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toContain(
      "Compose a server in the Flagship app on your phone, then scan here to deliver it.",
    );
    expect(r.body).toContain("match code");
  });

  it("guards the QR region behind a ≥1024px media query (hidden on small screens)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toMatch(/\.hero-qr\s*\{\s*display:\s*none;?\s*\}/);
    expect(r.body).toMatch(/@media\s*\(min-width:\s*1024px\)/);
    // And inside that media query the hero-art gets hidden so the QR
    // takes its slot at large viewports.
    expect(r.body).toMatch(/@media\s*\(min-width:\s*1024px\)[\s\S]*?\.hero-art\s*\{\s*display:\s*none/);
  });

  it("loads the hero-QR script defer-style and the script is served", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.body).toContain('src="/heroQr.js"');

    const js = await app.inject({ method: "GET", url: "/heroQr.js" });
    expect(js.statusCode).toBe(200);
    // Wire-shape for #59 documented in source.
    expect(js.body).toContain("/api/build-relay/sessions");
    // Lazy-open discipline: no auto-fire, only on explicit tap.
    expect(js.body).toContain("IntersectionObserver");
    expect(js.body).toContain("addEventListener(\"click\"");
    // 10-second cold-visitor rotation.
    expect(js.body).toContain("ROTATE_AFTER_MS");
    expect(js.body).toContain("10_000");
    // Fallback path when the relay is unreachable.
    expect(js.body).toMatch(/renderFallback\s*\(\s*\)/);
  });

  it("the page still works without JS (progressive enhancement)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/" });
    // Hero copy + the existing Get-a-build-code CTA are present in the
    // static HTML — nothing on the page depends on heroQr.js running.
    expect(r.body).toContain("Your stuff,");
    expect(r.body).toMatch(/href="\/build\/"[^>]*>\s*Get a build code/);
    // The QR script is defer so HTML parse is never blocked.
    expect(r.body).toMatch(/src="\/heroQr\.js"\s+defer/);
  });
});
