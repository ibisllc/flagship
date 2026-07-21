/**
 * GYM webapp FEATURE-COVERAGE tranche — §6 rows for features that previously
 * had ZERO gym coverage: transfer-a-box (giver offer + acquirer claim), the
 * Box Request Inbox, the multi-pod switcher, the create-server Advanced
 * (one-shot pairing) toggles, and the Slice-D admin-tier client surfaces
 * (promote-a-device / rotate-admin-root / admin-root state).
 *
 * NO BACKEND, by construction — same posture as gym-total.spec.ts. The two
 * backendless seed techniques are reused verbatim:
 *
 *   1. CLIENT-SIDE STORE SEEDING — session/profile slots (username, sessionId,
 *      pod base URL, session token) and the Slice-D `session.adminRootSeed`
 *      gate are written through the served ES modules via `page.evaluate`.
 *      Crypto is REAL (WebCrypto Ed25519): the transfer-claim spec signs a
 *      genuine offer with the session IRK, and the box-inbox spec mints a real
 *      box STK + a genuinely-signed secret-request, so the client's own
 *      verification paths (verifyTransferOffer, fetchVerifiedRequests'
 *      STK re-verify) pass HONESTLY — nothing is bypassed.
 *   2. ROUTE-STUBBED reads — `/pods`, `/api/me/servers`, `/api/secret-requests`,
 *      the pod `apps-list`, and the one giver `transfer/offer` POST are
 *      intercepted with fixture bodies. Everything un-routed fails closed
 *      (same-origin 404s on the static server; foreign hosts are routed to 404
 *      by the specs that would otherwise touch them).
 *
 * The verdict is the assertions (Layer 1, §2.1). Every `test(...)` title is
 * the UNIQUE grep token the web adapter selects on via `scenario.harness`.
 * Handles are grepped from the real `apps/web/public/webapp` tree — never
 * invented. All destructive ceremonies STOP at their confirm stage (Cancel) —
 * nothing is revoked, rotated, transferred, or claimed.
 *
 * Registered in tools/gym/src/suites/web.ts (tier "total"); the gym config's
 * testMatch is widened to include this file (the gym-quality precedent).
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
  await page.click("#bootstrap-create");
  await expect(page.locator(".modal-title")).toHaveText("Create your account");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator(".modal-title")).toHaveText("Confirm passphrase");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });
}

/** Bootstrap → reload(?view=<alias>) → passphrase unlock (the proven S1 path). */
async function reachShell(page: Page, viewAlias: string): Promise<void> {
  await coldLaunch(page);
  await generateIdentity(page);
  await page.goto(`/index.html?view=${viewAlias}`);
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
}

/** Reach Home AND let dispatchInitialView settle (see gym-total.spec.ts). */
async function reachHome(page: Page): Promise<void> {
  await reachShell(page, "home");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(150);
}

/** Seed the active profile + username on both the store AND the live session
 *  (the same idiom the trusted-devices total spec uses). */
async function seedProfileUsername(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = await import("/lib/profilesStore.js");
    store.ensureProfile("smoketest");
    store.setActiveCloudName("smoketest");
    store.set("username", "smoketest");
    const { getSession } = await import("/lib/state.js");
    getSession().username = "smoketest";
  });
}

/** Additionally mark this device PAIRED: the per-profile sessionId slot Home
 *  reads (`recoveryStoreGet("sessionId")`) + the pod session token. */
async function seedPairedHome(page: Page): Promise<void> {
  await seedProfileUsername(page);
  await page.evaluate(async () => {
    const store = await import("/lib/profilesStore.js");
    store.set("sessionId", "gym-fixture-session-id");
    const api = await import("/lib/api.js");
    api.setSessionToken("gym-fixture-session-token");
  });
}

/** The seedPairedPod idiom from gym-total.spec.ts — a single scoped pod. */
const POD_BASE = "https://home.smoketest.flagship.services";
async function seedPairedPod(page: Page): Promise<void> {
  await page.evaluate(async (podBase) => {
    const [store, api] = await Promise.all([
      import("/lib/profilesStore.js"),
      import("/lib/api.js"),
    ]);
    store.ensureProfile("smoketest");
    store.setActiveCloudName("smoketest");
    api.setPodBaseUrl(podBase);
    api.setSessionToken("gym-fixture-session-token");
  }, POD_BASE);
}

/** Stub a JSON endpoint by URL substring on ANY host (the .com apex reads
 *  resolve to the prod literal under the gym's localhost origin, so routing on
 *  the path keeps every fixture read off the network + deterministic). */
async function routeAnyJson(page: Page, pathSubstring: string, body: unknown, status = 200): Promise<void> {
  await page.route(
    (url) => url.href.includes(pathSubstring),
    async (route) => {
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    },
  );
}

/** The minimal ServerDetailResponse the server-detail view renders from. */
function serverDetailBody(): Record<string, unknown> {
  const now = Date.now();
  return {
    serverFqdn: "home.smoketest.flagship.services",
    username: "smoketest",
    daemonVersion: "gym-fixture-1.0.0",
    uptimeMs: 3 * 86_400_000,
    certNotAfter: now + 60 * 86_400_000,
    certSans: ["home.smoketest.flagship.services", "*.home.smoketest.flagship.services"],
    serviceCount: 2,
    pairedSessionCount: 1,
    recentInstallEvents: [],
  };
}

test.describe("gym webapp features", () => {
  // ─── Transfer-a-box — the GIVER offer ceremony (server-detail entry) ──────

  test("gym total webapp transfer offer opens the giver ceremony and renders the code", async ({ page }, testInfo) => {
    // D1 (§4 transfer-a-box) — server-detail carries the "Transfer to another
    // account" entry; it opens the irreversible-warning dialog whose Create
    // button is GATED on typing the server's full name (what-you-see-is-what-
    // you-sign). The offer signing is real (session IRK via the Slice-D gated
    // signer); only the .com broker POST is stubbed. The rendered result is
    // the universal transfer link the acquirer pastes/scans.
    await reachHome(page);
    await seedPairedPod(page);
    await routeAnyJson(page, "/api/screens/server-detail", serverDetailBody());
    await routeAnyJson(page, "/transfer/offer", { ok: true });
    await page.evaluate(async () => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail();
    });
    await expect(page.locator("#transfer-card")).toBeVisible({ timeout: 10_000 });
    await page.click("#transfer-start-btn");
    const dlg = page.locator('dialog[aria-label="Transfer this server"]');
    await expect(dlg).toBeVisible({ timeout: 5_000 });
    // Severe gate: Create is disabled until the exact FQDN is typed.
    const go = dlg.locator("[data-transfer-go]");
    await expect(go).toBeDisabled();
    await dlg.locator("[data-transfer-confirm]").fill("wrong-name");
    await expect(go).toBeDisabled();
    await dlg.locator("[data-transfer-confirm]").fill("home.smoketest.flagship.services");
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "transfer-confirm-gate");
    // Create → the IRK-signed offer is deposited (stubbed 200) and the
    // paste-able universal link renders.
    await go.click();
    await expect(dlg.locator("[data-transfer-result]")).toBeVisible({ timeout: 10_000 });
    const link = await dlg.locator("[data-transfer-qr]").inputValue();
    expect(link).toContain("/transfer?o=");
    await shot(page, testInfo, "transfer-offer-code");
    await dlg.locator("[data-transfer-cancel]").click();
    await expect(dlg).toBeHidden({ timeout: 5_000 });
  });

  // ─── Transfer-a-box — the ACQUIRER take-over claim ────────────────────────

  test("gym total webapp take-over claim verifies an offer into the severe confirm", async ({ page }, testInfo) => {
    // D1 (§4 transfer-a-box, Slice C) — the standalone acquirer claim surface:
    // Home's "Take over" entry opens the paste/scan dialog; a pasted offer is
    // signature-verified (vs its own giverIrkPub) BEFORE the severe stage. We
    // sign a REAL offer in-page with the session IRK so verification passes
    // honestly, then assert the type-to-confirm gate; Cancel — no claim POSTs.
    await reachHome(page);
    await seedProfileUsername(page);
    await page.evaluate(async () => {
      const { renderHome } = await import("/views/home.js");
      await renderHome();
    });
    await expect(page.locator("#empty-take-over")).toBeVisible({ timeout: 10_000 });
    await page.click("#empty-take-over");
    const dlg = page.locator('dialog[aria-label="Take over a box"]');
    await expect(dlg).toBeVisible({ timeout: 5_000 });
    await expect(dlg.locator("[data-claim-input]")).toBeVisible();
    await shot(page, testInfo, "take-over-input");
    // A REAL signed offer (giver == this session's IRK; the verify path is the
    // same one an attacker-supplied paste runs).
    const offerJson = await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      const { canonicalOfferBytes } = await import("/lib/serverTransfer.js");
      const { signWithIrk, bytesToHex } = await import("/keystore.js");
      const s = getSession();
      const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      const offer = {
        serverDomain: "hali.giver.flagship.services",
        transferNonce: nonce,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 15 * 60_000,
      };
      const sig = await signWithIrk(s.umk, canonicalOfferBytes(offer));
      return JSON.stringify({
        v: 1,
        kind: "flagship-transfer-offer",
        ...offer,
        giverIrkPub: bytesToHex(s.irk.publicKey),
        offerSignature: bytesToHex(sig),
      });
    });
    await dlg.locator("[data-claim-input]").fill(offerJson);
    await dlg.locator("[data-claim-continue]").click();
    // Verified → the severe confirm stage names the box and gates "Take over"
    // on typing its full name.
    await expect(dlg.locator("[data-confirm-domain]")).toHaveText("hali.giver.flagship.services", { timeout: 10_000 });
    const go = dlg.locator("[data-confirm-go]");
    await expect(go).toBeDisabled();
    await dlg.locator("[data-confirm-input]").fill("hali.giver.flagship.services");
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "take-over-confirm");
    // Cancel — the claim is never signed/POSTed (non-destructive).
    await dlg.locator("[data-confirm-cancel]").click();
    await expect(dlg).toBeHidden({ timeout: 5_000 });
  });

  // ─── Box Request Inbox — the one-tap card + approve surface ──────────────

  test("gym total webapp box inbox surfaces a pending request and its approve card", async ({ page }, testInfo) => {
    // D5 (box-request-inbox) — a pod carrying a `pendingRequests` digest makes
    // its Home card read "waiting for approval" with the one-tap "Approve
    // unlock" affordance; tapping deep-links into the Box Request Inbox, whose
    // card is rendered ONLY after fetchVerifiedRequests RE-VERIFIES the box's
    // request signature against the directory STK. We mint a real STK and sign
    // the secret-request canonically in-page, so the verify chain passes
    // honestly (nothing stubbed but the relay reads).
    const FQDN = "hali.smoketest.flagship.services";
    await reachHome(page);
    await seedPairedHome(page);
    const fixture = await page.evaluate(async (fqdn) => {
      const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      const stkPubHex = toHex(rawPub);
      const nonceHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const issuedAt = Date.now();
      // flagship/secret-request/v1 canonical bytes (docs/box-request-inbox.md).
      const canonical = new TextEncoder().encode(
        ["flagship/secret-request/v1", fqdn, stkPubHex, "unlock-key", nonceHex, issuedAt].join("|"),
      );
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, canonical));
      return { stkPubHex, nonceHex, issuedAt, requestSignature: toHex(sig) };
    }, FQDN);
    await routeAnyJson(page, "/api/me/servers", { servers: [{ serverId: FQDN }] });
    await routeAnyJson(page, "/api/users/smoketest/pods", {
      pods: [
        {
          serverDomain: FQDN,
          identityPubKey: fixture.stkPubHex,
          registeredAt: Date.now() - 3_600_000,
          pendingRequests: [
            { id: fixture.nonceHex, type: "unlock-key", issuedAt: fixture.issuedAt, expiresAt: fixture.issuedAt + 600_000 },
          ],
        },
      ],
    });
    await routeAnyJson(page, "/api/secret-requests", {
      requests: [
        {
          serverDomain: FQDN,
          stkPub: fixture.stkPubHex,
          purpose: "unlock-key",
          requestNonceHex: fixture.nonceHex,
          requestSignature: fixture.requestSignature,
          issuedAt: fixture.issuedAt,
          deviceInfo: { ip: "192.168.1.20", os: "Debian" },
        },
      ],
    });
    await page.evaluate(async () => {
      const { renderHome } = await import("/views/home.js");
      await renderHome();
    });
    // The one-tap card: honest "waiting for approval" state + the affordance.
    const list = page.locator("#servers-list");
    await expect(list).toContainText(/waiting for approval/i, { timeout: 10_000 });
    const approveBtn = list.locator(".js-approve-unlock");
    await expect(approveBtn).toBeVisible();
    await shot(page, testInfo, "inbox-home-card");
    // Tap → the Box Request Inbox renders the STK-verified request card with
    // the approve affordance ("Yes, this is my box"). We do NOT approve — the
    // reply path needs a live boot worker (live slice).
    await approveBtn.click();
    await expect(page.locator("#view-boot-approval")).toBeVisible({ timeout: 10_000 });
    const card = page.locator(`[data-boot-request-id="${FQDN}#${fixture.nonceHex}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(FQDN);
    await expect(card.locator("[data-approve-id]")).toContainText(/yes, this is my box/i);
    await shot(page, testInfo, "inbox-approve-card");
  });

  // ─── Multi-pod — honest liveness + the PodSwitcher ────────────────────────

  test("gym total webapp pod switcher lists both pods with honest liveness and switches", async ({ page }, testInfo) => {
    // D5 (multi-pod-liveness) — with two pods seeded (one live, one
    // unreachable) Home renders the HONEST per-pod liveness labels, and the
    // Services-tab PodSwitcher lists "All servers" + both pods; tapping a pod
    // chip switches the active pod context (setPodBaseUrl), reflected in the
    // chip selection AND the live api slot.
    const ALPHA = "alpha.smoketest.flagship.services";
    const BETA = "beta.smoketest.flagship.services";
    await reachHome(page);
    await seedPairedHome(page);
    await routeAnyJson(page, "/api/me/servers", { servers: [{ serverId: ALPHA }, { serverId: BETA }] });
    await routeAnyJson(page, "/api/users/smoketest/pods", {
      pods: [
        {
          serverDomain: ALPHA,
          liveness: "live",
          lastReported: Date.now(),
          registeredAt: Date.now() - 86_400_000,
          currentCert: { validUntil: Date.now() + 60 * 86_400_000 },
        },
        {
          serverDomain: BETA,
          liveness: "unreachable",
          lastSeenMsAgo: 7_200_000,
          registeredAt: Date.now() - 86_400_000,
        },
      ],
    });
    // Keep the best-effort side reads off the network + deterministic.
    await routeAnyJson(page, "/api/secret-requests", { error: "gym" }, 404);
    await routeAnyJson(page, "/api/leads", { error: "gym" }, 404);
    await routeAnyJson(page, "/api/screens/apps-list", { apps: [] });
    await page.evaluate(async () => {
      const { renderHome } = await import("/views/home.js");
      await renderHome();
    });
    // Honest liveness on the Home cards: live → online, unreachable → offline
    // with the last-seen age (never a fake green).
    const alphaCard = page.locator("#servers-list .server-card", { hasText: "alpha" });
    const betaCard = page.locator("#servers-list .server-card", { hasText: "beta" });
    await expect(alphaCard).toContainText(/online/i, { timeout: 10_000 });
    await expect(betaCard).toContainText(/offline \(last seen/i);
    await shot(page, testInfo, "multi-pod-home-liveness");
    // Services tab → the PodSwitcher renders All servers + both pods, with
    // "All servers" selected (no single-pod scope yet).
    await page.click('[data-tab-target="apps"]');
    await expect(page.locator("#view-services-list")).toBeVisible({ timeout: 10_000 });
    const chips = page.locator(".pod-switcher .pod-switcher-chip");
    await expect(chips).toHaveCount(3, { timeout: 10_000 });
    await expect(chips.nth(0)).toHaveText(/All servers/);
    await expect(page.locator('.pod-switcher-chip.is-selected')).toHaveText(/All servers/);
    await shot(page, testInfo, "pod-switcher-all");
    // Switch to beta: the chip takes the teal selection AND the active pod
    // base URL now scopes to beta (the real context switch, not just CSS).
    await page.click(`[data-pod-switch="https://${BETA}"]`);
    await expect(page.locator(`[data-pod-switch="https://${BETA}"]`)).toHaveClass(/is-selected/, { timeout: 10_000 });
    const activeBase = await page.evaluate(async () => {
      const api = await import("/lib/api.js");
      return api.getPodBaseUrl();
    });
    expect(activeBase).toBe(`https://${BETA}`);
    await shot(page, testInfo, "pod-switcher-switched");
  });

  // ─── Create-server Advanced toggles (one-shot pairing security choices) ───

  test("gym total webapp create-server advanced toggles default off with the debug warning", async ({ page }, testInfo) => {
    // D4 (recipe-delivery / debug-access) — the two security choices baked
    // into the recipe at mint (embed-secrets, debug-friendly) live under the
    // Advanced toggle: hidden + OFF by default (production posture), each with
    // its warning copy; turning Advanced OFF resets both (a closed Advanced
    // section can never leave a secret-embedding or debug choice armed).
    await reachShell(page, "create-server");
    await expect(page.locator("#view-create-server")).toBeVisible({ timeout: 10_000 });
    const advanced = page.locator("#cs-advanced");
    await expect(advanced).toBeVisible();
    await expect(advanced).not.toBeChecked();
    await expect(page.locator("#cs-advanced-options")).toBeHidden();
    // Open Advanced → both toggles render, default OFF.
    await advanced.check();
    await expect(page.locator("#cs-advanced-options")).toBeVisible();
    await expect(page.locator("#cs-embed-secrets")).toBeVisible();
    await expect(page.locator("#cs-embed-secrets")).not.toBeChecked();
    await expect(page.locator("#cs-debug-friendly")).toBeVisible();
    await expect(page.locator("#cs-debug-friendly")).not.toBeChecked();
    // The debug-friendly warning copy (console-login consequence) renders.
    await expect(page.locator("#cs-debug-friendly-hint")).toContainText(/physical access/i);
    await expect(page.locator("#cs-embed-secrets-hint")).toContainText(/security keys directly in the recipe/i);
    await page.locator("#cs-debug-friendly").check();
    await shot(page, testInfo, "cs-advanced-open");
    // The reset rule: closing Advanced clears the armed debug choice…
    await advanced.uncheck();
    await expect(page.locator("#cs-advanced-options")).toBeHidden();
    // …so re-opening shows it OFF again (never a silently-armed debug box).
    await advanced.check();
    await expect(page.locator("#cs-debug-friendly")).not.toBeChecked();
    await expect(page.locator("#cs-embed-secrets")).not.toBeChecked();
    await shot(page, testInfo, "cs-advanced-reset");
  });

  // ─── Slice D — account-security admin-root state ──────────────────────────

  test("gym total webapp account-security shows the admin-root state", async ({ page }, testInfo) => {
    // D3 (device-admin-tier §5) — the Admin key card reports THIS device's
    // admin standing honestly: a non-admin device gets the explanatory
    // can't-rotate note (no button); a device holding the admin root gets the
    // revoke-semantic warning + the Rotate control. The gate is
    // session.adminRootSeed — exactly what unlockSession populates.
    await routeAnyJson(page, "/api/users/smoketest/pods", { pods: [] });
    await routeAnyJson(page, "/api/users/smoketest", { accountType: "single" });
    await reachHome(page);
    await seedProfileUsername(page);
    await page.click('[data-tab-target="settings"]');
    await expect(page.locator("#view-settings-tab")).toBeVisible();
    await page.click("#settings-tab-account-security");
    await expect(page.locator("#view-account-security")).toBeVisible({ timeout: 10_000 });
    // Non-admin device → the unavailable card, and NO rotate button.
    const unavailable = page.locator('[data-account-security-rotate="unavailable"]');
    await expect(unavailable).toBeVisible({ timeout: 10_000 });
    await expect(unavailable).toContainText(/isn't an admin device/i);
    await expect(page.locator("#account-security-rotate-admin")).toHaveCount(0);
    await shot(page, testInfo, "admin-root-non-admin");
    // Seed the admin root on the session (what an admin unlock does) and
    // re-render → the available card + the Rotate control.
    await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      getSession().adminRootSeed = crypto.getRandomValues(new Uint8Array(32));
      document.dispatchEvent(
        new CustomEvent("flagship:view-shown", { detail: { id: "view-account-security" } }),
      );
    });
    const available = page.locator('[data-account-security-rotate="available"]');
    await expect(available).toBeVisible({ timeout: 10_000 });
    await expect(available).toContainText(/REVOKES admin/);
    await expect(page.locator("#account-security-rotate-admin")).toBeVisible();
    await shot(page, testInfo, "admin-root-admin");
  });

  // ─── Slice D — the rotate-admin-root ceremony first screen ────────────────

  test("gym total webapp rotate admin key opens its warning ceremony", async ({ page }, testInfo) => {
    // D4 (device-admin-tier §5) — tapping Rotate opens the danger confirm
    // (the revoke-semantic warning, Continue/Cancel); we Cancel, so no
    // rotation envelope is ever signed/POSTed (non-destructive; the typed
    // ROTATE stage + the real rotation are the live slice).
    await routeAnyJson(page, "/api/users/smoketest/pods", { pods: [] });
    await routeAnyJson(page, "/api/users/smoketest", { accountType: "single" });
    await reachHome(page);
    await seedProfileUsername(page);
    await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      getSession().adminRootSeed = crypto.getRandomValues(new Uint8Array(32));
    });
    await page.click('[data-tab-target="settings"]');
    await expect(page.locator("#view-settings-tab")).toBeVisible();
    await page.click("#settings-tab-account-security");
    await expect(page.locator("#account-security-rotate-admin")).toBeVisible({ timeout: 10_000 });
    await page.click("#account-security-rotate-admin");
    // The ceremony first screen: title + the revoke-semantic warning + a
    // danger Continue.
    await expect(page.locator(".modal-title")).toHaveText("Rotate admin key?", { timeout: 5_000 });
    await expect(page.locator(".modal-message")).toContainText(/REVOKES admin/);
    await expect(page.locator("[data-modal-ok]")).toHaveText("Continue");
    await shot(page, testInfo, "rotate-admin-ceremony");
    // Cancel — nothing rotated; the admin card is still "available".
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    await expect(page.locator('[data-account-security-rotate="available"]')).toBeVisible();
  });

  // ─── Slice D — promote-a-device (add-device toggle, admin-gated) ──────────

  test("gym total webapp add-device offers promote-to-admin only on an admin device", async ({ page }, testInfo) => {
    // D3 (device-admin-tier D-4) — the promote-at-add-time toggle appears ONLY
    // in the synchronous SAS ceremony AND only when this device holds the
    // admin root to seal; it is default-OFF with the hard full-admin-authority
    // warning. A non-admin device omits the section entirely.
    await reachHome(page);
    await seedProfileUsername(page);
    // Non-admin device: no promote section at all.
    await page.evaluate(async () => {
      const { enterAddDevice } = await import("/views/add-device.js");
      await enterAddDevice();
    });
    await expect(page.locator("#view-add-device")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-section="promote-admin"]')).toHaveCount(0);
    await shot(page, testInfo, "promote-absent-non-admin");
    // Admin device: seed the admin root and re-render → the default-OFF
    // toggle + the hard warning.
    await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      getSession().adminRootSeed = crypto.getRandomValues(new Uint8Array(32));
      const { renderAddDevice } = await import("/views/add-device.js");
      renderAddDevice();
    });
    const section = page.locator('[data-section="promote-admin"]');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const toggle = page.locator("#add-device-promote-admin");
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('[data-section="promote-admin-warning"]')).toContainText(/full admin authority/i);
    await shot(page, testInfo, "promote-toggle-admin");
  });
});
