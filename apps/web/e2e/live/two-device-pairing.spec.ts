/**
 * TWO-DEVICE PAIRING INTO ONE CLOUD — REAL webapp, REAL box, TWO browser contexts.
 *
 * GOAL: device-1 OWNS the account + a freshly-provisioned gym box; device-2 (a
 * SEPARATE browser context = a second physical device, its OWN storage) pairs
 * into the SAME cloud so it SEES + can READ from that same box.
 *
 * Mechanism under test: the P14 COMPANION dock (the unattended two-context path).
 *   - Device-1 (owner via the gym __gymAdopt seam) pairs to the pod
 *     (IRK-signed add-paired-session → owner paired-session token), then MINTS a
 *     companion ticket (POST <pod>/api/screens/companion/mint-ticket) and builds
 *     the `flagship/remote-ticket/v1` a phone seals to a browser over /qr-pipe.
 *   - Device-2 (a fresh context) bootstraps its OWN device key (proving it is a
 *     distinct device), then takes that ticket through the remote page's own
 *     checks and redeem (lib/companionDockStart.js: parseRemoteTicket +
 *     redeemRemoteTicket, POST /api/companion/redeem, public, CORS-allowed) →
 *     a 4-HOUR companion paired-session to the SAME box. The relay hop itself
 *     is covered by the remote page's unit tests.
 *   - Device-2 then READS the same box cross-origin (server-detail + services
 *     screens-BFF over the companion token) — i.e. it genuinely reaches the
 *     SAME cloud, not just renders pairing UI.
 *
 * This is the COMPANION mechanism: a TEMPORARY (4h) READ-ONLY session, distinct
 * from a full device-add (cross-device QR + DeviceAdmit, which copies the UMK
 * and joins quarantined). The companion is the one that works fully unattended
 * across two browser contexts (no live SAS-compare choreography).
 *
 * Reads box.json from gym-results/feature-screenshots/ (written by
 * tools/live-e2e/provision-for-webapp.ts). Saves PNGs + findings.json to
 * gym-results/pairing-e2e/.
 */
import { test, expect, chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ORIGIN = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://webapp.gym.flagshipserver.com";
const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const BOX_DIR = join(REPO, "gym-results", "feature-screenshots");
const SHOT_DIR = join(REPO, "gym-results", "pairing-e2e");
mkdirSync(SHOT_DIR, { recursive: true });

const BOX = JSON.parse(readFileSync(join(BOX_DIR, "box.json"), "utf8")) as {
  username: string;
  fqdn: string;
  umkSeedHex: string;
  irkPubHex: string;
};
const POD_URL = `https://${BOX.fqdn}`;

type Grade = "A" | "B" | "C" | "FAIL";
type Finding = { step: string; grade: Grade; detail: string };
const findings: Finding[] = [];
function record(f: Finding) {
  findings.push(f);
  // eslint-disable-next-line no-console
  console.log(`[pairing] [${f.grade}] ${f.step}: ${f.detail}`);
}

let shotN = 0;
async function shot(page: Page, name: string) {
  shotN += 1;
  const file = `${String(shotN).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(SHOT_DIR, file), fullPage: true }).catch(() => undefined);
  return file;
}

// Capture every cross-origin call a page makes to the BOX (the CORS evidence).
type BoxCall = { who: string; url: string; status: number; acao: string | null; method: string };
const boxCalls: BoxCall[] = [];
function watchBoxCalls(page: Page, who: string) {
  page.on("response", (r) => {
    const u = r.url();
    if (u.startsWith(POD_URL)) {
      boxCalls.push({
        who,
        url: u.replace(POD_URL, ""),
        status: r.status(),
        acao: r.headers()["access-control-allow-origin"] ?? null,
        method: r.request().method(),
      });
    }
  });
}

test.describe.configure({ mode: "serial" });

test("two devices, one cloud: companion-pair a fresh device into the owner's box", async () => {
  test.setTimeout(8 * 60 * 1000);

  let browser: Browser | null = null;
  let ctx1: BrowserContext | null = null;
  let ctx2: BrowserContext | null = null;

  try {
    browser = await chromium.launch();

    // ── DEVICE 1 — the OWNER. Its own context (own storage). ──────────────────
    ctx1 = await browser.newContext({ baseURL: ORIGIN });
    await ctx1.addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);
    const d1 = await ctx1.newPage();
    const d1ConsoleErr: string[] = [];
    d1.on("console", (m) => { if (m.type() === "error") d1ConsoleErr.push(m.text().slice(0, 200)); });
    watchBoxCalls(d1, "device-1");

    await d1.goto("/index.html");
    await expect(d1.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });
    await d1.waitForTimeout(4_000);
    const seamOk = await d1.evaluate(() => typeof (window as any).__gymAdopt === "function");
    expect(seamOk, "gym adoption seam must be installed on the gym host").toBe(true);
    await shot(d1, "d1-boot");

    // Adopt the box-owning identity (the SAME deriveIRK(umkSeed) the box's owner
    // IRK is — this session genuinely OWNS the box).
    const adopt = await d1.evaluate(
      (p) => (window as any).__gymAdopt(p),
      { umkSeedHex: BOX.umkSeedHex, username: BOX.username },
    );
    await d1.waitForTimeout(1_500);
    record({
      step: "device-1 adopts the owner account",
      grade: adopt?.ok ? "A" : "FAIL",
      detail: `__gymAdopt → ${JSON.stringify(adopt)} (owner of ${BOX.fqdn})`,
    });

    // Device-1 PAIRS to the pod (IRK-signed add-paired-session) — this is what
    // mints the OWNER paired-session token that gates companion mint-ticket.
    await d1.evaluate(async () => {
      const m = await import("/views/pod-pair.js");
      await m.enterPodPair();
    });
    await expect(d1.locator("#view-pod-pair")).toBeVisible();
    await d1.fill("#pod-pair-base", POD_URL);
    await shot(d1, "d1-pod-pair-form");
    // The real UI click signs an add-paired-session order + round-trips to the
    // box; the box can be slow on first contact, so click + wait for the status
    // to flip to "paired to", with one re-click if the first order didn't land.
    let d1PairText = "";
    let d1Session = { base: "", tok: "" };
    for (let attempt = 0; attempt < 3; attempt++) {
      await d1.fill("#pod-pair-base", POD_URL);
      await d1.click("#pod-pair-go").catch(() => undefined);
      await d1.locator("#pod-pair-status:has-text('paired to')")
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => undefined);
      d1PairText = await d1.locator("#pod-pair-status").innerText().catch(() => "");
      d1Session = await d1.evaluate(async () => {
        const api = await import("/lib/api.js");
        return { base: api.getPodBaseUrl(), tok: api.getSessionToken().slice(0, 10) };
      });
      if (/paired to/i.test(d1PairText) && d1Session.tok.length > 0) break;
      await d1.waitForTimeout(2_000);
    }
    const d1Paired = /paired to/i.test(d1PairText) && d1Session.tok.length > 0;
    record({
      step: "device-1 pairs to the box (owner paired-session)",
      grade: d1Paired ? "A" : "FAIL",
      detail: `card="${d1PairText.trim()}"; persisted base=${d1Session.base} tok=${d1Session.tok}…`,
    });
    expect(d1Paired, "device-1 must hold a real owner paired-session to mint a companion").toBe(true);
    await shot(d1, "d1-paired-online");

    // Device-1 MINTS a companion ticket + builds the receiver URL (the pairing
    // artifact). Drive the authenticated client directly (same call the
    // Settings → Dock a browser UI makes), so we don't depend on QR rendering.
    // The companion ticket TTL is 60s by design, so we mint the ticket device-2
    // actually redeems LATER (right before device-2 navigates) — this initial
    // mint proves the artifact-generation mechanism + builds a representative URL.
    const mintArtifact = async (label: string) =>
      d1.evaluate(async ({ boxUsername, lbl }) => {
        const cc = await import("/lib/companionClient.js");
        const api = await import("/lib/api.js");
        const { get: profileGet } = await import("/lib/profilesStore.js");
        let ticket: any = null;
        let mintErr: string | null = null;
        try {
          ticket = await cc.companionMintTicket({ label: lbl });
        } catch (e) {
          mintErr = String((e && (e as any).message) || e);
        }
        const podBaseUrl = api.getPodBaseUrl();
        // The active profile's username may not be mirrored by the gym adopt seam;
        // fall back to the known box username (the receiver only uses it as a hint —
        // the daemon's redeem response carries the authoritative username anyway).
        const username = profileGet("username") || boxUsername;
        const sealed = ticket?.ticketId && ticket?.ticketSecret
          ? JSON.stringify({
            kind: "flagship/remote-ticket/v1",
            ticketId: ticket.ticketId,
            ticketSecret: ticket.ticketSecret,
            podBaseUrl,
            username,
          })
          : "";
        return {
          ticketId: ticket?.ticketId ? String(ticket.ticketId).slice(0, 10) : null,
          expiresAt: ticket?.expiresAt ?? 0,
          podBaseUrl,
          username,
          sealed,
          mintErr,
        };
      }, { boxUsername: BOX.username, lbl: label });

    const mint = await mintArtifact("device-2-companion-demo");
    record({
      step: "device-1 GENERATES the pairing artifact (remote ticket)",
      grade: mint?.sealed ? "A" : "FAIL",
      detail: mint?.sealed
        ? `ticket=${mint.ticketId}… ttl≈${Math.round((mint.expiresAt - Date.now()) / 1000)}s; podBase=${mint.podBaseUrl}`
        : `mint FAILED: mintErr=${mint?.mintErr}; ticketId=${mint?.ticketId}; podBase=${mint?.podBaseUrl}; username=${mint?.username}`,
    });
    expect(mint.sealed, "remote ticket must be built").toBeTruthy();

    // ── DEVICE 2 — a SEPARATE context (its OWN storage). ──────────────────────
    ctx2 = await browser.newContext({ baseURL: ORIGIN });
    await ctx2.addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);
    const d2 = await ctx2.newPage();
    const d2ConsoleErr: string[] = [];
    d2.on("console", (m) => { if (m.type() === "error") d2ConsoleErr.push(m.text().slice(0, 200)); });
    watchBoxCalls(d2, "device-2");

    // First-run on device-2: it has NO identity. Boot lands on the bootstrap
    // (device-key) screen → prove it is a genuinely fresh, separate device.
    await d2.goto("/index.html");
    await expect(d2.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });
    await d2.waitForTimeout(2_000);
    const d2HasUmkBefore = await d2.evaluate(async () => {
      const ks = await import("/keystore.js");
      return await ks.hasWrappedUmk();
    });
    record({
      step: "device-2 starts fresh (separate context, no identity)",
      grade: d2HasUmkBefore === false ? "A" : "C",
      detail: `fresh context: hasWrappedUmk()=${d2HasUmkBefore} (expected false — a brand-new device)`,
    });
    await shot(d2, "d2-fresh-boot");

    // Bootstrap a NEW device identity on device-2 (its OWN device key — distinct
    // from device-1). This is "device-2 bootstraps a new device identity".
    const d2DeviceKey = await d2.evaluate(async () => {
      const { bootstrapNewIdentity } = await import("/keystore.js");
      const seed = await bootstrapNewIdentity("device-2-local-pass-xyz");
      // Derive this device's IRK pub to show it differs from the owner's.
      const ks = await import("/keystore.js");
      let pub = "";
      try {
        const irk = await ks.deriveIrkFromSeed(seed);
        if (irk?.publicKey) pub = ks.bytesToHex(irk.publicKey);
      } catch { /* the key existing is the point */ }
      return { hasSeed: seed instanceof Uint8Array && seed.length === 32, devicePub: pub.slice(0, 16) };
    }).catch((e) => ({ hasSeed: false, devicePub: "", err: String(e) } as any));
    record({
      step: "device-2 bootstraps its OWN device identity",
      grade: d2DeviceKey?.hasSeed ? "A" : "C",
      detail: `fresh device key minted (hasSeed=${d2DeviceKey?.hasSeed}; devicePub=${d2DeviceKey?.devicePub || "n/a"}…) — distinct from owner ${BOX.irkPubHex.slice(0, 16)}…`,
    });

    // REDEEM the pairing artifact on device-2 the way the remote page does once
    // the phone's seal is open: parseRemoteTicket, then redeemRemoteTicket POSTs
    // /api/companion/redeem to the pod (cross-origin, CORS-allowed) and persists
    // a companion profile.
    //
    // Mint the ticket device-2 will redeem FRESH here (the 60s TTL means a ticket
    // minted at the top of the test would expire during the device-2 setup). This
    // is still device-1 (the owner) generating the artifact + device-2 redeeming
    // it across two contexts — only the wall-clock gap is tightened.
    const liveMint = await mintArtifact("device-2-companion");
    record({
      step: "device-1 mints the fresh ticket device-2 will redeem",
      grade: liveMint?.sealed ? "A" : "FAIL",
      detail: `ticket=${liveMint.ticketId}… ttl≈${Math.round((liveMint.expiresAt - Date.now()) / 1000)}s`,
    });
    expect(liveMint.sealed, "fresh remote ticket must be built").toBeTruthy();

    let redeemStatus: number | "none" = "none";
    let redeemAcao: string | null = null;
    d2.on("response", (r) => {
      if (r.url().includes("/api/companion/redeem")) {
        redeemStatus = r.status();
        redeemAcao = r.headers()["access-control-allow-origin"] ?? null;
      }
    });
    await d2.evaluate(async (sealed) => {
      const m = await import("/lib/companionDockStart.js");
      await m.redeemRemoteTicket(m.parseRemoteTicket(sealed));
    }, liveMint.sealed);
    await d2.waitForTimeout(1_000);

    // Inspect the persisted companion profile on device-2.
    const d2Profile = await d2.evaluate(async () => {
      const api = await import("/lib/api.js");
      const { get: profileGet, getActiveCloudName } = await import("/lib/profilesStore.js");
      return {
        base: api.getPodBaseUrl(),
        tok: api.getSessionToken().slice(0, 10),
        kind: profileGet("kind"),
        cloud: getActiveCloudName?.() ?? null,
        companionExpiresAt: profileGet("companionExpiresAt"),
        username: profileGet("username"),
      };
    });
    const redeemed =
      (redeemStatus === 200 || redeemStatus === "none") &&
      d2Profile.kind === "companion" &&
      d2Profile.base === POD_URL &&
      d2Profile.tok.length > 0;
    record({
      step: "device-2 REDEEMS the companion link → session on the SAME box",
      grade: redeemed ? "A" : "FAIL",
      detail: `redeem POST status=${redeemStatus} ACAO=${redeemAcao}; profile kind=${d2Profile.kind} base=${d2Profile.base} tok=${d2Profile.tok}… expiresAt=${d2Profile.companionExpiresAt}; cloud=${d2Profile.cloud}`,
    });
    await shot(d2, "d2-companion-redeemed-home");

    // Confirm device-2 and device-1 point at the SAME pod (same cloud).
    const sameCloud = d2Profile.base === d1Session.base && d2Profile.base === POD_URL;
    record({
      step: "device-2 + device-1 are on ONE cloud (same pod)",
      grade: sameCloud ? "A" : "FAIL",
      detail: `device-1 base=${d1Session.base} · device-2 base=${d2Profile.base} · box=${POD_URL}`,
    });

    // ── PROVE device-2 can DRIVE/READ the shared box (not just render UI). ────
    // Server-detail screens-BFF over the companion token (cross-origin).
    await d2.evaluate(async () => {
      try {
        const m = await import("/views/server-detail.js");
        await m.enterServerDetail();
      } catch (e) { (window as any).__sdErr = String(e); }
    });
    await d2.waitForTimeout(4_000);
    const d2SdVisible = await d2.locator("#view-server-detail").isVisible().catch(() => false);
    const d2SdText = await d2.locator("#server-detail-content").innerText().catch(() => "");
    const d2SdErr = await d2.evaluate(() => (window as any).__sdErr ?? null);
    // Did a screens-BFF GET to the box succeed WITH ACAO for device-2?
    const d2BffOk = boxCalls.some(
      (c) => c.who === "device-2" && c.url.startsWith("/api/screens/") && c.status >= 200 && c.status < 300 && c.acao,
    );
    const sdReadsBox =
      d2BffOk ||
      d2SdText.includes(BOX.fqdn) ||
      /unlock|metrics|front page|journal|status|online/i.test(d2SdText);
    record({
      step: "device-2 READS the shared box (server-detail screens-BFF, cross-origin)",
      grade: sdReadsBox ? "A" : (d2SdVisible ? "C" : "FAIL"),
      detail: `bffOkWithAcao=${d2BffOk}; content="${d2SdText.replace(/\s+/g, " ").slice(0, 120)}"; err=${d2SdErr ?? "none"}`,
    });
    await shot(d2, "d2-server-detail-shared-box");

    // Services-list screens-BFF over the companion token (cross-origin read).
    await d2.evaluate(async () => {
      try {
        const m = await import("/views/services-list.js");
        await m.enterServicesList();
      } catch (e) { (window as any).__svcErr = String(e); }
    });
    await d2.waitForTimeout(3_000);
    const d2SvcText = await d2.locator("#services-list-content").innerText().catch(() => "");
    const d2SvcErr = await d2.evaluate(() => (window as any).__svcErr ?? null);
    const d2SvcCallOk = boxCalls.some(
      (c) => c.who === "device-2" &&
        (c.url.includes("/api/services") || c.url.includes("/api/screens/")) &&
        c.status >= 200 && c.status < 300 && c.acao,
    );
    const svcReadsBox = d2SvcCallOk || /whoami|service|installed|no services/i.test(d2SvcText);
    record({
      step: "device-2 reads the box services list (cross-origin)",
      grade: svcReadsBox ? "A" : "C",
      detail: `callOkWithAcao=${d2SvcCallOk}; content="${d2SvcText.replace(/\s+/g, " ").slice(0, 120)}"; err=${d2SvcErr ?? "none"}`,
    });
    await shot(d2, "d2-services-list-shared-box");

    // Companion WRITE must be REFUSED (it's a read-only session) — proves the
    // 4h companion is genuinely scoped, not a full owner device.
    const writeRefused = await d2.evaluate(async (podBase) => {
      try {
        const api = await import("/lib/api.js");
        const r = await fetch(`${podBase}/api/screens/companion/mint-ticket`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-flagship-session": api.getSessionToken() },
          body: JSON.stringify({ label: "should-be-refused" }),
        });
        let body = "";
        try { body = (await r.text()).slice(0, 120); } catch { /* */ }
        return { status: r.status, body };
      } catch (e) { return { status: -1, body: String(e) }; }
    }, POD_URL);
    record({
      step: "device-2 companion is READ-ONLY (write refused)",
      grade: writeRefused.status === 403 ? "A" : "C",
      detail: `companion mint-ticket (a write) → status=${writeRefused.status} body="${writeRefused.body}" (expected 403 companion-write-not-allowed)`,
    });

    // ── Verify on device-1 that the companion shows up in the active list. ────
    // Authoritative check: query the box's OWN companion-list BFF (the same call
    // Settings → Dock a browser makes) — it returns the redeemed companion rows.
    const ownerCompanionView = await d1.evaluate(async () => {
      const cc = await import("/lib/companionClient.js");
      try {
        const body = await cc.companionList();
        return { ok: true, count: (body.companions ?? []).length, companions: body.companions ?? [] };
      } catch (e) {
        return { ok: false, err: String((e && (e as any).message) || e) };
      }
    });
    // Then re-render the UI so the screenshot shows the docked companion row.
    await d1.evaluate(async () => {
      const m = await import("/views/companion-dock.js");
      await m.renderCompanionDock();
    }).catch(() => undefined);
    await d1.waitForTimeout(1_500);
    const d1CompanionList = await d1.locator("#companion-dock-content").innerText().catch(() => "");
    const labels = (ownerCompanionView.companions ?? []).map((c: any) => c.label).filter(Boolean);
    const ownerSeesCompanion =
      ownerCompanionView.ok === true && (ownerCompanionView.count ?? 0) >= 1;
    record({
      step: "device-1 (owner) sees device-2 in its Active companions list",
      grade: ownerSeesCompanion ? "A" : "C",
      detail: ownerSeesCompanion
        ? `box reports ${ownerCompanionView.count} docked companion(s); labels=[${labels.join(", ")}]; UI snippet="${d1CompanionList.replace(/\s+/g, " ").slice(0, 90)}"`
        : `companion list failed/empty: ${JSON.stringify(ownerCompanionView)}`,
    });
    await shot(d1, "d1-active-companions-list");

    // ── Summary ───────────────────────────────────────────────────────────────
    const d2BoxCalls = boxCalls.filter((c) => c.who === "device-2");
    const d2Successful = d2BoxCalls.filter((c) => c.status >= 200 && c.status < 300 && c.acao);
    writeFileSync(
      join(SHOT_DIR, "findings.json"),
      JSON.stringify(
        {
          box: BOX,
          mechanism: "companion (P14) — temporary 4h read-only session (NOT a full device-add)",
          screenshots: shotN,
          findings,
          twoDevicesOneCloud: sameCloud && redeemed,
          device2ReadsBox: sdReadsBox || svcReadsBox,
          corsEvidence: {
            device2BoxCalls: d2BoxCalls.length,
            device2SuccessfulWithAcao: d2Successful.length,
            calls: boxCalls,
          },
          consoleErrors: { device1: d1ConsoleErr.slice(0, 8), device2: d2ConsoleErr.slice(0, 8) },
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console
    console.log(
      `\n[pairing] DONE — ${shotN} screenshots; sameCloud=${sameCloud} redeemed=${redeemed} ` +
        `device-2 box calls ok-with-ACAO=${d2Successful.length}/${d2BoxCalls.length}; findings.json written`,
    );

    // The headline assertions: two devices on ONE cloud, and device-2 actually
    // reached the box (a successful cross-origin box call with ACAO).
    expect(sameCloud, "device-1 and device-2 must point at the SAME box").toBe(true);
    expect(redeemed, "device-2 must hold a real companion session to the box").toBe(true);
    expect(d2Successful.length, "device-2 must make at least one successful box call WITH ACAO").toBeGreaterThan(0);
  } finally {
    await ctx1?.close().catch(() => undefined);
    await ctx2?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
});
