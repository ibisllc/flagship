// Code protection (TOTP) — turn on, confirm and turn off, signed by the
// account's admin key, against `.com`.
//
// Mirror of the iOS AccountSecurityViewModel (+ Android equivalent):
//
//   POST /api/users/:u/totp/enroll-begin    admin-signed
//   POST /api/users/:u/totp/enroll-confirm  admin-signed + sample code
//   POST /api/users/:u/totp/disable         admin-signed + live code
//
// Turning code protection on or off is an admin order (owner, 2026-11-23):
// the three canonical tags are in lib/adminRoot.js SENSITIVE_TAGS, so the
// gated signer signs them with the admin root (one passkey prompt when the
// key is passkey-protected) and falls back to the IRK only on an account with
// no admin root, which `.com` still takes. A non-admin device never gets here:
// the view shows the setting read-only.
//
// Canonical bytes mirror @flagship/protocol exactly:
//   flagship/totp-enroll-begin/v1 | <username> | <issuedAt>
//   flagship/totp-enroll-confirm/v1 | <username> | <issuedAt>
//   flagship/totp-disable/v1 | <username> | <issuedAt>
//
// Every failure reaches the view as an Error with a `userMessage` written for
// the person and a `code` (security report F2: the old "Network error" covered
// a refusal, a server failure, a blocked request and a missing account alike):
// offline, unreachable, a server failure, a browser that can't sign, an
// account that isn't loaded, or `.com`'s own refusal code.
//
// Recovery codes (the ten plaintext strings returned ONCE on
// enroll-confirm) are handed back to the caller and held only in the
// view's transient state — they leave the moment the user dismisses the
// codes screen (gated behind an explicit "I've saved these" tap), same
// as the mobile flow.

import { signWithIrk } from "../keystore.js";
import { sensitiveSigner } from "./adminRoot.js";
import { controlApex } from "./apex.js";
import { throwIfRateLimited } from "./rateLimited.js";
import { HUMAN_ERROR_COPY, humanError, knownReasonText, userError } from "./humanError.js";
import { custodyErrorText } from "./keyCustody.js";
import { tr } from "./i18n.js";

const COM_BASE = controlApex();

export const TAG_TOTP_ENROLL_BEGIN = "flagship/totp-enroll-begin/v1";
export const TAG_TOTP_ENROLL_CONFIRM = "flagship/totp-enroll-confirm/v1";
export const TAG_TOTP_DISABLE = "flagship/totp-disable/v1";

/** What each failure says. Exported for the view and the tests. */
export const TOTP_COPY = {
  offline: tr("You're offline. Connect to the internet and try again."),
  unreachable: tr("Couldn't reach Flagship. If your connection works, a browser extension, VPN or firewall may be blocking flagshipserver.com."),
  server: HUMAN_ERROR_COPY.server,
  unsupported: tr("This browser can't make the signature this needs. Update it, or turn this on from the Flagship app."),
  signFailed: tr("This browser couldn't sign the request. Try again."),
  alreadyOn: tr("Code protection is already on for this account. Turn it off first to set up a new authenticator."),
  alreadyOff: tr("Code protection is already off for this account."),
  notLoaded: tr("This browser hasn't loaded your account. Lock and unlock it, then try again."),
  locked: tr("Unlock the webapp first."),
  adminOnly: tr("Only an admin device of this account can change code protection."),
  notAvailable: tr("Code protection isn't available on this server yet. Try again later."),
  expired: tr("This setup expired. Start again to get a new key."),
  wrongCode: tr("That code didn't match. Try a fresh code from your authenticator."),
  otherDevices: tr("Disable refused — other devices are still trusted on this account. Disconnect them first."),
  accountNotFound: tr("Flagship doesn't know this account. Lock and unlock this browser, then try again."),
};

/** The sentence for `.com`'s answer to one of the three calls. */
export function totpRefusalText(status, code, reason) {
  switch (code) {
    case "totp-admin-only":
      return TOTP_COPY.adminOnly;
    case "totp-already-enrolled":
      return TOTP_COPY.alreadyOn;
    case "totp-not-enrolled":
      return TOTP_COPY.alreadyOff;
    case "totp-not-configured":
      return TOTP_COPY.notAvailable;
    case "totp-pending-expired":
    case "totp-no-pending":
      return TOTP_COPY.expired;
    case "invalid-totp-code":
      return TOTP_COPY.wrongCode;
    case "totp-other-devices":
      return TOTP_COPY.otherDevices;
    case "account-not-found":
      return TOTP_COPY.accountNotFound;
    case "internal-error":
      return TOTP_COPY.server;
    default:
      break;
  }
  if (status === 503) return TOTP_COPY.notAvailable;
  if (status >= 500) return TOTP_COPY.server;
  return knownReasonText(reason) ?? humanError(status);
}

/** A failed fetch() (it never got an answer), told apart: offline, or something in the way. */
export function transportError(cause, nav = globalThis.navigator) {
  const offline = nav?.onLine === false;
  return userError(offline ? TOTP_COPY.offline : TOTP_COPY.unreachable, { code: offline ? "offline" : "network", cause });
}

/** A failure to sign, told apart: passkey custody, a browser without Ed25519, anything else. */
export function signingError(cause) {
  if (typeof cause?.code === "string" && cause.code.startsWith("custody-")) {
    return userError(custodyErrorText(cause), { code: cause.code, cause });
  }
  if (cause?.name === "NotSupportedError") return userError(TOTP_COPY.unsupported, { code: "unsupported", cause });
  return userError(TOTP_COPY.signFailed, { code: "sign-failed", cause });
}

/** True when this browser has WebCrypto at all (Ed25519 itself is only known by trying). */
function hasWebCrypto() {
  return !!globalThis.crypto?.subtle;
}

/** The sentence for anything the three calls threw. */
export function totpErrorText(e) {
  if (e && typeof e === "object" && typeof e.userMessage === "string" && e.userMessage) return e.userMessage;
  return humanError(e);
}

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
  let r;
  try {
    r = await f(`${baseUrl}/api/users/${encodeURIComponent(username)}`, {
      method: "GET",
      cache: "no-store",
    });
  } catch (e) {
    throw transportError(e, deps.navigator);
  }
  if (r.status >= 500) throw userError(TOTP_COPY.server, { code: "server", status: r.status });
  if (!r.ok) return { accountType: null, totpEnrolledAt: null };
  const body = await r.json();
  return {
    accountType: body.accountType ?? "single",
    totpEnrolledAt: body.totpEnrolledAt ?? null,
  };
}

/**
 * Common shape for the three signed POSTs. Builds the canonical bytes,
 * signs them with the admin key (the gated signer), and POSTs
 * `{ request, signature[, code] }`. Resolves the parsed JSON on 2xx; throws
 * an Error carrying `.status`, `.code` and a `userMessage` otherwise.
 */
async function signedPost(path, { username, umk, code }, deps) {
  if (!username) throw userError(TOTP_COPY.notLoaded, { code: "account-not-loaded", status: 0 });
  if (!umk) throw userError(TOTP_COPY.locked, { code: "locked", status: 0 });
  const f = deps.fetch || fetch;
  const baseUrl = deps.baseUrl || COM_BASE;
  const sign = deps.sign || (deps.signWithIrk ? deps.signWithIrk : sensitiveSigner(signWithIrk));
  const toHex = deps.bytesToHex || bytesToHexLocal;
  const issuedAt = (deps.now || Date.now)();
  const tag = path.endsWith("/enroll-begin")
    ? TAG_TOTP_ENROLL_BEGIN
    : path.endsWith("/enroll-confirm")
      ? TAG_TOTP_ENROLL_CONFIRM
      : TAG_TOTP_DISABLE;
  if (!deps.sign && !deps.signWithIrk && !hasWebCrypto()) {
    throw userError(TOTP_COPY.unsupported, { code: "unsupported", status: 0 });
  }
  let sig;
  try {
    sig = await sign(umk, canonical([tag, username, issuedAt]));
  } catch (e) {
    throw signingError(e);
  }
  const reqBody = {
    request: { username, issuedAt },
    signature: toHex(sig),
  };
  if (code !== undefined) reqBody.code = code;
  let r;
  try {
    r = await f(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    throw transportError(e, deps.navigator);
  }
  await throwIfRateLimited(r);
  const text = await r.text();
  let body = null;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const reason = body && typeof body === "object" && typeof body.error === "string" ? body.error : "";
    const refusal = body && typeof body === "object" && typeof body.code === "string" ? body.code : "";
    throw userError(totpRefusalText(r.status, refusal, reason), {
      status: r.status,
      code: refusal || `http-${r.status}`,
      body,
    });
  }
  if (!body || typeof body !== "object") throw userError(TOTP_COPY.server, { status: r.status, code: "bad-answer" });
  return body;
}

/**
 * Step 1 — enroll-begin. Stages a fresh TOTP secret for an hour and
 * returns `{ secret, otpauthUrl, qrPngBase64, issuer }` (the QR + manual
 * key the sheet renders). Refused while code protection is on
 * (`code: "totp-already-enrolled"`).
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
  if (!trimmed) throw userError(tr("Enter the 6-digit code from your authenticator app."), { code: "no-code", status: 0 });
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
 * Turn code protection off with a live 6-digit code (or a
 * recovery code). Refused (`.status === 409`) when other paired sessions
 * exist. On success the account returns to `'single'`.
 *
 * @param {{ username: string, umk: Uint8Array, code: string }} args
 * @param {object} [deps]
 * @returns {Promise<{ accountType: string }>}
 */
export async function totpDisable({ username, umk, code }, deps = {}) {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) throw userError(tr("Enter your 6-digit code or a recovery code to confirm."), { code: "no-code", status: 0 });
  const body = await signedPost(
    `/api/users/${encodeURIComponent(username)}/totp/disable`,
    { username, umk, code: trimmed },
    deps,
  );
  return { accountType: body.accountType ?? "single" };
}
