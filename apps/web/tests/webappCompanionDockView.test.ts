/**
 * P14 — Companion-browser dock view (apps/web/public/webapp/views/companion-dock.js)
 * + companionClient.js + the index.html settings tab + section section.
 *
 * Coverage:
 *   1. Static-surface gates: the view file + client file + index.html
 *      changes are reachable as static assets and contain the expected
 *      symbols.
 *   2. companionClient: mint/list/revoke call shapes, buildCompanionReceiverUrl
 *      + parseCompanionPayload round-trip.
 *   3. The view reads every documented field on the BFF response.
 *   4. The view speaks the empty state.
 *   5. Settings tab strip carries the entry button.
 *   6. The router slot + sub-view tab wiring is registered.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function fetchAsset(url: string) {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url });
  expect(r.statusCode).toBe(200);
  return r.body;
}

describe("companion-dock view — static surface", () => {
  it("is reachable as a static asset and registers a view", async () => {
    const body = await fetchAsset("/webapp/views/companion-dock.js");
    expect(body).toContain('registerView("view-companion-dock")');
  });

  it("exports the standard view contract", async () => {
    const body = await fetchAsset("/webapp/views/companion-dock.js");
    expect(body).toContain("export function initCompanionDockView");
    expect(body).toContain("export async function enterCompanionDock");
    expect(body).toContain("export async function renderCompanionDock");
  });

  it("uses the desktop-initiated ceremony and retains list/revoke", async () => {
    const body = await fetchAsset("/webapp/views/companion-dock.js");
    expect(body).toContain("companionList");
    expect(body).toContain("companionRevoke");
    // The ceremony moved to its own origin, so the link is absolute and
    // derived from the apex rather than a same-origin `/dock` path.
    expect(body).toContain("remoteOrigin()");
    expect(body).not.toContain("companionMintTicket");
    expect(body).not.toContain("buildCompanionReceiverUrl");
  });

  it("reads every documented field on CompanionListResponse rows", async () => {
    const body = await fetchAsset("/webapp/views/companion-dock.js");
    // Top-level field
    expect(body).toContain("body.companions");
    // Per-row fields
    for (const f of [
      "tokenPrefix",
      "redeemedAt",
      "expiresAt",
      "userAgent",
    ]) {
      expect(body, `companion row field ${f}`).toContain(`c.${f}`);
    }
  });

  it("speaks the empty state ('no browsers connected')", async () => {
    const body = await fetchAsset("/webapp/views/companion-dock.js");
    expect(body).toMatch(/no browsers connected/);
  });

  it("does not render a phone-generated QR", async () => {
    const body = await fetchAsset("/webapp/views/companion-dock.js");
    expect(body).not.toContain('import("/qrEncoder.js")');
  });
});

describe("companionClient.js — endpoint shapes", () => {
  it("client file is reachable", async () => {
    const body = await fetchAsset("/webapp/lib/companionClient.js");
    expect(body).toContain("export async function companionMintTicket");
    expect(body).toContain("export async function companionList");
    expect(body).toContain("export async function companionRevoke");
    expect(body).toContain("/api/screens/companion/mint-ticket");
    expect(body).toContain("/api/screens/companion/list");
    expect(body).toContain("/api/screens/companion/revoke");
  });

  it("buildCompanionReceiverUrl round-trips through parseCompanionPayload", async () => {
    // Load the module directly (Node ESM) — no fetch wrapping needed.
    const path = resolve(__dirname, "..", "public", "webapp", "lib", "companionClient.js");
    const mod = await import(pathToFileURL(path).href);
    const url = mod.buildCompanionReceiverUrl({
      ticketId: "deadbeef".repeat(4),
      ticketSecret: "ab".repeat(32),
      podBaseUrl: "https://home.alice.flagship.services",
      username: "alice",
    });
    expect(url).toMatch(/^https:\/\/webapp\.flagshipserver\.com\/\?companion=/);
    const b64 = new URL(url).searchParams.get("companion")!;
    const parsed = mod.parseCompanionPayload(b64);
    expect(parsed).toEqual({
      ticketId: "deadbeef".repeat(4),
      ticketSecret: "ab".repeat(32),
      podBaseUrl: "https://home.alice.flagship.services",
      username: "alice",
    });
  });

  it("parseCompanionPayload returns null on garbage", async () => {
    const path = resolve(__dirname, "..", "public", "webapp", "lib", "companionClient.js");
    const mod = await import(pathToFileURL(path).href);
    expect(mod.parseCompanionPayload("")).toBeNull();
    expect(mod.parseCompanionPayload("not-base64-at-all!@#$")).toBeNull();
    // valid base64url of '{"ticketId":"x"}' — missing required fields.
    const bad = Buffer.from(JSON.stringify({ ticketId: "x" })).toString("base64url");
    expect(mod.parseCompanionPayload(bad)).toBeNull();
  });

  it("companionRevoke rejects short prefixes locally before any network call", async () => {
    const path = resolve(__dirname, "..", "public", "webapp", "lib", "companionClient.js");
    const mod = await import(pathToFileURL(path).href);
    await expect(mod.companionRevoke("abc")).rejects.toThrow(/tokenPrefix/);
  });
});

describe("index.html — companion-dock surface", () => {
  it("includes the Remote settings entry", async () => {
    const html = await fetchAsset("/webapp/");
    expect(html).toContain('id="settings-tab-companion-dock"');
    expect(html).toContain(">Remote<");
    // The feature was renamed on 2026-07-23 — the old label must not survive
    // anywhere on the shell's settings surface.
    expect(html).not.toContain("Dock a browser");
  });

  it("includes the view-companion-dock section + content container", async () => {
    const html = await fetchAsset("/webapp/");
    expect(html).toContain('id="view-companion-dock"');
    expect(html).toContain('id="companion-dock-content"');
    expect(html).toContain('id="companion-dock-refresh"');
    expect(html).toContain('id="companion-dock-back"');
  });
});

describe("app.js — companion-dock wiring", () => {
  it("registers initCompanionDockView + enterCompanionDock", async () => {
    const body = await fetchAsset("/webapp/app.js");
    expect(body).toContain("initCompanionDockView");
    expect(body).toContain("enterCompanionDock");
  });

  it("tags view-companion-dock under the Settings tab", async () => {
    const body = await fetchAsset("/webapp/app.js");
    expect(body).toContain('"view-companion-dock": "settings"');
  });

  it("wires the Settings → Remote button", async () => {
    const body = await fetchAsset("/webapp/app.js");
    expect(body).toContain('"settings-tab-companion-dock"');
  });
});

describe("companionGuard.js — read surface", () => {
  it("exports requireOwnerProfile + CompanionWriteError", async () => {
    const body = await fetchAsset("/webapp/lib/companionGuard.js");
    expect(body).toContain("export function requireOwnerProfile");
    expect(body).toContain("export class CompanionWriteError");
    expect(body).toContain('"companion-write-not-allowed"');
  });

  it("marks unsupported companion capabilities unavailable", async () => {
    const body = await fetchAsset("/webapp/lib/companionGuard.js");
    expect(body).toContain("installCompanionUiRestrictions");
    expect(body).toContain("data-companion-unavailable");
    expect(body).toContain("services-list-open-vibe-code");
  });

  it("signing helpers import the guard", async () => {
    for (const f of [
      "/webapp/lib/releaseServer.js",
      "/webapp/lib/revokeServer.js",
      "/webapp/lib/replaceDeviceCeremony.js",
      "/webapp/lib/wipeRestartCeremony.js",
    ]) {
      const body = await fetchAsset(f);
      expect(body, `${f} imports companionGuard`).toContain('from "./companionGuard.js"');
    }
  });
});
