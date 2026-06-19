// Service access gating — webapp view wiring (docs/service-access-gating.md).
//
// Structure-level tests over the EXACT static assets the production webapp
// loads (served via the Fastify app), mirroring inviteUxView.test.ts: the
// admin view + the friend redeem view register, wire the right endpoints/lib,
// and the shell (index.html + app.js) declares + inits them.

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildServer } from "../src/server.js";

async function loadServiceAccessModule() {
  // The view module imports only lib helpers that are window/IndexedDB-free at
  // load time, so it imports clean under Node (no JSDOM in the repo). Cache-bust
  // so each test gets a fresh module instance.
  const bust = `?t=${Math.random().toString(36).slice(2)}`;
  const path = resolve(__dirname, "..", "public", "webapp", "views", "service-access.js");
  return await import(pathToFileURL(path).href + bust);
}

describe("service-access admin view", () => {
  it("/views/service-access.js registers a view + drives the access mode toggle and invite mgmt", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-access.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-service-access")');
    // The open ⇄ restricted toggle is the access-mode control.
    expect(r.body).toContain("sa-restricted-toggle");
    expect(r.body).toContain("setServiceAccessMode");
    // Allow-list manager: add a person → mint an invite → show the link.
    expect(r.body).toContain("createInvite");
    expect(r.body).toContain("listInvites");
    expect(r.body).toContain("revokeInvite");
    // Remove must ALSO prune the bound AID on the box (the .com revoke alone
    // never reaches the box). The Remove button carries the bound AID.
    expect(r.body).toContain("removeServiceAllow");
    expect(r.body).toContain("data-aid=");
    // Identity derivations come from the keystore (AID + household + IRK).
    expect(r.body).toContain("deriveAccountIdFromSeed");
    expect(r.body).toContain("deriveHouseholdKeyFromSeed");
    // Sign mode-change with the IRK; the invite create/revoke too.
    expect(r.body).toContain("signWithIrk");
    // The copyable share-link + Web Share API + clipboard fallback.
    expect(r.body).toContain("navigator.share");
    expect(r.body).toContain("navigator.clipboard");
  });

  it("/lib/serviceInvite.js exposes the crypto-mirror + wire surface", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/serviceInvite.js" });
    expect(r.statusCode).toBe(200);
    // Canonical-bytes tags MUST match @flagship/protocol.
    expect(r.body).toContain('"flagship/service-invite/create/v1"');
    expect(r.body).toContain('"flagship/service-invite/redeem/v1"');
    expect(r.body).toContain('"flagship/service-invite/revoke/v1"');
    expect(r.body).toContain('"flagship/service-access-mode/v1"');
    expect(r.body).toContain('"flagship/service-allow-remove/v1"');
    expect(r.body).toContain('"flagship/service-visit/v1"');
    // AEAD bundle + canonical builders + wire helpers.
    expect(r.body).toContain("sealInviteBundle");
    expect(r.body).toContain("openInviteBundle");
    expect(r.body).toContain("serviceInviteId");
    expect(r.body).toContain("buildInviteLink");
    expect(r.body).toContain("inviteSecretFromLocation");
    // .com routes for create / list / revoke.
    expect(r.body).toContain("/service-invites");
    expect(r.body).toContain("/service-invites/revoke");
    // The box redeem endpoint + the owner-IRK set-mode endpoint + the prune.
    expect(r.body).toContain("/api/service-invites/redeem");
    expect(r.body).toContain("/api/service-access");
    expect(r.body).toContain("/api/service-access/allow-remove");
    expect(r.body).toContain("removeServiceAllow");
  });

  it("keystore.js exposes the AID + household-key + AID-signer derivations", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/keystore.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("deriveAccountIdFromSeed");
    expect(r.body).toContain("deriveHouseholdKeyFromSeed");
    expect(r.body).toContain("signWithAccountId");
    // The fixed HKDF infos (byte-identical to @flagship/protocol).
    expect(r.body).toContain("flagship/account-id/v1");
    expect(r.body).toContain("flagship/household-key/v1");
  });
});

describe("service-access friend redeem view + deep-link", () => {
  it("/views/invite-redeem.js registers a view + redeems against the box with the AID", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/invite-redeem.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-invite-redeem")');
    expect(r.body).toContain("redeemInvite");
    expect(r.body).toContain("deriveAccountIdFromSeed");
    expect(r.body).toContain("signWithAccountId");
    // Resume hooks consumed by the unlock/bootstrap detour.
    expect(r.body).toContain("hasPendingInviteRedeem");
    expect(r.body).toContain("resumePendingInviteRedeem");
  });

  it("deepLink.js resumes a pending invite redeem after the friend unlocks", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/deepLink.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("hasPendingInviteRedeem");
    expect(r.body).toContain("resumePendingInviteRedeem");
  });

  it("app.js wires the /invite#<secret> boot-handler + inits both views", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("inviteSecretFromLocation");
    expect(r.body).toContain("enterInviteRedeem");
    expect(r.body).toContain("initServiceAccessView");
    expect(r.body).toContain("initInviteRedeemView");
    expect(r.body).toContain('"view-service-access": "apps"');
  });

  it("service-detail.js wires the 'Manage who can open this' button", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-detail.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("sd-access");
    expect(r.body).toContain("./service-access.js");
    expect(r.body).toContain("enterServiceAccess");
  });

  it("index.html declares the service-access + invite-redeem sections", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="view-service-access"');
    expect(r.body).toContain('id="service-access-content"');
    expect(r.body).toContain('id="view-invite-redeem"');
    expect(r.body).toContain('id="invite-redeem-content"');
  });
});

// ──────────────────────────────────────────────────────────────────────
// runRemovePerson — the two-leg remove behavior (dependency-injected, no DOM).
// Mirrors webappCompanionRequestsView's runApprove pattern: the view exports the
// pure-core the click handler calls so the .com revoke + box prune are testable.
// ──────────────────────────────────────────────────────────────────────
describe("service-access — runRemovePerson (revoke .com + prune box)", () => {
  const SERVICE = "alice-notes";
  const AID = "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c";
  const baseDeps = () => ({
    getSession: () => ({ username: "alice", umk: new Uint8Array(32).fill(0x0b) }),
    controlApex: () => "https://flagshipserver.com",
    podBaseUrl: () => "https://home.alice.flagship.services",
    signWithIrk: async () => new Uint8Array(64),
    humanError: (e: unknown) => String((e as Error)?.message ?? e),
  });

  it("a BOUND person → revokes on .com AND fires the box prune with the right serviceRef + aid", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "inv-1", boundAID: AID },
      { ...baseDeps(), revokeInvite, removeServiceAllow },
    );
    expect(out).toEqual({ ok: true, prunedBox: true });
    // Leg 1: .com revoke, by inviteId.
    expect(revokeInvite).toHaveBeenCalledTimes(1);
    expect(revokeInvite.mock.calls[0]![0]).toMatchObject({ username: "alice", inviteId: "inv-1" });
    // Leg 2: the box prune, with the exact serviceRef + bound AID.
    expect(removeServiceAllow).toHaveBeenCalledTimes(1);
    const pruneArg = removeServiceAllow.mock.calls[0]![0] as { baseUrl: string; serviceRef: string; aid: string };
    expect(pruneArg.serviceRef).toBe(SERVICE);
    expect(pruneArg.aid).toBe(AID);
    expect(pruneArg.baseUrl).toBe("https://home.alice.flagship.services");
  });

  it("an UNREDEEMED invite (no boundAID) → only the .com revoke, no box prune", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => ({ ok: true, removed: true }));
    const out = await mod.runRemovePerson(
      { serviceRef: SERVICE, inviteId: "inv-2", boundAID: null },
      { ...baseDeps(), revokeInvite, removeServiceAllow },
    );
    expect(out).toEqual({ ok: true, prunedBox: false });
    expect(revokeInvite).toHaveBeenCalledTimes(1);
    expect(removeServiceAllow).not.toHaveBeenCalled();
  });

  it("a box-prune failure throws a tagged error (the box is what enforces — access may persist)", async () => {
    const mod = await loadServiceAccessModule();
    const revokeInvite = vi.fn(async () => ({ revoked: true }));
    const removeServiceAllow = vi.fn(async () => {
      const e = new Error("request failed (403): bad sig");
      throw e;
    });
    await expect(
      mod.runRemovePerson(
        { serviceRef: SERVICE, inviteId: "inv-3", boundAID: AID },
        { ...baseDeps(), revokeInvite, removeServiceAllow },
      ),
    ).rejects.toMatchObject({ code: "box-prune-failed" });
    // The .com revoke still ran (leg 1 succeeds before the box prune fails).
    expect(revokeInvite).toHaveBeenCalledTimes(1);
  });
});
