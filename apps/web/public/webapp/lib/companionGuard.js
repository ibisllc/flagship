// P14 — remote-session write guard.
//
// Signing helpers (releaseServer, revokeServer, replaceDeviceCeremony,
// wipeRestartCeremony, installService, ...) call requireOwnerProfile()
// BEFORE pulling the UMK from the session. If the active profile is a
// companion (kind === "companion"), this throws a tagged Error the
// router catches and surfaces as a toast — "A remote browser can't
// sign. Open your owner app to approve this change."
//
// Wave 9 will add the write-relay: a remote-initiated signed write will
// queue on the pod and the owner approves it asynchronously. Today the
// contract is simpler: remote sessions are strictly read-only, signing
// is gated, and the error message tells the user where to go.

import { get as profileGet } from "./profilesStore.js";

export const COMPANION_WRITE_ERROR_CODE = "companion-write-not-allowed";

export class CompanionWriteError extends Error {
  constructor(message = "A remote browser can't sign — open your owner app to approve this") {
    super(message);
    this.name = "CompanionWriteError";
    this.code = COMPANION_WRITE_ERROR_CODE;
  }
}

/**
 * Return true when the active profile is a companion. Default-false on
 * any read failure — better to attempt the write and let the server
 * surface a 403 than to block an owner mid-flight due to a transient
 * localStorage hiccup.
 */
export function isCompanionProfile() {
  try {
    return profileGet("kind") === "companion";
  } catch {
    return false;
  }
}

/**
 * Refuse to proceed when the active profile is a companion. Used as a
 * one-liner at the top of every signing path (releaseServer.js etc.).
 *
 * Companions DO hold a valid paired-session token (the BFF accepts
 * their reads), but the seed needed to sign was never persisted in
 * this browser. Calling crypto.subtle.sign with a missing seed would
 * surface as a cryptic "umk required" — this guard surfaces the
 * actual reason ("you're a remote, not signed in") at the right layer.
 */
export function requireOwnerProfile() {
  if (isCompanionProfile()) throw new CompanionWriteError();
}

const UNAVAILABLE_IDS = [
  "settings-tab-account-security",
  "settings-tab-providers",
  "settings-tab-recovery",
  "settings-tab-trusted-devices",
  "settings-tab-reset",
  "settings-tab-account-delete",
  "settings-tab-create-server",
  "settings-tab-companion-dock",
  "settings-tab-companion-requests",
  "services-list-open-vibe-code",
  "trusted-devices-add",
  "recovery-cloud-setup",
  "recovery-cloud-remove",
  "recovery-keyfile-export",
  "add-provider-go",
  "build-src-scratch",
  "build-src-git",
  "build-src-mcp",
  "build-mcp-create",
];

/** Make the shared webapp shell honest about the currently unsupported
 * remote-session capabilities. Read surfaces remain identical to the owner webapp;
 * server release/revoke are intentionally not disabled because they already
 * have a phone-approval relay. */
export function applyCompanionUiRestrictions(doc = globalThis.document) {
  const active = isCompanionProfile();
  doc?.getElementById?.("companion-mode-banner")?.classList.toggle("hidden", !active);
  for (const id of UNAVAILABLE_IDS) {
    const el = doc?.getElementById?.(id);
    if (!el) continue;
    if (active) {
      el.setAttribute("data-companion-unavailable", "true");
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("title", "Unavailable in a keyless remote session");
      if ("disabled" in el) el.disabled = true;
    } else if (el.getAttribute("data-companion-unavailable") === "true") {
      el.removeAttribute("data-companion-unavailable");
      el.removeAttribute("aria-disabled");
      el.removeAttribute("title");
      if ("disabled" in el) el.disabled = false;
    }
  }
}

export function installCompanionUiRestrictions(doc = globalThis.document) {
  applyCompanionUiRestrictions(doc);
  doc?.addEventListener?.("flagship:view-shown", () => applyCompanionUiRestrictions(doc));
  if (typeof MutationObserver === "function" && doc?.body) {
    const observer = new MutationObserver(() => applyCompanionUiRestrictions(doc));
    observer.observe(doc.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }
  return () => {};
}
