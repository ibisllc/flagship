import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * #82 — Invite UX webapp views.
 *
 * Tests assert the modules are served as static assets and have the
 * required structural pieces: registerView calls, label-book usage,
 * Web Share API + clipboard fallback in invite-issue, and revoke flow
 * in invite-manage. We don't simulate the runtime here — the dist is
 * what the production webapp loads, so structure-level tests catch
 * regressions early.
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

  it("/views/app-detail.js wires the 'Invite people' button to the invite views", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/app-detail.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("ad-invite-issue");
    expect(r.body).toContain("ad-invite-manage");
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
