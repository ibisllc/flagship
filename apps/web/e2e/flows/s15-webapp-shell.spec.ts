/**
 * S15 — webapp PWA shell visuals.
 *
 * Verifies the webapp shares the brand DNA with the marketing site
 * (Geist + Geist Mono + Instrument Serif, single signal-amber accent)
 * while running on the paired-ink surface that suits an app shell.
 *
 * Behavioral coverage of the views themselves lives in S1–S13. This
 * spec only checks the chrome — header pill, button paradigm, label
 * mono-treatment, manifest, theme-color — to catch a brand regression
 * even if every existing behavioral spec passes.
 */

import { test, expect } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-shell-test";

test.describe("S15 — webapp brand DNA", () => {
  test("webapp loads with paired-ink palette + amber accent", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#view-bootstrap")).toBeVisible();

    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        canvas: cs.getPropertyValue("--canvas").trim(),
        ink: cs.getPropertyValue("--ink").trim(),
        accent: cs.getPropertyValue("--accent").trim(),
        fontSans: cs.getPropertyValue("--font-sans").trim(),
        fontDisplay: cs.getPropertyValue("--font-display").trim(),
        fontMono: cs.getPropertyValue("--font-mono").trim(),
        renderedBody: body.fontFamily,
      };
    });

    // Paired-ink canvas (warm off-black, not pure #0a0a0a from the old
    // identity).
    expect(tokens.canvas.toLowerCase()).not.toContain("#0a0a0a");
    // Accent is signal-amber (the marketing-surface uses the deep
    // #B26016, the webapp uses the lighter #D38347 since it sits on
    // an ink background — but both belong to the same hue family
    // and the OLD palette greens are gone).
    expect(tokens.accent.toLowerCase()).not.toContain("4ad295");
    expect(tokens.accent.toLowerCase()).not.toContain("3b5bff");
    expect(tokens.accent).not.toBe("");
    // Geist must appear in the body's resolved fontFamily.
    expect(tokens.fontSans.toLowerCase()).toContain("geist");
    expect(tokens.renderedBody.toLowerCase()).toContain("geist");
    expect(tokens.fontMono.toLowerCase()).toContain("mono");
    expect(tokens.fontDisplay.toLowerCase()).toContain("instrument");
  });

  test("webapp header carries the editorial display-serif title", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    const header = page.locator("header h1#title");
    await expect(header).toContainText("Flagship");
    // The header h1 resolves to the display-serif stack (via the new
    // /style.css). We don't pin to an exact font-family string —
    // Chromium may rewrite the stack — but we check the resolved
    // family starts with Instrument Serif.
    const fontFamily = await header.evaluate((el) =>
      getComputedStyle(el).fontFamily.toLowerCase(),
    );
    expect(fontFamily).toContain("instrument");
  });

  test("webapp manifest carries the paired-ink theme-color + new icons", async ({
    request,
    page,
  }) => {
    await page.goto("/");
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBeTruthy();
    const r = await request.get((manifestHref ?? "/manifest.json").startsWith("http")
      ? manifestHref!
      : `${page.url().replace(/\/$/, "")}${manifestHref}`);
    expect(r.status()).toBe(200);
    const manifest = await r.json();
    // theme + background match the new ink canvas, not the old #0a0a0a.
    expect(manifest.theme_color.toLowerCase()).toBe("#14120d");
    expect(manifest.background_color.toLowerCase()).toBe("#14120d");
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    // Categories field added in the revamp.
    expect(manifest.categories).toContain("productivity");
  });

  test("webapp head pins theme-color + apple-touch-icon to the new identity", async ({
    page,
  }) => {
    await page.goto("/");
    const themeColor = await page
      .locator('meta[name="theme-color"]')
      .first()
      .getAttribute("content");
    expect((themeColor ?? "").toLowerCase()).toBe("#14120d");
    const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    expect(appleIcon).toBeTruthy();
    // Webapp serves its own /icon.svg at the root (the host-rewrite on
    // web.flagshipserver.com maps /icon.svg to apps/web/public/webapp/icon.svg).
    expect(appleIcon).toMatch(/icon\.svg$/);
  });

  test("webapp /icon.svg is the unified rounded-square mark", async ({ request, page }) => {
    await page.goto("/");
    // Discover the icon URL from the document so we hit the same host
    // rewrite the browser sees.
    const iconHref = await page
      .locator('link[rel="icon"]')
      .first()
      .getAttribute("href");
    expect(iconHref).toBeTruthy();
    const r = await request.get(
      iconHref!.startsWith("http")
        ? iconHref!
        : `${page.url().replace(/\/$/, "")}${iconHref}`,
    );
    expect(r.status()).toBe(200);
    const body = await r.text();
    // The unified brand mark — a rounded square containing a circle, in
    // the app-logo colorway (teal ground + white disc). Same mark the
    // installed app icon uses.
    expect(body).toContain("#14B8A6"); // brand teal ground
    expect(body).toContain("#FFFFFF"); // white disc
    expect(body).toContain("<circle");
    // The old flag-on-mast pennant (amber flag + ivory caps + mast) is gone.
    expect(body).not.toMatch(/#D38347/i);
    expect(body).not.toContain("<line");
    expect(body).not.toMatch(/#4ad295/i);
  });

  test("bootstrap card uses the refined .card primitive (not generic black box)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#view-bootstrap")).toBeVisible();
    const firstCard = page.locator("#view-bootstrap .card").first();
    const styles = await firstCard.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        border: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
      };
    });
    // The new .card has a 1px hairline border + non-zero radius —
    // catches a regression where the design system fails to load and
    // browser defaults take over.
    expect(styles.border).toBe("1px");
    expect(parseFloat(styles.radius)).toBeGreaterThan(0);
    // It's a tinted surface, not pure black. We just check it isn't
    // rgb(0, 0, 0) — the rendered hex varies with the ink palette.
    expect(styles.background).not.toBe("rgb(0, 0, 0)");
  });

  test("primary CTA renders as a pill with accent-on background", async ({
    page,
  }) => {
    await page.goto("/");
    const btn = page.locator("#bootstrap-go");
    await expect(btn).toBeVisible();
    const styles = await btn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        radius: cs.borderTopLeftRadius,
        background: cs.backgroundColor,
        fontFamily: cs.fontFamily,
      };
    });
    // Pill (>= 22px radius means it's effectively round-capped).
    expect(parseFloat(styles.radius)).toBeGreaterThan(20);
    // Background is the brand ink shade (the new buttons land on the
    // ink color in the webapp). Not browser default light-gray.
    expect(styles.background).not.toBe("rgb(239, 239, 239)");
    expect(styles.fontFamily.toLowerCase()).toContain("geist");
  });

  test("section labels render in uppercase mono (label discipline)", async ({
    page,
    podSim,
  }) => {
    await page.goto("/");
    await page.fill("#bootstrap-passphrase", PASSPHRASE);
    await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
    await page.click("#bootstrap-go");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

    // Section h2 elements ("Identity", "Servers", "Session", etc.) all
    // resolve to the mono stack + uppercase per the new style.css.
    const h2 = page.locator("#view-home h2").first();
    const styles = await h2.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        fontFamily: cs.fontFamily.toLowerCase(),
        textTransform: cs.textTransform,
        letterSpacing: cs.letterSpacing,
      };
    });
    expect(styles.fontFamily).toContain("mono");
    expect(styles.textTransform).toBe("uppercase");
    expect(parseFloat(styles.letterSpacing)).toBeGreaterThan(0.5);

    // Keep podSim happy — fixture cleanup wants a referenced binding.
    void podSim;
  });
});
