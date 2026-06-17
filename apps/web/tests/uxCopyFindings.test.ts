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

describe("UX-C — recovery-gated session buttons are greyed + toast on tap", () => {
  it("the settings card drops the old recovery CTA and reframes tier-2 as 'Lock with passkey'", () => {
    const html = readFileSync(join(WEBAPP, "index.html"), "utf8");
    // The swap-to-CTA design is gone in favour of a greyed button + toast.
    expect(html).not.toContain('id="settings-signout-recovery"');
    expect(html).toContain('id="settings-signout"');
    expect(html).toContain("Lock with passkey");
  });

  it("settings.js greys the gated buttons until recovery is enrolled and toasts on a blocked tap", () => {
    const src = read("views", "settings.js");
    // Both destructive buttons carry the `.gated` greyed class until enrolled.
    expect(src).toContain('classList.toggle("gated"');
    expect(src).toContain("settings-signout");
    expect(src).toContain("settings-reset");
    // A tap while not enrolled surfaces a toast instead of running the action.
    expect(src).toContain("Set up account recovery to use this.");
    expect(src).toContain("sessionRecoveryEnrolled");
  });
});

describe("Tier-1 'Lock with PIN code' (webapp-only)", () => {
  it("the Session card carries the PIN lock + a hidden Change-PIN control", () => {
    const html = readFileSync(join(WEBAPP, "index.html"), "utf8");
    expect(html).toContain('id="settings-pin-lock"');
    expect(html).toContain("Lock with PIN code");
    // Change PIN ships hidden — settings.js reveals it once a PIN is set.
    expect(html).toMatch(/class="[^"]*hidden[^"]*"\s+id="settings-pin-change"/);
    // The PIN unlock + set views exist, with the passphrase fallback.
    expect(html).toContain('id="view-pin-unlock"');
    expect(html).toContain('id="pin-unlock-passphrase"');
    expect(html).toContain('id="view-pin-set"');
    expect(html).toContain('id="pin-set-current"');
  });

  it("settings.js gates Change-PIN on hasPin and wires the lock/setup buttons", () => {
    const src = read("views", "settings.js");
    expect(src).toContain("settings-pin-lock");
    expect(src).toContain("settings-pin-change");
    expect(src).toContain("hasPin(");
    expect(src).toContain("startSetPin(");
    expect(src).toContain("lockToPin(");
  });

  it("a full passphrase unlock clears the PIN (the reset rule)", () => {
    const src = read("views", "unlock.js");
    expect(src).toContain("clearPin(");
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

describe("UX-B (B3) — error-humanizer rollout: no catch site shows raw error text", () => {
  // Every webapp file that previously did `toast(String(e), "err")` (or
  // rendered a raw `e.message` / `HTTP ${status}`) must now route the
  // user-facing string through the static humanError() helper. A raw
  // `String(e)` toast leaks a stack message; humanError() never does.
  const CONVERTED_FILES = [
    "app.js",
    "views/server-detail.js",
    "views/service-detail.js",
    "views/services-list.js",
    "views/create-server.js",
    "views/companion-dock.js",
    "views/companion-requests.js",
    "views/invite-manage.js",
    "views/url-controller.js",
    "views/trusted-devices.js",
    "views/paired-sessions.js",
    "views/peer-backup.js",
    "views/audit-log.js",
    "views/account-audit.js",
    "views/boot-approval.js",
    "views/browser-viewer.js",
    "views/bootstrap.js",
    "views/pending-server.js",
    "views/post-recovery.js",
    "views/profiles.js",
    "views/add-device.js",
    "views/build-key.js",
    "lib/deepLink.js",
    "lib/companionReceiver.js",
  ];

  it("no converted file still toasts a raw `String(...)` error", () => {
    // Covers every variant we replaced: String(e), String(e?.message ?? e),
    // String(err), String(e.message || e).
    for (const rel of CONVERTED_FILES) {
      const src = read(...rel.split("/"));
      expect(src, `${rel} still toasts a raw String(...) error`).not.toMatch(
        /toast\(String\(/,
      );
    }
  });

  it("every converted file now references humanError(", () => {
    for (const rel of CONVERTED_FILES) {
      const src = read(...rel.split("/"));
      expect(src, `${rel} does not route through humanError`).toContain("humanError(");
    }
  });

  it("companion-requests renders humanError, not a raw e.message, into the card/rows", () => {
    const src = read("views", "companion-requests.js");
    expect(src).not.toContain("escapeHtml(e.message)");
    expect(src).not.toContain("`sign + post failed: ${msg}`");
    expect(src).not.toContain("`resolve-pending failed:");
    expect(src).toContain("escapeHtml(humanError(e))");
    expect(src).toContain("setRowError(row.requestId, humanError(e))");
  });

  it("companionReceiver no longer surfaces a raw `HTTP ${r.status}` to the user", () => {
    const src = read("lib", "companionReceiver.js");
    // The user-facing return uses humanError(status); the raw `HTTP <code>`
    // only ever appears in a console.error detail line, never the returned copy.
    expect(src).toContain("humanError(r.status)");
    expect(src).not.toMatch(/error:\s*`redeem failed: \$\{msg\}`/);
  });
});
