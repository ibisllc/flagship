/**
 * #25 + #95 — first-run wizard + peer-backup opt-in.
 *
 * We don't drive the wizard end-to-end (that's covered by Playwright
 * e2e); these tests cover the static structure + module surface so
 * future refactors don't accidentally drop the load-bearing parts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VIEW_JS = readFileSync(
  join(__dirname, "..", "public", "webapp", "views", "wizard.js"),
  "utf8",
);
const INDEX_HTML = readFileSync(
  join(__dirname, "..", "public", "webapp", "index.html"),
  "utf8",
);

describe("first-run wizard (#25)", () => {
  it("exports enterWizard, shouldShowRecoveryWarning, getPeerBackupChoice", () => {
    expect(VIEW_JS).toMatch(/export async function enterWizard\(/);
    expect(VIEW_JS).toMatch(/export function shouldShowRecoveryWarning\(/);
    expect(VIEW_JS).toMatch(/export function getPeerBackupChoice\(/);
  });

  it("registers view-wizard with the router", () => {
    expect(VIEW_JS).toMatch(/registerView\(['"]view-wizard['"]\)/);
  });

  it("declares the 7 steps the design pass agreed on", () => {
    for (const id of [
      "device-key",
      "username",
      "passphrase",
      "webauthn-recovery",
      "create-server",
      "peer-backup",
      "demo-app",
    ]) {
      expect(VIEW_JS).toContain(`"${id}"`);
    }
  });

  it("recovery + peer-backup + demo are explicitly skippable", () => {
    // The skippable flag is set on each step that the user can defer.
    const skippableLine = VIEW_JS.match(/skippable: true/g);
    expect(skippableLine?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("links to the no-KYC policy from the username step", () => {
    expect(VIEW_JS).toMatch(/security\.html#no-kyc/);
  });

  it("index.html includes the view-wizard slot", () => {
    expect(INDEX_HTML).toMatch(/<section id="view-wizard" class="hidden">/);
  });
});

describe("account-creation taken-name state + trademark claim (Change C)", () => {
  it("pre-flights availability via checkUsername before opening the account", () => {
    expect(VIEW_JS).toMatch(/import \{ checkUsername \}/);
    expect(VIEW_JS).toMatch(/await checkUsername\(username\)/);
    expect(VIEW_JS).toMatch(/avail\.available === false/);
  });

  it("renders a dedicated taken-name panel (not just a toast)", () => {
    // The wizard renders its step bodies dynamically into the
    // #view-wizard slot, so the taken-name panel markup lives in the JS,
    // not index.html.
    expect(VIEW_JS).toMatch(/wizard-username-taken/);
    expect(VIEW_JS).toMatch(/function renderTakenState\(/);
    expect(VIEW_JS).toMatch(/id="wizard-username-taken"/);
  });

  it("offers the trademark-claim affordance in the taken state", () => {
    expect(VIEW_JS).toMatch(/import \{ trademarkClaimMailto \}/);
    expect(VIEW_JS).toMatch(/trademarkClaimMailto\(username\)/);
    expect(VIEW_JS).toContain("I hold a trademark to this name");
  });

  it("also shows the taken state when the claim itself comes back conflicted", () => {
    expect(VIEW_JS).toMatch(/already claimed\|409\|conflict/);
  });
});

describe("trademark-claim mailto helper (Change C)", () => {
  it("targets trademarks@flagshipserver.com with the requested name pre-filled", async () => {
    const {
      trademarkClaimMailto,
      trademarkClaimSubject,
      trademarkClaimBody,
      TRADEMARK_CLAIM_EMAIL,
    } = await import("../public/webapp/lib/trademarkClaim.js");

    expect(TRADEMARK_CLAIM_EMAIL).toBe("trademarks@flagshipserver.com");
    expect(trademarkClaimSubject("acme")).toBe('Trademark claim for the name "acme"');

    const body = trademarkClaimBody("acme");
    expect(body).toContain("acme");
    expect(body).toContain("Trademark registration number:");
    expect(body).toContain("Requested name: acme");

    const mailto = trademarkClaimMailto("acme");
    expect(mailto.startsWith("mailto:trademarks@flagshipserver.com?")).toBe(true);
    expect(mailto).toContain(`subject=${encodeURIComponent(trademarkClaimSubject("acme"))}`);
    expect(mailto).toContain(`body=${encodeURIComponent(body)}`);
  });

  it("URL-encodes the requested name into both subject and body", async () => {
    const { trademarkClaimMailto } = await import("../public/webapp/lib/trademarkClaim.js");
    // A bare handle never has spaces, but the encoder must still run so
    // the body's newlines/spaces are escaped.
    const mailto = trademarkClaimMailto("widgets");
    expect(mailto).not.toContain("\n");
    expect(mailto).toContain("widgets");
  });
});

describe('"Secure your account" backup nudge step', () => {
  it("declares the secure-account step right after the username step", () => {
    // It must run immediately after the account is opened (username),
    // before any other step or the app shell.
    const usernameIdx = VIEW_JS.indexOf('{ id: "username"');
    const secureIdx = VIEW_JS.indexOf('{ id: "secure-account"');
    const passphraseIdx = VIEW_JS.indexOf('{ id: "passphrase"');
    expect(usernameIdx).toBeGreaterThan(-1);
    expect(secureIdx).toBeGreaterThan(usernameIdx);
    expect(passphraseIdx).toBeGreaterThan(secureIdx);
  });

  it("uses the approved verbatim title + body copy", () => {
    expect(VIEW_JS).toContain('label: "Secure your account"');
    expect(VIEW_JS).toMatch(
      /Back up your account now so you can get back in if you lose this\s+device\. No one — not even us — can recover it for you\./,
    );
  });

  it("offers both backup methods with the approved labels + sublabels", () => {
    expect(VIEW_JS).toContain("Save to a passkey");
    expect(VIEW_JS).toContain("Recover with your device passkey or password manager.");
    expect(VIEW_JS).toContain("Save a backup file");
    expect(VIEW_JS).toContain("An encrypted .flagshipkey you keep yourself.");
  });

  it("detects passkey availability via window.PublicKeyCredential", () => {
    expect(VIEW_JS).toMatch(/window\.PublicKeyCredential/);
    expect(VIEW_JS).toMatch(/export function passkeysAvailable\(/);
  });

  it("reuses the existing backup primitives (no rebuilt crypto)", () => {
    // Cloud = lib/recovery.js setupCloudRecovery; file = the recovery
    // view's keyfile export ceremony.
    expect(VIEW_JS).toMatch(/setupCloudRecovery/);
    expect(VIEW_JS).toMatch(/runKeyfileExportCeremony/);
  });

  it("guards skip with the approved warning + Skip-anyway / Back buttons", () => {
    expect(VIEW_JS).toContain(
      "Without a backup, losing this device means losing your account for good. You can set this up anytime in Settings.",
    );
    expect(VIEW_JS).toContain('okLabel: "Skip anyway"');
    expect(VIEW_JS).toContain('cancelLabel: "Back"');
    // Skipping pins the persistent home-screen recovery warning. Post P12
    // hard cut-over the write goes through the per-profile profilesStore;
    // the home-screen banner reads from the same slot.
    expect(VIEW_JS).toMatch(/profileSet\(["']recoveryWarn["'],\s*["']true["']\)/);
  });

  it("the recovery view exports the reusable keyfile export ceremony", () => {
    const RECOVERY_JS = readFileSync(
      join(__dirname, "..", "public", "webapp", "views", "recovery.js"),
      "utf8",
    );
    expect(RECOVERY_JS).toMatch(/export async function runKeyfileExportCeremony\(/);
    // Both backup methods stay reachable from Settings → Recovery so the
    // "set this up anytime in Settings" promise holds: the cloud passkey
    // (#recovery-cloud-setup) and the file export (#recovery-keyfile-export).
    expect(RECOVERY_JS).toMatch(/recovery-cloud-setup/);
    expect(RECOVERY_JS).toMatch(/recovery-keyfile-export/);
  });
});

describe('"Secure your account" pre-selection behaviour', () => {
  // passkeysAvailable() reads globalThis.window at CALL time, and
  // renderSecureAccountStep() calls it fresh on each invocation — so one
  // static import suffices and we just swap window between cases.
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("pre-selects the cloud (passkey) option when WebAuthn is available", async () => {
    (globalThis as { window?: unknown }).window = { PublicKeyCredential: function () {} };
    const { passkeysAvailable, renderSecureAccountStep } = await import(
      "../public/webapp/views/wizard.js"
    );
    expect(passkeysAvailable()).toBe(true);
    const html = renderSecureAccountStep();
    // The cloud radio is checked + enabled; the file radio is not checked.
    expect(html).toMatch(/id="wizard-secure-cloud"[^>]*checked/);
    expect(html).not.toMatch(/id="wizard-secure-cloud"[^>]*disabled/);
    expect(html).toContain("Recover with your device passkey or password manager.");
    expect(html).not.toMatch(/id="wizard-secure-file"[^>]*checked/);
  });

  it("does NOT pre-select cloud when passkeys are unavailable; file + skip still work", async () => {
    (globalThis as { window?: unknown }).window = {}; // no PublicKeyCredential
    const { passkeysAvailable, renderSecureAccountStep } = await import(
      "../public/webapp/views/wizard.js"
    );
    expect(passkeysAvailable()).toBe(false);
    const html = renderSecureAccountStep();
    // Cloud is disabled + NOT checked; the disabled hint shows.
    expect(html).toMatch(/id="wizard-secure-cloud"[^>]*disabled/);
    expect(html).not.toMatch(/id="wizard-secure-cloud"[^>]*checked/);
    expect(html).toContain("Passkeys aren't available in this browser — use a backup file.");
    // File is pre-selected instead so the step still works without passkeys.
    expect(html).toMatch(/id="wizard-secure-file"[^>]*checked/);
    // The skip link is always present (skip is the no-backup escape hatch).
    expect(html).toContain('id="wizard-secure-skip"');
  });

  it("passkeysAvailable() fails closed when window is absent", async () => {
    delete (globalThis as { window?: unknown }).window;
    const { passkeysAvailable } = await import("../public/webapp/views/wizard.js");
    expect(passkeysAvailable()).toBe(false);
  });
});

describe("peer-backup opt-in step (#95)", () => {
  it("renders three buttons: enable / decline / maybe-later", () => {
    expect(VIEW_JS).toMatch(/wizard-pb-enable/);
    expect(VIEW_JS).toMatch(/wizard-pb-decline/);
    expect(VIEW_JS).toMatch(/wizard-pb-later/);
  });

  it("persists the user's choice to the per-profile profilesStore (post P12 cut-over)", () => {
    // Pre-cut-over this was a flat-key localStorage write. The store still
    // owns the value; the slot is `peerBackupChoice`.
    expect(VIEW_JS).toMatch(/profileSet\(["']peerBackupChoice["'],\s*["']enabled["']\)/);
    expect(VIEW_JS).toMatch(/profileSet\(["']peerBackupChoice["'],\s*["']declined["']\)/);
    expect(VIEW_JS).toMatch(/profileSet\(["']peerBackupChoice["'],\s*["']deferred["']\)/);
  });

  it("links to the no-KYC framing (sealed against keys only you hold)", () => {
    expect(VIEW_JS).toMatch(/sealed against keys only you hold/i);
  });

  it("includes a Settings reference so the user knows they can change later", () => {
    expect(VIEW_JS).toMatch(/Settings.*Peer-backup/);
  });
});
