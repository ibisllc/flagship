import { test, expect, type Page } from "@playwright/test";
import { ADMIN_SEED_HEX, mock, reachHome, sawToast, shot } from "./gymKit";

/**
 * The browser's admin key under a passkey (docs/webapp-key-custody.md items 2, 5 and 6), with a
 * Chrome virtual authenticator that has the PRF extension (CDP WebAuthn.addVirtualAuthenticator,
 * hasPrf): a passphrase-only admin root is protected from Account security, a key still under the
 * passphrase moves under the passkey on its first signature, every signature asks the
 * authenticator again (its sign count goes up each time), and while signatures of the shell are
 * required an unsigned shell can't open the key.
 */

async function authenticator(page: Page): Promise<{ count: () => Promise<number> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  return {
    count: async () => {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials.reduce((n, c) => n + (c.signCount ?? 0), 0);
    },
  };
}

/** The account's admin root as a passphrase-only (version 1) record, and the session's handle for it. */
async function legacyAdminRoot(page: Page): Promise<void> {
  await page.evaluate(async (seedHex) => {
    const ks = await import("/keystore.js");
    const kc = await import("/lib/keyCustody.js");
    const { getSession } = await import("/lib/state.js");
    const s = getSession();
    await ks.persistAdminRootSeed(s.umk, ks.hexToBytes(seedHex));
    s.adminRootSeed = await kc.loadAdminRootKey(() => s.umk);
  }, ADMIN_SEED_HEX);
}

const recordVersion = (page: Page) =>
  page.evaluate(async () => {
    const ks = await import("/keystore.js");
    return (await ks.kvGet(ks.adminRootRecordKey()))?.version ?? null;
  });

/** Signs one admin order in the page; returns whether the signature verifies under the admin root. */
const signOnce = (page: Page) =>
  page.evaluate(async () => {
    const ks = await import("/keystore.js");
    const { getSession } = await import("/lib/state.js");
    const key = getSession().adminRootSeed;
    const msg = new TextEncoder().encode("flagship/box-release/v1|home.smoketest.flagship.services|" + "ab".repeat(32) + "|1|" + "00".repeat(16));
    try {
      const sig = await ks.signWithAdminRoot(key, msg);
      return { ok: await ks.verifyWithEd25519Pub(ks.hexToBytes(key.pubHex), sig, msg), code: null };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? "error", text: (e as { userMessage?: string }).userMessage ?? "" };
    }
  });

// WebAuthn refuses an IP address as the relying party, so these run on localhost (same static server).
test.use({ baseURL: `http://localhost:${Number(process.env.GYM_WEBAPP_PORT ?? "8799")}` });

test.describe("gym custody", () => {
  test("gym custody Account security protects a passphrase-only admin key with a passkey", async ({ page }, testInfo) => {
    const auth = await authenticator(page);
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    m.get((u) => u.pathname === "/api/users/smoketest", () => ({ json: { accountType: "single", totpEnrolledAt: null } }));
    await legacyAdminRoot(page);
    await page.click('[data-tab-target="settings"]');
    await page.click("#settings-tab-account-security");
    await expect(page.locator("[data-account-security-custody=passphrase]")).toBeVisible({ timeout: 15_000 });
    await page.click("#account-security-protect-key");
    await sawToast(page, "This browser's admin key is now protected by a passkey.");
    await expect(page.locator("[data-account-security-custody=passkey]")).toContainText("Browser: software key, unlocked with a passkey");
    expect(await recordVersion(page)).toBe(2);
    expect(await auth.count()).toBeGreaterThan(0);
    await shot(page, testInfo, "custody-protected");
  });

  test("gym custody the first signature moves the key under a passkey and every signature asks again", async ({ page }, testInfo) => {
    const auth = await authenticator(page);
    await reachHome(page, { kind: "admin" });
    await legacyAdminRoot(page);
    expect(await recordVersion(page)).toBe(1);
    expect(await signOnce(page)).toMatchObject({ ok: true });
    expect(await recordVersion(page)).toBe(2);
    const after1 = await auth.count();
    expect(await signOnce(page)).toMatchObject({ ok: true });
    const after2 = await auth.count();
    expect(after2).toBeGreaterThan(after1);
    expect(await signOnce(page)).toMatchObject({ ok: true });
    expect(await auth.count()).toBeGreaterThan(after2);
    // The passphrase path can no longer open it.
    const sealed = await page.evaluate(async () => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      try {
        await ks.loadAdminRootSeed(getSession().umk);
        return "opened";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(sealed).toBe("custody-sealed");
    await shot(page, testInfo, "custody-signed");
  });

  test("gym custody while signed shells are required an unsigned shell can't open the admin key", async ({ page }, testInfo) => {
    await authenticator(page);
    // The deploy under test turns the requirement on; the gym's static server serves no signature.
    await page.route("**/lib/shellTrust.js", async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace("export const SHELL_SIGNATURE_REQUIRED = false;", "export const SHELL_SIGNATURE_REQUIRED = true;");
      await route.fulfill({ response: res, body });
    });
    await reachHome(page, { kind: "admin" });
    await legacyAdminRoot(page);
    const r = await signOnce(page);
    expect(r).toMatchObject({ ok: false, code: "custody-shell-unsigned" });
    expect((r as { text: string }).text).toContain("isn't signed by Flagship");
    expect(await recordVersion(page)).toBe(1);
    await shot(page, testInfo, "custody-unsigned-shell");
  });
});
