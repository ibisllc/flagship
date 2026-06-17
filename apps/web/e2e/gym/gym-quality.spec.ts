/**
 * GYM webapp D7-QUALITY scenarios (§6 D7, §7-B/D/E) — the AUTOMATABLE Layer-1
 * quality gates, distinct from the feature-flow specs (gym-smoke / gym-total)
 * and from the ADVISORY AI judge (ai/byokSeam.ts, never a gate). Three sweeps,
 * all DETERMINISTIC pass/fail:
 *
 *   - token-conformance (D7-beautiful, the pass/fail half): the rendered palette
 *     matches the brand tokens — TEAL accent (--teal #14B8A6 / --teal-bright
 *     #2DD4BF) resolving from --accent; a warm canvas (banned: pure #000/#FFF);
 *     the Geist brand font stack; and — the load-bearing assertion — NO element
 *     anywhere in the booted shell computes the LEGACY blue #3B5BFF.
 *   - nav-graph (D7-understandable): from Home, every one of the 4 tab targets
 *     reaches a KNOWN view (no orphan / dead-end / unreachable route), and the
 *     back edge (re-selecting Home) returns cleanly.
 *   - dead-control sweep (D7-usable): on a representative rendered screen (the
 *     build chooser), every VISIBLE interactive control is addressable (has an
 *     id) and visible + enabled — no dead/unlabeled control.
 *
 * NO BACKEND, by construction (same static-server posture as the other gym
 * specs — every /api/* is a hard 404). Handles reuse the EXISTING webapp id
 * convention (§8). Each `test(...)` title is the grep token the gym web adapter
 * selects on via `scenario.harness`, so every title is UNIQUE and anchored. The
 * verdict is the assertions (Layer 1, §2.1); screenshots ride along for the
 * advisory judge but never decide pass/fail.
 *
 * Registered in tools/gym/src/suites/quality.ts (surface "web", tier "total",
 * dimension "D7"). Lives in its OWN spec file so it never collides with the
 * feature-flow specs; the gym config's testMatch is widened to include it.
 */

import { test, expect, type Page } from "@playwright/test";

/** A passphrase that satisfies the bootstrap 8+ rule. */
const PASSPHRASE = "correct-horse-battery-staple-gym";

async function shot(page: Page, testInfo: import("@playwright/test").TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

async function coldLaunch(page: Page): Promise<void> {
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
}

async function generateIdentity(page: Page): Promise<void> {
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
}

/**
 * Reach a logged-in shell view with NO backend, via the proven S1 path:
 * bootstrap (mint identity → wrapped UMK to IndexedDB) → RELOAD with
 * `?view=<alias>` → unlock with the passphrase → land on the target view.
 */
async function reachShell(page: Page, viewAlias: string): Promise<void> {
  await coldLaunch(page);
  await generateIdentity(page);
  await expect(page.locator("#view-wizard")).toBeVisible({ timeout: 10_000 });
  await page.goto(`/index.html?view=${viewAlias}`);
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
}

/** Parse a CSS color string into normalized {r,g,b}, or null if not an rgb()/rgba(). */
function parseRgb(value: string): { r: number; g: number; b: number } | null {
  const m = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!m) return null;
  return { r: Math.round(Number(m[1])), g: Math.round(Number(m[2])), b: Math.round(Number(m[3])) };
}

/** #3B5BFF — the banned legacy Flagship blue. */
const LEGACY_BLUE = { r: 0x3b, g: 0x5b, b: 0xff };
/** --teal #14B8A6 (and --teal-bright #2DD4BF) — the only brand accent allowed. */
const TEAL = { r: 0x14, g: 0xb8, b: 0xa6 };
const TEAL_BRIGHT = { r: 0x2d, g: 0xd4, b: 0xbf };

function sameRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

test.describe("gym webapp quality", () => {
  // ─── D7-beautiful (token conformance — pass/fail half) ───────────────────

  test("gym quality token-conformance brand palette fonts and no legacy blue", async ({ page }, testInfo) => {
    await coldLaunch(page);

    // 1. The brand TOKENS resolve to the teal palette + the Geist font stack,
    //    on a WARM canvas (never pure #000 / #FFF — both banned, design-system §2).
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const read = (name: string) => cs.getPropertyValue(name).trim().toLowerCase();
      return {
        accent: read("--accent"),
        teal: read("--teal"),
        tealBright: read("--teal-bright"),
        canvas: read("--canvas"),
        fontSans: read("--font-sans"),
        // The body's RESOLVED font + background, as the browser computes them.
        renderedBodyFont: body.fontFamily.toLowerCase(),
        renderedBodyBg: body.backgroundColor.toLowerCase(),
      };
    });

    // The brand accent IS teal — assert the literal token values.
    expect(tokens.teal).toBe("#14b8a6");
    expect(tokens.tealBright).toBe("#2dd4bf");
    // --accent is the legacy alias → it must resolve to the teal (var or literal).
    expect(tokens.accent).not.toBe("");
    expect(tokens.accent).not.toContain("3b5bff"); // legacy blue is gone from the accent
    // The canvas must not be pure black or pure white (banned), and not the old
    // pure-black `#0a0a0a` identity from a previous palette.
    expect(tokens.canvas).not.toBe("#000000");
    expect(tokens.canvas).not.toBe("#000");
    expect(tokens.canvas).not.toBe("#ffffff");
    expect(tokens.canvas).not.toBe("#fff");
    expect(tokens.canvas).not.toBe("#0a0a0a");
    // The brand font stack is Geist, and the body actually renders it.
    expect(tokens.fontSans).toContain("geist");
    expect(tokens.renderedBodyFont).toContain("geist");
    // The rendered body background is a real color (not transparent) and not pure black/white.
    const bodyBg = parseRgb(tokens.renderedBodyBg);
    expect(bodyBg).not.toBeNull();
    expect(sameRgb(bodyBg!, { r: 0, g: 0, b: 0 })).toBe(false);
    expect(sameRgb(bodyBg!, { r: 255, g: 255, b: 255 })).toBe(false);

    // 2. The LOAD-BEARING gate: NO element anywhere in the booted shell computes
    //    the legacy blue #3B5BFF on any color-bearing property. We sweep every
    //    element's computed color / background / border / outline / fill / stroke.
    const offenders = await page.evaluate((blue: { r: number; g: number; b: number }) => {
      const toRgb = (v: string): { r: number; g: number; b: number } | null => {
        const m = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        if (!m) return null;
        return { r: Math.round(Number(m[1])), g: Math.round(Number(m[2])), b: Math.round(Number(m[3])) };
      };
      const PROPS = ["color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "outlineColor", "fill", "stroke"];
      const hits: string[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const cs = getComputedStyle(el as Element);
        for (const p of PROPS) {
          const rgb = toRgb((cs as unknown as Record<string, string>)[p] ?? "");
          if (rgb && rgb.r === blue.r && rgb.g === blue.g && rgb.b === blue.b) {
            const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
            hits.push(`${(el as Element).tagName.toLowerCase()}${id}.${p}`);
            break;
          }
        }
        if (hits.length >= 10) break;
      }
      return hits;
    }, LEGACY_BLUE);
    expect(offenders, `legacy blue #3B5BFF found on: ${offenders.join(", ")}`).toEqual([]);

    await shot(page, testInfo, "token-conformance");
  });

  // ─── D7-understandable (nav-graph — no orphan / dead-end routes) ──────────

  test("gym quality nav-graph reaches each tab and returns home", async ({ page }, testInfo) => {
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

    // Each of the 4 tab targets must reach a KNOWN view (no orphan/dead-end),
    // and Home must be reachable again after each (the back edge works).
    const tabs: { target: string; view: string }[] = [
      { target: "settings", view: "#view-settings-tab" },
      { target: "activity", view: "#view-activity" },
      { target: "apps", view: "#view-services-list" },
      { target: "home", view: "#view-home" },
    ];
    for (const { target, view } of tabs) {
      await page.click(`[data-tab-target="${target}"]`);
      await expect(page.locator(view), `tab "${target}" must render ${view}`).toBeVisible({ timeout: 10_000 });
      // Return to Home and confirm it renders — every push has a working back edge.
      await page.click('[data-tab-target="home"]');
      await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    }
    await shot(page, testInfo, "nav-graph");
  });

  // ─── D7-usable (dead-control sweep — every visible control is addressable) ─

  test("gym quality dead-control sweep on the build chooser", async ({ page }, testInfo) => {
    // The build chooser is a tight, deterministic, backendless surface: 3 source
    // tiles + a journal link + a back button, all unconditionally rendered.
    await reachShell(page, "home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await page.click('[data-tab-target="apps"]');
    await expect(page.locator("#view-services-list")).toBeVisible();
    await page.click("#services-list-open-vibe-code");
    await expect(page.locator("#view-build-source")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "dead-control-target");

    // Enumerate every VISIBLE interactive control inside the chooser and assert
    // each is addressable (has an id) and visible + enabled — no dead/unlabeled
    // control. Scoped to the rendered view container so this stays deterministic.
    const controls = page.locator(
      "#view-build-source button, #view-build-source a, #view-build-source input, #view-build-source select, #view-build-source [role='button']",
    );
    const count = await controls.count();
    // Sanity floor: the chooser's known controls (3 tiles + journal link + back)
    // must all be present — guards against an empty/blank render passing vacuously.
    expect(count).toBeGreaterThanOrEqual(5);

    const unaddressable: string[] = [];
    for (let i = 0; i < count; i++) {
      const c = controls.nth(i);
      if (!(await c.isVisible())) continue; // only sweep what the user can see
      const id = await c.getAttribute("id");
      const tag = await c.evaluate((el) => el.tagName.toLowerCase());
      const text = ((await c.textContent()) ?? "").trim().slice(0, 30);
      if (!id || id.trim().length === 0) {
        unaddressable.push(`${tag}["${text}"] (no id)`);
        continue;
      }
      // An addressable control must be enabled (a dead/disabled control on a
      // freshly-rendered chooser would be a defect — nothing here gates on state).
      await expect(c, `control #${id} must be enabled`).toBeEnabled();
    }
    expect(unaddressable, `unaddressable controls: ${unaddressable.join(", ")}`).toEqual([]);

    // Spot-check the named load-bearing controls are addressable by id.
    for (const id of ["#build-src-scratch", "#build-src-git", "#build-src-mcp", "#build-source-back"]) {
      await expect(page.locator(id)).toBeVisible();
    }
    await shot(page, testInfo, "dead-control-swept");
  });
});
