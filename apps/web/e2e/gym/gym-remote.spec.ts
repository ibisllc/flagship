/**
 * The browser remote, QR-first (AGENTS.md "Remote is QR-first", 2026-10-14):
 * remote.<apex> shows a QR at once, the phone that scans it shows the same
 * 6-digit code, and the owner's approval arrives as a sealed
 * `flagship/remote-ticket/v1` the page redeems on the server the phone named.
 * The page never asks for an account and never reads `/pods`.
 *
 * The surface switches on the HOST (`isRemoteSurface()` reads
 * location.hostname), so the shell is served at https://remote.flagshipserver.com
 * from the repo's webapp tree through page.route — the same files the Worker's
 * host rewrite serves, on the real origin. The QR relay (`/qr-pipe`) is a
 * routed WebSocket playing the relay; the phone's side (X25519 + HKDF + AES-GCM,
 * the same derivation as lib/pairingRelay.js) runs here in Node, so the code
 * and the sealed ticket are real crypto. Every other request is a 404.
 *
 * Handles mirror iOS CompanionDockScreen: #dock-code ↔ companion-dock-match-code.
 */

import { test, expect, type Page, type TestInfo, type WebSocketRoute } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REMOTE = "https://remote.flagshipserver.com";
const BOX = "https://home.smoketest.flagship.services";
const PUBLIC_ROOT = normalize(fileURLToPath(new URL("../../public/", import.meta.url)));
const WEBAPP_ROOT = join(PUBLIC_ROOT, "webapp");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function fileFor(pathname: string): string | null {
  const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  for (const root of [WEBAPP_ROOT, PUBLIC_ROOT]) {
    const p = normalize(join(root, rel));
    if (p.startsWith(root) && existsSync(p) && !statSync(p).isDirectory()) return p;
  }
  return extname(rel) === "" ? join(WEBAPP_ROOT, "index.html") : null;
}

async function shot(page: Page, testInfo: TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

/* ── the phone's side of the QR relay ── */

const subtle = globalThis.crypto.subtle;
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

async function phoneSeal(browserPkB64u: string, ticket: unknown) {
  const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const phonePk = b64u(new Uint8Array(await subtle.exportKey("raw", kp.publicKey)));
  const peer = await subtle.importKey("raw", Buffer.from(browserPkB64u, "base64url"), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: peer }, kp.privateKey, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const expand = async (info: string, bits: number) =>
    new Uint8Array(
      await subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("flagship/qr/v1"), info: new TextEncoder().encode(info) },
        base,
        bits,
      ),
    );
  const kEnc = await subtle.importKey("raw", await expand("flagship/qr/enc/v1", 256), "AES-GCM", false, ["encrypt"]);
  const s = await expand("flagship/qr/sas/v1", 32);
  const sas = (((s[0]! << 24) | (s[1]! << 16) | (s[2]! << 8) | s[3]!) >>> 0) % 1_000_000;
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce }, kEnc, new TextEncoder().encode(JSON.stringify(ticket))),
  );
  return { phonePk, sas: sas.toString().padStart(6, "0"), ciphertext: b64u(ct), nonce: b64u(nonce) };
}

/* ── the rig ── */

interface Rig {
  requests: string[];
  sockets: Array<{ url: string; ws: WebSocketRoute }>;
  redeems: Array<Record<string, unknown>>;
}

async function openRemote(page: Page, path = "/"): Promise<Rig> {
  const rig: Rig = { requests: [], sockets: [], redeems: [] };
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: REMOTE });
  page.on("request", (r) => rig.requests.push(r.url()));
  await page.routeWebSocket(/\/qr-pipe\//, (ws) => {
    rig.sockets.push({ url: ws.url(), ws });
    ws.send(JSON.stringify({ kind: "accepted" }));
    ws.onMessage(() => ws.send(JSON.stringify({ kind: "error", reason: "browser sends nothing" })));
  });
  await page.route(
    (url) => !url.href.startsWith("http://127.0.0.1"),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === REMOTE) {
        const file = fileFor(url.pathname);
        if (file) {
          await route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
          return;
        }
      }
      if (url.origin === BOX && url.pathname === "/api/companion/redeem" && route.request().method() === "POST") {
        rig.redeems.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            companionSessionToken: "gym-companion-session-token-0001",
            expiresAt: Date.now() + 8 * 3_600_000,
            podBaseUrl: BOX,
            username: "smoketest",
          }),
        });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "gym: no stub" }) });
    },
  );
  await page.goto(`${REMOTE}${path}`);
  await expect(page.locator("#view-dock-start")).toBeVisible({ timeout: 10_000 });
  return rig;
}

/** The approval link the QR encodes, read through the page's own Copy button. */
async function approvalLink(page: Page): Promise<URL> {
  await expect(page.locator("#dock-qr svg")).toBeVisible({ timeout: 10_000 });
  await page.click("#dock-copy");
  await expect(page.locator("#toast")).toContainText("Link copied");
  return new URL(await page.evaluate(() => navigator.clipboard.readText()));
}

const readsPods = (rig: Rig) => rig.requests.filter((u) => /\/pods\b|\/api\/username\//.test(u));

function ticketFor(podBaseUrl: string) {
  return {
    kind: "flagship/remote-ticket/v1",
    ticketId: "0123456789abcdef0123456789abcdef",
    ticketSecret: "ab".repeat(32),
    username: "smoketest",
    podBaseUrl,
  };
}

test.describe("gym webapp remote", () => {
  test("gym remote shows the QR at once and asks for no account", async ({ page }, testInfo) => {
    const rig = await openRemote(page);
    const link = await approvalLink(page);
    // https app link on the control apex, carrying the relay session + this
    // browser's ephemeral X25519 key (32 bytes, base64url).
    expect(link.origin).toBe("https://flagshipserver.com");
    expect(link.pathname).toBe("/remote");
    const sid = link.searchParams.get("s") ?? "";
    expect(sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(link.searchParams.get("k") ?? "", "base64url")).toHaveLength(32);
    // The browser joined that very relay session as the browser.
    expect(rig.sockets).toHaveLength(1);
    expect(rig.sockets[0]!.url).toBe(`wss://flagshipserver.com/qr-pipe/${sid}?role=browser`);
    // No code until a phone joins; nothing to type; no account read.
    await expect(page.locator("#dock-code-step")).toBeHidden();
    await expect(page.locator("#view-dock-start input")).toHaveCount(0);
    await expect(page.locator("#view-bootstrap")).toBeHidden();
    await expect(page.locator("#view-wizard")).toBeHidden();
    expect(readsPods(rig)).toEqual([]);
    await shot(page, testInfo, "remote-qr");

    // Every entry path on this origin is the remote ceremony, never the owner shell.
    const deep = await openRemote(page, "/?view=settings");
    await expect(page.locator("#dock-qr svg")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#view-settings")).toBeHidden();
    expect(readsPods(deep)).toEqual([]);
  });

  test("gym remote shows the phone's code and redeems the sealed ticket on the named server", async ({ page }, testInfo) => {
    const rig = await openRemote(page);
    const link = await approvalLink(page);
    const sealed = await phoneSeal(link.searchParams.get("k")!, ticketFor(BOX));
    const relay = rig.sockets[0]!.ws;

    // The phone scans and says hello: both screens show the same code.
    relay.send(JSON.stringify({ kind: "peer-hello", phonePk: sealed.phonePk }));
    await expect(page.locator("#dock-code-step")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#dock-code")).toHaveText(`${sealed.sas.slice(0, 3)} ${sealed.sas.slice(3)}`);
    await expect(page.locator("#dock-status")).toHaveText("Waiting for approval on your phone…");
    await shot(page, testInfo, "remote-code");

    // The owner approves on the phone: the sealed ticket arrives and the page
    // redeems it on the server the phone picked — and only there.
    relay.send(JSON.stringify({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce }));
    await expect.poll(() => rig.redeems.length, { timeout: 10_000 }).toBe(1);
    expect(rig.redeems[0]).toEqual({ ticketId: "0123456789abcdef0123456789abcdef", ticketSecret: "ab".repeat(32) });
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    const profile = await page.evaluate(async () => {
      const store = await import("/lib/profilesStore.js");
      return { kind: store.get("kind"), podBaseUrl: store.get("podBaseUrl"), username: store.get("username") };
    });
    expect(profile).toEqual({ kind: "companion", podBaseUrl: BOX, username: "smoketest" });
    // The relay never learned the account; the page never read /pods to get here.
    const redeemAt = rig.requests.findIndex((u) => u.endsWith("/api/companion/redeem"));
    expect(readsPods({ ...rig, requests: rig.requests.slice(0, redeemAt) })).toEqual([]);
    await shot(page, testInfo, "remote-connected");
  });

  test("gym remote refuses a ticket naming a server off the data apex", async ({ page }, testInfo) => {
    const rig = await openRemote(page);
    const link = await approvalLink(page);
    const sealed = await phoneSeal(link.searchParams.get("k")!, ticketFor("https://home.smoketest.example.com"));
    const relay = rig.sockets[0]!.ws;
    relay.send(JSON.stringify({ kind: "peer-hello", phonePk: sealed.phonePk }));
    await expect(page.locator("#dock-code")).toHaveText(`${sealed.sas.slice(0, 3)} ${sealed.sas.slice(3)}`, { timeout: 10_000 });
    relay.send(JSON.stringify({ kind: "peer-deliver", ciphertext: sealed.ciphertext, nonce: sealed.nonce }));
    await expect(page.locator("#dock-status")).toHaveText("The phone named a server this page won't connect to", { timeout: 10_000 });
    await expect(page.locator("#dock-status")).toHaveClass(/err-text/);
    await expect(page.locator("#dock-restart")).toBeVisible();
    expect(rig.redeems).toEqual([]);
    expect(rig.requests.filter((u) => u.includes("/api/companion/redeem"))).toEqual([]);
    await shot(page, testInfo, "remote-refused");
  });

  test("gym remote replaces an expired code with a fresh QR", async ({ page }, testInfo) => {
    const rig = await openRemote(page);
    const first = await approvalLink(page);
    rig.sockets[0]!.ws.send(JSON.stringify({ kind: "expired" }));
    // A quiet restart: a new relay session, a new key, no error shown.
    await expect.poll(() => rig.sockets.length, { timeout: 10_000 }).toBe(2);
    const second = await approvalLink(page);
    expect(second.searchParams.get("s")).not.toBe(first.searchParams.get("s"));
    expect(second.searchParams.get("k")).not.toBe(first.searchParams.get("k"));
    expect(rig.sockets[1]!.url).toBe(`wss://flagshipserver.com/qr-pipe/${second.searchParams.get("s")}?role=browser`);
    await expect(page.locator("#dock-status")).not.toHaveClass(/err-text/);
    await expect(page.locator("#dock-restart")).toBeHidden();
    await shot(page, testInfo, "remote-fresh-qr");
  });
});
