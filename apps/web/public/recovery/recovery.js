// Flagship WebAuthn-PRF recovery — dedicated sub-origin (Tasks #73 + #74).
//
// This module runs ONLY at https://recovery.flagshipserver.com/. The
// passkey created/used here is scoped to rpId =
// "recovery.flagshipserver.com" via the browser's WebAuthn same-origin
// enforcement — so an XSS on flagshipserver.com or
// webapp.flagshipserver.com cannot silently exercise it. This is the C3/B1
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
//        prfSaltHashHex, passkeyAttestationObject} back to the parent so the parent signs + uploads
//        via /api/recovery on the apex. (Task #74)
//
//   recover mode (#recover):
//     1. Collect username + passphrase.
//     2. Re-derive Argon2id → fetchToken + prfSalt.
//     3. POST /api/recovery/by-username/<u>/challenge (SEC-REPAIR-001).
//     4. ONE WebAuthn get(): PRF (input = prfSalt) and a signature over that challenge.
//     5. POST /api/recovery/by-username/<u>/fetch with fetchToken + the passkey's answer. .com
//        checks both; returns wrappedUmk + prfSaltHash + a short-lived recoveryProof on match.
//     6. Unwrap → UMK seed; a record from before the passkey check offers the update once.
//     7. postMessage the seed + the recoveryProof back to the parent.
//
//   The recoveryProof is .com's attestation that THIS caller passed the
//   passphrase gate. The parent needs it because a re-pair initiate (an
//   account-key rotation) is otherwise authorized by nothing a stranger
//   couldn't supply. The fetchToken itself stays on this origin — the
//   proof is an opaque, username-bound, 15-minute bearer, which is
//   strictly less sensitive than the seed we already hand over.
//
// Argon2id parameters (see derivePassphraseKey below). Tuned for ~1.5s
// on a Pixel 6 in pure JS / Web Worker context. The recovery flow is
// rare (once per device-pair / once per fresh-browser-recovery), so
// 1.5-2s of latency is acceptable; the security gain is significant
// (offline attack on a leaked wrappedUmk requires ~m*t per guess at
// the attacker's tier).
import { argon2id } from "./vendor/noble-hashes/argon2.js";
import {
  wrapWithPrf,
  unwrapWithPrf,
  HKDF_UMK_SALT,
  HKDF_ADMIN_ROOT_SALT,
} from "./recoveryWrap.js";
import { ciphertextMismatch } from "./recoveryRecordCheck.js";
import { attestationField, challengeBytes, fetchPasskeyField } from "./recoveryPasskey.js";
import { tr, trn } from "./recoveryI18n.js";

// The page serves only at recovery.<apex> (prod recovery.flagshipserver.com, the gym
// recovery.gym.flagshipserver.com), so its own host names the apex, the rpId and the webapp.
const PROD_APEX_HOST = "flagshipserver.com";
const OWN_HOST = typeof location !== "undefined" && location.hostname.startsWith("recovery.") ? location.hostname : `recovery.${PROD_APEX_HOST}`;
const APEX_HOST = OWN_HOST.slice("recovery.".length);
const APEX = `https://${APEX_HOST}`;
const RP_ID = OWN_HOST;
const RP_NAME = "Flagship recovery"; // i18n: keep (saved with the passkey: one name in every language)

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

// The owner webapp (webapp.flagshipserver.com) is the only postMessage
// peer we trust. Browsers enforce this via `event.origin`; we also re-pin
// every outbound postMessage's targetOrigin so a compromised/redirected
// parent can't widen the audience.
//
// Deliberately NOT widened to remote.flagshipserver.com: a remote session
// is keyless by construction and has no business enrolling or unwrapping
// a recovery credential (the whole recovery surface is disabled there —
// see companionGuard's UNAVAILABLE_IDS). One origin in, one origin out.
const PARENT_ORIGIN = `https://webapp.${APEX_HOST}`;

const state = {
  mode: null, // "enroll" | "recover" | null
  enrollUmk: null, // Uint8Array, only present in enroll mode
  enrollAdminRootSeed: null, // Slice D (D-3): admin root, escrowed with the UMK
  enrollUsername: null,
  parentOrigin: null, // pinned to event.origin of the first valid HELLO
  askUpdate: true, // the webapp says false when the owner already declined the recovery update here
};

// SEC-REPAIR-001: the sentences the apps share (iOS is the reference), in the webapp's language
// (recoveryI18n.js has loaded the catalog before this module runs).
const PASSKEY_ERRORS = {
  "passkey-required": tr("This recovery needs your passkey. Try again and choose your Flagship passkey."),
  "passkey-challenge": tr("The passkey check expired. Try again."),
  "passkey-invalid": tr("That passkey isn't the one your account recovery uses."),
  "passkey-unavailable": tr("Passkey recovery isn't available right now. Try again later."),
};
const MIN_PASSPHRASE = tr("Use at least 8 characters.");

function coded(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

const DECLINED_PREFIX = "flagship.recovery.updateDeclined.";
function updateDeclined(username) {
  try {
    return localStorage.getItem(DECLINED_PREFIX + username.toLowerCase()) === "1";
  } catch {
    return false;
  }
}
function markUpdateDeclined(username) {
  try {
    localStorage.setItem(DECLINED_PREFIX + username.toLowerCase(), "1");
  } catch {
    /* private window: the webapp keeps its own flag */
  }
}

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
  // `#recover&lang=es`: the mode, then what the webapp hands over (recoveryI18n.js reads `lang=`).
  const h = (location.hash || "").replace(/^#/, "").split("&")[0].trim().toLowerCase();
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
    if (m.askUpdate === false) state.askUpdate = false;
    postToParent({ type: "flagship-recovery-ready", mode: state.mode });
    return;
  }
  if (m.type === "flagship-recovery-enroll-payload" && state.mode === "enroll") {
    if (!(m.umk instanceof Uint8Array) && !Array.isArray(m.umk)) {
      postToParent({ type: "flagship-recovery-error", reason: "umk missing or wrong shape" }); // i18n: keep
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
    if (el) el.textContent = tr("Will enrol passkey for: {0}", state.enrollUsername);
  }
});

// Tell the parent we're alive. The parent set state.parentOrigin via
// the incoming HELLO, but if the window.opener path is used the parent
// may also be listening for our ready signal on a fresh pipe.
// The catalog load (a top-level await in recoveryI18n.js) can finish after the load event.
function start() {
  selectMode();
  postToParent({ type: "flagship-recovery-ready", mode: state.mode });
}
if (document.readyState === "complete") start();
else window.addEventListener("load", start);

// ──────────────────────────────────────────────────────────────────────
// Enroll
// ──────────────────────────────────────────────────────────────────────

$("enroll-go")?.addEventListener("click", async () => {
  const btn = $("enroll-go");
  if (btn) btn.disabled = true;
  setStatus("enroll-status", tr("Working…"), null);
  try {
    if (!state.enrollUmk || !state.enrollUsername) {
      throw new Error(tr("Waiting for the webapp to send your account key. Open recovery from inside the webapp."));
    }
    await assertWebauthn();
    const pp1 = $("enroll-passphrase")?.value || "";
    const pp2 = $("enroll-passphrase-2")?.value || "";
    if (pp1.length < 8) throw new Error(MIN_PASSPHRASE);
    if (pp1 !== pp2) throw new Error(tr("Passphrases don't match."));

    const username = state.enrollUsername;
    setStatus("enroll-status", tr("Hardening your passphrase (Argon2id, ~1.5s)…"), null);
    const { fetchToken, prfSalt } = await derivePassphraseSecrets(pp1, username);

    setStatus("enroll-status", tr("Creating passkey on this device…"), null);
    const { credentialIdHex, prfBytes, passkeyAttestationObject } = await createPasskey(username, prfSalt);
    // Cross-platform escrow (mobile-identical): each secret is its OWN
    // self-contained blob, wrapped under an HKDF-SHA256(prf, <domain salt>)
    // AES-256-GCM key — NEVER the raw PRF bytes, and NEVER a `umk||adminRoot`
    // concatenation. The UMK rides `wrappedUmk`; the admin master root (Slice D
    // D-3, when present) rides a SEPARATE `wrappedAdminRoot` blob under its own
    // salt, so an iOS/Android device can unwrap each with Recovery.unwrap /
    // AdminRootEscrow.unwrapFromEscrow verbatim.
    const wrappedB64 = await wrapWithPrf(state.enrollUmk, prfBytes, HKDF_UMK_SALT);
    const wrappedAdminRootB64 = state.enrollAdminRootSeed
      ? await wrapWithPrf(state.enrollAdminRootSeed, prfBytes, HKDF_ADMIN_ROOT_SALT)
      : null;

    const fetchTokenHashHex = await sha256Hex(fetchToken);
    const prfSaltHashHex = await sha256Hex(prfSalt);

    postToParent({
      type: "flagship-recovery-enroll-result",
      credentialIdHex,
      wrappedUmkB64: wrappedB64,
      ...(wrappedAdminRootB64 ? { wrappedAdminRootB64 } : {}),
      fetchTokenHashHex,
      prfSaltHashHex,
      passkeyAttestationObject,
    });
    setStatus("enroll-status", tr("Done — return to the webapp to finish."), "ok");
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
  setStatus("recover-status", tr("Working…"), null);
  try {
    await assertWebauthn();
    const username = ($("recover-username")?.value || "").trim().toLowerCase();
    const pp = $("recover-passphrase")?.value || "";
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) throw new Error(tr("That isn't a valid username."));
    if (pp.length < 8) throw new Error(MIN_PASSPHRASE);

    // SEC-REPAIR-001 order: the passphrase first (it feeds the PRF), then ONE passkey sheet that both
    // unwraps (PRF) and signs .com's challenge, then the fetch carrying that signature.
    setStatus("recover-status", tr("Hardening your passphrase (Argon2id, ~1.5s)…"), null);
    const { fetchToken, prfSalt } = await derivePassphraseSecrets(pp, username);

    setStatus("recover-status", tr("Asking {0} for your recovery…", APEX_HOST), null);
    const meta = await recoveryMeta(username);
    if (!meta) throw new Error(tr("There is no cloud recovery for that username."));
    const challenge = await recoveryChallenge(username, meta.passkeyRequired === true);

    setStatus("recover-status", tr("Confirm with your passkey…"), null);
    const cred = await passkeySheet(hexToBytes(meta.credentialId), prfSalt, challenge ? challengeBytes(challenge) : randBytes(32));
    const prfBytes = readPrfFirst(cred);
    if (!prfBytes) throw new Error(tr("WebAuthn PRF is not supported by this authenticator."));

    const fetched = await fetchWrappedUmk(username, fetchToken, challenge ? fetchPasskeyField(challenge, cred) : null, meta.credentialId);
    const { credentialIdHex, wrappedUmkB64, wrappedAdminRootB64, prfSaltHash, recoveryProof, signed } =
      fetched;
    if (credentialIdHex.toLowerCase() !== String(meta.credentialId).toLowerCase()) {
      throw new Error(tr("The recovery record changed while you were signing in. Try again."));
    }

    // N03: a signed record names the digest of every ciphertext it covers. Refuse before any
    // unwrap if `.com` returned a different one (a swapped, dropped or added escrow). A legacy
    // record has no such signature; it is passed on labelled, never as verified.
    if (signed) {
      const bad = await ciphertextMismatch(signed.claim, {
        wrappedUmkB64, wrappedAdminRootB64, wrappedAcmeAccountKeyB64: fetched.wrappedAcmeAccountKeyB64,
      });
      if (bad) throw new Error(tr("The stored recovery record does not match its signed digest ({0}). Refusing to unwrap it.", bad));
    }

    // A tampered .com could feed a different salt to coerce the wrong PRF output; say so plainly
    // instead of a bare AES-GCM tag failure.
    if (prfSaltHash) {
      const localPrfSaltHash = await sha256Hex(prfSalt);
      if (localPrfSaltHash !== prfSaltHash.toLowerCase()) {
        throw new Error(tr("The server returned a stale prfSaltHash. Refusing to proceed."));
      }
    }

    // Cross-platform unwrap: the UMK is its OWN blob (HKDF under the UMK salt);
    // the admin master root (Slice D D-3) is a SEPARATE `wrappedAdminRoot` blob
    // under its own salt. Both are mobile-produced-or-webapp-produced
    // interchangeably. A legacy/UMK-only escrow simply has no admin-root blob.
    const umk = await unwrapWithPrf(wrappedUmkB64, prfBytes, HKDF_UMK_SALT);
    const adminRootSeed = wrappedAdminRootB64
      ? await unwrapWithPrf(wrappedAdminRootB64, prfBytes, HKDF_ADMIN_ROOT_SALT)
      : null;

    // A record from before the passkey check: offer the update once, here, while the passphrase is
    // still in memory, so the owner is not asked for it again.
    let update = null;
    let updateDeclinedNow = false;
    if (fetched.passkeyLegacy && state.askUpdate && !updateDeclined(username)) {
      if ((await askRecoveryUpdate()) === "update") {
        update = await reenrolForUpdate(username, prfSalt, fetchToken, umk, adminRootSeed);
      } else {
        markUpdateDeclined(username);
        updateDeclinedNow = true;
      }
    }

    postToParent({
      type: "flagship-recovery-recover-result",
      username,
      umk: Array.from(umk), // serialize for structured-clone safety
      ...(adminRootSeed ? { adminRootSeed: Array.from(adminRootSeed) } : {}),
      ...(recoveryProof ? { recoveryProof } : {}),
      ...(signed ? { signedRecord: { claim: signed.claim, signatureHex: signed.signatureHex } } : { recordLegacy: true }),
      ...(fetched.passkeyLegacy ? { passkeyLegacy: true } : {}),
      ...(update ? { update } : {}),
      ...(updateDeclinedNow ? { updateDeclined: true } : {}),
    });
    setStatus("recover-status", tr("Done — return to the webapp to finish."), "ok");
  } catch (e) {
    const msg = e?.code && PASSKEY_ERRORS[e.code] ? PASSKEY_ERRORS[e.code] : String(e?.message ?? e);
    setStatus("recover-status", msg, "err");
    postToParent({ type: "flagship-recovery-error", reason: msg, ...(e?.code ? { code: e.code } : {}) });
  } finally {
    if (btn) btn.disabled = false;
    hide("view-recover-update");
  }
});

/** "Update your account recovery" with Update / Not now; resolves to the choice. */
function askRecoveryUpdate() {
  show("view-recover-update");
  return new Promise((resolve) => {
    const done = (v) => {
      $("recover-update-go")?.removeEventListener("click", onUpdate);
      $("recover-update-later")?.removeEventListener("click", onLater);
      resolve(v);
    };
    const onUpdate = () => done("update");
    const onLater = () => done("later");
    $("recover-update-go")?.addEventListener("click", onUpdate);
    $("recover-update-later")?.addEventListener("click", onLater);
  });
}

/** A new recovery passkey (one sheet) over the same passphrase, its attestation for .com, and the re-wrapped escrows. */
async function reenrolForUpdate(username, prfSalt, fetchToken, umk, adminRootSeed) {
  setStatus("recover-status", tr("Creating your new recovery passkey…"), null);
  const made = await createPasskey(username, prfSalt);
  return {
    credentialIdHex: made.credentialIdHex,
    wrappedUmkB64: await wrapWithPrf(umk, made.prfBytes, HKDF_UMK_SALT),
    ...(adminRootSeed ? { wrappedAdminRootB64: await wrapWithPrf(adminRootSeed, made.prfBytes, HKDF_ADMIN_ROOT_SALT) } : {}),
    fetchTokenHashHex: await sha256Hex(fetchToken),
    prfSaltHashHex: await sha256Hex(prfSalt),
    passkeyAttestationObject: made.passkeyAttestationObject,
  };
}

// ──────────────────────────────────────────────────────────────────────
// WebAuthn helpers
// ──────────────────────────────────────────────────────────────────────

async function assertWebauthn() {
  if (!("credentials" in navigator) || !window.PublicKeyCredential) {
    throw new Error(tr("WebAuthn is not supported in this browser."));
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
  if (!cred) throw new Error(tr("Passkey creation was cancelled."));
  const credentialId = new Uint8Array(cred.rawId);
  let prfBytes = readPrfFirst(cred);
  if (!prfBytes) prfBytes = await getPrfWithGet(credentialId, prfSalt);
  if (!prfBytes) throw new Error(tr("WebAuthn PRF is not supported by this authenticator."));
  return { credentialIdHex: bytesToHex(credentialId), prfBytes, passkeyAttestationObject: attestationField(cred.response.attestationObject) };
}

async function getPrfWithGet(credentialId, prfSalt) {
  return readPrfFirst(await passkeySheet(credentialId, prfSalt, randBytes(32)));
}

/** The one get() of a recovery: the PRF for the unwrap and, with `.com`'s challenge, its signature. */
async function passkeySheet(credentialId, prfSalt, challenge) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: RP_ID,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      timeout: 90_000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  if (!cred) throw new Error(tr("Passkey sign-in was cancelled."));
  return cred;
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

/** The public metadata: credentialId, whether the passkey check applies. Null when there is no record. */
async function recoveryMeta(username) {
  const meta = await fetch(`${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`);
  if (meta.status === 404) return null;
  if (meta.status === 429) throw new Error(await tooManyTries(meta));
  if (!meta.ok) throw new Error(tr("Couldn't read your recovery record (error {0}). Try again later.", meta.status));
  const body = await meta.json();
  if (!body.hasFetchTokenGate) {
    throw new Error(tr("This recovery record predates the passphrase check. Set up cloud recovery again first."));
  }
  if (typeof body.credentialId !== "string" || !/^[0-9a-fA-F]+$/.test(body.credentialId)) throw new Error(tr("The recovery record names no passkey."));
  return body;
}

/**
 * `.com`'s challenge for this account, or null for a record from before the passkey check when
 * `.com` cannot issue one (the fetch then needs only the passphrase, as before).
 */
async function recoveryChallenge(username, required) {
  let r;
  try {
    r = await fetch(`${APEX}/api/recovery/by-username/${encodeURIComponent(username)}/challenge`, { method: "POST" });
  } catch (e) {
    if (!required) return null;
    throw e;
  }
  if (r.status === 429) throw new Error(await tooManyTries(r));
  if (r.ok) {
    const b = await r.json().catch(() => ({}));
    if (typeof b.challenge === "string" && b.challenge) return b.challenge;
  }
  if (!required) return null;
  throw coded(PASSKEY_ERRORS["passkey-unavailable"], "passkey-unavailable");
}

async function fetchWrappedUmk(username, fetchToken, passkey, credentialIdHex) {
  // Task #74 — the gate: .com releases the ciphertext only when SHA-256(fetchToken) matches the
  // stored hash and, for a record that holds the passkey's key, the passkey signed the challenge.
  // The rate-limiter caps attempts at 3-per-15min per usernameHash.
  const gated = await fetch(
    `${APEX}/api/recovery/by-username/${encodeURIComponent(username)}/fetch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fetchToken: bytesToHex(fetchToken),
        issuedAt: Date.now(),
        ...(passkey ? { passkey } : {}),
      }),
    },
  );
  if (gated.status === 403 || gated.status === 503) {
    const body = await gated.json().catch(() => ({}));
    if (body && PASSKEY_ERRORS[body.code]) throw coded(PASSKEY_ERRORS[body.code], body.code);
    if (gated.status === 403) throw new Error(tr("Wrong passphrase"));
  }
  if (gated.status === 429) {
    throw new Error(await tooManyTries(gated));
  }
  if (!gated.ok) {
    throw new Error(tr("Couldn't fetch your recovery copy (error {0}). Try again later.", gated.status));
  }
  const b = await gated.json();
  return {
    credentialIdHex: b.credentialId ?? credentialIdHex,
    wrappedUmkB64: b.wrappedUmk,
    // Opaque attestation that the passphrase gate was just cleared.
    // Absent on a deployment without FLAGSHIP_RECOVERY_PROOF_SECRET, in
    // which case the follow-on re-pair fails closed (by design).
    recoveryProof:
      b.recoveryProof && typeof b.recoveryProof.token === "string"
        ? b.recoveryProof
        : null,
    // Slice D (D-3): the admin master root rides as a SEPARATE escrow blob
    // (`.com` releases it alongside the UMK on the gated fetch when present).
    wrappedAdminRootB64: typeof b.wrappedAdminRoot === "string" ? b.wrappedAdminRoot : null,
    wrappedAcmeAccountKeyB64: typeof b.wrappedAcmeAccountKey === "string" ? b.wrappedAcmeAccountKey : null,
    signed: b.signed && typeof b.signed === "object" && b.signed.claim && typeof b.signed.signatureHex === "string" ? b.signed : null,
    prfSaltHash: b.prfSaltHash,
    passkeyLegacy: b.passkeyLegacy === true,
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

// The limiter's sentence, worded here from its `limit` + `retryAfterSec` like webapp/lib/rateLimited.js (same
// keys, so the same translation); `.com`'s own English sentence only when those are missing.
const TOO_MANY = {
  ip: (wait) => tr("Too many tries from your network. Try again {0}.", wait),
  irk: (wait) => tr("Too many tries from this account. Try again {0}.", wait),
  usernameHash: (wait) => tr("Too many tries for this account name. Try again {0}.", wait),
};

/** "in a minute" / "in about 12 minutes" / "in about 2 hours". */
function retryAfterPhrase(sec) {
  if (sec < 60) return tr("in a minute");
  const min = Math.ceil(sec / 60);
  if (min < 60) return trn(min, "in about {0} minute", "in about {0} minutes");
  const h = Math.max(1, Math.round(min / 60));
  return trn(h, "in about {0} hour", "in about {0} hours");
}

async function tooManyTries(resp) {
  try {
    const body = await resp.json();
    if (body?.error === "rate-limited") {
      const sec = Number(body.retryAfterSec);
      if (Object.hasOwn(TOO_MANY, body.limit) && body.retryAfterSec != null && Number.isFinite(sec) && sec >= 0) return TOO_MANY[body.limit](retryAfterPhrase(sec));
      if (typeof body.message === "string") return body.message;
    }
  } catch {}
  return TOO_MANY.usernameHash(retryAfterPhrase(15 * 60));
}

function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
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
async function sha256Hex(b) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return bytesToHex(h);
}
