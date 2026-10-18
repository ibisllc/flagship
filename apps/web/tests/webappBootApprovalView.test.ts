import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// Boot-approval relay — webapp parity with the iOS SecretRequestsScreen
// + SecretRequestCoordinator. The webapp is a co-equal trust-root device
// (it holds the IRK), so it approves a booting box exactly like the
// phone: IRK mailbox-auth → directory re-verify → seal LUKS for the box
// STK bound to (nonce, purpose) → owner-IRK Flagship-Boot-v1 header.
describe("webapp boot-approval relay (parity with iOS SecretRequestsScreen)", () => {
  it("lib/edToMont.js implements the Ed25519→X25519 public conversion", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/edToMont.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export function ed25519PubToX25519");
    // The 25519 birational map u = (1 + y) / (1 - y) mod p, p = 2^255-19.
    expect(r.body).toContain("(1n << 255n) - 19n");
    expect(r.body).toContain("(1n + y)");
  });

  it("lib/bootApproval.js pins the canonical-bytes tags + seal tag from @flagship/protocol", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/bootApproval.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("flagship/device-endpoint-claim/v1");
    expect(r.body).toContain("flagship/secret-request/v1");
    // The (nonce, purpose) context tag MUST match phoneEndpoint.ts exactly.
    expect(r.body).toContain("flagship/secret-response/v1");
    expect(r.body).toContain("flagship/boot-auth/v1");
    expect(r.body).toContain("flagship.seal.v1");
  });

  it("lib/bootApproval.js re-verifies against the DIRECTORY STK (relay is not trusted)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/bootApproval.js" });
    expect(r.statusCode).toBe(200);
    // Fetches the mailbox + the directory and verifies each request under
    // the directory-bound STK (mirror SecretRequestCoordinator).
    expect(r.body).toContain("/api/secret-requests");
    expect(r.body).toContain("/pods");
    expect(r.body).toContain("directoryStkPubHex");
    expect(r.body).toContain("Ed25519");
    // Public API mirrors the coordinator.
    expect(r.body).toContain("export async function fetchVerifiedRequests");
    expect(r.body).toContain("export async function approveUnlock");
  });

  it("lib/bootApproval.js posts the sealed reply to the boot worker with an owner header", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/bootApproval.js" });
    expect(r.statusCode).toBe(200);
    // Boot worker host + the response route + the sealed-luks-key fetch.
    expect(r.body).toContain("boot.flagshipserver.com");
    expect(r.body).toContain("/api/boot/response");
    expect(r.body).toContain("/sealed-luks-key");
    // Owner role in the boot-auth envelope.
    expect(r.body).toContain('"owner"');
    expect(r.body).toContain("Flagship-Boot-v1");
  });

  it("views/boot-approval.js registers the view + wires fetch + generic satisfy + the device-info backstop", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/boot-approval.js" });
    expect(r.statusCode).toBe(200);
    // No page of its own any more: the list lives in Activity's Server approvals.
    expect(r.body).not.toContain("registerView(");
    expect(r.body).toContain("fetchVerifiedRequests");
    // The inbox now dispatches ANY type through the registry's `satisfy`
    // (not just unlock), and titles come from BOX_REQUEST_TYPES.
    expect(r.body).toContain("satisfy");
    expect(r.body).toContain("BOX_REQUEST_TYPES");
    expect(r.body).toContain("export async function enterBootApproval");
    expect(r.body).toContain("export function initBootApprovalView");
    // The "is this my box?" device-info confirm + the one-tap CTA.
    expect(r.body).toContain("Yes, this is my box");
    expect(r.body).toContain("Region");
  });

  it("app.js + index.html put the approvals list inside the Activity tab", async () => {
    const app = buildServer();
    const js = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.body).toContain('from "./views/boot-approval.js"');
    expect(js.body).toContain("initBootApprovalView");
    expect(js.body).not.toContain('"view-boot-approval"');
    expect(js.body).not.toContain("activity-open-boot-approval");

    const html = await app.inject({ method: "GET", url: "/webapp/" });
    expect(html.statusCode).toBe(200);
    expect(html.body).not.toContain('id="view-boot-approval"');
    expect(html.body).not.toContain('id="activity-open-boot-approval"');
    expect(html.body).toContain('id="activity-approvals"');
    expect(html.body).toContain("Server approvals");
    expect(html.body).toContain('id="activity-approvals-count"');
    // The section is static Activity markup, inside #view-activity.
    const activity = html.body.slice(html.body.indexOf('id="view-activity"'));
    expect(activity.indexOf('id="boot-approval-content"')).toBeGreaterThan(0);
    expect(activity.indexOf('id="boot-approval-content"')).toBeLessThan(activity.indexOf('id="activity-feed"'));
  });

  it("the new view + lib files are precached in the service worker (offline)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/service-worker.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('"/lib/bootApproval.js"');
    expect(r.body).toContain('"/lib/edToMont.js"');
    expect(r.body).toContain('"/lib/auditLog.js"');
    expect(r.body).toContain('"/lib/totp.js"');
    expect(r.body).toContain('"/views/boot-approval.js"');
    expect(r.body).toContain('"/views/account-audit.js"');
  });

  it("an approval another device already answered (409) is done, a failed one is not", async () => {
    const { isAlreadyAnswered } = await import("../public/webapp/views/boot-approval.js");
    expect(isAlreadyAnswered(Object.assign(new Error('post boot response failed: 409 {"error":"already answered"}'), { status: 409 }))).toBe(true);
    expect(isAlreadyAnswered(Object.assign(new Error("x"), { status: 500 }))).toBe(false);
    expect(isAlreadyAnswered(new Error("x"))).toBe(false);
  });

  it("an approval clears its card at once and never prints the raw error", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../public/webapp/views/boot-approval.js", import.meta.url), "utf8");
    expect(src).toContain("lastVerified = lastVerified.filter((r) => r.id !== id)");
    expect(src).not.toMatch(/Approval failed: \$\{e\?\.message/);
    expect(src).toContain("Nothing waiting for you");
    expect(src).toContain('id="boot-approval-retry"');
    expect(src).toContain('"flagship:view-shown"');
  });

  it("the old route is an alias that lands on Activity with the section in view", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../public/webapp/views/boot-approval.js", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function enterBootApproval"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('show("view-activity")');
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('scrollIntoView');
  });
});
