/**
 * P14 Phase 2 — Companion-requests view (apps/web/public/webapp/views/companion-requests.js)
 * + companionRequestsClient.js + the index.html settings tab + section section.
 *
 * Coverage:
 *   1. Static surface: view file reachable + registers a view + hits the
 *      documented endpoints + empty-state copy.
 *   2. index.html exposes the settings-tab entry button + section.
 *   3. app.js wires the entry button + tags the view under the Settings tab.
 *   4. intentSummary predicate truth table (release-server / revoke-server / unknown).
 *   5. renderPendingRowHtml (pure) renders the documented row structure.
 *   6. Approve flow invokes the right signing helper (releaseServerName /
 *      revokeServer) AND posts resolve-pending only on success.
 *   7. Deny flow posts resolve-pending directly (no signing).
 *   8. Approve refuses to resolve if the destination signing helper throws
 *      OR if the helper returns the {pending:true} relay shape.
 *
 * The view module is loaded under Node (no JSDOM in the repo); render+DOM
 * is exercised statically. Approve / deny call paths exercise behavior
 * directly through the dependency-injected helpers.
 */

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function fetchAsset(url: string) {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url });
  expect(r.statusCode).toBe(200);
  return r.body;
}

async function loadViewModule() {
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const path = resolve(
    __dirname, "..", "public", "webapp", "views", "companion-requests.js",
  );
  return await import(pathToFileURL(path).href + bust);
}

describe("companion-requests view — static surface", () => {
  it("is reachable as a static asset and registers the view", async () => {
    const body = await fetchAsset("/webapp/views/companion-requests.js");
    expect(body).toContain('registerView("view-companion-requests")');
  });

  it("exports the standard view contract", async () => {
    const body = await fetchAsset("/webapp/views/companion-requests.js");
    expect(body).toContain("export function initCompanionRequestsView");
    expect(body).toContain("export async function enterCompanionRequests");
    expect(body).toContain("export async function renderCompanionRequests");
  });

  it("uses the Phase 2 endpoints via companionRequestsClient + signing helpers", async () => {
    const body = await fetchAsset("/webapp/views/companion-requests.js");
    expect(body).toContain("listPendingWrites");
    expect(body).toContain("resolvePending");
    expect(body).toContain("releaseServerName");
    expect(body).toContain("revokeServer");
  });

  it("renders Approve + Deny buttons + an error slot per row", async () => {
    const body = await fetchAsset("/webapp/views/companion-requests.js");
    expect(body).toContain('data-action="approve"');
    expect(body).toContain('data-action="deny"');
    expect(body).toContain("data-row-error");
  });
});

describe("companionRequestsClient.js — static surface", () => {
  it("client file is reachable + exposes the wrapper functions", async () => {
    const body = await fetchAsset("/webapp/lib/companionRequestsClient.js");
    expect(body).toContain("export async function listPendingWrites");
    expect(body).toContain("export async function resolvePending");
    expect(body).toContain("export function pollPending");
    expect(body).toContain("/api/screens/companion/pending-writes");
    expect(body).toContain("/api/screens/companion/resolve-pending");
  });
});

describe("companionWriteRelay.js — static surface", () => {
  it("relay file is reachable + carries the documented constants", async () => {
    const body = await fetchAsset("/webapp/lib/companionWriteRelay.js");
    expect(body).toContain("export async function submitWriteRequest");
    expect(body).toContain("export async function pollUntilResolved");
    expect(body).toContain("/api/companion/request-write");
    expect(body).toContain("/api/companion/my-pending");
    expect(body).toContain('"release-server"');
    expect(body).toContain('"revoke-server"');
  });
});

describe("index.html — companion-requests surface", () => {
  it("includes the Companion requests settings entry", async () => {
    const html = await fetchAsset("/webapp/");
    expect(html).toContain('id="settings-tab-companion-requests"');
    expect(html).toContain("Companion requests");
    expect(html).toContain('id="companion-requests-badge"');
  });

  it("includes the view-companion-requests section + content container", async () => {
    const html = await fetchAsset("/webapp/");
    expect(html).toContain('id="view-companion-requests"');
    expect(html).toContain('id="companion-requests-content"');
    expect(html).toContain('id="companion-requests-refresh"');
    expect(html).toContain('id="companion-requests-back"');
  });
});

describe("app.js — companion-requests wiring", () => {
  it("registers initCompanionRequestsView + enterCompanionRequests", async () => {
    const body = await fetchAsset("/webapp/app.js");
    expect(body).toContain("initCompanionRequestsView");
    expect(body).toContain("enterCompanionRequests");
  });

  it("tags view-companion-requests under the Settings tab", async () => {
    const body = await fetchAsset("/webapp/app.js");
    expect(body).toContain('"view-companion-requests": "settings"');
  });

  it("wires the Settings → Companion requests button", async () => {
    const body = await fetchAsset("/webapp/app.js");
    expect(body).toContain('"settings-tab-companion-requests"');
  });
});

describe("companion-requests view — pure helpers", () => {
  it("intentSummary truth table (release / revoke / unknown / null)", async () => {
    const mod = await loadViewModule();
    expect(mod.intentSummary("release-server", {
      username: "alice",
      serverDomain: "home.alice.flagship.services",
      issuedAt: 1,
    })).toMatch(/Release.*home\.alice\.flagship\.services/);
    expect(mod.intentSummary("revoke-server", {
      userId: "alice",
      revokedServerId: "home.alice.flagship.services",
      reason: "stolen",
      issuedAt: 1,
    })).toMatch(/Revoke.*stolen/);
    expect(mod.intentSummary("unknown-kind", { foo: 1 })).toContain("unknown-kind");
    expect(mod.intentSummary("release-server", null)).toBe("(no intent)");
    expect(mod.intentSummary("release-server", "not-an-object")).toBe("(no intent)");
  });

  it("renderPendingRowHtml renders the documented row HTML", async () => {
    const mod = await loadViewModule();
    const html = mod.renderPendingRowHtml({
      requestId: "req-1",
      companionTokenPrefix: "abcdef",
      companionLabel: "Library iMac",
      kind: "release-server",
      intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
      queuedAt: 1700000000000,
      expiresAt: 1700000600000,
    }, 1700000000000);
    expect(html).toContain('data-row="req-1"');
    expect(html).toContain("Library iMac");
    expect(html).toContain("release-server");
    expect(html).toContain("home.alice.flagship.services");
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
    expect(html).toContain('data-id="req-1"');
  });

  it("EMPTY_STATE_HTML contains the 'No pending requests' copy", async () => {
    const mod = await loadViewModule();
    expect(mod.EMPTY_STATE_HTML).toContain("No pending requests");
  });
});

describe("companion-requests view — approve flow", () => {
  it("approve(release-server) → invokes releaseServerName then resolvePending", async () => {
    const mod = await loadViewModule();
    const releaseServerName = vi.fn(async () => ({ ok: true }));
    const revokeServer = vi.fn(async () => ({ ok: true }));
    const resolvePending = vi.fn(async () => ({ ok: true }));
    const out = await mod.runApprove(
      {
        requestId: "req-1",
        kind: "release-server",
        intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
      },
      {
        releaseServerName,
        revokeServer,
        resolvePending,
        getSession: () => ({ umk: new Uint8Array(32), irk: {} }),
        signWithIrk: async () => new Uint8Array(64),
      },
    );
    expect(out.ok).toBe(true);
    expect(releaseServerName).toHaveBeenCalledTimes(1);
    expect(revokeServer).not.toHaveBeenCalled();
    expect(resolvePending).toHaveBeenCalledWith({ requestId: "req-1", outcome: "approved" });
    const releaseArg = releaseServerName.mock.calls[0]![0] as { username: string; serverDomain: string };
    expect(releaseArg.username).toBe("alice");
    expect(releaseArg.serverDomain).toBe("home.alice.flagship.services");
  });

  it("approve(revoke-server) → invokes revokeServer then resolvePending", async () => {
    const mod = await loadViewModule();
    const releaseServerName = vi.fn(async () => ({ ok: true }));
    const revokeServer = vi.fn(async () => ({ ok: true }));
    const resolvePending = vi.fn(async () => ({ ok: true }));
    const out = await mod.runApprove(
      {
        requestId: "req-2",
        kind: "revoke-server",
        intent: {
          userId: "alice",
          revokedServerId: "home.alice.flagship.services",
          reason: "stolen",
          issuedAt: 1,
        },
      },
      {
        releaseServerName,
        revokeServer,
        resolvePending,
        getSession: () => ({ umk: new Uint8Array(32), irk: {} }),
        signWithIrk: async () => new Uint8Array(64),
      },
    );
    expect(out.ok).toBe(true);
    expect(revokeServer).toHaveBeenCalledTimes(1);
    expect(releaseServerName).not.toHaveBeenCalled();
    expect(resolvePending).toHaveBeenCalledWith({ requestId: "req-2", outcome: "approved" });
  });

  it("approve does NOT resolve when the destination signing helper throws", async () => {
    const mod = await loadViewModule();
    const releaseServerName = vi.fn(async () => { throw new Error("403"); });
    const resolvePending = vi.fn(async () => ({ ok: true }));
    const out = await mod.runApprove(
      {
        requestId: "req-3",
        kind: "release-server",
        intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
      },
      {
        releaseServerName,
        resolvePending,
        getSession: () => ({ umk: new Uint8Array(32), irk: {} }),
        signWithIrk: async () => new Uint8Array(64),
      },
    );
    expect(out.ok).toBe(false);
    expect(resolvePending).not.toHaveBeenCalled();
  });

  it("approve refuses to resolve if the signing helper returns the {pending:true} relay shape", async () => {
    const mod = await loadViewModule();
    const releaseServerName = vi.fn(async () => ({
      ok: false, pending: true, kind: "release-server", requestId: "x",
    }));
    const resolvePending = vi.fn(async () => ({ ok: true }));
    const out = await mod.runApprove(
      {
        requestId: "req-4",
        kind: "release-server",
        intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
      },
      {
        releaseServerName,
        resolvePending,
        getSession: () => ({ umk: new Uint8Array(32), irk: {} }),
        signWithIrk: async () => new Uint8Array(64),
      },
    );
    expect(out.ok).toBe(false);
    expect(resolvePending).not.toHaveBeenCalled();
  });

  it("approve refuses without an unlocked session (umk absent)", async () => {
    const mod = await loadViewModule();
    const releaseServerName = vi.fn(async () => ({ ok: true }));
    const resolvePending = vi.fn(async () => ({ ok: true }));
    const out = await mod.runApprove(
      {
        requestId: "req-5",
        kind: "release-server",
        intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
      },
      {
        releaseServerName,
        resolvePending,
        getSession: () => ({ umk: null, irk: null }),
        signWithIrk: async () => new Uint8Array(64),
      },
    );
    expect(out.ok).toBe(false);
    expect(releaseServerName).not.toHaveBeenCalled();
    expect(resolvePending).not.toHaveBeenCalled();
  });

  it("approve rejects an unknown kind without invoking any signer", async () => {
    const mod = await loadViewModule();
    const releaseServerName = vi.fn(async () => ({ ok: true }));
    const revokeServer = vi.fn(async () => ({ ok: true }));
    const resolvePending = vi.fn(async () => ({ ok: true }));
    const out = await mod.runApprove(
      {
        requestId: "req-mystery",
        kind: "wipe-and-restart",
        intent: { foo: 1 },
      },
      {
        releaseServerName,
        revokeServer,
        resolvePending,
        getSession: () => ({ umk: new Uint8Array(32), irk: {} }),
        signWithIrk: async () => new Uint8Array(64),
      },
    );
    expect(out.ok).toBe(false);
    expect(releaseServerName).not.toHaveBeenCalled();
    expect(revokeServer).not.toHaveBeenCalled();
    expect(resolvePending).not.toHaveBeenCalled();
  });
});

describe("companion-requests view — deny flow", () => {
  it("deny → posts resolve-pending with outcome=denied; never invokes signer", async () => {
    const mod = await loadViewModule();
    const releaseServerName = vi.fn(async () => ({ ok: true }));
    const revokeServer = vi.fn(async () => ({ ok: true }));
    const resolvePending = vi.fn(async () => ({ ok: true }));
    const out = await mod.runDeny(
      {
        requestId: "req-6",
        kind: "release-server",
        intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
      },
      {
        releaseServerName,
        revokeServer,
        resolvePending,
      },
    );
    expect(out.ok).toBe(true);
    expect(releaseServerName).not.toHaveBeenCalled();
    expect(revokeServer).not.toHaveBeenCalled();
    expect(resolvePending).toHaveBeenCalledWith({ requestId: "req-6", outcome: "denied" });
  });

  it("deny surfaces a failure when resolve-pending throws", async () => {
    const mod = await loadViewModule();
    const resolvePending = vi.fn(async () => { throw new Error("503"); });
    const out = await mod.runDeny(
      {
        requestId: "req-7",
        kind: "release-server",
        intent: { username: "alice", serverDomain: "home.alice.flagship.services", issuedAt: 1 },
      },
      { resolvePending },
    );
    expect(out.ok).toBe(false);
  });
});
