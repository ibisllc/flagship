import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// Live account audit log — webapp parity with the iOS/Android
// AuditLogScreen + AuditLogViewModel. The mobile apps read the LIVE
// identity-plane endpoint GET /api/users/:u/audit (NOT the daemon BFF
// `/api/screens/audit-log`, which is still gated). This suite pins the
// webapp's live model + full-page view + activity-tab wiring.
describe("webapp live account audit log (parity with iOS AuditLogScreen)", () => {
  it("lib/auditLog.js hits the live .com audit endpoint with grow-the-window pagination", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/auditLog.js" });
    expect(r.statusCode).toBe(200);
    // Live identity-plane endpoint (same as AuditLogViewModel) — NOT the
    // daemon BFF surface.
    expect(r.body).toContain("/api/users/");
    expect(r.body).toContain("/audit");
    expect(r.body).toContain("since=");
    expect(r.body).toContain("limit=");
    expect(r.body).not.toContain("/api/screens/audit-log");
    // Server cap mirrors MAX_LIMIT in auditEvents.ts.
    expect(r.body).toContain("AUDIT_MAX_LIMIT");
    expect(r.body).toContain("50");
    // Public surface.
    expect(r.body).toContain("export function createAuditLogModel");
    expect(r.body).toContain("export async function fetchAuditEvents");
    expect(r.body).toContain("export function auditKindLabel");
    expect(r.body).toContain("export function auditKindIcon");
  });

  it("lib/auditLog.js covers the v1.1 device-lifecycle AND v1.2 account-type / TOTP kinds", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/auditLog.js" });
    expect(r.statusCode).toBe(200);
    for (const kind of [
      // v1.1 device lifecycle (docs/revocation-ui.md)
      "device-disconnected",
      "device-replaced",
      "device-added",
      "wipe-restart",
      "recovery-set-up",
      "recovery-rotated",
      "app-renamed",
      // v1.2 account-type + TOTP (emitted by control-plane/src/totp.ts)
      "account-type-changed-single-to-multi",
      "account-type-changed-multi-to-single",
      "totp-enrolled",
      "totp-disabled",
      "totp-failed-rate",
    ]) {
      expect(r.body).toContain(kind);
    }
  });

  it("views/account-audit.js registers the full-page view + pages off the live model", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/account-audit.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-account-audit")');
    expect(r.body).toContain("createAuditLogModel");
    expect(r.body).toContain("export async function enterAccountAudit");
    expect(r.body).toContain("export function initAccountAuditView");
    expect(r.body).toContain("export async function renderAccountAudit");
    // Reuses the shared label/icon mapping.
    expect(r.body).toContain("auditKindLabel");
    expect(r.body).toContain("auditKindIcon");
    // Empty-state copy nudges the user toward security actions.
    expect(r.body).toMatch(/No account events yet/);
  });

  it("the activity tab previews account events + links to the full-page view", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/activity.js" });
    expect(r.statusCode).toBe(200);
    // Live .com audit fetch in the fan-out.
    expect(r.body).toContain("/audit?since=0&limit=20");
    // Shares the mapping with the full-page view.
    expect(r.body).toContain('from "../lib/auditLog.js"');
    expect(r.body).toContain("enterAccountAudit");
    expect(r.body).toContain("activity-see-all-audit");
  });

  it("app.js registers the account-audit view + parents it under the activity tab", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('from "./views/account-audit.js"');
    expect(r.body).toContain("initAccountAuditView");
    expect(r.body).toContain('"view-account-audit": "activity"');
  });

  it("the view-account-audit shell exists in index.html", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="view-account-audit"');
    expect(r.body).toContain('id="account-audit-content"');
  });
});
