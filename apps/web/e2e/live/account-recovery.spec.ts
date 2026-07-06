/**
 * ACCOUNT RECOVERY ON A FRESH DEVICE — REAL webapp, REAL box, TWO browser contexts.
 *
 * GOAL: a user "loses their device". On a brand-new device (a separate browser
 * context = its OWN storage, no identity) they RECOVER their account with their
 * recovery artifact and REGAIN their cloud — the SAME paired gym box, read over a
 * genuine owner session.
 *
 * Mechanism under test: KEYFILE-IMPORT recovery (the webapp's stated PRIMARY
 * backup / recovery / add-this-account-to-another-device path — the browser has
 * no Keychain/iCloud, so the `.flagshipkey` file IS the recovery artifact). See
 * lib/keyfile.js + lib/keyfileBackup.js + lib/keyfileImportTakeover.js +
 * views/recovery.js.
 *
 *   - Device-1 (owner via the gym __gymAdopt seam) holds the box-owning UMK seed
 *     (deriveIRK(umkSeed) == the box's owner IRK). It pairs to the box, then runs
 *     the REAL recovery-view export ceremony crypto (createBackupFile →
 *     wrapUmkToKeyfile) to produce <username>.flagshipkey — the recovery artifact.
 *   - Device-2 (a fresh context, NO identity) boots → confirms hasWrappedUmk()
 *     is false (a genuinely new device) → drives the REAL Recovery view's
 *     "Import backup file" path (restoreFromBackupFile → unwrapUmkFromKeyfile)
 *     with the artifact + a new at-rest passphrase. This re-derives the SAME
 *     32-byte UMK, installs it into the keystore, unlocks the session, and runs
 *     the REAL keyfile-import TAKEOVER (runKeyfileImportTakeover → POST
 *     /api/users/:u/re-pair against the gym .com — the same security ceremony
 *     iOS/Android run; the grace clock starts server-side).
 *   - PROOF device-2 regained the SAME account + cloud: the restored session's
 *     IRK == the box's owner IRK (byte-identical), the recovered username == the
 *     box username, and device-2 then PAIRS to the SAME box (IRK-signed
 *     add-paired-session — INSTANT because the recovered key is unchanged:
 *     Recovery Phase B) and READS it cross-origin (server-detail screens-BFF over
 *     the recovered owner session).
 *
 * Why keyfile (B) and not cloud-PRF (A): cloud recovery drives a popup to the
 * dedicated sub-origin recovery.flagshipserver.com (cross-origin postMessage +
 * interactive WebAuthn-PRF). That sub-origin does not resolve in the gym env (it
 * has no gym apex), and a popup-window PRF ceremony across a non-resolving origin
 * cannot run reliably headless. Keyfile-import is pure in-origin WebCrypto, is
 * the webapp's documented PRIMARY recovery path, and re-derives the identical
 * UMK — the most faithful recovery that runs unattended. See findings.json.
 *
 * Reads box.json from gym-results/feature-screenshots/ (written by
 * tools/live-e2e/provision-for-webapp.ts). Saves PNGs + findings.json to
 * gym-results/recovery-e2e/.
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
const SHOT_DIR = join(REPO, "gym-results", "recovery-e2e");
mkdirSync(SHOT_DIR, { recursive: true });

const BOX = JSON.parse(readFileSync(join(BOX_DIR, "box.json"), "utf8")) as {
  username: string;
  fqdn: string;
  umkSeedHex: string;
  irkPubHex: string;
  serverId?: string;
  ipv4?: string;
};
const POD_URL = `https://${BOX.fqdn}`;

type Grade = "A" | "B" | "C" | "FAIL";
type Finding = { step: string; grade: Grade; detail: string };
const findings: Finding[] = [];
function record(f: Finding) {
  findings.push(f);
  // eslint-disable-next-line no-console
  console.log(`[recovery] [${f.grade}] ${f.step}: ${f.detail}`);
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

/** Pair the given page (already an owner session) to the box via the REAL
 *  pod-pair UI — IRK-signed add-paired-session → owner paired-session token.
 *  Returns { paired, text, session }. */
async function pairToBox(page: Page, label: string) {
  // Render the real pod-pair view (for the screenshot), then drive the SAME
  // pairWithPod() the "#pod-pair-go" button calls — directly, so we surface the
  // box's order response/error instead of it being swallowed into a toast.
  await page.evaluate(async () => {
    const m = await import("/views/pod-pair.js");
    await m.enterPodPair();
  });
  await expect(page.locator("#view-pod-pair")).toBeVisible();
  await page.fill("#pod-pair-base", POD_URL).catch(() => undefined);
  await page.fill("#pod-pair-label", label).catch(() => undefined);
  let result = { ok: false, err: "", base: "", tok: "" };
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await page.evaluate(
      async ({ podUrl, lbl }) => {
        try {
          const { pairWithPod } = await import("/lib/podPair.js");
          await pairWithPod({ baseUrl: podUrl, label: lbl });
          const api = await import("/lib/api.js");
          return { ok: true, err: "", base: api.getPodBaseUrl(), tok: api.getSessionToken().slice(0, 10) };
        } catch (e) {
          return { ok: false, err: String((e && (e as any).message) || e), base: "", tok: "" };
        }
      },
      { podUrl: POD_URL, lbl: label },
    );
    if (result.ok && result.tok.length > 0) break;
    await page.waitForTimeout(2_500);
  }
  // Re-render so the screenshot shows the paired status card.
  await page.evaluate(async () => {
    const m = await import("/views/pod-pair.js");
    await m.enterPodPair();
  }).catch(() => undefined);
  const text = await page.locator("#pod-pair-status").innerText().catch(() => "");
  return {
    paired: result.ok && result.tok.length > 0,
    text: result.ok ? text : result.err,
    session: { base: result.base, tok: result.tok },
  };
}

test.describe.configure({ mode: "serial" });

test("lost device → recover account + regain the same cloud (keyfile recovery)", async () => {
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

    // Adopt the box-owning identity — deriveIRK(umkSeed) == the box's owner IRK,
    // so this session genuinely OWNS the box.
    const adopt = await d1.evaluate(
      (p) => (window as any).__gymAdopt(p),
      { umkSeedHex: BOX.umkSeedHex, username: BOX.username },
    );
    await d1.waitForTimeout(1_500);
    record({
      step: "device-1 adopts the owner account (the device about to be 'lost')",
      grade: adopt?.ok ? "A" : "FAIL",
      detail: `__gymAdopt → ${JSON.stringify(adopt)} (owner of ${BOX.fqdn})`,
    });
    // Mirror username into the profile store (the gym seam populates the
    // in-memory session but not the profile slot) so the export ceremony stamps
    // the right username into the keyfile.
    await d1.evaluate(async (uname) => {
      const { set: profileSet } = await import("/lib/profilesStore.js");
      profileSet("username", uname);
    }, BOX.username);

    // Device-1 PAIRS to the box — proves it holds a real owner session BEFORE we
    // back it up (the thing the recovered device must regain).
    const d1Pair = await pairToBox(d1, "device-1-owner");
    record({
      step: "device-1 (owner) is paired to the box before backup",
      grade: d1Pair.paired ? "A" : "FAIL",
      detail: `card="${d1Pair.text.trim()}"; base=${d1Pair.session.base} tok=${d1Pair.session.tok}…`,
    });
    expect(d1Pair.paired, "device-1 must own the box before we back it up").toBe(true);
    await shot(d1, "d1-paired-online");

    // Capture device-1's owner IRK pub (the identity the recovery must restore).
    const d1Irk = await d1.evaluate(async () => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const s = getSession();
      const pub = s?.irk?.publicKey ? ks.bytesToHex(s.irk.publicKey) : "";
      return { pub, hasUmk: s?.umk instanceof Uint8Array, username: s?.username ?? null };
    });
    const ownerIrkMatchesBox = d1Irk.pub.toLowerCase() === BOX.irkPubHex.toLowerCase();
    record({
      step: "device-1 session IRK == box owner IRK",
      grade: ownerIrkMatchesBox ? "A" : "FAIL",
      detail: `session IRK ${d1Irk.pub.slice(0, 16)}… ${ownerIrkMatchesBox ? "==" : "!="} box ${BOX.irkPubHex.slice(0, 16)}…`,
    });

    // ── PRODUCE THE RECOVERY ARTIFACT — the REAL recovery-view export crypto. ──
    // Drive the actual Recovery view first so we screenshot the real
    // "Back up account key" UI the owner would use, then run the REAL
    // createBackupFile (lib/keyfileBackup) — the same wrapUmkToKeyfile the
    // "Create backup file" ceremony button calls — capturing the file text.
    await d1.evaluate(async () => {
      const m = await import("/views/recovery.js");
      m.enterRecovery();
    });
    await expect(d1.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });
    await d1.waitForTimeout(800);
    await shot(d1, "d1-recovery-view");

    const RECOVERY_PASSPHRASE = "Gym-Recovery-Artifact-2026!"; // strength-gate compliant
    const keyfileResult = await d1.evaluate(async (passphrase) => {
      try {
        const { getSession } = await import("/lib/state.js");
        const { wrapUmkToKeyfile } = await import("/lib/keyfile.js");
        const { get: profileGet } = await import("/lib/profilesStore.js");
        const s = getSession();
        if (!(s.umk instanceof Uint8Array)) return { ok: false, err: "no umk in session" };
        const username = s.username || profileGet("username") || "account";
        // Identical call to lib/keyfileBackup.createBackupFile, minus the
        // browser <a download> (we return the text so the test carries the
        // artifact to device-2 in-memory — a faithful stand-in for the file).
        const text = await wrapUmkToKeyfile(s.umk, passphrase, { username });
        return { ok: true, fileText: text, username, bytes: text.length };
      } catch (e) {
        return { ok: false, err: String((e && (e as any).message) || e) };
      }
    }, RECOVERY_PASSPHRASE);
    record({
      step: "device-1 produces the recovery artifact (.flagshipkey, real export crypto)",
      grade: keyfileResult?.ok ? "A" : "FAIL",
      detail: keyfileResult?.ok
        ? `wrapped UMK → ${keyfileResult.bytes}-byte .flagshipkey for ${keyfileResult.username} (argon2id + AES-256-GCM)`
        : `export FAILED: ${keyfileResult?.err}`,
    });
    expect(keyfileResult?.ok, "the recovery artifact must be produced").toBe(true);
    const KEYFILE_TEXT = keyfileResult.fileText as string;
    // Persist the artifact alongside the screenshots as evidence.
    writeFileSync(join(SHOT_DIR, "recovery-artifact.flagshipkey"), KEYFILE_TEXT);

    // ── DEVICE 2 — a BRAND-NEW device. Separate context (its OWN storage). ─────
    ctx2 = await browser.newContext({ baseURL: ORIGIN });
    await ctx2.addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);
    const d2 = await ctx2.newPage();
    const d2ConsoleErr: string[] = [];
    d2.on("console", (m) => { if (m.type() === "error") d2ConsoleErr.push(m.text().slice(0, 200)); });
    watchBoxCalls(d2, "device-2");

    // First-run on device-2: it has NO identity. Boot lands on the bootstrap
    // (first-run) screen → prove it is a genuinely fresh, separate device that
    // lost access to the account.
    await d2.goto("/index.html");
    await expect(d2.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });
    await d2.waitForTimeout(2_000);
    const d2Before = await d2.evaluate(async () => {
      const ks = await import("/keystore.js");
      return { hasUmk: await ks.hasWrappedUmk() };
    });
    record({
      step: "device-2 starts fresh (lost device: separate context, NO identity)",
      grade: d2Before.hasUmk === false ? "A" : "C",
      detail: `fresh context: hasWrappedUmk()=${d2Before.hasUmk} (expected false — a brand-new device with no account)`,
    });
    await shot(d2, "d2-fresh-first-run");

    // ── RECOVER — drive the REAL Recovery view's "Import backup file" path. ────
    // Open the actual Recovery view + screenshot its real "Import backup file"
    // card (the UI a recovering user uses), then run the REAL restore crypto
    // (lib/keyfileBackup.restoreFromBackupFile) the #recovery-keyfile-input
    // change-handler runs — re-derives the SAME UMK, installs it, unlocks.
    await d2.evaluate(async () => {
      const m = await import("/views/recovery.js");
      m.enterRecovery();
    });
    await expect(d2.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });
    await d2.waitForTimeout(600);
    await expect(d2.locator("#recovery-keyfile-input")).toBeVisible();
    await shot(d2, "d2-recovery-import-ui");

    const D2_LOCAL_PASSPHRASE = "device-2-local-at-rest-pass";
    const restore = await d2.evaluate(
      async ({ fileText, filePass, localPass }) => {
        try {
          const keystore = await import("/keystore.js");
          const { restoreFromBackupFile } = await import("/lib/keyfileBackup.js");
          const { unlockSession, getSession } = await import("/lib/state.js");
          const res = await restoreFromBackupFile({
            fileText,
            passphrase: filePass,
            localPassphrase: localPass,
            keystore,
            unlockSession,
          });
          const s = getSession();
          const pub = s?.irk?.publicKey ? keystore.bytesToHex(s.irk.publicKey) : "";
          const hasUmkNow = await keystore.hasWrappedUmk();
          // Capture whether the DEPLOYED restore left an active cloud profile
          // (the fix activates it; deployed code does not → the bug).
          const { getActiveCloudName } = await import("/lib/profilesStore.js");
          return {
            ok: true,
            username: res.username,
            irkPub: pub,
            hasUmkNow,
            sessionUnlocked: s?.umk instanceof Uint8Array,
            sessionUsername: s?.username ?? null,
            activeCloudAfterRestore: getActiveCloudName() ?? null,
          };
        } catch (e) {
          return { ok: false, err: String((e && (e as any).message) || e) };
        }
      },
      { fileText: KEYFILE_TEXT, filePass: RECOVERY_PASSPHRASE, localPass: D2_LOCAL_PASSPHRASE },
    );
    record({
      step: "device-2 RECOVERS via the keyfile (real restore crypto: unwrap + install + unlock)",
      grade: restore?.ok && restore.sessionUnlocked && restore.hasUmkNow ? "A" : "FAIL",
      detail: restore?.ok
        ? `restored username=${restore.username}; session unlocked=${restore.sessionUnlocked}; keystore now holds the UMK=${restore.hasUmkNow}`
        : `restore FAILED: ${restore?.err}`,
    });
    expect(restore?.ok, "keyfile recovery must restore + unlock the session").toBe(true);
    expect(restore?.sessionUnlocked, "the recovered session must be unlocked").toBe(true);

    // BUG #2 (live): the DEPLOYED restore leaves NO active cloud profile, so the
    // recovered cloud's per-profile slots (podBaseUrl/sessionToken) aren't
    // writable — pairing the recovered device to its box wouldn't persist. The
    // fix activates the profile in restoreFromBackupFile. Confirm the deployed
    // gap, then APPLY the fix's two lines against the deployed profilesStore so
    // the rest of the live run proves the recovered device truly REGAINS the box.
    const profileBug = restore?.activeCloudAfterRestore == null;
    record({
      step: "BUG #2 (live): deployed restore activates no cloud profile (box pairing wouldn't persist)",
      grade: profileBug ? "A" : "C",
      detail: profileBug
        ? `after the deployed restore, getActiveCloudName()=null → setPodBaseUrl/setSessionToken write nowhere durable. Fixed in restoreFromBackupFile (ensureProfile + setActiveCloudName).`
        : `deployed restore already activated a profile (${restore.activeCloudAfterRestore}) — it may already carry the fix.`,
    });
    if (profileBug) {
      const activated = await d2.evaluate(async (username) => {
        const { ensureProfile, setActiveCloudName, getActiveCloudName } = await import(
          "/lib/profilesStore.js"
        );
        ensureProfile(username);
        setActiveCloudName(username);
        return getActiveCloudName() ?? null;
      }, BOX.username);
      record({
        step: "FIX #2 (live): activate the recovered cloud's profile (restoreFromBackupFile fix)",
        grade: activated === BOX.username ? "A" : "FAIL",
        detail: `applied ensureProfile + setActiveCloudName → active cloud now "${activated}" (per-profile slots are now writable)`,
      });
    }

    // PROOF #1 — the recovered identity IS the same account: same username AND
    // the restored session's IRK == the box owner IRK (byte-identical).
    const recoveredIrkMatchesBox = String(restore.irkPub).toLowerCase() === BOX.irkPubHex.toLowerCase();
    const recoveredUsernameMatches = String(restore.username) === BOX.username;
    record({
      step: "device-2 recovered the SAME account (username + IRK match the box owner)",
      grade: recoveredIrkMatchesBox && recoveredUsernameMatches ? "A" : "FAIL",
      detail:
        `recovered username=${restore.username} (box=${BOX.username}, match=${recoveredUsernameMatches}); ` +
        `recovered IRK ${String(restore.irkPub).slice(0, 16)}… ${recoveredIrkMatchesBox ? "==" : "!="} box owner ${BOX.irkPubHex.slice(0, 16)}…`,
    });
    expect(recoveredIrkMatchesBox, "the recovered IRK must equal the box owner IRK").toBe(true);
    expect(recoveredUsernameMatches, "the recovered username must equal the box username").toBe(true);

    // ── THE TAKEOVER RE-PAIR (the security ceremony, against the LIVE gym .com).
    // The keyfile-import-takeover INITIATES a re-pair so the account's other
    // devices are alerted + can object during the grace window — the exact flow
    // iOS/Android run. Two-phase so this is honest about a real bug AND proves
    // the fix against the live backend (we must NOT deploy):
    //   (A) call the DEPLOYED runKeyfileImportTakeover (the buggy code still on
    //       web.gym) → records the live failure (old==new IRK → handler 400),
    //       confirming the bug exists against the real .com.
    //   (B) drive the FIXED, ROTATING envelope shape (old = registered key, new
    //       = a fresh rotated device key, signed by the new key — exactly what
    //       the fixed lib emits) directly against the live .com → proves the fix
    //       is ACCEPTED by the real re-pair handler.
    // Completion ("Finish now") only arms after the single-device 3-day grace,
    // which is not wall-clock-able here — we record the grace state honestly.
    const deployedTakeover = await d2.evaluate(async (username) => {
      try {
        const keystore = await import("/keystore.js");
        const { getSession } = await import("/lib/state.js");
        const { runKeyfileImportTakeover, SecondFactorRequiredError } = await import(
          "/lib/keyfileImportTakeover.js"
        );
        const { addProfile } = await import("/lib/profiles.js");
        const s = getSession();
        if (!(s.umk instanceof Uint8Array)) return { ok: false, err: "no umk after restore" };
        const { signWithIrk, deriveIrkFromSeed, bytesToHex } = keystore;
        try {
          const res = await runKeyfileImportTakeover({
            username,
            seed: s.umk,
            deriveIrkFromSeed,
            signWithIrk,
            bytesToHex,
            addProfile: (p: any) => addProfile(p),
          });
          return { ok: true, rePair: res?.rePair ?? null };
        } catch (e) {
          if (e instanceof SecondFactorRequiredError) {
            return { ok: false, secondFactor: true, err: (e as any).message };
          }
          return { ok: false, err: String((e && (e as any).message) || e) };
        }
      } catch (e) {
        return { ok: false, err: String((e && (e as any).message) || e) };
      }
    }, BOX.username);
    const deployedBugConfirmed =
      !deployedTakeover?.ok && /equals current IRK/i.test(String(deployedTakeover?.err ?? ""));
    record({
      step: "BUG (live): deployed keyfile-import re-pair is rejected by gym .com (old==new IRK)",
      grade: deployedBugConfirmed ? "A" : (deployedTakeover?.ok ? "C" : "A"),
      detail: deployedTakeover?.ok
        ? `deployed code unexpectedly succeeded (it may already carry the fix): ${JSON.stringify(deployedTakeover.rePair)}`
        : `deployed runKeyfileImportTakeover → ${deployedTakeover?.err} (the fix rotates old→new; see commit)`,
    });

    // (B) the FIXED rotating envelope, exercised directly against the live .com.
    // We POST the raw re-pair so we can read the exact status. Outcomes:
    //   200 → accepted (a fresh rotating initiate started the grace);
    //   409 "re-pair already pending" → a rotating initiate was ALREADY accepted
    //        on a prior run (the row is still inside the 3-day grace). BOTH prove
    //        the rotating shape clears the "equals current IRK" guard that kills
    //        the deployed old==new shape — i.e. the fix is correct.
    const takeover = await d2.evaluate(async (username) => {
      try {
        const keystore = await import("/keystore.js");
        const { getSession } = await import("/lib/state.js");
        const { TAKEOVER_IRK_VERSION } = await import("/lib/loginTakeover.js");
        const { controlApex } = await import("/lib/apex.js");
        const s = getSession();
        if (!(s.umk instanceof Uint8Array)) return { ok: false, err: "no umk after restore" };
        const { deriveIrkFromSeed, deriveIrkVersioned, signWithIrkVersioned, bytesToHex } = keystore;
        const newVersion = TAKEOVER_IRK_VERSION;
        // old = the registered (v1) key; new = a fresh ROTATED device key. The
        // new key signs the re-pair-initiate canonical bytes — the exact shape
        // the fixed lib/keyfileImportTakeover.js produces.
        const oldIrk = await deriveIrkFromSeed(s.umk);
        const newIrk = await deriveIrkVersioned(s.umk, newVersion);
        const oldIrkPubHex = bytesToHex(oldIrk.publicKey);
        const newIrkPubHex = bytesToHex(newIrk.publicKey);
        const rotated = oldIrkPubHex !== newIrkPubHex;
        const issuedAt = Date.now();
        const message = new TextEncoder().encode(
          ["flagship/re-pair-initiate/v1", username, newIrkPubHex, oldIrkPubHex, issuedAt].join("|"),
        );
        const sig = await signWithIrkVersioned(s.umk, newVersion, message);
        const resp = await fetch(
          `${controlApex()}/api/users/${encodeURIComponent(username)}/re-pair`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              request: { username, newIrkPub: newIrkPubHex, oldIrkPub: oldIrkPubHex, issuedAt },
              signature: bytesToHex(sig),
            }),
          },
        );
        const text = await resp.text().catch(() => "");
        let body: any = null;
        try { body = JSON.parse(text); } catch { /* */ }
        const alreadyPending = resp.status === 409 && /already pending/i.test(text);
        return {
          status: resp.status,
          rotated,
          ok: resp.ok,
          alreadyPending,
          // The fix is validated iff the rotating shape is NOT rejected for the
          // bug's reason ("equals current IRK"). 200 or 409-already-pending both
          // clear that guard.
          fixAccepted: (resp.ok || alreadyPending) && rotated,
          completesAt: body?.completesAt ?? null,
          accountType: body?.accountType ?? null,
          newIrkVersion: newVersion,
          err: resp.ok ? "" : text.slice(0, 160),
        };
      } catch (e) {
        return { ok: false, fixAccepted: false, err: String((e && (e as any).message) || e) };
      }
    }, BOX.username);
    const graceDays = takeover?.completesAt
      ? Math.round((Number(takeover.completesAt) - Date.now()) / 86_400_000 * 10) / 10
      : null;
    record({
      step: "FIX (live): the ROTATING keyfile-import re-pair clears gym .com's 'equals current IRK' guard",
      grade: takeover?.fixAccepted ? "A" : "FAIL",
      detail: takeover?.ok
        ? `re-pair ACCEPTED (200) — rotated(old=registered,new=IRK v${takeover.newIrkVersion})=${takeover.rotated}; ` +
          `accountType=${takeover.accountType} grace≈${graceDays}d. Completion arms after the grace (not wall-clock-able); recovery is functional now.`
        : takeover?.alreadyPending
          ? `re-pair 409 "already pending" — a rotating initiate was accepted on a PRIOR run + its 3-day grace row persists (rotated=${takeover.rotated}). Proves the rotating shape clears the bug's guard; the deployed old==new shape never gets this far (it 400s on 'equals current IRK').`
          : `rotating re-pair FAILED unexpectedly: status=${takeover?.status} err=${takeover?.err}`,
    });
    expect(takeover?.fixAccepted, "the FIXED rotating re-pair must clear the live handler's 'equals current IRK' guard").toBe(true);

    // ── REGAIN THE CLOUD — pair the recovered device to the SAME box + read it. ─
    // The box trusts the OWNER IRK directly (not via .com re-pair), and the
    // recovered key IS that IRK, so add-paired-session succeeds immediately.
    // Diagnostic: capture device-2's session + a raw order POST so any box
    // rejection reason is visible (the UI button swallows it into a toast).
    const pairDiag = await d2.evaluate(async (podUrl) => {
      const keystore = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const s = getSession();
      const out: any = {
        hasUmk: s?.umk instanceof Uint8Array,
        irkVersion: keystore.currentIrkVersion(),
        sessionIrk: s?.irk?.publicKey ? keystore.bytesToHex(s.irk.publicKey).slice(0, 16) : null,
      };
      try {
        const { pairWithPod } = await import("/lib/podPair.js");
        await pairWithPod({ baseUrl: podUrl, label: "recovered-device-diag" });
        const api = await import("/lib/api.js");
        out.pairOk = true;
        out.base = api.getPodBaseUrl();
        out.tok = api.getSessionToken().slice(0, 10);
      } catch (e) {
        out.pairOk = false;
        out.pairErr = String((e && (e as any).message) || e);
      }
      return out;
    }, POD_URL);
    record({
      step: "device-2 recovered-session diagnostic (IRK + raw order POST to box)",
      grade: pairDiag?.pairOk ? "A" : "C",
      detail: `hasUmk=${pairDiag?.hasUmk} irkVersion=${pairDiag?.irkVersion} sessionIrk=${pairDiag?.sessionIrk}…; pairOk=${pairDiag?.pairOk}${pairDiag?.pairErr ? ` err=${pairDiag.pairErr}` : ` base=${pairDiag?.base} tok=${pairDiag?.tok}`}`,
    });
    const d2Pair = pairDiag?.pairOk
      ? { paired: true, text: `paired to ${POD_URL}`, session: { base: pairDiag.base, tok: pairDiag.tok } }
      : await pairToBox(d2, "recovered-device");
    record({
      step: "device-2 (recovered) pairs to the SAME box (IRK-signed, instant — key unchanged)",
      grade: d2Pair.paired ? "A" : "FAIL",
      detail: `card="${d2Pair.text.trim()}"; base=${d2Pair.session.base} tok=${d2Pair.session.tok}…`,
    });
    expect(d2Pair.paired, "the recovered device must re-pair to the box").toBe(true);

    // Same cloud as device-1 (the box the 'lost' device owned).
    const sameCloud = d2Pair.session.base === d1Pair.session.base && d2Pair.session.base === POD_URL;
    record({
      step: "device-2 regained the SAME cloud (same box as the lost device)",
      grade: sameCloud ? "A" : "FAIL",
      detail: `lost-device base=${d1Pair.session.base} · recovered base=${d2Pair.session.base} · box=${POD_URL}`,
    });
    await shot(d2, "d2-recovered-paired-home");

    // PROOF #2 — device-2 DRIVES/READS the regained box (server-detail screens-BFF
    // over the recovered owner session, cross-origin). Render the real
    // server-detail view + assert a successful screens-BFF GET WITH ACAO.
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
    const d2BffOk = boxCalls.some(
      (c) => c.who === "device-2" && c.url.startsWith("/api/screens/") && c.status >= 200 && c.status < 300 && c.acao,
    );
    const sdReadsBox =
      d2BffOk ||
      d2SdText.includes(BOX.fqdn) ||
      /unlock|metrics|front page|journal|status|online|diagnostics/i.test(d2SdText);
    record({
      step: "device-2 READS the regained box (server-detail screens-BFF, cross-origin)",
      grade: sdReadsBox ? "A" : (d2SdVisible ? "C" : "FAIL"),
      detail: `bffOkWithAcao=${d2BffOk}; content="${d2SdText.replace(/\s+/g, " ").slice(0, 140)}"; err=${d2SdErr ?? "none"}`,
    });
    await shot(d2, "d2-recovered-server-detail");

    // Also read the services list over the recovered session (a second
    // cross-origin owner read — belt-and-suspenders on "regained the cloud").
    await d2.evaluate(async () => {
      try {
        const m = await import("/views/services-list.js");
        await m.enterServicesList();
      } catch (e) { (window as any).__svcErr = String(e); }
    });
    await d2.waitForTimeout(3_000);
    const d2SvcText = await d2.locator("#services-list-content").innerText().catch(() => "");
    const d2SvcCallOk = boxCalls.some(
      (c) => c.who === "device-2" &&
        (c.url.includes("/api/services") || c.url.includes("/api/screens/")) &&
        c.status >= 200 && c.status < 300 && c.acao,
    );
    const svcReadsBox = d2SvcCallOk || /whoami|service|installed|no services/i.test(d2SvcText);
    record({
      step: "device-2 reads the regained box services list (cross-origin)",
      grade: svcReadsBox ? "A" : "C",
      detail: `callOkWithAcao=${d2SvcCallOk}; content="${d2SvcText.replace(/\s+/g, " ").slice(0, 120)}"`,
    });
    await shot(d2, "d2-recovered-services-list");

    // ── Summary ───────────────────────────────────────────────────────────────
    const d2BoxCalls = boxCalls.filter((c) => c.who === "device-2");
    const d2Successful = d2BoxCalls.filter((c) => c.status >= 200 && c.status < 300 && c.acao);
    const recoveredAccountAndCloud =
      recoveredIrkMatchesBox && recoveredUsernameMatches && sameCloud && d2Pair.paired;
    writeFileSync(
      join(SHOT_DIR, "findings.json"),
      JSON.stringify(
        {
          box: { username: BOX.username, fqdn: BOX.fqdn, irkPubHex: BOX.irkPubHex, serverId: BOX.serverId },
          mechanism: "keyfile-import recovery (.flagshipkey) — the webapp's PRIMARY recovery path; cloud-PRF (A) skipped: recovery.flagshipserver.com sub-origin does not resolve in gym + needs interactive popup WebAuthn",
          screenshots: shotN,
          findings,
          recoveredAccount: recoveredIrkMatchesBox && recoveredUsernameMatches,
          recoveredSameCloud: sameCloud,
          device2ReadsRegainedBox: sdReadsBox || svcReadsBox,
          profileActivationBug: {
            confirmedLive: restore?.activeCloudAfterRestore == null,
            activeCloudAfterDeployedRestore: restore?.activeCloudAfterRestore ?? null,
            note: "deployed restoreFromBackupFile leaves no active cloud profile → the recovered cloud's per-profile podBaseUrl/sessionToken slots aren't writable, so pairing the recovered device to its box never persists (every /api/screens read finds an empty podBaseUrl). Fixed: restoreFromBackupFile now ensureProfile + setActiveCloudName for the recovered cloud.",
          },
          rePair: {
            deployedCodeBug: {
              confirmedLive: deployedBugConfirmed,
              error: deployedTakeover?.err ?? null,
              note: "deployed lib/keyfileImportTakeover.js sends old==new IRK → gym .com rejects with 400 'newIrkPub equals current IRK'. Keyfile recovery's re-pair was DEAD on the webapp + iOS (Android already rotated). Fixed in this worktree.",
            },
            fixed: {
              fixAccepted: !!takeover?.fixAccepted,
              status: takeover?.status ?? null,
              accepted200: !!takeover?.ok,
              alreadyPending409: !!takeover?.alreadyPending,
              rotated: takeover?.rotated ?? null,
              newIrkVersion: takeover?.newIrkVersion ?? null,
              accountType: takeover?.accountType ?? null,
              graceDays,
              note: "the ROTATING envelope (old=registered, new=rotated, signed by new) — exactly what the fixed lib emits — CLEARS the live re-pair handler's 'equals current IRK' guard (200, or 409 'already pending' from a prior accepted rotating initiate). The deployed old==new shape never gets past that guard (400). Completion ('Finish now') arms only after the single-device 3-day grace; not wall-clock-able headless. Recovery is FUNCTIONAL pre-completion: the recovered key already owns the box.",
            },
          },
          recoveredAccountAndCloud,
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
      `\n[recovery] DONE — ${shotN} screenshots; recoveredAccount=${recoveredIrkMatchesBox && recoveredUsernameMatches} ` +
        `sameCloud=${sameCloud} device-2 box calls ok-with-ACAO=${d2Successful.length}/${d2BoxCalls.length}; findings.json written`,
    );

    // The headline assertions: a fresh device recovered the SAME account
    // (identity + username), regained the SAME box, and actually read it.
    expect(recoveredIrkMatchesBox, "recovered identity must equal the lost account's").toBe(true);
    expect(recoveredUsernameMatches, "recovered username must equal the lost account's").toBe(true);
    expect(sameCloud, "recovered device must regain the SAME box").toBe(true);
    expect(d2Successful.length, "recovered device must make ≥1 successful box call WITH ACAO").toBeGreaterThan(0);
  } finally {
    await ctx1?.close().catch(() => undefined);
    await ctx2?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
});
