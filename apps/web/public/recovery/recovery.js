// Flagship WebAuthn-PRF recovery — dedicated sub-origin (Tasks #73 + #74).
//
// This module runs ONLY at https://recovery.flagshipserver.com/. The
// passkey created/used here is scoped to rpId =
// "recovery.flagshipserver.com" via the browser's WebAuthn same-origin
// enforcement — so an XSS on flagshipserver.com or
// web.flagshipserver.com cannot silently exercise it. This is the C3/B1
// audit fix.
//
// We never see the user's IRK private key here. The webapp (parent)
// keeps signing + identity logic; this page is a thin shell that:
//
//   enroll mode (#enroll):
//     1. Receive {umk, username} from the parent via postMessage.
//     2. User picks a recovery passphrase. We derive
//        passphraseKey = Argon2id(passphrase, salt=username, m, t, p)
//        then split into:
//          fetchToken = HKDF(passphraseKey, "flagship.recovery.fetch.v1")
//          prfSalt    = HKDF(passphraseKey, "flagship.recovery.salt.v1")
//     3. Create a passkey + PRF-derived AES-GCM key (PRF input = prfSalt).
//     4. Wrap the UMK seed → ciphertext.
//     5. postMessage {credentialIdHex, wrappedUmkB64, fetchTokenHashHex,
//        prfSaltHashHex} back to the parent so the parent signs + uploads
//        via /api/recovery on the apex. (Task #74)
//
//   recover mode (#recover):
//     1. Collect username + passphrase.
//     2. Re-derive Argon2id → fetchToken + prfSalt.
//     3. POST /api/recovery/by-username/<u>/fetch with fetchToken. .com
//        verifies SHA256(fetchToken) === stored hash; returns wrappedUmk +
//        prfSaltHash on match.
//     4. WebAuthn get() with PRF (input = prfSalt) → unwrap → UMK seed.
//     5. postMessage the seed back to the parent.
//
// Argon2id parameters (see derivePassphraseKey below). Tuned for ~1.5s
// on a Pixel 6 in pure JS / Web Worker context. The recovery flow is
// rare (once per device-pair / once per fresh-browser-recovery), so
// 1.5-2s of latency is acceptable; the security gain is significant
// (offline attack on a leaked wrappedUmk requires ~m*t per guess at
// the attacker's tier).
import { argon2id } from "./vendor/noble-hashes/argon2.js";

const APEX = "https://flagshipserver.com";
const RP_ID = "recovery.flagshipserver.com";
const RP_NAME = "Flagship recovery";

// Argon2id parameters (RFC 9106). Picked to satisfy:
//   - OWASP 2024 minimum (m=19MB, t=2) and 2026 stretch (m=46MB, t=3, p=1).
//   - <2s on Pixel 6 / Apple A14 / mid-range desktop (verified in the
//     recoveryPassphraseSubOrigin.test.ts performance smoke).
//   - Memory: 46 MiB fits comfortably on every iOS / Android version
//     we ship for (iOS 16+ webview cap is 800 MiB, Android Chrome 4 GiB).
// Spec called for m=64MB, t=3, p=1; we dialled m down by ~30% so the
// flow completes inside the 2-second budget on a worst-case Pixel 6
// (low-power Cortex-A55, where pure-JS Argon2 is ~3x slower than on
// a Pixel 6 high-perf core). See docs/runbooks/recovery-subdomain.md
// for the budget calibration notes.
const ARGON2_M_KB = 46 * 1024; // 46 MiB
const ARGON2_T = 3;
const ARGON2_P = 1;
const ARGON2_KEY_BYTES = 32;

// Per-user Argon2 salt namespace. The Argon2 salt itself is the lower-
// cased username — we don't have a server-side per-user random salt
// because the user must be able to regenerate the key from passphrase
// alone on a fresh browser (no .com round trip until AFTER the
// fetchToken is derived). Username is at least globally unique within
// Flagship's namespace, which is enough to prevent cross-user rainbow
// tables while keeping the flow stateless.
const ARGON2_SALT_TAG = "flagship.recovery.argon2.v1";

const FETCH_TOKEN_INFO = new TextEncoder().encode("flagship.recovery.fetch.v1");
const PRF_SALT_INFO = new TextEncoder().encode("flagship.recovery.salt.v1");

// The webapp (web.flagshipserver.com) is the only postMessage peer we
// trust. Browsers enforce this via `event.origin`; we also re-pin every
// outbound postMessage's targetOrigin so a compromised/redirected
// parent can't widen the audience.
const PARENT_ORIGIN = "https://web.flagshipserver.com";

const state = {
  mode: null, // "enroll" | "recover" | null
  enrollUmk: null, // Uint8Array, only present in enroll mode
  enrollAdminRootSeed: null, // Slice D (D-3): admin root, escrowed with the UMK
  enrollUsername: null,
  parentOrigin: null, // pinned to event.origin of the first valid HELLO
};

function $(id) { return document.getElementById(id); }
function show(id) { $(id)?.classList.remove("hidden"); }
function hide(id) { $(id)?.classList.add("hidden"); }

function setStatus(id, msg, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("err", "ok");
  if (kind === "err") el.classList.add("err");
  if (kind === "ok") el.classList.add("ok");
}

function selectMode() {
  const h = (location.hash || "").replace(/^#/, "").trim().toLowerCase();
  if (h === "enroll") {
    state.mode = "enroll";
    hide("view-idle");
    show("view-enroll");
  } else if (h === "recover") {
    state.mode = "recover";
    hide("view-idle");
    show("view-recover");
  } else {
    state.mode = null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Parent ↔ sub-origin messaging
// ──────────────────────────────────────────────────────────────────────

function postToParent(msg) {
  const target = state.parentOrigin || PARENT_ORIGIN;
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(msg, target);
  } else if (window.parent && window.parent !== window) {
    window.parent.postMessage(msg, target);
  }
}

window.addEventListener("message", (ev) => {
  // Strict origin check — we only listen to the webapp. Anything else
  // is dropped. Browsers also enforce that messages from cross-origin
  // windows can only be sent by code running on that origin (or by
  // synthetic browser machinery for opener relationships), so this is
  // belt-and-braces.
  if (ev.origin !== PARENT_ORIGIN) return;
  const m = ev.data;
  if (!m || typeof m !== "object") return;
  if (m.type === "flagship-recovery-hello") {
    state.parentOrigin = ev.origin;
    postToParent({ type: "flagship-recovery-ready", mode: state.mode });
    return;
  }
  if (m.type === "flagship-recovery-enroll-payload" && state.mode === "enroll") {
    if (!(m.umk instanceof Uint8Array) && !Array.isArray(m.umk)) {
      postToParent({ type: "flagship-recovery-error", reason: "umk missing or wrong shape" });
      return;
    }
    state.enrollUmk = m.umk instanceof Uint8Array ? new Uint8Array(m.umk) : new Uint8Array(m.umk);
    // Slice D (D-3): OPTIONAL admin master root, escrowed alongside the UMK.
    state.enrollAdminRootSeed =
      Array.isArray(m.adminRootSeed) || m.adminRootSeed instanceof Uint8Array
        ? new Uint8Array(m.adminRootSeed)
        : null;
    state.enrollUsername = typeof m.username === "string" ? m.username : null;
    if (!state.enrollUsername) {
      postToParent({ type: "flagship-recovery-error", reason: "username missing" });
      return;
    }
    const el = $("enroll-username");
    if (el) el.textContent = `Will enrol passkey for: ${state.enrollUsername}`;
  }
});

// Tell the parent we're alive. The parent set state.parentOrigin via
// the incoming HELLO, but if the window.opener path is used the parent
// may also be listening for our ready signal on a fresh pipe.
window.addEventListener("load", () => {
  selectMode();
  postToParent({ type: "flagship-recovery-ready", mode: state.mode });
});

// ──────────────────────────────────────────────────────────────────────
// Enroll
// ──────────────────────────────────────────────────────────────────────

$("enroll-go")?.addEventListener("click", async () => {
  const btn = $("enroll-go");
  if (btn) btn.disabled = true;
  setStatus("enroll-status", "Working…", null);
  try {
    if (!state.enrollUmk || !state.enrollUsername) {
      throw new Error("waiting for the webapp to send your UMK — open recovery from inside the webapp");
    }
    await assertWebauthn();
    const pp1 = $("enroll-passphrase")?.value || "";
    const pp2 = $("enroll-passphrase-2")?.value || "";
    if (pp1.length < 8) throw new Error("passphrase must be 8+ characters");
    if (pp1 !== pp2) throw new Error("passphrases do not match");

    const username = state.enrollUsername;
    setStatus("enroll-status", "Hardening your passphrase (Argon2id, ~1.5s)…", null);
    const { fetchToken, prfSalt } = await derivePassphraseSecrets(pp1, username);

    setStatus("enroll-status", "Creating passkey on this device…", null);
    const { credentialIdHex, prfBytes } = await createPasskey(username, prfSalt);
    // Slice D (D-3): escrow the admin root by wrapping `umk || adminRootSeed`
    // (64 bytes) under the PRF key. Without an admin root we wrap the UMK alone
    // (32 bytes) — byte-identical to the pre-D escrow. `.com` stores opaque
    // ciphertext, so the length change is transparent to it.
    const secretMaterial = state.enrollAdminRootSeed
      ? concatBytes(state.enrollUmk, state.enrollAdminRootSeed)
      : state.enrollUmk;
    const wrappedB64 = await wrapUmkWithPrf(secretMaterial, prfBytes);

    const fetchTokenHashHex = await sha256Hex(fetchToken);
    const prfSaltHashHex = await sha256Hex(prfSalt);

    postToParent({
      type: "flagship-recovery-enroll-result",
      credentialIdHex,
      wrappedUmkB64: wrappedB64,
      fetchTokenHashHex,
      prfSaltHashHex,
    });
    setStatus("enroll-status", "Done — return to the webapp to finish.", "ok");
  } catch (e) {
    setStatus("enroll-status", String(e?.message ?? e), "err");
    postToParent({ type: "flagship-recovery-error", reason: String(e?.message ?? e) });
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ──────────────────────────────────────────────────────────────────────
// Recover
// ──────────────────────────────────────────────────────────────────────

$("recover-go")?.addEventListener("click", async () => {
  const btn = $("recover-go");
  if (btn) btn.disabled = true;
  setStatus("recover-status", "Working…", null);
  try {
    await assertWebauthn();
    const username = ($("recover-username")?.value || "").trim().toLowerCase();
    const pp = $("recover-passphrase")?.value || "";
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) throw new Error("invalid username");
    if (pp.length < 8) throw new Error("passphrase must be 8+ characters");

    setStatus("recover-status", "Hardening your passphrase (Argon2id, ~1.5s)…", null);
    const { fetchToken, prfSalt } = await derivePassphraseSecrets(pp, username);

    setStatus("recover-status", "Asking flagshipserver.com for the wrapped key…", null);
    const fetched = await fetchWrappedUmk(username, fetchToken);
    if (!fetched) throw new Error("no cloud recovery for that username");
    const { credentialIdHex, wrappedUmkB64, prfSaltHash } = fetched;

    // Defense-in-depth: verify the server returned the same prfSalt we
    // derived locally (otherwise a tampered .com could feed us a
    // different salt to coerce the wrong PRF output → AES-GCM decrypt
    // will then fail with a generic "tag mismatch" that's hard to
    // debug. Surface a specific error here.)
    if (prfSaltHash) {
      const localPrfSaltHash = await sha256Hex(prfSalt);
      if (localPrfSaltHash !== prfSaltHash.toLowerCase()) {
        throw new Error("server returned a stale prfSaltHash — refusing to proceed");
      }
    }

    const credentialId = hexToBytes(credentialIdHex);
    const wrapped = base64ToBytes(wrappedUmkB64);
    const prfBytes = await getPrfWithGet(credentialId, prfSalt);
    if (!prfBytes) throw new Error("WebAuthn PRF not supported by this authenticator");

    const material = await unwrapUmkWithPrf(wrapped, prfBytes);
    // Slice D (D-3): a post-D escrow is `umk(32) || adminRootSeed(32)`; a legacy
    // escrow is the 32-byte UMK alone. Split so the UMK stays exactly 32 bytes
    // (the parent's invariant) and the admin root rides as an additive field the
    // recovery-rotation consumer (deferred) picks up.
    const umk = material.slice(0, 32);
    const adminRootSeed = material.length >= 64 ? material.slice(32, 64) : null;
    postToParent({
      type: "flagship-recovery-recover-result",
      username,
      umk: Array.from(umk), // serialize for structured-clone safety
      ...(adminRootSeed ? { adminRootSeed: Array.from(adminRootSeed) } : {}),
    });
    setStatus("recover-status", "Done — return to the webapp to finish.", "ok");
  } catch (e) {
    setStatus("recover-status", String(e?.message ?? e), "err");
    postToParent({ type: "flagship-recovery-error", reason: String(e?.message ?? e) });
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ──────────────────────────────────────────────────────────────────────
// WebAuthn helpers
// ──────────────────────────────────────────────────────────────────────

async function assertWebauthn() {
  if (!("credentials" in navigator) || !window.PublicKeyCredential) {
    throw new Error("WebAuthn not supported in this browser");
  }
}

async function createPasskey(username, prfSalt) {
  const userIdBytes = new TextEncoder().encode(username);
  const challenge = randBytes(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: RP_ID, name: RP_NAME },
      user: { id: userIdBytes, name: username, displayName: username },
      pubKeyCredParams: [
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
      timeout: 90_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  if (!cred) throw new Error("passkey creation cancelled");
  const credentialId = new Uint8Array(cred.rawId);
  let prfBytes = readPrfFirst(cred);
  if (!prfBytes) prfBytes = await getPrfWithGet(credentialId, prfSalt);
  if (!prfBytes) throw new Error("WebAuthn PRF not supported by this authenticator");
  return { credentialIdHex: bytesToHex(credentialId), prfBytes };
}

async function getPrfWithGet(credentialId, prfSalt) {
  const challenge = randBytes(32);
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: RP_ID,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "preferred",
      timeout: 90_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  return readPrfFirst(cred);
}

function readPrfFirst(cred) {
  if (!cred) return null;
  const r = cred.getClientExtensionResults?.();
  const first = r?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

// ──────────────────────────────────────────────────────────────────────
// .com fetch
// ──────────────────────────────────────────────────────────────────────

async function fetchWrappedUmk(username, fetchToken) {
  // Task #74 — the gate. We first hit the metadata GET to confirm a
  // record exists + grab the credentialId, then POST /fetch with the
  // passphrase-derived fetchToken. .com only releases the ciphertext
  // when SHA-256(fetchToken) matches the stored hash. A wrong
  // passphrase will return 403 here; the rate-limiter caps attempts
  // at 3-per-15min per usernameHash before the request even reaches
  // this handler.
  const meta = await fetch(
    `${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`,
  );
  if (meta.status === 404) return null;
  if (!meta.ok) throw new Error(`metadata fetch failed: ${meta.status}`);
  const metaBody = await meta.json();
  if (!metaBody.hasFetchTokenGate) {
    throw new Error(
      "this record predates the passphrase gate — re-enrol cloud recovery first",
    );
  }
  const credentialIdHex = metaBody.credentialId;

  const gated = await fetch(
    `${APEX}/api/recovery/by-username/${encodeURIComponent(username)}/fetch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fetchToken: bytesToHex(fetchToken),
        issuedAt: Date.now(),
      }),
    },
  );
  if (gated.status === 403) {
    throw new Error("wrong passphrase");
  }
  if (gated.status === 429) {
    throw new Error("too many attempts — wait 15 minutes before retrying");
  }
  if (!gated.ok) {
    throw new Error(`fetch failed: ${gated.status}`);
  }
  const b = await gated.json();
  return {
    credentialIdHex: b.credentialId ?? credentialIdHex,
    wrappedUmkB64: b.wrappedUmk,
    prfSaltHash: b.prfSaltHash,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Crypto + serialization
// ──────────────────────────────────────────────────────────────────────

/**
 * Argon2id over the passphrase → 32-byte master key → HKDF-split into
 * (fetchToken, prfSalt). Both are surfaced as Uint8Arrays.
 *
 * The Argon2id salt is the lowercased username. Argon2's salt only
 * needs to be unique-per-passphrase to defeat rainbow tables; a
 * username is unique within Flagship and persistable without a
 * round-trip to .com, which is exactly what we need for stateless
 * client recovery.
 *
 * Why split:
 *   - fetchToken is the .com gate: revealing it (or its SHA-256) to
 *     the server doesn't compromise the prfSalt.
 *   - prfSalt feeds WebAuthn's prf.eval.first — it stays client-side
 *     forever.
 * Domain-separating them with HKDF means even if the .com gate is
 * ever weakened, the PRF salt still depends on the full passphrase
 * via Argon2id.
 */
async function derivePassphraseSecrets(passphrase, username) {
  const pwd = new TextEncoder().encode(passphrase);
  const salt = new TextEncoder().encode(
    `${ARGON2_SALT_TAG}|${username.toLowerCase()}`,
  );
  // argon2id signature: argon2id(password, salt, opts) → Uint8Array(dkLen)
  // Defer the actual work to noble; it's pure-JS but uses Uint32Array
  // for the internal blocks. m=46MB, t=3, p=1 → ~1.5s on a Pixel 6.
  const masterKey = argon2id(pwd, salt, {
    t: ARGON2_T,
    m: ARGON2_M_KB,
    p: ARGON2_P,
    dkLen: ARGON2_KEY_BYTES,
  });

  // HKDF-Extract+Expand using WebCrypto so the split itself is fast +
  // doesn't depend on noble.
  const ikm = await crypto.subtle.importKey(
    "raw", masterKey, "HKDF", false, ["deriveBits"],
  );
  const hkdfSalt = new Uint8Array(); // zero-length per RFC 5869 default
  const fetchToken = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: FETCH_TOKEN_INFO },
      ikm, 256,
    ),
  );
  const prfSalt = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info: PRF_SALT_INFO },
      ikm, 256,
    ),
  );
  // Wipe the master key from memory; noble's `clean` would be nicer
  // but it's not exported here, and we can't help GC otherwise.
  masterKey.fill(0);
  return { fetchToken, prfSalt };
}

async function wrapUmkWithPrf(umkSeed, prfBytes) {
  const aesKey = await crypto.subtle.importKey(
    "raw", prfBytes.slice(0, 32),
    { name: "AES-GCM" }, false, ["encrypt"],
  );
  const nonce = randBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, umkSeed),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToB64(out);
}

async function unwrapUmkWithPrf(wrapped, prfBytes) {
  if (wrapped.length < 12 + 16) throw new Error("wrapped UMK too short");
  const nonce = wrapped.slice(0, 12);
  const ct = wrapped.slice(12);
  const aesKey = await crypto.subtle.importKey(
    "raw", prfBytes.slice(0, 32),
    { name: "AES-GCM" }, false, ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ct);
  return new Uint8Array(pt);
}

function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToB64(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256Hex(b) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return bytesToHex(h);
}
