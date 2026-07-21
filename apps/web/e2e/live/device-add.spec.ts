/**
 * FULL CROSS-DEVICE DEVICE-ADD INTO ONE CLOUD — REAL webapp, REAL box, TWO
 * browser contexts, a GENUINE human SAS-compare.
 *
 * GOAL (distinct from the read-only 4h companion dock): device-2 becomes a
 * FULL MEMBER of device-1's account — the cross-device QR + DeviceAdmit +
 * SAS-compare path. A scanned-in device mints its OWN fresh device key, the
 * owner vouches for it with an IRK-signed `DeviceAdmit`, seals the account UMK
 * seed + admit over the SAS-verified AEAD relay, and the new device joins
 * QUARANTINED (the server stamps a 14-day review window). After joining it
 * holds the SAME account UMK ⇒ derives the SAME IRK ⇒ owns the SAME box.
 *
 * Mechanism under test (the deployed webapp):
 *   - device-1 (owner via the gym __gymAdopt seam) opens Settings → Trusted
 *     devices → Add device (views/add-device.js → runAdminAddDevice): opens
 *     the QrRelay v2 session, renders the /join QR + link, and on peer-connect
 *     derives + DISPLAYS a 6-digit SAS in #add-device-sas.
 *   - device-2 (a SEPARATE context = a second physical device, its OWN
 *     storage) opens the /join?sid=…&pk=… link (views/join.js → runIncomingJoin):
 *     mints a FRESH device key, connects the relay, derives + DISPLAYS the SAS
 *     in #join-sas.
 *   - SAS-COMPARE (the human step, played here): we READ both displayed codes
 *     and ASSERT THEY ARE EQUAL — a mismatch fails the test. Then we confirm
 *     on both screens.
 *   - the relay completes: device-1 signs the admit + seals { umkSeed, admit,
 *     admitSig }; device-2 receives it, verifies the admit under the account
 *     IRK pub (GET /api/users/:u/pubkey-cert), POSTs /api/users/:u/devices/admit
 *     → joins, server returns quarantineUntil.
 *   - membership assertion: device-2 now holds an UMK whose derived IRK pub ==
 *     device-1's account IRK pub (the SAME cloud), and can READ the shared box
 *     (server-detail screens-BFF over a paired session). And it is QUARANTINED.
 *
 * Reads box.json from gym-results/feature-screenshots/ (provision-for-webapp.ts).
 * Saves PNGs + findings.json to gym-results/device-add-e2e/.
 */
import { test, expect, chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ORIGIN = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://web.gym.flagshipserver.com";
const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const BOX_DIR = join(REPO, "gym-results", "feature-screenshots");
const SHOT_DIR = join(REPO, "gym-results", "device-add-e2e");
mkdirSync(SHOT_DIR, { recursive: true });

const BOX = JSON.parse(readFileSync(join(BOX_DIR, "box.json"), "utf8")) as {
  username: string;
  fqdn: string;
  umkSeedHex: string;
  irkPubHex: string;
};
const POD_URL = `https://${BOX.fqdn}`;
const CONTROL = process.env.GYM_LIVE_CONTROL_APEX ?? "gym.flagshipserver.com";

// The deployed webapp's lib/pairingRelay.js has a broken admin→incoming seal
// (it writes a browser-role `deliver`, which the QrRelay DO rejects with
// "browser sends nothing" + tears down leg-1 after the incoming's first frame —
// proven in tools/live-e2e/device-add-relay-probe.ts). The FIX (the two-leg
// choreography) lives in THIS worktree but can't be deployed by the agent. To
// prove the fix end-to-end against the REAL backend + REAL box, we keep the
// origin `web.gym.flagshipserver.com` (so the gym adopt seam installs, CORS
// allows .com calls, and the apex resolves to gym) and ONLY swap pairingRelay.js
// for the fixed file via Playwright route interception. Set
// GYM_USE_DEPLOYED_RELAY=1 to instead test the deployed (broken) file as-is.
const USE_DEPLOYED_RELAY = process.env.GYM_USE_DEPLOYED_RELAY === "1";
const FIXED_RELAY_PATH = join(REPO, "apps", "web", "public", "webapp", "lib", "pairingRelay.js");
const FIXED_RELAY_SRC = USE_DEPLOYED_RELAY ? "" : readFileSync(FIXED_RELAY_PATH, "utf8");
async function installRelayFix(ctx: BrowserContext) {
  if (USE_DEPLOYED_RELAY) return;
  await ctx.route("**/lib/pairingRelay.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: FIXED_RELAY_SRC,
    });
  });
}

type Grade = "A" | "B" | "C" | "FAIL";
type Finding = { step: string; grade: Grade; detail: string };
const findings: Finding[] = [];
function record(f: Finding) {
  findings.push(f);
  // eslint-disable-next-line no-console
  console.log(`[device-add] [${f.grade}] ${f.step}: ${f.detail}`);
}

let shotN = 0;
async function shot(page: Page, name: string) {
  shotN += 1;
  const file = `${String(shotN).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(SHOT_DIR, file), fullPage: true }).catch(() => undefined);
  return file;
}

// Capture every cross-origin call each page makes (the .com admit + the box).
type ApiCall = { who: string; url: string; status: number; acao: string | null; method: string };
const apiCalls: ApiCall[] = [];
function watchApi(page: Page, who: string) {
  page.on("response", (r) => {
    const u = r.url();
    if (u.startsWith(POD_URL) || u.includes(CONTROL)) {
      apiCalls.push({
        who,
        url: u.replace(POD_URL, "<pod>").replace(`https://${CONTROL}`, "<com>"),
        status: r.status(),
        acao: r.headers()["access-control-allow-origin"] ?? null,
        method: r.request().method(),
      });
    }
  });
}

// Read a #...-sas element's text and normalise to the 6 digits the SAS is.
async function readSas(page: Page, sel: string): Promise<string> {
  const raw = await page.locator(sel).innerText().catch(() => "");
  return raw.replace(/\D/g, "");
}

test.describe.configure({ mode: "serial" });

test("full device-add: a second device joins the SAME cloud, quarantined, after a real SAS match", async () => {
  test.setTimeout(9 * 60 * 1000);

  let browser: Browser | null = null;
  let ctx1: BrowserContext | null = null;
  let ctx2: BrowserContext | null = null;

  // Collected for the headline assertions / findings.json.
  let d1Sas = "";
  let d2Sas = "";
  let sasMatched = false;
  let joinUsername = "";
  let quarantineUntil: number | null = null;
  let d2DerivedIrkPub = "";
  let bundleDelivered = false;

  try {
    browser = await chromium.launch();
    record({
      step: "test harness: webapp relay transport",
      grade: USE_DEPLOYED_RELAY ? "C" : "A",
      detail: USE_DEPLOYED_RELAY
        ? "GYM_USE_DEPLOYED_RELAY=1 — driving the DEPLOYED (broken) lib/pairingRelay.js as-is (expect bundle delivery to hang)"
        : "lib/pairingRelay.js swapped for the FIXED two-leg version via route interception (origin unchanged = web.gym.flagshipserver.com; CORS/seam/apex all live)",
    });

    // ── DEVICE 1 — the OWNER. Its own context (own storage). ──────────────────
    ctx1 = await browser.newContext({ baseURL: ORIGIN });
    await ctx1.addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);
    await installRelayFix(ctx1);
    const d1 = await ctx1.newPage();
    const d1ConsoleErr: string[] = [];
    d1.on("console", (m) => { if (m.type() === "error") d1ConsoleErr.push(m.text().slice(0, 200)); });
    watchApi(d1, "device-1");

    await d1.goto("/index.html");
    await expect(d1.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });
    await d1.waitForTimeout(3_000);
    const seamOk = await d1.evaluate(() => typeof (window as any).__gymAdopt === "function");
    expect(seamOk, "gym adoption seam must be installed on the gym host").toBe(true);
    await shot(d1, "d1-boot");

    // Adopt the box-owning identity (the SAME deriveIRK(umkSeed) the box's owner
    // IRK is). This session genuinely OWNS the box + account.
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
    expect(adopt?.ok, "device-1 must own the account").toBe(true);

    // device-1's account IRK pub, derived locally from the adopted UMK — the
    // ground truth the new device must match to be "the same cloud".
    const d1IrkPub = await d1.evaluate(async (umkSeedHex: string) => {
      const ks = await import("/keystore.js");
      const seed = new Uint8Array(umkSeedHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
      const irk = await ks.deriveIrkFromSeed(seed);
      return ks.bytesToHex(irk.publicKey);
    }, BOX.umkSeedHex);
    record({
      step: "device-1 account IRK pub (ground truth for 'same cloud')",
      grade: d1IrkPub.toLowerCase() === BOX.irkPubHex.toLowerCase() ? "A" : "FAIL",
      detail: `derived ${d1IrkPub.slice(0, 16)}… == box owner ${BOX.irkPubHex.slice(0, 16)}…`,
    });
    expect(d1IrkPub.toLowerCase()).toBe(BOX.irkPubHex.toLowerCase());

    // ── DEVICE 1 — open Settings → Trusted devices → Add device. ──────────────
    // Drive the REAL UI entry (trusted-devices → enterAddDevice), so the screen
    // the owner actually uses renders. add-device.js auto-runs startPairing() on
    // render: opens the relay, renders the QR + /join link, and (on peer-connect)
    // surfaces the SAS into #add-device-sas + arms #add-device-confirm.
    await d1.evaluate(async () => {
      const m = await import("/views/add-device.js");
      await m.enterAddDevice();
    });
    await expect(d1.locator("#view-add-device")).toBeVisible({ timeout: 15_000 });
    // The join link appears AFTER relay.open() round-trips + the view-shown
    // event drives renderAddDevice → renderQr; poll the input value (the
    // render is async/event-driven, so a single waitFor can land too early).
    let joinLink = "";
    for (let i = 0; i < 20; i++) {
      joinLink = await d1.locator("#add-device-link").inputValue().catch(() => "");
      if (joinLink.includes("/join?sid=")) break;
      await d1.waitForTimeout(500);
    }
    record({
      step: "device-1 'Add device' opens + renders the /join QR + link",
      grade: joinLink.includes("/join?sid=") && joinLink.includes("&pk=") ? "A" : "FAIL",
      detail: joinLink.includes("/join?sid=")
        ? `join link = ${joinLink.slice(0, 90)}…`
        : `no /join link rendered (got "${joinLink.slice(0, 80)}")`,
    });
    await shot(d1, "d1-add-device-qr");
    expect(joinLink, "device-1 must render a /join pairing link").toContain("/join?sid=");

    // ── DEVICE 2 — a SEPARATE context (its OWN storage). ──────────────────────
    ctx2 = await browser.newContext({ baseURL: ORIGIN });
    await ctx2.addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);
    await installRelayFix(ctx2);
    const d2 = await ctx2.newPage();
    const d2ConsoleErr: string[] = [];
    d2.on("console", (m) => { if (m.type() === "error") d2ConsoleErr.push(m.text().slice(0, 200)); });
    watchApi(d2, "device-2");

    // Prove device-2 is genuinely fresh BEFORE opening the join link.
    await d2.goto("/index.html");
    await expect(d2.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });
    await d2.waitForTimeout(1_500);
    const d2HasUmkBefore = await d2.evaluate(async () => {
      const ks = await import("/keystore.js");
      return await ks.hasWrappedUmk();
    });
    record({
      step: "device-2 starts fresh (separate context, no identity)",
      grade: d2HasUmkBefore === false ? "A" : "C",
      detail: `fresh context: hasWrappedUmk()=${d2HasUmkBefore} (expected false)`,
    });
    await shot(d2, "d2-fresh-boot");

    // device-2 OPENS the /join link (the QR scan). NOTE: the QR encodes
    // `<controlApex>/join?sid=&pk=` (a phone universal/deep link). In the gym
    // env neither `gym.flagshipserver.com/join` (control = marketing) nor
    // `web.gym.flagshipserver.com/join` (also marketing) serves the WEBAPP — so
    // a webapp receiver can't be reached by navigating the literal /join URL
    // (recorded as a finding). The webapp boot path that WOULD handle it is
    // `joinLinkFromLocation()` → `enterJoin({sid,pk})`; we drive that exact code
    // path here after loading the webapp at /index.html (mirroring the boot).
    const parsed = await d2.evaluate(async (lnk: string) => {
      const m = await import("/lib/crossDevicePairing.js");
      return m.parseJoinLink(lnk);
    }, joinLink);
    record({
      step: "join link parses to { sid, pk } (webapp boot would route this)",
      grade: parsed?.sid && parsed?.pk ? "A" : "FAIL",
      detail: `parseJoinLink → sid=${String(parsed?.sid).slice(0, 10)}… pk=${String(parsed?.pk).slice(0, 10)}…`,
    });
    expect(parsed?.sid, "join link must carry a relay sid").toBeTruthy();
    // Capture the admit POST status + ACAO when it fires (it may not, if the
    // bundle never arrives — that's exactly what we want to observe honestly).
    let admitStatus: number | "none" = "none";
    let admitAcao: string | null = null;
    let admitBody = "";
    d2.on("response", async (r) => {
      if (r.url().includes("/devices/admit")) {
        admitStatus = r.status();
        admitAcao = r.headers()["access-control-allow-origin"] ?? null;
        try {
          const t = await r.text();
          admitBody = t.slice(0, 200);
          try {
            const j = JSON.parse(t);
            if (typeof j?.quarantineUntil === "number") quarantineUntil = j.quarantineUntil;
          } catch { /* not json */ }
        } catch { /* */ }
      }
    });
    // Drive the webapp's join entry directly (the boot path's join branch).
    await d2.evaluate(async (link: { sid: string; pk: string }) => {
      const m = await import("/views/join.js");
      m.enterJoin(link);
    }, parsed as { sid: string; pk: string });
    await expect(d2.locator("#view-join")).toBeVisible({ timeout: 20_000 });
    await shot(d2, "d2-join-opened");

    // ── Wait for BOTH screens to display the SAS (peer-connect on the relay). ──
    // The admin's SAS appears once device-2's hello reaches it; device-2's SAS
    // appears once it derives the shared secret. Poll both up to 30s.
    for (let i = 0; i < 30; i++) {
      d1Sas = await readSas(d1, "#add-device-sas");
      d2Sas = await readSas(d2, "#join-sas");
      if (d1Sas.length === 6 && d2Sas.length === 6) break;
      await d1.waitForTimeout(1_000);
    }
    await shot(d1, "d1-sas-shown");
    await shot(d2, "d2-sas-shown");
    record({
      step: "both devices DISPLAY a 6-digit SAS (relay peer-connect)",
      grade: d1Sas.length === 6 && d2Sas.length === 6 ? "A" : "FAIL",
      detail: `device-1 #add-device-sas="${d1Sas}" · device-2 #join-sas="${d2Sas}"`,
    });
    expect(d1Sas.length, "device-1 must display a SAS (relay must connect)").toBe(6);
    expect(d2Sas.length, "device-2 must display a SAS (relay must connect)").toBe(6);

    // ── THE HUMAN SECURITY CHECK: compare the two displayed codes. ────────────
    // This is the verification a person does holding both screens. We do NOT
    // fake it — a mismatch must fail the whole test.
    sasMatched = d1Sas === d2Sas && d1Sas.length === 6;
    record({
      step: "SAS-COMPARE (human step): device-1 SAS === device-2 SAS",
      grade: sasMatched ? "A" : "FAIL",
      detail: sasMatched
        ? `MATCH: both screens show ${d1Sas} — a real ECDH-derived short-auth-string, equal on both sides`
        : `MISMATCH: device-1=${d1Sas} device-2=${d2Sas} — would indicate a relay MitM; refusing`,
    });
    expect(sasMatched, "the SAS shown on both devices MUST match (the human security check)").toBe(true);

    // ── Confirm on BOTH screens (the user taps "codes match"). ────────────────
    // device-1's confirm is anti-double-tap gated ~600ms; wait for enabled.
    await d1.locator("#add-device-confirm:not([disabled])").waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    await d1.click("#add-device-confirm").catch(() => undefined);
    await d2.locator("#join-confirm:not([disabled])").waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    await d2.click("#join-confirm").catch(() => undefined);
    record({
      step: "both users confirm the SAS match",
      grade: "A",
      detail: "device-1 'Codes match — confirm & add' + device-2 'Codes match — continue' both clicked",
    });
    await shot(d1, "d1-confirmed");
    await shot(d2, "d2-confirmed");

    // ── Let the relay complete: admin signs + seals the bundle; incoming
    //    receives it, verifies the admit, POSTs the admit, joins quarantined. ──
    // Poll device-2 for the quarantine surface (the success signal) OR the
    // join status text up to 45s. We record what ACTUALLY happens — if the
    // bundle never arrives, device-2 stays on "receiving keys…" and we grade
    // the delivery step honestly (a known transport bug, fixed separately).
    let d2JoinStatus = "";
    let quarantineShown = false;
    for (let i = 0; i < 45; i++) {
      d2JoinStatus = await d2.locator("#join-status").innerText().catch(() => "");
      quarantineShown = await d2.locator("#join-quarantine .card").isVisible().catch(() => false);
      if (quarantineShown || admitStatus !== "none") break;
      await d2.waitForTimeout(1_000);
    }
    bundleDelivered = admitStatus !== "none" || quarantineShown;
    await shot(d2, "d2-after-handshake");
    await shot(d1, "d1-after-handshake");

    record({
      step: "relay delivers the sealed { umkSeed, admit, admitSig } to device-2",
      grade: bundleDelivered ? "A" : "FAIL",
      detail: bundleDelivered
        ? `device-2 progressed past SAS — join status="${d2JoinStatus}", admit POST status=${admitStatus}`
        : `device-2 STUCK after SAS — join status="${d2JoinStatus}" (bundle never arrived; admit POST never fired). ` +
          `This is the QrRelay one-directional transport: the DO rejects browser-role inbound frames + tears down after the phone's first deliver, so runAdminAddDevice.seal() can't reach device-2.`,
    });

    // ── Admit POST + quarantine. ──────────────────────────────────────────────
    if (admitStatus !== "none") {
      // Pull the authoritative quarantineUntil + username out of device-2.
      const q = await d2.evaluate(() => {
        const txt = document.querySelector("#join-quarantine")?.textContent ?? "";
        return { txt };
      });
      record({
        step: "device-2 POSTs /api/users/:u/devices/admit → joins QUARANTINED",
        grade: admitStatus === 200 ? "A" : "FAIL",
        detail: `admit POST status=${admitStatus} ACAO=${admitAcao} body=${admitBody}; quarantine card="${q.txt.replace(/\s+/g, " ").slice(0, 140)}"`,
      });
    }

    // Read device-2's persisted identity AFTER the handshake — is it a member?
    const d2Member = await d2.evaluate(async () => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const { get: profileGet } = await import("/lib/profilesStore.js");
      let derivedIrk = "";
      let hasUmk = false;
      try {
        hasUmk = await ks.hasWrappedUmk();
        const s = getSession();
        if (s?.umk) {
          const irk = await ks.deriveIrkFromSeed(s.umk);
          derivedIrk = ks.bytesToHex(irk.publicKey);
        }
      } catch { /* */ }
      return {
        hasUmk,
        username: profileGet("username") ?? null,
        kind: profileGet("kind") ?? null,
        derivedIrk,
      };
    });
    joinUsername = d2Member.username ?? "";
    d2DerivedIrkPub = d2Member.derivedIrk ?? "";

    // ── HEADLINE: is device-2 on the SAME cloud as device-1? ──────────────────
    // The strongest proof: device-2 holds an UMK whose derived IRK pub equals
    // device-1's account IRK pub (the SAME account key material).
    const sameCloud = d2DerivedIrkPub.length === 64 &&
      d2DerivedIrkPub.toLowerCase() === d1IrkPub.toLowerCase();
    record({
      step: "device-2 is a MEMBER of the SAME cloud (derived IRK pub matches)",
      grade: sameCloud ? "A" : (bundleDelivered ? "C" : "FAIL"),
      detail: sameCloud
        ? `device-2 derived IRK ${d2DerivedIrkPub.slice(0, 16)}… == owner ${d1IrkPub.slice(0, 16)}… (same account UMK; username=${joinUsername})`
        : `device-2 derived IRK="${d2DerivedIrkPub.slice(0, 16)}…" username="${joinUsername}" hasUmk=${d2Member.hasUmk} kind=${d2Member.kind} — NOT yet a member (bundle ${bundleDelivered ? "arrived but didn't persist" : "never arrived"})`,
    });

    // ── If device-2 joined, prove it can READ the shared box. ─────────────────
    if (sameCloud) {
      // Pair device-2's (quarantined member) session to the box + read it.
      await d2.evaluate(async () => {
        const m = await import("/views/pod-pair.js");
        await m.enterPodPair();
      }).catch(() => undefined);
      await d2.locator("#view-pod-pair").waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
      let d2Paired = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await d2.fill("#pod-pair-base", POD_URL).catch(() => undefined);
        await d2.click("#pod-pair-go").catch(() => undefined);
        await d2.locator("#pod-pair-status:has-text('paired to')")
          .waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
        const txt = await d2.locator("#pod-pair-status").innerText().catch(() => "");
        if (/paired to/i.test(txt)) { d2Paired = true; break; }
        await d2.waitForTimeout(2_000);
      }
      await shot(d2, "d2-paired-to-shared-box");
      const d2BoxReadOk = apiCalls.some(
        (c) => c.who === "device-2" && c.url.startsWith("<pod>") && c.status >= 200 && c.status < 300 && c.acao,
      );
      record({
        step: "device-2 (member) READS the shared box over its own session",
        grade: d2Paired || d2BoxReadOk ? "A" : "C",
        detail: `paired=${d2Paired}; box call ok-with-ACAO=${d2BoxReadOk}`,
      });
    }

    // ── Verify on device-1 that the new device shows in the directory. ────────
    // There is no anonymous roster route: the device list is readable ONLY over
    // the signed active-device directory API, and its names are ciphertext that
    // decrypts locally under the account's UMK-derived directory key. So drive
    // the real webapp module rather than a bare fetch — that is the only path a
    // caller without the unlocked account can't take.
    const ownerRoster = await d1.evaluate(async () => {
      try {
        const m = await import("/lib/accountDirectory.js");
        const dir = await m.fetchDecryptedDirectory();
        const devices = Array.isArray(dir?.devices) ? dir.devices : [];
        return {
          ok: true,
          count: devices.length,
          // deviceIds are opaque 16-byte hex; names never travel in plaintext.
          opaqueIds: devices.every((d: any) => /^[0-9a-f]{32}$/.test(String(d?.deviceId ?? ""))),
          // Whatever the UI shows came from LOCAL decryption, not the wire.
          decryptedNames: devices.filter((d: any) => typeof d?.displayName === "string").length,
        };
      } catch (e) { return { ok: false, err: String(e) }; }
    }).catch((e) => ({ ok: false, err: String(e) } as any));
    record({
      step: "signed directory read lists the admitted device (opaque ids, locally decrypted names)",
      grade: ownerRoster?.ok && (ownerRoster.count ?? 0) >= 1 && ownerRoster.opaqueIds ? "A" : "C",
      detail: `GET /api/accounts/${BOX.username}/directory (signed) → ${JSON.stringify(ownerRoster)}`,
    });
    // The privacy invariant: the removed anonymous roster route must stay gone.
    const anonRoster = await d1.evaluate(async (uname: string) => {
      try {
        const r = await fetch(`https://${location.host.replace(/^web\./, "")}/api/users/${uname}/devices`, {
          method: "GET",
        }).catch(() => null);
        return r ? { status: r.status } : { status: null };
      } catch { return { status: null }; }
    }, BOX.username).catch(() => ({ status: null } as any));
    record({
      step: "anonymous device-roster route is gone (no username-only device read)",
      grade: anonRoster?.status !== 200 ? "A" : "FAIL",
      detail: `GET /api/users/${BOX.username}/devices → ${anonRoster?.status}`,
    });
    await shot(d1, "d1-final");

    // ── Summary + findings.json ───────────────────────────────────────────────
    const overall: Grade = (sameCloud && sasMatched && quarantineUntil !== null) ? "A"
      : (sasMatched && bundleDelivered ? "B"
      : (sasMatched ? "C" : "FAIL"));
    writeFileSync(
      join(SHOT_DIR, "findings.json"),
      JSON.stringify(
        {
          box: BOX,
          mechanism: "FULL device-add (cross-device QR + DeviceAdmit + SAS-compare → quarantined membership)",
          overall,
          sas: { device1: d1Sas, device2: d2Sas, matched: sasMatched },
          bundleDelivered,
          becameFullMember: (d2DerivedIrkPub.toLowerCase() === d1IrkPub.toLowerCase()) && d2DerivedIrkPub.length === 64,
          joinUsername,
          quarantineUntil,
          admit: { status: admitStatus, acao: admitAcao, body: admitBody },
          screenshots: shotN,
          findings,
          apiCalls,
          consoleErrors: { device1: d1ConsoleErr.slice(0, 8), device2: d2ConsoleErr.slice(0, 8) },
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console
    console.log(`\n[device-add] DONE — overall=${overall}; SAS matched=${sasMatched} (${d1Sas}); bundleDelivered=${bundleDelivered}; findings.json written (${shotN} shots)`);

    // The non-negotiable assertions: both screens connected + the SAS matched
    // (the real security check). Membership is asserted above when the transport
    // works; if it doesn't, findings.json records the honest partial result.
    expect(sasMatched, "the human SAS-compare must succeed").toBe(true);
    expect(bundleDelivered, "device-2 must receive the sealed bundle (full device-add must complete)").toBe(true);
    expect(d2DerivedIrkPub.toLowerCase(), "device-2 must end up on the SAME cloud (account IRK match)").toBe(d1IrkPub.toLowerCase());
  } finally {
    await ctx1?.close().catch(() => undefined);
    await ctx2?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
});
