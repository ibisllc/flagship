import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("webapp /views/audit-log.js — Activity-tab audit log (task #34)", () => {
  it("is reachable as a static asset and registers both router slots", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-audit-log")');
    expect(r.body).toContain('registerView("view-audit-entry")');
  });

  it("hits the audit-log BFF endpoints (list + detail)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("/api/screens/audit-log");
    expect(r.body).toContain("/api/screens/audit-log/");
  });

  it("exports the standard view contract + inline-activity preview hook", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export function initAuditLogView");
    expect(r.body).toContain("export async function enterAuditLog");
    expect(r.body).toContain("export async function renderAuditLog");
    expect(r.body).toContain("export async function renderInlineActivityAuditLog");
    expect(r.body).toContain("export async function enterAuditEntry");
  });

  it("covers every event-kind family the task lists", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    for (const kind of [
      "app-grant.issue",
      "app-grant.renew",
      "app-grant.revoke",
      "pod.register",
      "pod.revoke",
      "url.claim",
      "url.drop",
      "lease.grant",
      "lease.consume",
      "lease.revoke",
      "recovery.setup",
      "recovery.use",
      "username.rename",
      "app.install",
      "app.uninstall",
      "app.update",
      "invite.issue",
      "invite.consume",
      "invite.revoke",
      "recovery.j3",
      "recovery.merge-back",
    ]) {
      expect(r.body).toContain(kind);
    }
  });

  it("renders the signed envelope JSON for verification-curious users", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    // Detail view must show signature, signer pubkey, canonical-bytes.
    expect(r.body).toContain("signatureHex");
    expect(r.body).toContain("signerPubkeyHex");
    expect(r.body).toContain("canonicalBytes");
    expect(r.body).toContain("Signed request");
    expect(r.body).toContain("verify");
  });

  it("speaks the empty state (encourages the user to take signed actions)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/no events yet|no signed events yet/);
    expect(r.body).toMatch(/verify yourself/);
  });

  it("handles the BFF-not-yet-wired case gracefully (404/503)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/audit log not yet available/);
  });

  it("exports kindFamily + KNOWN_EVENT_KINDS for shell deep-links + tests", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/audit-log.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export function kindFamily");
    expect(r.body).toContain("export const KNOWN_EVENT_KINDS");
  });

  it("style.css declares the audit-envelope-pre primitive", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/style.css" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(".audit-envelope-pre");
  });
});
