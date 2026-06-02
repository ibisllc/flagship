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

  it("views/boot-approval.js registers the view + wires fetch + approve + the device-info backstop", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/boot-approval.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('registerView("view-boot-approval")');
    expect(r.body).toContain("fetchVerifiedRequests");
    expect(r.body).toContain("approveUnlock");
    expect(r.body).toContain("export async function enterBootApproval");
    expect(r.body).toContain("export function initBootApprovalView");
    // The "is this my box?" device-info confirm + the one-tap CTA.
    expect(r.body).toContain("Yes, this is my box");
    expect(r.body).toContain("Region");
  });

  it("app.js + index.html wire the boot-approval view under the activity tab", async () => {
    const app = buildServer();
    const js = await app.inject({ method: "GET", url: "/webapp/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.body).toContain('from "./views/boot-approval.js"');
    expect(js.body).toContain("initBootApprovalView");
    expect(js.body).toContain("enterBootApproval");
    expect(js.body).toContain('"view-boot-approval": "activity"');
    expect(js.body).toContain("activity-open-boot-approval");

    const html = await app.inject({ method: "GET", url: "/webapp/" });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('id="view-boot-approval"');
    expect(html.body).toContain('id="boot-approval-content"');
    expect(html.body).toContain('id="activity-open-boot-approval"');
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
});
