// Owner debug access (docs/recipe-delivery-and-remote-install.md "Debug
// access"): an admin device lets one SSH public key in as the box's `debug`
// user until a set time. Both orders are sensitive (admin root on a pinned
// box, the IRK only where none is pinned):
//
//   flagship/debug-access/v2|<serverDomain>|<sshPublicKey>|<issuedAt>|<expiresAt>
//   flagship/debug-access-revoke/v1|<serverDomain>|<issuedAt>
//
// Port of packages/protocol/src/debugAccess.ts; must pass
// packages/protocol/test-vectors/debug-access/vectors.json.

import { sha256 } from "../vendor/noble-hashes/sha2.js";
import { bytesToHex } from "../keystore.js";
import { sensitiveSigner } from "./adminRoot.js";
import { getSession } from "./state.js";

export const TAG_DEBUG_ACCESS = "flagship/debug-access/v2";
export const TAG_DEBUG_ACCESS_REVOKE = "flagship/debug-access-revoke/v1";

export const DEBUG_ACCESS_HOUR_MS = 60 * 60 * 1000;
export const DEBUG_ACCESS_DEFAULT_MS = 24 * DEBUG_ACCESS_HOUR_MS;
export const DEBUG_ACCESS_MAX_MS = 7 * 24 * DEBUG_ACCESS_HOUR_MS;

/** The durations the server page offers; 24 hours is the default. */
export const DEBUG_DURATIONS = [
  { id: "1h", label: "1 hour", ms: DEBUG_ACCESS_HOUR_MS },
  { id: "24h", label: "24 hours", ms: DEBUG_ACCESS_DEFAULT_MS },
  { id: "7d", label: "7 days", ms: DEBUG_ACCESS_MAX_MS },
];
export const DEBUG_DEFAULT_DURATION = "24h";

export const DEBUG_WARNING = "Anyone with this key can read everything on this server while it's on.";
export const DEBUG_ADMIN_ONLY = "Only an admin device can turn debug access on or off.";

export const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa",
];

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function b64decode(s) {
  if (!B64.test(s) || s.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function b64encodeNoPad(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/=+$/, "");
}

/** `<type> <base64>` for a pasted OpenSSH public key line, or null. */
export function normalizeSshPublicKey(input) {
  if (typeof input !== "string") return null;
  const parts = input.trim().split(/\s+/);
  const at = parts.findIndex((p) => SSH_KEY_TYPES.includes(p));
  if (at < 0 || at + 1 >= parts.length) return null;
  const type = parts[at];
  const body = parts[at + 1];
  const blob = b64decode(body);
  if (!blob || blob.length < 4 + type.length || blob.length > 4096) return null;
  const n = ((blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]) >>> 0;
  if (n !== type.length) return null;
  if (new TextDecoder().decode(blob.subarray(4, 4 + n)) !== type) return null;
  return `${type} ${body}`;
}

/** OpenSSH's `SHA256:<base64 without padding>`, or null. */
export function sshKeyFingerprint(key) {
  const norm = normalizeSshPublicKey(key);
  if (!norm) return null;
  return `SHA256:${b64encodeNoPad(sha256(b64decode(norm.split(" ")[1])))}`;
}

/** Why a grant can't be signed, as the sentence to show, or null. */
export function debugAccessGrantProblem(g) {
  if (!g || typeof g.serverDomain !== "string" || g.serverDomain.length === 0) {
    return "The debug access grant doesn't name a server.";
  }
  if (typeof g.sshPublicKey !== "string" || g.sshPublicKey.trim().length === 0) {
    return "Debug access needs an SSH public key.";
  }
  if (normalizeSshPublicKey(g.sshPublicKey) !== g.sshPublicKey) {
    return "That isn't an SSH public key this server can use.";
  }
  if (!Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expiresAt) || g.issuedAt <= 0) {
    return "The debug access grant has no valid time.";
  }
  if (g.expiresAt <= g.issuedAt) return "Debug access has to end after it starts.";
  if (g.expiresAt - g.issuedAt > DEBUG_ACCESS_MAX_MS) return "Debug access can be on for at most 7 days at a time.";
  return null;
}

function guard(name, v) {
  if (/[|\x00-\x1f\x7f]/.test(v)) throw new Error(`${name} contains a separator or control character`);
}

export function canonicalDebugAccessGrant(g) {
  guard("serverDomain", g.serverDomain);
  guard("sshPublicKey", g.sshPublicKey);
  if (!Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expiresAt)) {
    throw new Error("debug access times must be integers");
  }
  return new TextEncoder().encode(
    [TAG_DEBUG_ACCESS, g.serverDomain, g.sshPublicKey, String(g.issuedAt), String(g.expiresAt)].join("|"),
  );
}

export function canonicalDebugAccessRevoke(r) {
  guard("serverDomain", r.serverDomain);
  if (!Number.isSafeInteger(r.issuedAt)) throw new Error("issuedAt must be an integer");
  return new TextEncoder().encode([TAG_DEBUG_ACCESS_REVOKE, r.serverDomain, String(r.issuedAt)].join("|"));
}

function signerFor(deps) {
  const umk = deps.umk ?? getSession()?.umk;
  if (!umk) throw new Error("Unlock the webapp first.");
  return { umk, sign: deps.sign ?? sensitiveSigner() };
}

/**
 * Sign `{grant, signatureHex}` for one key. `sshPublicKey` may be the pasted
 * line; it is normalized first. Throws the problem sentence before signing.
 */
export async function buildDebugAccessGrant({ serverDomain, sshPublicKey, durationMs = DEBUG_ACCESS_DEFAULT_MS }, deps = {}) {
  const issuedAt = (deps.now ?? Date.now)();
  const key = normalizeSshPublicKey(sshPublicKey ?? "");
  if (!key && String(sshPublicKey ?? "").trim().length > 0) {
    throw new Error("That isn't an SSH public key this server can use.");
  }
  const grant = { serverDomain, sshPublicKey: key ?? "", issuedAt, expiresAt: issuedAt + durationMs };
  const problem = debugAccessGrantProblem(grant);
  if (problem) throw new Error(problem);
  const { umk, sign } = signerFor(deps);
  const sig = await sign(umk, canonicalDebugAccessGrant(grant));
  return { grant, signatureHex: bytesToHex(sig) };
}

export async function buildDebugAccessRevoke({ serverDomain }, deps = {}) {
  const revoke = { serverDomain, issuedAt: (deps.now ?? Date.now)() };
  const { umk, sign } = signerFor(deps);
  const sig = await sign(umk, canonicalDebugAccessRevoke(revoke));
  return { revoke, signatureHex: bytesToHex(sig) };
}

/**
 * Turn on (or renew) debug access on a box. `fetchJson(path, init)` is the
 * box's screens fetch; a refusal throws with the box's own sentence.
 * Resolves to the box's `{ok, change, debugAccess}`.
 */
export async function turnOnDebugAccess({ serverDomain, sshPublicKey, durationMs, fetchJson }, deps = {}) {
  const carrier = await buildDebugAccessGrant({ serverDomain, sshPublicKey, durationMs }, deps);
  return fetchJson("/api/screens/debug-access", { method: "POST", body: JSON.stringify(carrier) });
}

export async function turnOffDebugAccess({ serverDomain, fetchJson }, deps = {}) {
  const carrier = await buildDebugAccessRevoke({ serverDomain }, deps);
  return fetchJson("/api/screens/debug-access/revoke", { method: "POST", body: JSON.stringify(carrier) });
}

/** The banner line while it's on, or null. `fmt` formats the end time. */
export function debugAccessBanner(view, fmt) {
  if (!view || view.on !== true || typeof view.expiresAt !== "number") return null;
  return `Debug access is on until ${fmt(view.expiresAt)}.`;
}
