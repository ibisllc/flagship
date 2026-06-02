import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// TOTP 2FA — webapp parity with iOS AccountSecurityViewModel. The webapp
// holds the IRK (keystore.js signWithIrk over WebCrypto Ed25519) so it
// drives the SAME IRK-signed enroll/disable handshake the mobile app
// does — the parity gap was the old "use your phone, can't sign"
// placeholder in account-security.js.
describe("webapp TOTP enroll/disable (parity with iOS AccountSecurityViewModel)", () => {
  it("lib/totp.js pins the canonical-bytes tags from @flagship/protocol", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/totp.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("flagship/totp-enroll-begin/v1");
    expect(r.body).toContain("flagship/totp-enroll-confirm/v1");
    expect(r.body).toContain("flagship/totp-disable/v1");
  });

  it("lib/totp.js IRK-signs all three POSTs against the .com totp endpoints", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/totp.js" });
    expect(r.statusCode).toBe(200);
    // The signing path comes from keystore.js (WebCrypto Ed25519).
    expect(r.body).toContain("signWithIrk");
    expect(r.body).toContain('from "../keystore.js"');
    // The four endpoints from packages/control-plane/src/totp.ts.
    expect(r.body).toContain("/totp/enroll-begin");
    expect(r.body).toContain("/totp/enroll-confirm");
    expect(r.body).toContain("/totp/disable");
    // Public surface mirrors the iOS view-model methods.
    expect(r.body).toContain("export async function totpEnrollBegin");
    expect(r.body).toContain("export async function totpEnrollConfirm");
    expect(r.body).toContain("export async function totpDisable");
    expect(r.body).toContain("export async function fetchAccountType");
  });

  it("the lib carries the request/signature/code wire shape + signs over username|issuedAt", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/totp.js" });
    expect(r.statusCode).toBe(200);
    // The signed body shape the Worker handler expects:
    // { request: { username, issuedAt }, signature, code? }.
    expect(r.body).toContain("request:");
    expect(r.body).toContain("issuedAt");
    expect(r.body).toContain("signature");
    // recoveryCodes are returned once on enroll-confirm + surfaced to the caller.
    expect(r.body).toContain("recoveryCodes");
  });

  it("account-security.js drives the real signed flow (no 'use your phone' placeholder)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/account-security.js" });
    expect(r.statusCode).toBe(200);
    // Wires the real lib.
    expect(r.body).toContain('from "../lib/totp.js"');
    expect(r.body).toContain("totpEnrollBegin");
    expect(r.body).toContain("totpEnrollConfirm");
    expect(r.body).toContain("totpDisable");
    // The old placeholder copy is GONE.
    expect(r.body).not.toContain("Coming in v1.3");
    expect(r.body).not.toContain("doesn't yet sign");
    // Branches on the same statuses the iOS state machine does.
    expect(r.body).toContain("401");
    expect(r.body).toContain("409");
    expect(r.body).toContain("503");
  });

  it("the enroll sheet still renders QR + manual key + recovery codes (print-friendly)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/views/account-security.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("data-account-security-qr");
    expect(r.body).toContain("data-account-security-manual-secret");
    expect(r.body).toContain("data-account-security-recovery-codes");
    // The "I've saved these" gate before dismissing the codes.
    expect(r.body).toContain("data-account-security-saved-toggle");
  });
});
