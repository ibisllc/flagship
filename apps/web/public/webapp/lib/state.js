// Session-scoped derived state for the webapp.
//
// Sensitive material (UMK seed, IRK private key) lives only in this
// module's closure. Never on `window`, never logged. Views import
// `getSession()` to read; the bootstrap/unlock flow calls `unlock()`
// to populate; `lock()` clears.

import { deriveIrkFromSeed } from "../keystore.js";

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
  _session.username = username ?? localStorage.getItem("flagship.username") ?? "";
}

export function lockSession() {
  _session.umk = null;
  _session.irk = null;
  _session.username = null;
}

/**
 * Lazy-init the user's chosen username. Used by pairing + promo flows
 * that need a stable DNS-safe handle. Throws on invalid input so the
 * calling view can surface it via toast.
 */
export async function ensureUsername() {
  if (_session.username) return _session.username;
  const handle = prompt(
    "Pick a username (DNS-safe label, will appear at <name>.flagship.services):",
    "",
  );
  if (!handle || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(handle)) {
    throw new Error("invalid username");
  }
  localStorage.setItem("flagship.username", handle);
  _session.username = handle;
  return handle;
}
