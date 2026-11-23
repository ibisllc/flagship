import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("lib/totp.js signs all three POSTs (admin key, IRK only on an account without one) against the .com totp endpoints", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/totp.js" });
    expect(r.statusCode).toBe(200);
    // The gated signer: the admin root, else keystore.js's IRK (WebCrypto Ed25519).
    expect(r.body).toContain("sensitiveSigner(signWithIrk)");
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
    // Branches on `.com`'s refusal codes (F2), not on statuses or English.
    expect(r.body).toContain("totpErrorText");
    expect(r.body).toContain('"invalid-totp-code"');
    expect(r.body).toContain('"totp-pending-expired"');
    // One name on every surface: "Code protection" (F2 owner decision).
    expect(r.body).toContain("Turn on code protection");
    expect(r.body).toContain("Turn off code protection");
    expect(r.body).not.toContain("multi-device + 2FA");
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

// Security report F2: every failure gets its own sentence and code, never a
// blanket "Network error".
describe("webapp code protection errors (F2)", () => {
  const loadTotp = () => import("../public/webapp/lib/totp.js");
  const umk = new Uint8Array(32).fill(1);
  const sign = async () => new Uint8Array(64);
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  afterEach(() => vi.restoreAllMocks());

  it("a rejected fetch while offline says offline", async () => {
    const { totpEnrollBegin, TOTP_COPY } = await loadTotp();
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const e = await totpEnrollBegin({ username: "alice", umk }, { fetch: f, sign, navigator: { onLine: false } }).catch((x) => x);
    expect(e.code).toBe("offline");
    expect(e.userMessage).toBe(TOTP_COPY.offline);
  });

  it("a rejected fetch while online says something is in the way", async () => {
    const { totpEnrollBegin, TOTP_COPY } = await loadTotp();
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const e = await totpEnrollBegin({ username: "alice", umk }, { fetch: f, sign, navigator: { onLine: true } }).catch((x) => x);
    expect(e.code).toBe("network");
    expect(e.userMessage).toBe(TOTP_COPY.unreachable);
    expect(e.userMessage).toMatch(/extension, VPN or firewall/);
  });

  it("a 500 internal-error is a server failure, not a network error", async () => {
    const { totpEnrollBegin, TOTP_COPY } = await loadTotp();
    const e = await totpEnrollBegin(
      { username: "alice", umk },
      { fetch: answer(500, { error: "internal-error", code: "internal-error", requestId: "r1" }), sign },
    ).catch((x) => x);
    expect(e.status).toBe(500);
    expect(e.code).toBe("internal-error");
    expect(e.userMessage).toBe(TOTP_COPY.server);
    expect(e.userMessage).not.toMatch(/network/i);
  });

  it("a browser without Ed25519 says so", async () => {
    const { totpEnrollBegin, TOTP_COPY } = await loadTotp();
    const noEd = async () => {
      throw Object.assign(new Error("Unrecognized name."), { name: "NotSupportedError" });
    };
    const f = vi.fn();
    const e = await totpEnrollBegin({ username: "alice", umk }, { fetch: f, sign: noEd }).catch((x) => x);
    expect(e.code).toBe("unsupported");
    expect(e.userMessage).toBe(TOTP_COPY.unsupported);
    expect(f).not.toHaveBeenCalled();
  });

  it("a closed passkey prompt says nothing was signed", async () => {
    const { totpEnrollBegin } = await loadTotp();
    const cancelled = async () => {
      throw Object.assign(new Error("cancelled"), { code: "custody-cancelled" });
    };
    const e = await totpEnrollBegin({ username: "alice", umk }, { fetch: vi.fn(), sign: cancelled }).catch((x) => x);
    expect(e.code).toBe("custody-cancelled");
    expect(e.userMessage).toMatch(/Nothing was signed/);
  });

  it("an empty account name or a locked browser never sends anything and never says network", async () => {
    const { totpEnrollBegin, TOTP_COPY } = await loadTotp();
    const f = vi.fn();
    const noName = await totpEnrollBegin({ username: "", umk }, { fetch: f, sign }).catch((x) => x);
    expect(noName.code).toBe("account-not-loaded");
    expect(noName.userMessage).toBe(TOTP_COPY.notLoaded);
    const locked = await totpEnrollBegin({ username: "alice", umk: null }, { fetch: f, sign }).catch((x) => x);
    expect(locked.userMessage).toBe(TOTP_COPY.locked);
    expect(f).not.toHaveBeenCalled();
  });

  it("each refusal code reads as its own sentence", async () => {
    const { totpEnrollBegin, totpEnrollConfirm, totpDisable, TOTP_COPY } = await loadTotp();
    const cases: [number, Record<string, unknown>, string][] = [
      [409, { error: "x", code: "totp-already-enrolled" }, TOTP_COPY.alreadyOn],
      [403, { error: "Only an admin device of this account can change code protection.", code: "totp-admin-only" }, TOTP_COPY.adminOnly],
      [503, { error: "TOTP not configured", code: "totp-not-configured" }, TOTP_COPY.notAvailable],
      [404, { error: "unknown username", code: "account-not-found" }, TOTP_COPY.accountNotFound],
      [409, { error: "x", code: "totp-pending-expired" }, TOTP_COPY.expired],
    ];
    for (const [status, body, sentence] of cases) {
      const e = await totpEnrollBegin({ username: "alice", umk }, { fetch: answer(status, body), sign }).catch((x) => x);
      expect(e.userMessage).toBe(sentence);
      expect(e.code).toBe(body.code);
    }
    const stale = await totpEnrollBegin(
      { username: "alice", umk },
      { fetch: answer(403, { error: "stale request", code: "stale-request" }), sign },
    ).catch((x) => x);
    expect(stale.userMessage).toMatch(/clock/);
    const wrong = await totpEnrollConfirm(
      { username: "alice", umk, code: "123456" },
      { fetch: answer(401, { error: "invalid TOTP code", code: "invalid-totp-code" }), sign },
    ).catch((x) => x);
    expect(wrong.code).toBe("invalid-totp-code");
    const others = await totpDisable(
      { username: "alice", umk, code: "123456" },
      { fetch: answer(409, { error: "x", code: "totp-other-devices" }), sign },
    ).catch((x) => x);
    expect(others.userMessage).toBe(TOTP_COPY.otherDevices);
  });

  it("a page load that can't reach Flagship throws a sentence, not a raw message", async () => {
    const { fetchAccountType, TOTP_COPY } = await loadTotp();
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const e = await fetchAccountType("alice", { fetch: f, navigator: { onLine: true } }).catch((x) => x);
    expect(e.userMessage).toBe(TOTP_COPY.unreachable);
    const down = await fetchAccountType("alice", { fetch: answer(502, {}) }).catch((x) => x);
    expect(down.userMessage).toBe(TOTP_COPY.server);
  });

  it("the begin, confirm and disable tags sign under the admin root (SENSITIVE_TAGS)", async () => {
    const { SENSITIVE_TAGS } = await import("../public/webapp/lib/adminRoot.js");
    for (const t of ["flagship/totp-enroll-begin/v1", "flagship/totp-enroll-confirm/v1", "flagship/totp-disable/v1"]) {
      expect(SENSITIVE_TAGS.has(t)).toBe(true);
    }
  });

  it("a non-admin device, an empty account name and a locked browser are each told why (view preflight)", async () => {
    const view = await import("../public/webapp/views/account-security.js");
    const { TOTP_COPY } = await loadTotp();
    expect(view.preflight({ username: "", umk })).toBe(TOTP_COPY.notLoaded);
    expect(view.preflight({ username: "alice", umk: null })).toBe(TOTP_COPY.locked);
    expect(view.preflight({ username: "alice", umk, adminRootSeed: null })).toBe(TOTP_COPY.adminOnly);
  });
});
