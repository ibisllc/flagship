// Flagship WebAuthn-PRF recovery — dedicated sub-origin (Task #73).
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
//     2. Collect a recovery passphrase from the user (Task #74 in the
//        next commit; this commit only verifies the postMessage round
//        trip + does an unsalted PRF-wrap that matches the current
//        on-the-wire payload).
//     3. Create a passkey + PRF-derived AES-GCM key.
//     4. Wrap the UMK seed → ciphertext.
//     5. postMessage the {credentialIdHex, wrappedUmkB64} back to the
//        parent so it can sign + upload via /api/recovery on the apex.
//
//   recover mode (#recover):
//     1. Collect username + passphrase.
//     2. Fetch the wrapped UMK from .com via /api/recovery/by-username/<u>.
//        (Task #74 will swap this for an Argon2id-gated POST.)
//     3. WebAuthn get() with PRF → unwrap → UMK seed.
//     4. postMessage the seed back to the parent.

const APEX = "https://flagshipserver.com";
const RP_ID = "recovery.flagshipserver.com";
const RP_NAME = "Flagship recovery";

// Stable salt for the PRF-derived wrap key. Per WebAuthn spec the PRF
// input is hashed before evaluation, so this can be arbitrary bytes.
// Commit 2 (Task #74) replaces this constant with a per-user Argon2-
// derived salt so a stolen passkey alone cannot regenerate the wrap
// key without the recovery passphrase.
const DEFAULT_PRF_SALT = new TextEncoder().encode("flagship.recovery.v1");

// The webapp (web.flagshipserver.com) is the only postMessage peer we
// trust. Browsers enforce this via `event.origin`; we also re-pin every
// outbound postMessage's targetOrigin so a compromised/redirected
// parent can't widen the audience.
const PARENT_ORIGIN = "https://web.flagshipserver.com";

const state = {
  mode: null, // "enroll" | "recover" | null
  enrollUmk: null, // Uint8Array, only present in enroll mode
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
    const prfSalt = await derivePrfSalt(pp1, username);

    const { credentialIdHex, prfBytes } = await createPasskey(username, prfSalt);
    const wrappedB64 = await wrapUmkWithPrf(state.enrollUmk, prfBytes);

    postToParent({
      type: "flagship-recovery-enroll-result",
      credentialIdHex,
      wrappedUmkB64: wrappedB64,
      // Task #74 will also include the fetchToken-hash + prfSaltHash
      // hex so the parent can put them in the signed envelope.
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

    const prfSalt = await derivePrfSalt(pp, username);
    const fetched = await fetchWrappedUmk(username);
    if (!fetched) throw new Error("no cloud recovery for that username");
    const { credentialIdHex, wrappedUmkB64 } = fetched;

    const credentialId = hexToBytes(credentialIdHex);
    const wrapped = base64ToBytes(wrappedUmkB64);
    const prfBytes = await getPrfWithGet(credentialId, prfSalt);
    if (!prfBytes) throw new Error("WebAuthn PRF not supported by this authenticator");

    const umk = await unwrapUmkWithPrf(wrapped, prfBytes);
    postToParent({
      type: "flagship-recovery-recover-result",
      username,
      umk: Array.from(umk), // serialize for structured-clone safety
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

async function fetchWrappedUmk(username) {
  // Task #74 swaps this for a POST that includes a passphrase-derived
  // fetchToken; .com only releases the ciphertext when the token hash
  // matches the stored hash. The current GET form remains for one
  // commit so the sub-origin scaffold can land independently of the
  // schema migration.
  const r = await fetch(
    `${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`,
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
  const b = await r.json();
  return { credentialIdHex: b.credentialId, wrappedUmkB64: b.wrappedUmk };
}

// ──────────────────────────────────────────────────────────────────────
// Crypto + serialization
// ──────────────────────────────────────────────────────────────────────

async function derivePrfSalt(_passphrase, _username) {
  // Commit 1 of Tasks #73 + #74: still using the fixed PRF salt that
  // the prior webapp-origin flow used. The rpId change from
  // flagshipserver.com → recovery.flagshipserver.com already invalidates
  // pre-existing passkeys, so this commit doesn't make the situation
  // any worse and keeps the diff to just the sub-origin scaffolding.
  //
  // Commit 2 replaces this with an Argon2id-derived per-user salt so
  // an attacker holding only the credentialId + wrappedUmk still has
  // no way to regenerate the wrap key without the user's passphrase.
  return DEFAULT_PRF_SALT;
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
