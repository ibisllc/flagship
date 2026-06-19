// Service access gating — webapp view wiring (docs/service-access-gating.md).
//
// Structure-level tests over the EXACT static assets the production webapp
// loads (served via the Fastify app), mirroring inviteUxView.test.ts: the
// admin view + the friend redeem view register, wire the right endpoints/lib,
// and the shell (index.html + app.js) declares + inits them.

import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

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
    // The box redeem endpoint + the owner-IRK set-mode endpoint.
    expect(r.body).toContain("/api/service-invites/redeem");
    expect(r.body).toContain("/api/service-access");
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
