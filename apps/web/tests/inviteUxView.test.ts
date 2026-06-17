import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * #82 / P6 — Invite UX webapp views.
 *
 * Tests assert the modules are served as static assets and have the
 * required structural pieces: registerView calls, label-book usage,
 * Web Share API + clipboard fallback in invite-issue, and revoke flow
 * in invite-manage. We don't simulate the runtime here — the dist is
 * what the production webapp loads, so structure-level tests catch
 * regressions early. With the P6 BFF live (87868e8 + d0e6508), the
 * "no BFF" fallback branch is now defence-in-depth, and the empty
 * state copy reflects "no invites yet" instead of "no data tracked
 * locally".
 */
describe("webapp invite views (#82)", () => {
  it("/views/invite-issue.js registers a view and calls into the label-book", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/invite-issue.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-invite-issue")');
    expect(r.body).toContain("generateOpaqueTag");
    expect(r.body).toContain("putLabel");
    expect(r.body).toContain("buildShareUrl");
    // Web Share API + fallback copy
    expect(r.body).toContain("navigator.share");
    expect(r.body).toContain("navigator.clipboard");
    // Hits the daemon's app-invite/issue BFF
    expect(r.body).toContain("/api/screens/app-invite/issue");
    // L6 — guards a double-submit (an invite is single-use): the button is
    // disabled + relabelled while the POST is in flight, then restored in a
    // finally. Mirrors iOS/Android.
    expect(r.body).toContain("goBtn.disabled = true");
    expect(r.body).toContain('"Issuing…"');
    expect(r.body).toContain("if (goBtn?.disabled) return");
  });

  it("/views/invite-manage.js registers a view, lists pending + active, and revokes", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/invite-manage.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-invite-manage")');
    expect(r.body).toContain("listLabelsForApp");
    expect(r.body).toContain("/api/screens/app-invite/list/");
    expect(r.body).toContain("/api/screens/app-invite/access/");
    expect(r.body).toContain("/api/screens/app-invite/revoke");
    expect(r.body).toContain("removeLabel");
  });

  it("invite-manage.js reads every BFF field the daemon returns (no drift)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/invite-manage.js" });
    expect(r.statusCode).toBe(200);
    // AppInvitePendingSummary — { opaqueTag, inviteId, role, expiresAt }
    expect(r.body).toContain("inv.opaqueTag");
    expect(r.body).toContain("inv.inviteId");
    expect(r.body).toContain("inv.role");
    expect(r.body).toContain("inv.expiresAt");
    // AppInviteAccessSummary — { opaqueTag, irkPubHex, role, grantedAt }
    expect(r.body).toContain("a.opaqueTag");
    expect(r.body).toContain("a.irkPubHex");
    expect(r.body).toContain("a.role");
    expect(r.body).toContain("a.grantedAt");
    // Revoke wire shape: { serviceId, inviteId, scope: "invite" }
    // OR { serviceId, irkPubKey, scope: "access" }
    expect(r.body).toContain('scope: "invite"');
    expect(r.body).toContain('scope: "access"');
    expect(r.body).toContain("irkPubKey");
  });

  it("invite-issue.js sends the BFF the wire shape the daemon expects", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/invite-issue.js" });
    expect(r.statusCode).toBe(200);
    // AppInviteIssueRequest — { serviceId, role, opaqueTag, contextNote }
    expect(r.body).toContain("serviceId: app.serviceId");
    expect(r.body).toContain("role,");
    expect(r.body).toContain("opaqueTag,");
    expect(r.body).toContain("contextNote: contextNote || null");
    // AppInviteIssueResponse — { secret, expiresAt }
    expect(r.body).toContain("body.secret");
    expect(r.body).toContain("body.expiresAt");
  });

  it("invite-manage.js empty-state copy reflects the live BFF (P6 done)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/invite-manage.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("no pending invites yet");
    expect(r.body).toContain("no active access yet");
    // The legacy "tracked locally" wording is no longer the primary
    // empty state — the fallback degraded path still references it
    // internally as defence-in-depth, but the main empty-state copy
    // pivoted.
    expect(r.body).not.toContain("no pending invites tracked locally");
    expect(r.body).not.toContain("access list not available");
  });

  it("app.js registers both invite views under SUB_VIEW_TABS=apps", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("initInviteIssueView");
    expect(r.body).toContain("initInviteManageView");
    expect(r.body).toContain('"view-invite-issue": "apps"');
    expect(r.body).toContain('"view-invite-manage": "apps"');
  });

  it("/lib/labelBook.js exposes IDB persistence primitives", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/labelBook.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("putLabel");
    expect(r.body).toContain("getLabel");
    expect(r.body).toContain("listLabelsForApp");
    expect(r.body).toContain("removeLabel");
    expect(r.body).toContain("snapshotDirty");
    expect(r.body).toContain("clearDirty");
    expect(r.body).toContain("buildShareUrl");
    expect(r.body).toContain("generateOpaqueTag");
    // Namespaced into the same webapp DB as keystore (shares the
    // upgrade transaction so a single open isn't redundant).
    expect(r.body).toContain('"flagship-webapp"');
    expect(r.body).toContain('"labelBook"');
  });

  it("/views/service-detail.js wires the 'Invite people' button to the invite views", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/service-detail.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("sd-invite-issue");
    expect(r.body).toContain("sd-invite-manage");
    expect(r.body).toContain("./invite-issue.js");
    expect(r.body).toContain("./invite-manage.js");
  });

  it("index.html declares the invite-issue + invite-manage sections", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/index.html" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="view-invite-issue"');
    expect(r.body).toContain('id="view-invite-manage"');
    expect(r.body).toContain('id="invite-issue-content"');
    expect(r.body).toContain('id="invite-manage-content"');
  });
});
