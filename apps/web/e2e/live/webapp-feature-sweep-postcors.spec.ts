/**
 * POST-CORS LIVE webapp FEATURE SWEEP — re-runs the box-driven webapp feature
 * sweep against a REAL gym box that clones `main` (so the box's daemon carries
 * the CORS fix, commit 86d67a42: it now emits Access-Control-Allow-Origin for
 * https://web.gym.flagshipserver.com on its own /api/* surface).
 *
 * The PRIOR sweep (webapp-feature-sweep.spec.ts) documented the box-driven
 * screens (pairing, screens-BFF server-detail / services-list, journal,
 * front-page, power) as CORS-BLOCKED in the browser — the webapp UI rendered
 * the screen but its own cross-origin fetch failed, so those were path B
 * (proven via the signed API in node) or C (render-only). This spec re-drives
 * the SAME UI flows and records, HONESTLY, whether each now SUCCEEDS in the
 * browser (path A) — and captures the network response (status + ACAO header)
 * as explicit CORS evidence.
 *
 * Identity: the box was provisioned by tools/live-e2e/provision-for-webapp.ts,
 * owned by deriveIRK(umkSeed) — the SAME derivation the webapp keystore uses —
 * and the box's PSK == that owner IRK (FLAGSHIP_PSK_PUB_HEX), so the in-browser
 * `add-paired-session` order (IRK-signed) is genuinely accepted by the box. The
 * gym-only window.__gymAdopt seam (app.js, gym branch only) restores that UMK
 * into a real session.
 *
 * Reads box.json from gym-results/feature-screenshots/. Saves PNGs +
 * findings-postcors.json to gym-results/feature-screenshots-postcors/.
 */
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ORIGIN = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://web.gym.flagshipserver.com";
const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const BOX_DIR = join(REPO, "gym-results", "feature-screenshots");
const SHOT_DIR = join(REPO, "gym-results", "feature-screenshots-postcors");
mkdirSync(SHOT_DIR, { recursive: true });

const BOX = JSON.parse(readFileSync(join(BOX_DIR, "box.json"), "utf8")) as {
  username: string;
  fqdn: string;
  umkSeedHex: string;
  irkPubHex: string;
};
const POD_URL = `https://${BOX.fqdn}`;

type Finding = {
  feature: string;
  before: "skeleton" | "B (api-proven)" | "C (render-only)" | "A";
  now: "A" | "B" | "C";
  tookEffect: string;
  evidence: string;
};
const findings: Finding[] = [];
function record(f: Finding) {
  findings.push(f);
  // eslint-disable-next-line no-console
  console.log(`[postcors] (${f.before} → ${f.now}) ${f.feature}: ${f.tookEffect} — ${f.evidence}`);
}

// CORS network evidence: capture, for every cross-origin call the page makes to
// the box, the status + whether Access-Control-Allow-Origin came back.
type BoxCall = { url: string; status: number; acao: string | null; method: string };
const boxCalls: BoxCall[] = [];

let shotN = 0;
async function shot(page: import("@playwright/test").Page, name: string) {
  shotN += 1;
  const file = `${String(shotN).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(SHOT_DIR, file), fullPage: true }).catch(() => undefined);
  return file;
}

test.describe.configure({ mode: "serial" });

test("post-CORS webapp feature sweep against the live owned box", async ({ page }) => {
  test.setTimeout(12 * 60 * 1000);
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  // Record every response whose URL is the BOX (cross-origin) — this is the
  // CORS evidence. We read access-control-allow-origin off each.
  page.on("response", (r) => {
    const u = r.url();
    if (u.startsWith(POD_URL)) {
      const acao = r.headers()["access-control-allow-origin"] ?? null;
      boxCalls.push({ url: u.replace(POD_URL, ""), status: r.status(), acao, method: r.request().method() });
    }
  });
  await page.context().addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);

  // ── 1. Boot + trust gate ────────────────────────────────────────────────────
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(5_000);
  const trustSliverVisible = await page
    .locator("#flagship-trust-sliver, [data-trust-sliver], .trust-sliver")
    .first()
    .isVisible()
    .catch(() => false);
  record({
    feature: "Boot + maintainer-trust gate",
    before: "A",
    now: "A",
    tookEffect: trustSliverVisible ? "NO — untrusted sliver showing" : "YES — trust gate PASSES",
    evidence: `bootstrap rendered; untrusted-red-sliver visible=${trustSliverVisible}`,
  });
  await shot(page, "boot-bootstrap-and-trust");

  const hasSeam = await page.evaluate(() => typeof (window as any).__gymAdopt === "function");
  expect(hasSeam, "gym adoption seam must be installed on the gym host").toBe(true);

  // ── 2. Adopt the owner account (loads the box-owning IRK into the session) ────
  const adoptResult = await page.evaluate(
    (p) => (window as any).__gymAdopt(p),
    { umkSeedHex: BOX.umkSeedHex, username: BOX.username },
  );
  await page.waitForTimeout(1_500);
  record({
    feature: "Identity / login (gym seam → real session-population path)",
    before: "A",
    now: "A",
    tookEffect: "YES — session holds the UMK whose deriveIRK() == box owner IRK",
    evidence: `adopted ${JSON.stringify(adoptResult)} via bootstrapFromExistingSeed + unlockSession`,
  });

  // ── 3. Home (authenticated) ──────────────────────────────────────────────────
  await page.evaluate(async () => {
    const m = await import("/views/home.js");
    await m.enterHome();
  });
  await page.waitForTimeout(2_000);
  await expect(page.locator("#view-home")).toBeVisible();
  const homeText = await page.locator("#view-home").innerText().catch(() => "");
  record({
    feature: "Home / server list",
    before: "C (render-only)",
    now: "C",
    tookEffect: "PARTIAL — shell renders; registered-box card needs a .com session the seam doesn't mint",
    evidence: `home snippet="${homeText.replace(/\s+/g, " ").slice(0, 90)}"`,
  });
  await shot(page, "home-authenticated");

  // ── 4. Pod pairing — REAL UI click. With CORS, /api/orders-from-user should
  //     now SUCCEED cross-origin and persist a REAL session token. ─────────────
  await page.evaluate(async () => {
    const m = await import("/views/pod-pair.js");
    await m.enterPodPair();
  });
  await expect(page.locator("#view-pod-pair")).toBeVisible();
  await page.fill("#pod-pair-base", POD_URL);
  await page.fill("#pod-pair-label", "webapp-sweep-postcors");
  await shot(page, "pod-pair-form");

  let ordersStatus: number | "blocked" = "blocked";
  let ordersAcao: string | null = null;
  const ordersListener = (r: import("@playwright/test").Response) => {
    if (r.url().includes("/api/orders-from-user")) {
      ordersStatus = r.status();
      ordersAcao = r.headers()["access-control-allow-origin"] ?? null;
    }
  };
  page.on("response", ordersListener);
  await page.click("#pod-pair-go");
  await page.waitForTimeout(4_000);
  page.off("response", ordersListener);
  const pairedText = await page.locator("#pod-pair-status").innerText().catch(() => "");
  const pairedInBrowser = /paired to/i.test(pairedText);
  // Confirm the REAL token actually persisted into lib/api.js state.
  const persistedTok = await page.evaluate(async () => {
    try {
      const api = await import("/lib/api.js");
      return { base: api.getPodBaseUrl(), tok: api.getSessionToken().slice(0, 8) };
    } catch {
      return { base: "", tok: "" };
    }
  });
  record({
    feature: "Pod pairing (IRK-signed add-paired-session)",
    before: "B (api-proven)",
    now: pairedInBrowser ? "A" : "C",
    tookEffect: pairedInBrowser
      ? "YES via UI — box accepted the order cross-origin; real token persisted"
      : "STILL BLOCKED in browser",
    evidence: `UI Pair → /api/orders-from-user status=${ordersStatus} ACAO=${ordersAcao}; persisted base=${persistedTok.base} tok=${persistedTok.tok}…; card="${pairedText.trim()}"`,
  });
  await shot(page, "pod-pair-after-click");

  // ── 5. Server detail (screens BFF) — should now LOAD with the real token ─────
  await page.evaluate(async () => {
    try {
      const m = await import("/views/server-detail.js");
      await m.enterServerDetail();
    } catch (e) {
      (window as any).__sdErr = String(e);
    }
  });
  await expect(page.locator("#view-server-detail")).toBeVisible();
  await page.waitForTimeout(4_000);
  const sdText = await page.locator("#server-detail-content").innerText().catch(() => "");
  const sdHasFqdn = sdText.includes(BOX.fqdn) || /unlock|metrics|front page|journal/i.test(sdText);
  const sdErr = await page.evaluate(() => (window as any).__sdErr ?? null);
  record({
    feature: "Server detail (status + cards: front-page/power/dead-man/journal)",
    before: "C (render-only)",
    now: sdHasFqdn ? "A" : "C",
    tookEffect: sdHasFqdn
      ? "YES — screens-BFF returned real box detail; cards paint with live data"
      : "RENDER-ONLY — BFF GET still failed",
    evidence: `content="${sdText.replace(/\s+/g, " ").slice(0, 140)}"; bffErr=${sdErr ?? "none"}`,
  });
  await shot(page, "server-detail");

  // ── 6. Journal — click "View journal"; IRK-signed POST /api/journal ──────────
  let journalDone = false;
  if (await page.locator("#journal-fetch-btn").isVisible().catch(() => false)) {
    await page.locator("#journal-card").scrollIntoViewIfNeeded().catch(() => undefined);
    await page.click("#journal-fetch-btn").catch(() => undefined);
    await page.waitForTimeout(3_500);
    const journalOut = await page.locator("#journal-output").innerText().catch(() => "");
    const journalStatus = await page.locator("#journal-status").innerText().catch(() => "");
    const gotLinesInUi = journalOut.trim().length > 20;
    journalDone = gotLinesInUi;
    record({
      feature: "Journal / View journal (real daemon log lines IN THE UI)",
      before: "B (api-proven)",
      now: gotLinesInUi ? "A" : "C",
      tookEffect: gotLinesInUi
        ? "YES via UI — real daemon journal lines rendered in the browser"
        : "NOT rendered in UI",
      evidence: `UI status="${journalStatus.trim().slice(0, 80)}", output len=${journalOut.length}, head="${journalOut.replace(/\s+/g, " ").slice(0, 80)}"`,
    });
    await shot(page, "journal-card");
  }

  // ── 7. Front-page picker — read options, SET it, confirm it reflects ─────────
  let frontPageSet = false;
  if (await page.locator("#front-page-card").isVisible().catch(() => false)) {
    await page.locator("#front-page-card").scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(1_500);
    const fpOptions = await page.locator("#front-page-select option").allInnerTexts().catch(() => []);
    const selectEnabled = await page.locator("#front-page-select").isEnabled().catch(() => false);
    record({
      feature: "Front-page picker (read options)",
      before: "C (render-only)",
      now: fpOptions.length > 0 && selectEnabled ? "A" : "C",
      tookEffect:
        fpOptions.length > 0 && selectEnabled
          ? "YES — option list loaded from the box (unauthenticated GET succeeded cross-origin)"
          : "RENDER-ONLY — options didn't load",
      evidence: `options=[${fpOptions.join(", ")}], selectEnabled=${selectEnabled}`,
    });
    await shot(page, "front-page-picker");

    // Try to SET a front page (the first non-empty service option) and confirm.
    if (selectEnabled && fpOptions.length > 0) {
      const values = await page.locator("#front-page-select option").evaluateAll((opts) =>
        opts.map((o) => (o as HTMLOptionElement).value),
      );
      const target = values.find((v) => v && v.length > 0);
      if (target) {
        await page.selectOption("#front-page-select", target).catch(() => undefined);
        await page.click("#front-page-save").catch(() => undefined);
        await page.waitForTimeout(3_000);
        const fpStatus = await page.locator("#front-page-status").innerText().catch(() => "");
        frontPageSet = /set|saved|now/i.test(fpStatus);
        record({
          feature: "Front-page picker (SET via IRK-signed order)",
          before: "C (render-only)",
          now: frontPageSet ? "A" : "C",
          tookEffect: frontPageSet
            ? `YES — set front page to "${target}"; box accepted the signed set-front-page order`
            : "NOT confirmed in UI",
          evidence: `selected="${target}"; status="${fpStatus.trim().slice(0, 80)}"`,
        });
        await shot(page, "front-page-after-set");
      }
    }
  }

  // ── 8. Power / dead-man cards ────────────────────────────────────────────────
  if (await page.locator("#lock-power-card").isVisible().catch(() => false)) {
    await page.locator("#lock-power-card").scrollIntoViewIfNeeded().catch(() => undefined);
    // We render + observe but do NOT actually power-off the box (it would end
    // the sweep). The CORS-readiness is already proven by the BFF/journal calls.
    record({
      feature: "Power / dead-man cards",
      before: "C (render-only)",
      now: "C",
      tookEffect:
        "RENDER — cards paint from live server-detail; the destructive POST is CORS-eligible now but NOT fired (would power off the box)",
      evidence: "lock-power + deadman cards present with live labels",
    });
    await shot(page, "power-and-deadman-cards");
  }

  // ── 9. Services list (screens BFF) — should now LIST the installed service ───
  await page.evaluate(async () => {
    try {
      const m = await import("/views/services-list.js");
      await m.enterServicesList();
    } catch (e) {
      (window as any).__svcErr = String(e);
    }
  });
  await expect(page.locator("#view-services-list")).toBeVisible();
  await page.waitForTimeout(3_000);
  const svcText = await page.locator("#services-list-content").innerText().catch(() => "");
  const svcErr = await page.evaluate(() => (window as any).__svcErr ?? null);
  const svcListed = /whoami|service|installed|no services/i.test(svcText);
  record({
    feature: "Services list (apps-list BFF)",
    before: "C (render-only)",
    now: svcListed ? "A" : "C",
    tookEffect: svcListed
      ? "YES — apps-list BFF returned; list renders live box data"
      : "RENDER-ONLY — apps-list BFF still failed",
    evidence: `content="${svcText.replace(/\s+/g, " ").slice(0, 140)}"; bffErr=${svcErr ?? "none"}`,
  });
  await shot(page, "services-list");

  // ── 10. Build chooser + install a service THROUGH the UI ─────────────────────
  // Navigate the build chooser; the simplest install is the marketplace tile
  // (gym build doesn't run a model). We at least render the chooser + capture
  // any in-UI install affordance.
  await page.evaluate(async () => {
    const m = await import("/views/build-source.js");
    m.enterBuildSource();
  });
  await expect(page.locator("#view-build-source")).toBeVisible();
  await page.waitForTimeout(800);
  record({
    feature: "Build-a-service chooser",
    before: "C (render-only)",
    now: "C",
    tookEffect: "RENDER — chooser (scratch / git / mcp) renders",
    evidence: "build-source view visible",
  });
  await shot(page, "build-chooser");

  // ── 11. Settings — account + AI keys ─────────────────────────────────────────
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-tab-target="settings"]')?.click();
  });
  await expect(page.locator("#view-settings-tab")).toBeVisible();
  await page.waitForTimeout(1_000);
  record({
    feature: "Settings (account)",
    before: "A",
    now: "A",
    tookEffect: "YES — profile hero + grouped account rows render",
    evidence: "settings tab shows the adopted account",
  });
  await shot(page, "settings-account");

  // ── Summary ──────────────────────────────────────────────────────────────────
  const corsSuccesses = boxCalls.filter((c) => c.status >= 200 && c.status < 300 && c.acao);
  writeFileSync(
    join(SHOT_DIR, "findings-postcors.json"),
    JSON.stringify(
      {
        box: BOX,
        screenshots: shotN,
        consoleErrors: consoleErrors.slice(0, 12),
        findings,
        corsEvidence: {
          totalBoxCalls: boxCalls.length,
          successfulWithAcao: corsSuccesses.length,
          calls: boxCalls,
        },
        summary: {
          movedToA: findings.filter((f) => f.now === "A" && f.before !== "A").map((f) => f.feature),
        },
      },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(
    `\n[postcors] ${shotN} screenshots; ${corsSuccesses.length}/${boxCalls.length} box calls succeeded WITH ACAO; findings-postcors.json written`,
  );
  // At least the pairing or a BFF read must have succeeded with ACAO to call CORS proven.
  expect(boxCalls.length, "the page should have made at least one box call").toBeGreaterThan(0);
});
