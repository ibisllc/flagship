// TOTP 2FA enrollment + disable — IRK-signed, .com-backed.
//
// Mirror of the iOS AccountSecurityViewModel (+ Android equivalent).
// The webapp DOES hold the IRK (keystore.js signWithIrk over WebCrypto
// Ed25519), so — unlike the older "use your phone" placeholder — it can
// drive the full IRK-signed handshake against the four endpoints in
// packages/control-plane/src/totp.ts:
//
//   POST /api/users/:u/totp/enroll-begin    IRK-signed
//   POST /api/users/:u/totp/enroll-confirm  IRK-signed + sample code
//   POST /api/users/:u/totp/disable         IRK-signed + live code
//
// Canonical bytes mirror @flagship/protocol exactly:
//   flagship/totp-enroll-begin/v1 | <username> | <issuedAt>
//   flagship/totp-enroll-confirm/v1 | <username> | <issuedAt>
//   flagship/totp-disable/v1 | <username> | <issuedAt>
//
// Recovery codes (the ten plaintext strings returned ONCE on
// enroll-confirm) are handed back to the caller and held only in the
// view's transient state — they leave the moment the user dismisses the
// codes screen (gated behind an explicit "I've saved these" tap), same
// as the mobile flow.

import { signWithIrk as defaultSignWithIrk } from "../keystore.js";
import { controlApex } from "./apex.js";

const COM_BASE = controlApex();

export const TAG_TOTP_ENROLL_BEGIN = "flagship/totp-enroll-begin/v1";
export const TAG_TOTP_ENROLL_CONFIRM = "flagship/totp-enroll-confirm/v1";
export const TAG_TOTP_DISABLE = "flagship/totp-disable/v1";

function canonical(parts) {
  return new TextEncoder().encode(parts.join("|"));
}

function bytesToHexLocal(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Read the account-type badge state from `GET /api/users/:u`. Mirrors
 * AccountSecurityViewModel.load(). Returns `{ accountType, totpEnrolledAt }`
 * with nulls when the user row is absent (pre-migration) so the screen
 * renders a graceful placeholder rather than erroring.
 *
 * @param {string} username
 * @param {{ fetch?: typeof fetch, baseUrl?: string }} [deps]
 * @returns {Promise<{ accountType: string|null, totpEnrolledAt: number|null }>}
 */
export async function fetchAccountType(username, deps = {}) {
  if (!username) return { accountType: null, totpEnrolledAt: null };
  const f = deps.fetch || fetch;
  const baseUrl = deps.baseUrl || COM_BASE;
  const r = await f(`${baseUrl}/api/users/${encodeURIComponent(username)}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!r.ok) return { accountType: null, totpEnrolledAt: null };
  const body = await r.json();
  return {
    accountType: body.accountType ?? "single",
    totpEnrolledAt: body.totpEnrolledAt ?? null,
  };
}

/**
 * Common shape for the three signed POSTs. Builds the canonical bytes,
 * signs them with the IRK, and POSTs `{ request, signature[, code] }`.
 * Resolves the parsed JSON on 2xx; throws an Error carrying `.status`
 * (and the server's `error` message) otherwise so the view can branch
 * on 401 / 409 / 503 exactly like the mobile state machine.
 */
async function signedPost(path, { username, umk, code }, deps) {
  if (!username) throw withStatus(new Error("no active account on this device"), 0);
  if (!umk) throw withStatus(new Error("unlock the webapp first"), 0);
  const f = deps.fetch || fetch;
  const baseUrl = deps.baseUrl || COM_BASE;
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const toHex = deps.bytesToHex || bytesToHexLocal;
  const issuedAt = (deps.now || Date.now)();
  const tag = path.endsWith("/enroll-begin")
    ? TAG_TOTP_ENROLL_BEGIN
    : path.endsWith("/enroll-confirm")
      ? TAG_TOTP_ENROLL_CONFIRM
      : TAG_TOTP_DISABLE;
  const sig = await sign(umk, canonical([tag, username, issuedAt]));
  const reqBody = {
    request: { username, issuedAt },
    signature: toHex(sig),
  };
  if (code !== undefined) reqBody.code = code;
  const r = await f(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const text = await r.text();
  let body = null;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? body.error
        : `HTTP ${r.status}`;
    throw withStatus(new Error(msg), r.status);
  }
  return body;
}

function withStatus(err, status) {
  err.status = status;
  return err;
}

/**
 * Step 1 — enroll-begin. Stages a fresh TOTP secret on the user row and
 * returns `{ secret, otpauthUrl, qrPngBase64, issuer }` (the QR + manual
 * key the sheet renders). Throws `.status === 503` when the server has
 * no TOTP KEK configured.
 *
 * @param {{ username: string, umk: Uint8Array }} args
 * @param {object} [deps]
 * @returns {Promise<{ secret: string, otpauthUrl: string, qrPngBase64: string, issuer: string }>}
 */
export async function totpEnrollBegin({ username, umk }, deps = {}) {
  const body = await signedPost(
    `/api/users/${encodeURIComponent(username)}/totp/enroll-begin`,
    { username, umk },
    deps,
  );
  return {
    secret: body.secret,
    otpauthUrl: body.otpauthUrl,
    qrPngBase64: body.qrPngBase64 ?? "",
    issuer: body.issuer ?? "Flagship",
  };
}

/**
 * Step 2 — enroll-confirm with the user-entered 6-digit sample code. On
 * success the account flips to `'multi'` and 10 recovery codes are
 * returned ONCE. Throws `.status === 401` on a code mismatch (the view
 * should let the user retry without restarting).
 *
 * @param {{ username: string, umk: Uint8Array, code: string }} args
 * @param {object} [deps]
 * @returns {Promise<{ accountType: string, totpEnrolledAt: number, recoveryCodes: string[] }>}
 */
export async function totpEnrollConfirm({ username, umk, code }, deps = {}) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) throw withStatus(new Error("enter the 6-digit code from your authenticator app"), 0);
  const body = await signedPost(
    `/api/users/${encodeURIComponent(username)}/totp/enroll-confirm`,
    { username, umk, code: trimmed },
    deps,
  );
  return {
    accountType: body.accountType ?? "multi",
    totpEnrolledAt: body.totpEnrolledAt,
    recoveryCodes: body.recoveryCodes ?? [],
  };
}

/**
 * Disable a previously-enrolled 2FA with a live 6-digit code (or a
 * recovery code). Refused (`.status === 409`) when other paired sessions
 * exist. On success the account returns to `'single'`.
 *
 * @param {{ username: string, umk: Uint8Array, code: string }} args
 * @param {object} [deps]
 * @returns {Promise<{ accountType: string }>}
 */
export async function totpDisable({ username, umk, code }, deps = {}) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) throw withStatus(new Error("enter your 6-digit code or a recovery code to confirm"), 0);
  const body = await signedPost(
    `/api/users/${encodeURIComponent(username)}/totp/disable`,
    { username, umk, code: trimmed },
    deps,
  );
  return { accountType: body.accountType ?? "single" };
}
