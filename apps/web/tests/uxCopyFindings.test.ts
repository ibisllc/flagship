/**
 * UX cluster (webapp) — static-surface assertions for findings B, C, D, E, F.
 *
 * These pin the user-facing copy + wiring that the UX pass introduced, and
 * guard against regressing back to raw `HTTP <status>` strings or stranded
 * blocked states.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEBAPP = join(__dirname, "..", "public", "webapp");
const read = (...p: string[]) => readFileSync(join(WEBAPP, ...p), "utf8");
const RECOVERY_HTML = readFileSync(
  join(__dirname, "..", "public", "recovery", "index.html"),
  "utf8",
);

describe("UX-B — raw HTTP status codes no longer reach users", () => {
  it("install-progress no longer renders a raw `HTTP ${status}` card", () => {
    const src = read("views", "install-progress.js");
    expect(src).not.toContain("status check failed: HTTP ${resp.status}");
    // It routes through the shared human helper instead.
    expect(src).toContain("humanError(");
  });

  it("install-progress offers an escape (retry + go home) on a wedged read", () => {
    const src = read("views", "install-progress.js");
    expect(src).toContain("renderEscape");
    expect(src).toContain("ip-escape-retry");
    expect(src).toContain("ip-escape-home");
    // Honest framing — the box may still be installing.
    expect(src).toMatch(/may still be installing/i);
  });

  it("settings promo flow no longer interpolates `status ${r.status}` to the user", () => {
    const src = read("views", "settings.js");
    expect(src).not.toContain("status ${r.status}: ${body}");
    expect(src).toContain("humanError(");
  });

  it("service-detail no longer toasts a raw `(${r.status})` / raw rename text", () => {
    const src = read("views", "service-detail.js");
    expect(src).not.toContain("Couldn't request custom domain (${r.status}).");
    expect(src).not.toContain("Couldn't rename: ${text}");
    expect(src).toContain("humanError(");
  });

  it("account-security totp fallbacks route through humanError, not e.message", () => {
    const src = read("views", "account-security.js");
    expect(src).not.toContain("Couldn't start enrollment: ${e?.message");
    expect(src).not.toContain("Couldn't disable: ${e?.message");
    expect(src).not.toContain("Couldn't confirm: ${e?.message");
    expect(src).toContain("humanError(");
  });

  it("server-detail revoke + lease toasts go through humanError", () => {
    const src = read("views", "server-detail.js");
    expect(src).not.toContain("revoke failed: ${e.message ?? e}");
    expect(src).toContain("humanError(");
  });
});

describe("UX-C — sign-out blocked has a one-tap recovery CTA", () => {
  it("the settings card carries a 'Set up cloud recovery' button", () => {
    const html = readFileSync(join(WEBAPP, "index.html"), "utf8");
    expect(html).toContain('id="settings-signout-recovery"');
    expect(html).toContain("Set up cloud recovery");
  });

  it("the CTA routes into recovery enrollment and toggles with enrollment", () => {
    const src = read("views", "settings.js");
    expect(src).toContain("settings-signout-recovery");
    expect(src).toContain("enterRecovery()");
    // The note swaps the Sign-out button for the recovery CTA when not enrolled.
    expect(src).toContain('classList.toggle("hidden"');
  });
});

describe("UX-D — recovery passphrase copy is de-jargoned", () => {
  it("enroll copy drops 'fetch token' / 'PRF salt' for plain language", () => {
    expect(RECOVERY_HTML).not.toMatch(/fetch token/i);
    expect(RECOVERY_HTML).not.toMatch(/PRF salt/i);
    expect(RECOVERY_HTML).toMatch(/8\+ characters/);
    expect(RECOVERY_HTML).toMatch(/write it down somewhere safe/i);
    expect(RECOVERY_HTML).toMatch(/cannot reset it if it's lost/i);
  });

  it("the sub-origin line has a plain-language gloss (why you're on recovery.*)", () => {
    expect(RECOVERY_HTML).toMatch(/separate address/i);
    // Still names the origin (reviewer-visible + required by the sub-origin test).
    expect(RECOVERY_HTML).toContain("recovery.flagshipserver.com");
  });
});

describe("UX-E — short vs canonical link labels", () => {
  it("service-detail labels the short redirect and the canonical address", () => {
    const src = read("views", "service-detail.js");
    expect(src).toMatch(/redirects to your box/i);
    // App-bound short links have no TTL — they live until the next rename.
    expect(src).toMatch(/until you rename the service/i);
    expect(src).toMatch(/permanent, verifiable address/i);
  });
});
