// Session-scoped derived state for the webapp.
//
// Sensitive material (UMK seed, IRK private key) lives only in this
// module's closure. Never on `window`, never logged. Views import
// `getSession()` to read; the bootstrap/unlock flow calls `unlock()`
// to populate; `lock()` clears.

import { deriveIrkFromSeed } from "../keystore.js";
import {
  get as storeGet,
  set as storeSet,
  ensureProfile,
  setActiveCloudName,
} from "./profilesStore.js";

const _session = {
  umk: null,
  irk: null,
  username: null,
};

export function getSession() {
  return _session;
}

export async function unlockSession(seed, username) {
  _session.umk = seed;
  _session.irk = await deriveIrkFromSeed(seed);
  // Per-profile resolution: prefer the explicit arg, then the active
  // profile's `username` slot, then the legacy flat key (defensive
  // fallback for first-runs that haven't migrated yet).
  _session.username = username
    ?? storeGet("username")
    ?? localStorage.getItem("flagship.username")
    ?? "";
}

export function lockSession() {
  _session.umk = null;
  _session.irk = null;
  _session.username = null;
}

const USERNAME_RE = /^[a-z0-9]{3,30}$/; // 3–30, no hyphens — see packages/control-plane/src/labels.ts

/**
 * Lazy-init the user's chosen username. Used by pairing + promo flows
 * that need a stable DNS-safe handle. Throws on invalid input or user
 * cancel so the calling view can surface it via toast.
 *
 * #30 — uses the inline modal (no window.prompt). The modal hits the
 * .com username-lookup endpoint as a soft availability hint; a real
 * claim only happens at the pairing/promo callsite that uses the
 * resolved handle.
 */
export async function ensureUsername() {
  if (_session.username) return _session.username;
  const { inlinePrompt } = await import("./modal.js");
  const handle = await inlinePrompt({
    title: "Pick a username",
    message: "DNS-safe label — will appear at <name>.flagship.services.",
    placeholder: "alice",
    validate: (v) => {
      if (!v) return "username required";
      if (!USERNAME_RE.test(v)) return "3–30 lowercase letters and digits, no hyphens";
      return null;
    },
  });
  if (!handle) throw new Error("username required");
  // Persist under the active profile (auto-creating it when this is a
  // first-run with no profile yet) AND mirror to the legacy flat key
  // for any unmigrated read-site.
  try {
    ensureProfile(handle);
    setActiveCloudName(handle);
    storeSet("username", handle);
  } catch { /* fall through to legacy write */ }
  localStorage.setItem("flagship.username", handle);
  _session.username = handle;
  return handle;
}

/**
 * Soft check: 404 if a username is free on .com, 200 if claimed by
 * someone else. Used by the first-run wizard (#25) to colour the
 * "available / taken" hint as the user types. Rate-limit-aware:
 * surfaces the Retry-After header when present so the wizard can
 * back off without spamming.
 */
export async function checkUsernameAvailability(handle) {
  if (!handle) return { ok: false, reason: "empty" };
  if (!USERNAME_RE.test(handle)) return { ok: false, reason: "invalid" };
  try {
    const r = await fetch(`https://flagshipserver.com/api/username/${encodeURIComponent(handle)}`);
    if (r.status === 404) return { ok: true, available: true };
    if (r.status === 200) return { ok: true, available: false };
    if (r.status === 429) {
      const retry = Number(r.headers.get("retry-after") ?? "0");
      return { ok: false, reason: "rate-limited", retryAfter: retry };
    }
    return { ok: false, reason: `status ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e?.message ?? "network error" };
  }
}
