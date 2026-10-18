// comFetch — THE single chokepoint for every call to the `.com` control
// server. Centralising it is what makes the maintainer-trust gate enforceable:
// while the control server is untrusted (and its cert un-overridden), all
// backend interaction is short-circuited here (lib/serverTrust.js), per
// docs/maintainer-trust-enforcement.md ("While false, all backend interaction
// is short-circuited — not just the boot screen").
//
// It is a thin wrapper over fetch:
//   - prepends the .com apex to a leading-slash path (an absolute URL passes
//     through unchanged, so existing call-sites can migrate incrementally);
//   - refuses the call with a ServerUntrustedError when isServerTrusted() is
//     false — BEFORE the request leaves the device;
//   - turns the edge rate limiter's 429 (`error: "rate-limited"`) into a
//     thrown RateLimitedError (lib/rateLimited.js), whose message tells the
//     person who is limited and when to try again.
//
// The blessing endpoint itself is exempt (it's how trust is (re)established,
// so it must be reachable even while untrusted).

import { serverTrust } from "./serverTrust.js";
import { controlApex, controlHost } from "./apex.js";
import { throwIfRateLimited } from "./rateLimited.js";
import { UpdateRequiredError, isUpdateLocked, updateLockAllows } from "./updateLock.js";
import { answerIfAccountGone, noteAccountGoneResponse } from "./accountGone.js";

// Back-compat re-export: the control apex used to be a baked literal here.
// It is now derived (lib/apex.js — origin-driven, prod-default), so this
// stays the canonical name other modules import while resolving to the same
// prod value byte-for-byte.
export const COM_APEX = controlApex();

const BLESSING_PATH = "/api/maintainer-blessing";

export class ServerUntrustedError extends Error {
  constructor(message = "control server is not trusted") {
    super(message);
    this.name = "ServerUntrustedError";
    this.serverUntrusted = true;
  }
}

/** Resolve a path-or-URL to an absolute .com URL. */
export function comUrl(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const p = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${COM_APEX}${p}`;
}

function isBlessingUrl(url) {
  try {
    return new URL(url, COM_APEX).pathname === BLESSING_PATH;
  } catch {
    return url.includes(BLESSING_PATH);
  }
}

/**
 * Fetch a `.com` endpoint through the trust gate. Identical signature to
 * fetch(). Throws ServerUntrustedError (without touching the network) when the
 * control server is untrusted and the call is not the blessing probe.
 *
 * @param {string} pathOrUrl  a leading-slash path or an absolute .com URL
 * @param {RequestInit} [init]
 */
export async function comFetch(pathOrUrl, init = {}) {
  const url = comUrl(pathOrUrl);
  if (!isBlessingUrl(url) && !serverTrust.isServerTrusted()) {
    throw new ServerUntrustedError();
  }
  const fetchImpl = globalThis.fetch.bind(globalThis);
  const resp = await fetchImpl(url, init);
  await throwIfRateLimited(resp);
  return resp;
}

/** Does this URL point at the .com control server (the gated host)? The
 *  data plane (`*.flagship.services` pods) is NOT gated here — pods carry the
 *  RELAY blessing, gated separately on the box; and `recovery.` /
 *  `webapp.flagshipserver.com` sub-origins are gated only when they are the
 *  control apex. We gate exactly `flagshipserver.com` (the identity + state
 *  control server). */
function isComHost(url) {
  try {
    return new URL(url, COM_APEX).host === controlHost();
  } catch {
    return false;
  }
}

function lockRequest(input, init, url, controlHost) {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url, globalThis.location?.href).origin === globalThis.location?.origin;
  } catch {
    sameOrigin = false;
  }
  const method = init?.method ?? (input && typeof input === "object" ? input.method : undefined);
  return { url, method, sameOrigin, controlHost };
}

/**
 * Install a GLOBAL guard over `globalThis.fetch` so that EVERY call to the
 * `.com` control server is short-circuited while untrusted — no matter which
 * lib made it. The same guard enforces the "update required" lock
 * (lib/updateLock.js): while a signed security notice has the app locked,
 * nothing leaves the page except the webapp's own files and reads from `.com`. This is the true single chokepoint: it catches the existing
 * per-file call-sites (lib/leases.js, recovery.js, …) and any future one
 * without each having to import comFetch. The blessing probe is exempt so
 * trust can always be (re)established. A rate-limited `.com` answer rejects
 * with a RateLimitedError, so every screen's error path shows the wait. A
 * `404 account-not-found` for this browser's own account flips the "account
 * was removed" state (lib/accountGone.js) and later calls naming it are
 * answered locally.
 * Idempotent.
 */
export function installComFetchGuard() {
  if (typeof globalThis.fetch !== "function") return;
  if (globalThis.fetch.__flagshipTrustGuard) return;
  const real = globalThis.fetch.bind(globalThis);
  const guarded = async function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
          ? input.url
          : String(input);
    const com = isComHost(url);
    if (com && !isBlessingUrl(url) && !serverTrust.isServerTrusted()) {
      throw new ServerUntrustedError();
    }
    if (isUpdateLocked() && !updateLockAllows(lockRequest(input, init, url, com))) {
      throw new UpdateRequiredError();
    }
    if (com) {
      // An account that was removed answers locally: no poller keeps asking.
      const goneAnswer = answerIfAccountGone(url);
      if (goneAnswer) return goneAnswer;
    }
    const resp = await real(input, init);
    if (com) {
      await throwIfRateLimited(resp);
      await noteAccountGoneResponse(url, resp);
    }
    return resp;
  };
  guarded.__flagshipTrustGuard = true;
  guarded.__flagshipRealFetch = real;
  globalThis.fetch = guarded;
}

/** Remove the global guard (restore the underlying fetch). For tests. */
export function uninstallComFetchGuard() {
  if (globalThis.fetch && globalThis.fetch.__flagshipRealFetch) {
    globalThis.fetch = globalThis.fetch.__flagshipRealFetch;
  }
}
