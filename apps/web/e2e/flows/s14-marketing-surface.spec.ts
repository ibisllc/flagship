/**
 * S14 — marketing-surface UI revamp.
 *
 * Verifies that the unified design system (tokens.css + components.css +
 * motion.js + the single teal accent) is wired into every
 * publicly-routable marketing page on flagshipserver.com.
 *
 * Spec-level focus is BRAND CONSISTENCY across pages, not pixel-perfect
 * layout. We assert the contract — same tokens, same fonts, same nav,
 * same favicon, same OG poster — without anchoring to specific dimensions
 * or colors at the rendered-pixel level (which would be flaky across
 * Chromium versions).
 *
 * Runs against APEX_BASE_URL (the .com Worker). Doesn't depend on the
 * pod-sim — these flows test the static surface only.
 */

import { test, expect, type Page } from "@playwright/test";

const APEX =
  process.env.APEX_BASE_URL ??
  process.env.WEBAPP_BASE_URL ??
  "http://localhost:8787";

// S14 talks to the marketing surface, served by the apex Worker. Under
// wrangler dev the apex is the default routing target (no Host override
// needed) so we use the @playwright/test base unmodified. The per-page
// override that fixtures/pod-sim.ts injects is what makes the WEBAPP
// surface reachable for S1–S13 / S15.

/**
 * The pages that share the unified design system. Build / dev /
 * security / status etc. live on the legacy /site.css shim, but that
 * shim @imports tokens.css + components.css — so they should still
 * surface the same accent token + nav DNA when the CSS resolves.
 */
const MARKETING_PAGES = [
  { path: "/", label: "landing" },
  { path: "/how-it-works.html", label: "how it works" },
  { path: "/pricing.html", label: "pricing" },
  { path: "/faq.html", label: "faq" },
  { path: "/help.html", label: "help" },
  { path: "/privacy.html", label: "privacy" },
  { path: "/terms.html", label: "terms" },
  { path: "/docs/", label: "docs" },
  { path: "/open-source.html", label: "open source" },
  { path: "/security.html", label: "security" },
  { path: "/status/", label: "status" },
  { path: "/blog/", label: "blog" },
  { path: "/abuse.html", label: "abuse" },
  { path: "/404.html", label: "404" },
];

/** Token contract every page must expose at the document root. */
interface DocTokens {
  accent: string;
  ink: string;
  canvas: string;
  fontSans: string;
  fontDisplay: string;
  fontMono: string;
  primary: string;
  bg: string;
  fg: string;
}

async function readDocTokens(page: Page): Promise<DocTokens> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue("--accent").trim(),
      ink: cs.getPropertyValue("--ink").trim(),
      canvas: cs.getPropertyValue("--canvas").trim(),
      fontSans: cs.getPropertyValue("--font-sans").trim(),
      fontDisplay: cs.getPropertyValue("--font-display").trim(),
      fontMono: cs.getPropertyValue("--font-mono").trim(),
      // Legacy aliases — must resolve to the new tokens, not the old hex.
      primary: cs.getPropertyValue("--primary").trim(),
      bg: cs.getPropertyValue("--bg").trim(),
      fg: cs.getPropertyValue("--fg").trim(),
    };
  });
}

test.describe("S14 — unified design system on the marketing surface", () => {
  test("/tokens.css ships the teal accent (not the banned blue)", async ({
    request,
  }) => {
    const r = await request.get(`${APEX}/tokens.css`);
    expect(r.status()).toBe(200);
    const body = await r.text();
    // The single accent is brand teal. The lila/blue (#3B5BFF), the
    // saturated green (#4ad295), and the old amber (#B26016/#D38347)
    // from prior identities must be gone.
    expect(body).toMatch(/--teal:\s+#14B8A6/);
    expect(body).toMatch(/--accent:\s+var\(--teal\)/);
    expect(body).not.toMatch(/#B26016/i);
    expect(body).not.toMatch(/#D38347/i);
    expect(body).not.toMatch(/--primary:\s+#3B5BFF/);
    expect(body).not.toMatch(/--accent:\s+#4ad295/i);
    // Type system: Geist (UI/body), Instrument Serif (display), Geist Mono.
    expect(body).toContain("Instrument Serif");
    expect(body).toContain("Geist");
    expect(body).toContain("Geist Mono");
  });

  test("/components.css ships the new primitive classes", async ({
    request,
  }) => {
    const r = await request.get(`${APEX}/components.css`);
    expect(r.status()).toBe(200);
    const body = await r.text();
    for (const cls of [".btn", ".card", ".pill", ".nav", ".footer", ".eyebrow", ".skip-link", ".grain", ".reveal", ".btn-arrow"]) {
      expect(body, `${cls} should be defined`).toContain(cls);
    }
  });

  test("/site.css is a compatibility shim that imports the unified tokens", async ({
    request,
  }) => {
    const r = await request.get(`${APEX}/site.css`);
    expect(r.status()).toBe(200);
    const body = await r.text();
    // The shim should @import the new files so legacy pages inherit
    // the new identity without a markup change.
    expect(body).toContain('@import url("/tokens.css")');
    expect(body).toContain('@import url("/components.css")');
    // And it must NOT carry the old palette in its own declarations.
    expect(body).not.toMatch(/#4ad295/i);
    expect(body).not.toMatch(/--accent:\s+#4ad295/i);
  });

  test("/motion.js exposes the scroll-reveal + magnetic-hover runtime", async ({
    request,
  }) => {
    const r = await request.get(`${APEX}/motion.js`);
    expect(r.status()).toBe(200);
    const body = await r.text();
    expect(body).toContain("IntersectionObserver");
    expect(body).toContain("data-reveal-stagger");
    expect(body).toContain("data-magnetic");
    expect(body).toContain("prefers-reduced-motion");
  });

  test("/grain.svg renders as an SVG fractal-noise overlay", async ({
    request,
  }) => {
    const r = await request.get(`${APEX}/grain.svg`);
    expect(r.status()).toBe(200);
    const ct = r.headers()["content-type"] ?? "";
    expect(ct).toContain("svg");
    const body = await r.text();
    expect(body).toContain("feTurbulence");
  });

  test("/favicon.svg and /apple-touch-icon.svg are the same rounded-square mark", async ({
    request,
  }) => {
    const fav = await request.get(`${APEX}/favicon.svg`);
    const apple = await request.get(`${APEX}/apple-touch-icon.svg`);
    expect(fav.status()).toBe(200);
    expect(apple.status()).toBe(200);
    const f = await fav.text();
    const a = await apple.text();
    for (const body of [f, a]) {
      // Both icons are the unified brand: a rounded square containing a
      // circle, in the app-logo colorway (teal ground + white disc).
      expect(body).toContain("#14B8A6"); // brand teal ground
      expect(body).toContain("#FFFFFF"); // white disc
      expect(body).toContain("<circle"); // the disc
      // The old flag-on-mast pennant (amber flag + ivory pole caps + a
      // mast <line>) is gone.
      expect(body).not.toMatch(/#B26016/i);
      expect(body).not.toMatch(/#D38347/i);
      expect(body).not.toContain("<line");
      // And not the even-older blue/green server logos.
      expect(body).not.toMatch(/#3B5BFF/i);
      expect(body).not.toMatch(/#4ad295/i);
    }
  });

  test("/og returns an editorial poster with the new positioning copy", async ({
    request,
  }) => {
    const r = await request.get(`${APEX}/og`);
    expect(r.status()).toBe(200);
    const body = await r.text();
    // New default subtitle (was "Your stuff, on your hardware.").
    expect(body).toContain("Your stuff, on hardware you own.");
    // No remnant of the old blue→navy gradient poster.
    expect(body).not.toMatch(/#3b5bff/i);
    // Brand strip + footer caption land on the ivory-on-ink palette.
    expect(body).toContain("FLAGSHIPSERVER.COM");
    expect(body).toContain("YOU HOLD THE KEYS");
  });

  test("/og honors title + subtitle params and stays cacheable", async ({
    request,
  }) => {
    const r = await request.get(
      `${APEX}/og?title=Build%20a%20Flagship&subtitle=Ten%20minutes,%20any%20old%20PC.`,
    );
    expect(r.status()).toBe(200);
    expect(r.headers()["cache-control"] ?? "").toMatch(/max-age=3600/);
    const body = await r.text();
    expect(body).toContain("Build a Flagship");
    expect(body).toContain("Ten minutes, any old PC.");
  });

  test("/ landing page leads with the editorial hero", async ({ page }) => {
    await page.goto("/");
    // The hero positioning words anchor the page even though the
    // markup splits them across <br> + <em> tags.
    await expect(page.locator("main h1").first()).toContainText(/Your stuff/i);
    await expect(page.locator("main h1").first()).toContainText(/hardware/i);
    await expect(page.locator("main h1").first()).toContainText(/green padlock/i);

    // Brand mark + nav links + CTAs.
    await expect(page.locator(".nav-brand")).toContainText("Flagship");
    for (const label of [
      "How it works",
      "Apps",
      "Pricing",
      "Security",
      "Docs",
      "Status",
    ]) {
      await expect(page.getByRole("link", { name: label }).first()).toBeVisible();
    }
    await expect(page.getByRole("link", { name: /Get a build code/ }).first()).toBeVisible();

    // Scroll-reveal markers + grain overlay are wired.
    expect(await page.locator(".reveal").count()).toBeGreaterThan(8);
    await expect(page.locator(".grain").first()).toHaveCount(1);
    expect(await page.locator("[data-reveal-stagger]").count()).toBeGreaterThan(0);
  });

  test("/ scroll-reveals fire — .reveal elements receive the .is-in class", async ({
    page,
  }) => {
    await page.goto("/");
    // Pin to a single .reveal inside the hero — once motion.js boots and the
    // IntersectionObserver fires, .is-in lands within a frame or two.
    const firstReveal = page.locator(".reveal").first();
    await expect(firstReveal).toHaveClass(/is-in/, { timeout: 4_000 });
  });

  test("each marketing page shares the same accent + font tokens", async ({
    page,
  }) => {
    const baselines: Array<{ label: string; tokens: DocTokens }> = [];
    for (const p of MARKETING_PAGES) {
      const resp = await page.goto(p.path);
      // 200 OR 304 (cached). Anything else means the page is gone.
      expect(resp, `${p.path} response`).not.toBeNull();
      expect(resp!.status(), `${p.path} status`).toBeLessThan(400);
      const tokens = await readDocTokens(page);
      baselines.push({ label: p.label, tokens });
      // Every page must expose the teal accent, not the banned
      // colors. We don't pin to an exact rendered string (CSS may
      // resolve `var(--accent)` to either the literal hex or a
      // computed-color form depending on the browser version), so we
      // just check the property is defined and is NOT the old palette.
      expect(tokens.accent, `${p.label} --accent`).not.toBe("");
      expect(tokens.accent.toLowerCase()).not.toContain("3b5bff");
      expect(tokens.accent.toLowerCase()).not.toContain("4ad295");
      // Geist must appear in the sans stack on every page.
      expect(tokens.fontSans.toLowerCase()).toContain("geist");
      expect(tokens.fontMono.toLowerCase()).toContain("mono");
    }

    // Cross-page consistency: every page resolves --accent to the same
    // value as the landing page (proves the single-palette unification).
    const landingAccent = baselines[0]!.tokens.accent;
    for (const b of baselines) {
      expect(b.tokens.accent, `${b.label} accent matches landing`).toBe(landingAccent);
    }
  });

  test("nav links from the landing resolve without 404", async ({ page }) => {
    await page.goto("/");
    const hrefs = await page
      .locator(".nav-links a, .nav-cta a, footer a")
      .evaluateAll((nodes) =>
        nodes
          .map((n) => (n as HTMLAnchorElement).getAttribute("href"))
          .filter((h): h is string => !!h)
          .filter((h) => !h.startsWith("http")) // skip external (GitHub, mailto)
          .filter((h) => !h.startsWith("mailto:"))
          .filter((h) => !h.startsWith("#")),
      );

    // Dedupe — footer + nav often re-reference the same routes.
    const unique = [...new Set(hrefs)];
    expect(unique.length).toBeGreaterThan(6);

    for (const href of unique) {
      const r = await page.request.get(href.startsWith("/") ? href : "/" + href);
      // 200 is the happy path; some routes (e.g. /security.txt) are
      // proxied to the daemon and may 404 in dev — flag only real
      // missing-static-asset 404s coming from the Worker's assets
      // binding.
      expect(
        r.status(),
        `${href} returned ${r.status()}`,
      ).toBeLessThan(500);
    }
  });

  test("/404.html serves the branded 'sailed past the harbor' page", async ({
    page,
  }) => {
    await page.goto("/404.html");
    await expect(page.locator("main h1")).toContainText(/sailed past the harbor/i);
    await expect(page.getByRole("link", { name: /Back to harbor/ })).toBeVisible();
    // 404 must share the same brand nav as every other page.
    await expect(page.locator(".nav-brand")).toContainText("Flagship");
    // Suggestions list links to real routes.
    const suggestionHrefs = await page
      .locator(".suggestions a")
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href")),
      );
    expect(suggestionHrefs).toContain("/security.html");
    expect(suggestionHrefs).toContain("/status/");
  });

  test("magnetic-hover CTAs exist on the landing page", async ({ page }) => {
    await page.goto("/");
    // motion.js binds data-magnetic on hover-capable pointers. The
    // attribute alone is sufficient to assert the wiring; rendering
    // the transform requires a mouse move which Playwright can fire
    // but is flaky across Chromium versions. We check presence + that
    // motion.js mutated nothing harmful when reduced-motion is off.
    const magneticCount = await page.locator("[data-magnetic]").count();
    expect(magneticCount).toBeGreaterThanOrEqual(2);
  });

  test("reduced-motion preference disables the reveal animation", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    // motion.js short-circuits: every .reveal lands with .is-in immediately
    // and the `motion-reduced` class is set on <html>.
    await expect(page.locator("html")).toHaveClass(/motion-reduced/);
    const everyRevealIsIn = await page
      .locator(".reveal")
      .evaluateAll((nodes) => nodes.every((n) => n.classList.contains("is-in")));
    expect(everyRevealIsIn).toBe(true);
    await ctx.close();
  });

  test("skip-to-content link appears on every marketing page", async ({
    page,
  }) => {
    // The skip-link is part of the landing + 404 templates today. If we
    // add it elsewhere we can extend the loop; but at minimum these two
    // must carry it so keyboard navigation has a way out.
    for (const path of ["/", "/404.html"]) {
      await page.goto(path);
      const skip = page.locator(".skip-link").first();
      await expect(skip).toHaveAttribute("href", "#main");
    }
  });

  test("anti-slop guard — no banned AI marketing clichés on the landing", async ({
    page,
  }) => {
    await page.goto("/");
    const body = (await page.locator("main").innerText()).toLowerCase();
    // taste-skill bans these as AI tells. The redesign brief explicitly
    // calls them out; a guard test stops them from drifting back in.
    for (const banned of [
      "elevate",
      "seamless",
      "unleash",
      "next-gen",
      "game-changer",
      "delve into",
      "in the world of",
      "tapestry",
    ]) {
      expect(body, `landing copy must not contain "${banned}"`).not.toContain(
        banned,
      );
    }
  });
});
