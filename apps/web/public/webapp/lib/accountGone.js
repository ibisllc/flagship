// "This account was removed" (docs/account-gone.md): the state, no screen.
//
// After a reset or a wipe an account no longer exists on `.com`, but a browser
// that was already signed in keeps its identity and keeps calling. Every
// own-account route then answers one stable `404 { code: "account-not-found" }`
// (packages/control-plane/src/accountGone.ts). The global fetch guard
// (lib/comFetch.js) hands each such answer to `noteAccountGoneResponse`; when
// it names THIS browser's own account the state flips once, the screen
// (lib/accountGoneUi.js) takes over, and from then on every call that names
// that account is answered here with the same 404, without touching the
// network, so no poller keeps asking and no error toast repeats.
//
// Kept free of imports so the toast and the live-sync loop can read it.

export const ACCOUNT_NOT_FOUND_CODE = "account-not-found";

const OWN_ACCOUNT_PATH = /\/api\/(?:users|accounts)\/([^/?#]+)(?:[/?#]|$)/;
const NOT_OWN_NAMES = new Set(["check"]);

/** @type {string | null} */
let goneName = null;
/** @type {() => string[]} */
let ownNames = () => [];
const listeners = new Set();

/** The account a `.com` URL names in its path, lowercased, or null. */
export function accountNameInUrl(url) {
  const m = OWN_ACCOUNT_PATH.exec(String(url));
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[1]).toLowerCase(); } catch { return null; }
  return NOT_OWN_NAMES.has(name) ? null : name;
}

/** Tell this module which names are the signed-in browser's own (profile and
 *  session). Set once at boot by lib/accountGoneUi.js. */
export function setOwnAccountNames(fn) {
  ownNames = typeof fn === "function" ? fn : () => [];
}

export function isAccountGone() {
  return goneName !== null;
}

export function goneAccountName() {
  return goneName;
}

export function onAccountGone(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(goneName); } catch { /* a listener never breaks a request */ }
  }
}

/** Mark the account gone (idempotent). Returns true when this call changed it. */
export function markAccountGone(name) {
  const next = String(name).toLowerCase();
  if (goneName === next) return false;
  goneName = next;
  notify();
  return true;
}

/** The person removed it from this browser (or made a new account). */
export function clearAccountGone() {
  if (goneName === null) return;
  goneName = null;
  notify();
}

function isOwn(name) {
  try {
    return ownNames().some((n) => String(n ?? "").toLowerCase() === name);
  } catch {
    return false;
  }
}

/** The `404` body `.com` sends, also used for calls answered locally. */
export function accountGoneResponse() {
  return new Response(JSON.stringify({ error: ACCOUNT_NOT_FOUND_CODE, code: ACCOUNT_NOT_FOUND_CODE }), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** A local 404 for a call that names the removed account; null for any other call. */
export function answerIfAccountGone(url) {
  if (goneName === null) return null;
  return accountNameInUrl(url) === goneName ? accountGoneResponse() : null;
}

/**
 * Look at a `.com` answer. When it is `404 account-not-found` for this
 * browser's own account, the account is gone. Another account's name (a
 * shared server's owner, an invite author) never flips it. Returns true when
 * the answer was that 404 for our own account.
 */
export async function noteAccountGoneResponse(url, response) {
  if (!response || response.status !== 404) return false;
  const name = accountNameInUrl(url);
  if (!name || !isOwn(name)) return false;
  let body = null;
  try { body = await response.clone().json(); } catch { return false; }
  if (body?.code !== ACCOUNT_NOT_FOUND_CODE) return false;
  markAccountGone(name);
  return true;
}

/** Test seam. */
export function _resetAccountGoneForTests() {
  goneName = null;
  ownNames = () => [];
  listeners.clear();
}
