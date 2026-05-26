// P10 — Replace device (IRK rotation) ceremony.
//
// Mirror of FlagshipUI/ViewModels/ReplaceDeviceViewModel.swift. The
// webapp's Replace flow:
//
//   1. Derive OLD IRK (v1, the currently-registered key) and NEW IRK
//      (v(currentVersion+1)) locally from the session UMK using the
//      versioned HKDF in keystore.js.
//   2. Sign `flagship/re-pair-initiate/v1` canonical bytes — joined by
//      "|" with hex-encoded pubkeys — with the NEW IRK private key.
//      (The NEW key signs: proof of possession of the displacing
//      identity, per @flagship/protocol's RePairInitiate.)
//   3. POST `/api/users/:u/re-pair` with `{ request, signature }` and
//      the optional `If-Match` ETag captured from the most recent
//      /devices fetch. Worker returns:
//        - 200 + { ok, completesAt, graceMs, accountType, totpRequired }
//        - 412 (device list shifted — caller refreshes + retries)
//        - 409 (re-pair already pending)
//        - 401 (multi-device account: totpProof required — surfaced)
//        - 403 (stale request / mismatch)
//
// On success the caller persists the pending state locally (we don't
// have a Keystore-equivalent rotation counter on the webapp's session
// — single IRK version per browser profile — so the UI surfaces a
// "complete later" panel instead of bumping a slot).
//
// `complete()` is wired separately as a POST to `/re-pair/complete`
// after the grace expires. The server returns:
//   - 200 + { ok, newIrkPub, swappedAt, quarantineUntil, recoveryWipePolicy }
//   - 404 if no pending row exists (already completed / never initiated)
//   - 425 (Too Early) if the grace hasn't elapsed
//   - 409 if the pending row was objected or the IRK already rotated
//
// All network state lives in arguments; dependency injection lets the
// vitest suite drive the helpers without browser globals.

import {
  deriveIrkFromSeed,
  deriveIrkVersioned,
  bytesToHex,
} from "../keystore.js";

/** Canonical-bytes tag — MUST match @flagship/protocol TAG_RE_PAIR_INITIATE. */
export const TAG_RE_PAIR_INITIATE = "flagship/re-pair-initiate/v1";

const APEX = "https://flagshipserver.com";

/**
 * Build the canonical bytes the NEW IRK signs. Pinned byte-for-byte to
 * @flagship/protocol's `canonicalRePairInitiate`:
 *
 *   "flagship/re-pair-initiate/v1|<username>|<hex(newIrkPub)>|<hex(oldIrkPub)>|<issuedAt>"
 *
 * Exported so the vitest test suite can pin the contract.
 */
export function canonicalRePairInitiateBytes({ username, newIrkPubHex, oldIrkPubHex, issuedAt }) {
  return new TextEncoder().encode(
    [TAG_RE_PAIR_INITIATE, username, newIrkPubHex, oldIrkPubHex, issuedAt].join("|"),
  );
}

/**
 * Run the Replace-device ceremony. Returns `{ ok: true, completesAt,
 * graceMs, newVersion, accountType, totpRequired }` on a 200; throws
 * with a tagged error code (`.code` is one of "412" | "409" | "401" |
 * "403" | "400" | "5xx" | "network") on a non-2xx so the calling UI
 * can map to user-facing copy.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {Uint8Array} args.umk           session UMK seed (32 bytes)
 * @param {number} [args.currentVersion]  current IRK rotation slot (default 1)
 * @param {string|null} [args.ifMatch]    devices-list ETag for the CAS fence
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]     injectable fetch
 * @param {string} [deps.origin]          override the .com origin (tests)
 * @param {() => number} [deps.now]       injectable clock
 */
export async function runReplaceDeviceCeremony(args, deps = {}) {
  const { username, umk } = args;
  const currentVersion = args.currentVersion ?? 1;
  const ifMatch = args.ifMatch ?? null;
  if (!username) throw makeError("username required", "400");
  if (!(umk instanceof Uint8Array) || umk.length !== 32) {
    throw makeError("umk must be a 32-byte Uint8Array", "400");
  }
  const f = deps.fetch || fetch;
  const origin = deps.origin || APEX;
  const now = (deps.now || Date.now)();

  // 1 — derive OLD + NEW IRKs.
  const oldIrk = await deriveIrkVersioned(umk, currentVersion);
  const newVersion = currentVersion + 1;
  const newIrk = await deriveIrkVersioned(umk, newVersion);
  const oldIrkPubHex = bytesToHex(oldIrk.publicKey);
  const newIrkPubHex = bytesToHex(newIrk.publicKey);

  // 2 — sign canonical bytes with the NEW IRK.
  const issuedAt = now;
  const canonical = canonicalRePairInitiateBytes({
    username,
    newIrkPubHex,
    oldIrkPubHex,
    issuedAt,
  });
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, newIrk.privateKey, canonical),
  );

  // 3 — POST initiate.
  const headers = { "content-type": "application/json" };
  if (ifMatch) headers["if-match"] = ifMatch;
  const body = {
    request: { username, newIrkPub: newIrkPubHex, oldIrkPub: oldIrkPubHex, issuedAt },
    signature: bytesToHex(sigBytes),
  };
  let resp;
  try {
    resp = await f(`${origin}/api/users/${encodeURIComponent(username)}/re-pair`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  if (resp.status === 200) {
    const json = await resp.json().catch(() => ({}));
    return {
      ok: true,
      completesAt: json.completesAt,
      graceMs: json.graceMs,
      accountType: json.accountType,
      totpRequired: json.totpRequired ?? false,
      newVersion,
      newIrkPubHex,
      oldIrkPubHex,
    };
  }
  // Map the documented error statuses to the iOS-equivalent copy.
  const text = await resp.text().catch(() => "");
  if (resp.status === 412) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    throw makeError(
      "Your device list changed in the background. Refresh and try again.",
      "412",
      { currentEtag: parsed?.currentEtag ?? null },
    );
  }
  if (resp.status === 409) {
    throw makeError("A device replacement is already pending on this account.", "409");
  }
  if (resp.status === 401) {
    throw makeError("This account requires a TOTP code to recover. Open the app on a trusted device.", "401");
  }
  if (resp.status === 403) {
    throw makeError("The server rejected the request — refresh and try again.", "403");
  }
  if (resp.status === 400) {
    throw makeError(`Bad request: ${text || resp.status}`, "400");
  }
  throw makeError(`Server error (${resp.status}): ${text}`, "5xx");
}

/**
 * Finalize the rotation after the grace window. Returns the parsed
 * 200 body; throws (with `.code` "425" | "409" | "404") on the
 * documented non-2xx statuses.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {string} [deps.origin]
 */
export async function completeReplaceDeviceCeremony(args, deps = {}) {
  const { username } = args;
  if (!username) throw makeError("username required", "400");
  const f = deps.fetch || fetch;
  const origin = deps.origin || APEX;
  let resp;
  try {
    resp = await f(
      `${origin}/api/users/${encodeURIComponent(username)}/re-pair/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  if (resp.status === 200) {
    const body = await resp.json().catch(() => ({}));
    return { ok: true, ...body };
  }
  const text = await resp.text().catch(() => "");
  if (resp.status === 425) {
    throw makeError("The 24-hour grace hasn't ended yet. Try again later.", "425");
  }
  if (resp.status === 409) {
    throw makeError("Another device objected, or the IRK has already rotated. Local state stays unchanged.", "409");
  }
  if (resp.status === 404) {
    throw makeError("No pending rotation found on the server.", "404");
  }
  throw makeError(`Server error (${resp.status}): ${text}`, "5xx");
}

/**
 * Run a 3-second confirmation countdown. Resolves true if it ran to
 * completion, false if `cancel()` was invoked. The on-tick callback
 * receives the integer seconds remaining (3, 2, 1, then "go").
 * Uses globalThis.setTimeout so vitest fake timers can drive it.
 */
export function startCountdown({ onTick, intervalMs = 1000, ticks = 3 } = {}) {
  let remaining = ticks;
  let cancelled = false;
  let timer = 0;
  let resolver = null;
  if (typeof onTick === "function") onTick(remaining);
  const promise = new Promise((resolve) => {
    resolver = resolve;
    const step = () => {
      if (cancelled) return resolve(false);
      remaining -= 1;
      if (typeof onTick === "function") onTick(remaining);
      if (remaining <= 0) return resolve(true);
      timer = setTimeout(step, intervalMs);
    };
    timer = setTimeout(step, intervalMs);
  });
  return {
    promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (resolver) resolver(false);
    },
  };
}

function makeError(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// Re-export for tests that want to pin the helper exists.
export const _internal = { deriveIrkFromSeed };
