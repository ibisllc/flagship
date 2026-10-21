// API keys for a live app (docs/app-apis.md §3): scripts, devices and other
// servers call the app with `Authorization: Bearer fsk_<keyId>_<secret>`. This
// device picks the keyId and scope and signs them with the sensitive-order
// key; the box mints the secret, returns it once and keeps only its hash. Keys
// last until revoked: the webapp always signs expiresAt 0 (the field stays in
// the envelope, and the box still honours a non-zero one).
//
//   flagship/app-api-key/v1|<serverDomain>|<serviceId>|<keyId>|<scope>|<expiresAt ms or 0>|<issuedAt ms>
//
// Must pass packages/protocol/test-vectors/app-api-key/vectors.json.

import { requireOwnerProfile } from "./companionGuard.js";

import { tr } from "./i18n.js";
export const TAG_APP_API_KEY = "flagship/app-api-key/v1";

export const API_KEYS_TITLE = tr("API keys");
export const API_KEYS_NOTE =
  tr("Let scripts, devices and other servers call this app. Each key works until you revoke it.");
export const API_KEYS_EMPTY = tr("No API keys yet.");
export const API_KEYS_CREATE = tr("Create key");
export const API_KEYS_REVOKE = "Revoke";
export const API_KEYS_COPY = "Copy";
export const API_KEYS_DONE = "Done";
export const API_KEYS_COMPANION_NOTE = tr("Create and revoke keys from your owner app.");
export const API_KEY_COPY_WARNING = tr("Copy it now. Flagship can't show it again.");
export const API_KEY_LABEL_MAX = 64;

export const API_KEY_SCOPES = [
  { value: "read", label: tr("Read") },
  { value: "write", label: tr("Read & write") },
];

export const DEFAULT_API_KEY_SCOPE = "read";

const KEY_ID_RE = /^[0-9a-f]{16}$/;

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** 16 random lowercase hex characters. */
export function newApiKeyId(getRandomValues = (b) => crypto.getRandomValues(b)) {
  const b = new Uint8Array(8);
  getRandomValues(b);
  return toHex(b);
}

export function scopeLabel(scope) {
  return scope === "write" ? tr("Read & write") : "Read";
}

/** The trimmed label, or an error to show next to the field. */
export function checkApiKeyLabel(label) {
  const v = String(label ?? "").trim();
  if (!v) return { error: tr("Give the key a name, so you know what uses it.") };
  if (v.length > API_KEY_LABEL_MAX) return { error: tr("Keep the name under {0} characters.", API_KEY_LABEL_MAX + 1) };
  return { label: v };
}

export function canonicalAppApiKeyBytes({ serverDomain, serviceId, keyId, scope, expiresAt, issuedAt }) {
  if (!serverDomain) throw new Error("app-api-key: empty serverDomain");
  if (!serviceId) throw new Error("app-api-key: empty serviceId");
  if (!KEY_ID_RE.test(String(keyId ?? ""))) throw new Error("app-api-key: bad keyId");
  if (scope !== "read" && scope !== "write") throw new Error("app-api-key: bad scope");
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new Error("app-api-key: bad expiresAt");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("app-api-key: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_API_KEY, serverDomain, serviceId, keyId, scope, String(expiresAt), String(issuedAt)].join("|"),
  );
}

/** Resolves to the POST body `{grant, signature, label}`. */
export async function signApiKeyGrant({ grant, label, umk, signWithIrk, bytesToHex = toHex }) {
  const sig = await signWithIrk(umk, canonicalAppApiKeyBytes(grant));
  return { grant, signature: bytesToHex(sig), label };
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/** The keys of a GET answer, newest first; anything malformed is dropped. */
export function readApiKeys(body) {
  const arr = Array.isArray(body?.keys) ? body.keys : [];
  return arr
    .filter((k) => k && typeof k === "object" && typeof k.keyId === "string" && k.keyId)
    .map((k) => ({
      keyId: k.keyId,
      label: typeof k.label === "string" ? k.label : "",
      scope: k.scope === "write" ? "write" : "read",
      createdAt: num(k.createdAt),
      lastUsedAt: num(k.lastUsedAt),
      expiresAt: num(k.expiresAt),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Only a key a box holds with a past non-zero expiresAt; the webapp never sets one. */
export function isApiKeyExpired(key, now = Date.now()) {
  return key.expiresAt > 0 && key.expiresAt <= now;
}

/** `Authorization: Bearer <key>`, the line a caller sends. */
export function apiKeyUsageLine(key) {
  return tr("Authorization: Bearer {0}", key);
}

/** The box's refusal, said plainly. */
export function apiKeyErrorMessage(e) {
  const status = e?.status;
  const raw = typeof e?.body?.error === "string" && e.body.error ? e.body.error : String(e?.message ?? "");
  if (status === 400) return raw ? tr("Your server didn't accept this key: {0}", raw) : tr("Your server didn't accept this key.");
  if (status === 404) return tr("This app isn't installed on this server anymore.");
  if (status === 409) return tr("A key with that id already exists. Try again.");
  if (status === 403) {
    if (/companion|read-only/i.test(raw)) return API_KEYS_COMPANION_NOTE;
    if (/stale|clock|issuedAt/i.test(raw)) return tr("This device's clock is more than 10 minutes off. Fix the clock and try again.");
    if (/different server|serverDomain/i.test(raw)) return tr("This key was signed for a different server.");
    if (/signature/i.test(raw)) return tr("Your server didn't accept this key's signature.");
    return raw || tr("Your server refused this key.");
  }
  return raw || tr("Couldn't update this app's API keys.");
}

const keysPath = (serviceId) => `/api/screens/services/${encodeURIComponent(serviceId)}/api-keys`;

/** The app's keys, or null when the box has no API keys (an older box 404s). */
export async function fetchApiKeys(serviceId, fetchJson) {
  try {
    return readApiKeys(await fetchJson(keysPath(serviceId)));
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/**
 * Pick a keyId, sign the grant (expiresAt 0) and send it. Resolves to `{key,
 * keyId, scope, issuedAt, label}` where `key` is the full secret the box returns
 * once. A 409 (keyId taken) is retried once with a new keyId.
 *
 * @param {object} args
 * @param {string} args.serverDomain
 * @param {string} args.serviceId
 * @param {string} args.label
 * @param {"read"|"write"} args.scope
 * @param {Uint8Array} args.umk
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} args.signWithIrk  the sensitive-order signer
 * @param {(path: string, init?: object) => Promise<any>} args.fetchJson  screensFetch
 * @param {(b: Uint8Array) => string} [args.bytesToHex]
 * @param {{ now?: () => number, getRandomValues?: (b: Uint8Array) => void, requireOwnerProfile?: () => void }} [deps]
 */
export async function createApiKey(args, deps = {}) {
  const { serverDomain, serviceId, scope, umk, signWithIrk, fetchJson, bytesToHex } = args;
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  if (!umk || typeof signWithIrk !== "function") throw new Error(tr("Unlock the webapp first"));
  const checked = checkApiKeyLabel(args.label);
  if (checked.error) throw new Error(checked.error);
  for (let attempt = 0; ; attempt++) {
    const issuedAt = (deps.now || Date.now)();
    const grant = {
      serverDomain,
      serviceId,
      keyId: newApiKeyId(deps.getRandomValues),
      scope,
      expiresAt: 0,
      issuedAt,
    };
    const body = await signApiKeyGrant({
      grant,
      label: checked.label,
      umk,
      signWithIrk,
      ...(bytesToHex ? { bytesToHex } : {}),
    });
    let r;
    try {
      r = await fetchJson(keysPath(serviceId), { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      if (attempt === 0 && e?.status === 409) continue;
      throw e;
    }
    if (typeof r?.key !== "string" || !r.key) throw new Error(tr("Your server didn't return the new key."));
    return { key: r.key, keyId: grant.keyId, scope, issuedAt, label: checked.label };
  }
}

/** Revoke: the box drops the key. Removing access needs no signature; a key
 *  the box no longer has (404) counts as revoked. */
export async function revokeApiKey({ serviceId, keyId, fetchJson }, deps = {}) {
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  try {
    await fetchJson(`${keysPath(serviceId)}/${encodeURIComponent(keyId)}`, { method: "DELETE" });
  } catch (e) {
    if (e?.status !== 404) throw e;
  }
}
