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

  it("/recovery/recoveryWrap.js is served and wraps with HKDF over the three mobile salts", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recoveryWrap.js" });
    expect(r.statusCode).toBe(200);
    // The escrow wrap now derives its AES key via HKDF-SHA256 (mobile-identical)
    // — NOT the raw PRF bytes. Regressing to raw bytes reopens the cross-platform
    // divergence this KAT-backed module closed.
    expect(r.body).toContain("HKDF");
    expect(r.body).toContain("AES-GCM");
    // The three domain-separation salts must match iOS/Android verbatim.
    expect(r.body).toContain("flagship/recovery-wrap/v1");
    expect(r.body).toContain("flagship/recovery-acme-wrap/v1");
    expect(r.body).toContain("flagship/recovery-admin-root-wrap/v1");
  });

  it("/recovery/recovery.js delegates the wrap to recoveryWrap.js (no inline raw-PRF key)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('from "./recoveryWrap.js"');
    // The pre-reconciliation code keyed AES-GCM off the raw PRF output
    // (`prfBytes.slice(0, 32)`). That must be gone — the key is HKDF-derived.
    expect(r.body).not.toContain("prfBytes.slice(0, 32)");
    // And it must escrow the admin root as its OWN blob, never a concatenation.
    expect(r.body).toContain("wrappedAdminRootB64");
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

describe("Task #74 — Argon2id-gated wrappedUmk fetch (sub-origin code)", () => {
  it("/recovery/recovery.js imports argon2id from the vendored noble module", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    // The CSP forbids external scripts, so Argon2 must be self-hosted.
    expect(r.body).toMatch(/import\s*\{\s*argon2id\s*\}\s*from\s*["'].\/vendor\/noble-hashes\/argon2.js["']/);
  });

  it("vendored noble argon2 module is reachable + minified-but-readable", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/vendor/noble-hashes/argon2.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("export ");
    // Cheap shape check — RFC 9106 references the t/m/p params.
    expect(r.body).toContain("argon2id");
  });

  it("recovery.js documents the Argon2 parameter choice + Pixel-6 budget", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("ARGON2_M_KB");
    expect(r.body).toContain("ARGON2_T");
    expect(r.body).toContain("ARGON2_P");
    // Document the OWASP-aligned choice so future reviewers can audit
    // the parameter selection without spelunking docs.
    expect(r.body).toContain("OWASP");
  });

  it("recovery.js splits Argon2 output into fetchToken + prfSalt via HKDF (domain-separated)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("flagship.recovery.fetch.v1");
    expect(r.body).toContain("flagship.recovery.salt.v1");
    expect(r.body).toContain("HKDF");
  });

  it("recovery.js POSTs to the gated fetch endpoint (not the legacy GET ciphertext path)", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("/api/recovery/by-username/");
    expect(r.body).toContain("/fetch");
    // Sub-origin verifies server's prfSaltHash against its locally-
    // derived prfSalt — defense against a tampered .com swapping salts.
    expect(r.body).toContain("prfSaltHash");
  });

  it("recovery.js wipes the Argon2 master key from memory after splitting", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/recovery/recovery.js" });
    expect(r.statusCode).toBe(200);
    // .fill(0) the masterKey buffer — best-effort hygiene; documented
    // as best-effort in the source itself.
    expect(r.body).toMatch(/masterKey\.fill\(0\)/);
  });
});

describe("Task #74 — webapp delegates passphrase hashes through postMessage", () => {
  it("lib/recovery.js forwards fetchTokenHashHex + prfSaltHashHex to the upload envelope", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("fetchTokenHashHex");
    expect(r.body).toContain("prfSaltHashHex");
    expect(r.body).toContain("fetchTokenHash");
    expect(r.body).toContain("prfSaltHash");
  });

  it("lib/recovery.js refuses to upload when the sub-origin omitted the hashes", async () => {
    const app = buildServer();
    const r = await app.inject({ method: "GET", url: "/webapp/lib/recovery.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("sub-origin omitted the passphrase hashes");
  });
});
