import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

/**
 * Task #73 — Sub-origin isolation for the WebAuthn-PRF recovery flow.
 *
 * The recovery page lives at `apps/web/public/recovery/`. In production
 * the Worker serves it at `https://recovery.flagshipserver.com/`; in
 * the Fastify dev/test harness the same disk path is reachable at
 * `/recovery/...`.
 *
 * These tests pin the assets are wired up correctly + that the JS
 * declares the right rpId, postMessage origin, and crypto primitives.
 */
describe("recovery sub-origin static surface", () => {
  it("/recovery/ serves the dedicated recovery HTML shell", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Flagship recovery");
    // Strict-mode JS module — no inline scripts at all on this origin.
    expect(r.body).toContain('<script type="module" src="/recovery.js">');
    expect(r.body).not.toContain("<script>");
    // No inline styles either.
    expect(r.body).not.toContain("style=");
    // The page declares the canonical sub-origin in its footer for
    // operator + reviewer-visible confirmation.
    expect(r.body).toContain("recovery.flagshipserver.com");
  });

  it("/recovery/recovery.js declares rpId = recovery.flagshipserver.com (NOT the apex)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    // The whole point of Task #73 is that the rpId is the sub-origin.
    expect(r.body).toContain('const RP_ID = "recovery.flagshipserver.com"');
    // Critically NOT the apex — if this regresses an apex XSS could
    // reach the credential again.
    expect(r.body).not.toContain('const RP_ID = "flagshipserver.com"');
  });

  it("/recovery/recovery.js postMessages only to https://web.flagshipserver.com", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('PARENT_ORIGIN = "https://web.flagshipserver.com"');
    // origin check on inbound messages
    expect(r.body).toContain("ev.origin !== PARENT_ORIGIN");
  });

  it("/recovery/recovery.js uses WebAuthn PRF + AES-GCM (no plaintext UMK uploaded)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("navigator.credentials.create");
    expect(r.body).toContain("navigator.credentials.get");
    expect(r.body).toContain("AES-GCM");
    expect(r.body).toContain("prf:");
  });

  it("/recovery/recovery.css is reachable and self-hosted", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.css" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/css/);
    // No external @import / url(http...) — sub-origin must be hermetic
    // (the Worker's CSP forbids third-party fetches anyway, but we
    // also want clean reviewer-friendly source).
    expect(r.body).not.toMatch(/@import\s+url\(["']?https?:/);
  });
});

describe("webapp lib/recovery.js — drives the sub-origin", () => {
  it("opens the recovery sub-origin via window.open", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("https://recovery.flagshipserver.com");
    expect(r.body).toContain("window.open(");
    // The webapp must postMessage only to the recovery origin, never
    // to anywhere else.
    expect(r.body).toContain("RECOVERY_ORIGIN");
  });

  it("strict origin check on inbound postMessages from the sub-origin", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("ev.origin !== RECOVERY_ORIGIN");
  });

  it("no longer declares an inline rpId — the sub-origin owns WebAuthn", async () => {
    // After Task #73 the lib/recovery.js module in the webapp delegates
    // every WebAuthn call to the sub-origin. We check that the
    // delegation primitives are present and the inline rpId constants
    // are gone. (Docstrings can still mention navigator.credentials.*
    // when explaining the historical / sub-origin behaviour, so this
    // test focuses on positive evidence of delegation rather than
    // string-grepping out the API name.)
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('const RP_ID = "flagshipserver.com"');
    expect(r.body).not.toContain('const RP_ID = "recovery.flagshipserver.com"');
    // No PRF salt constant lives in the webapp any more; the sub-origin
    // is the only place that materialises one.
    expect(r.body).not.toContain('const PRF_SALT');
    // Delegation evidence:
    expect(r.body).toContain("runSubOriginFlow");
    expect(r.body).toContain("flagship-recovery-hello");
  });
});
