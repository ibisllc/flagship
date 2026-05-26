// Cloud-shard recovery using a WebAuthn passkey's PRF output.
//
// As of Tasks #73 + #74 the passkey itself lives on a dedicated
// sub-origin: https://recovery.flagshipserver.com/. The webapp opens
// that page in a popup, sends the UMK seed (for enrolment) or just
// triggers the recover flow, and receives the result back via
// postMessage. The webapp keeps the IRK + identity logic — the
// sub-origin only owns the WebAuthn passkey and the AES-GCM wrap.
//
// Flow (enrol):
//   setupCloudRecovery(username)
//     → window.open(recovery.flagshipserver.com/#enroll)
//     → postMessage HELLO + {umk, username}
//     → sub-origin: navigator.credentials.create() + PRF wrap
//     → sub-origin postMessages back {credentialIdHex, wrappedUmkB64}
//     → webapp signs the upload envelope with IRK and POSTs /api/recovery
//
// Flow (recover):
//   recoverFromCloud(username)
//     → window.open(recovery.flagshipserver.com/#recover)
//     → postMessage HELLO
//     → sub-origin: user types username + passphrase, fetches from .com,
//       does WebAuthn get() + PRF unwrap
//     → sub-origin postMessages back the UMK seed bytes
//     → webapp persists via passphrase wrap as today.
//
// Why this isolation: prior to the split, an XSS on any apex page
// (marketing or webapp) could call navigator.credentials.get() against
// rpId=flagshipserver.com and exfiltrate the wrapped UMK. Putting the
// passkey behind a dedicated rpId — which the browser enforces is
// reachable only from same-origin code — means an apex XSS literally
// cannot invoke the passkey.

import { bytesToHex, hexToBytes, signWithIrk } from "../keystore.js";
import { getSession } from "./state.js";

const APEX = "https://flagshipserver.com";
const RECOVERY_ORIGIN = "https://recovery.flagshipserver.com";

/** Time-budget for the popup round-trip; covers WebAuthn UV ceremony. */
const POPUP_TIMEOUT_MS = 180_000;

/**
 * Register a new passkey, wrap the user's UMK seed with its PRF
 * output, and upload to .com. Returns { credentialId, updated }.
 */
export async function setupCloudRecovery(username) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  if (!username) throw new Error("username required");

  // Drive the sub-origin popup. It will receive the UMK seed +
  // username, prompt the user for a passphrase (Task #74), and
  // postMessage back the wrap result.
  const result = await runSubOriginFlow("enroll", { umk: session.umk, username });
  if (result.type !== "flagship-recovery-enroll-result") {
    throw new Error(`enroll: ${result.reason ?? "no result"}`);
  }
  const { credentialIdHex, wrappedUmkB64, fetchTokenHashHex, prfSaltHashHex } = result;
  if (typeof credentialIdHex !== "string" || typeof wrappedUmkB64 !== "string") {
    throw new Error("enroll: bad payload from sub-origin");
  }
  // Task #74 — the sub-origin computed Argon2id over the user's
  // passphrase and split the result into a fetchToken (gates the
  // wrappedUmk fetch on .com) and a prfSalt (binds WebAuthn's PRF
  // input to the passphrase). The hashes ride the IRK-signed upload
  // envelope; .com persists them next to the ciphertext.
  if (typeof fetchTokenHashHex !== "string" || typeof prfSaltHashHex !== "string") {
    throw new Error("enroll: sub-origin omitted the passphrase hashes");
  }
  return await uploadRecord({
    session, username, credentialIdHex, wrappedUmkB64,
    fetchTokenHashHex, prfSaltHashHex,
  });
}

/**
 * Recover the UMK seed from a previously-uploaded record. Returns the
 * 32-byte UMK seed; caller is responsible for re-wrapping it under a
 * passphrase (or storing as-is) per the local-storage flow.
 */
export async function recoverFromCloud(username) {
  if (!username) throw new Error("username required");
  const result = await runSubOriginFlow("recover", { hintUsername: username });
  if (result.type !== "flagship-recovery-recover-result") {
    throw new Error(`recover: ${result.reason ?? "no result"}`);
  }
  if (!Array.isArray(result.umk) || result.umk.length !== 32) {
    throw new Error("recover: malformed UMK payload");
  }
  return new Uint8Array(result.umk);
}

/**
 * Delete the cloud recovery record. Requires the user to be unlocked
 * (we sign with IRK + pin to the current stored bytes via SHA-256).
 *
 * Delete still goes through the webapp directly (no sub-origin needed)
 * because we never have to touch the passkey to revoke — only sign
 * with the IRK over the current stored ciphertext's hash.
 */
export async function deleteCloudRecovery(username) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  // After Task #74 the metadata GET returns wrappedUmkHash directly —
  // no ciphertext, no Argon2 round-trip required. The IRK signature is
  // the only auth needed to delete.
  const r = await fetch(`${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`);
  if (r.status === 404) return { deleted: false };
  if (!r.ok) throw new Error(`fetch recovery failed: ${r.status}`);
  const body = await r.json();
  const wrappedHash = body.wrappedUmkHash;
  if (typeof wrappedHash !== "string") {
    throw new Error("metadata missing wrappedUmkHash");
  }
  const issuedAt = Date.now();
  const canonical = canonicalUpload({
    username,
    credentialIdHex: body.credentialId,
    wrappedUmkHashHex: wrappedHash,
    issuedAt,
  });
  const sig = await signWithIrk(session.umk, canonical);
  const del = await fetch(
    `${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          username,
          credentialId: body.credentialId,
          wrappedUmkHash: wrappedHash,
          issuedAt,
        },
        signature: bytesToHex(sig),
      }),
    },
  );
  if (!del.ok) {
    const txt = await del.text().catch(() => "");
    throw new Error(`delete failed: ${del.status} ${txt}`.trim());
  }
  return { deleted: true };
}

/**
 * Register a fresh recovery passkey + wrap a caller-supplied UMK seed
 * with its PRF output, WITHOUT uploading the envelope to .com. Returns
 * `{ credentialIdHex, wrappedUmkB64, wrappedUmkBytes }`.
 *
 * Used by ceremonies that need to bundle the registration result into a
 * larger atomically-posted envelope (wipe-restart, where the new
 * envelope is swapped in by the Worker handler at the same instant the
 * IRK rotates — uploading separately first would create a window where
 * a passkey is registered against a username whose IRK hasn't yet
 * accepted it).
 *
 * The 32-byte `umk` IS the new account key — anyone holding it AND the
 * passkey can take over the account. Callers must scope its lifetime
 * to the ceremony.
 */
export async function enrollNewRecoveryPasskey(umk, username) {
  if (!(umk instanceof Uint8Array) || umk.length !== 32) {
    throw new Error("umk must be a 32-byte Uint8Array");
  }
  if (!username) throw new Error("username required");
  const result = await runSubOriginFlow("enroll", { umk, username });
  if (result.type !== "flagship-recovery-enroll-result") {
    throw new Error(`enroll: ${result.reason ?? "no result"}`);
  }
  const { credentialIdHex, wrappedUmkB64 } = result;
  if (typeof credentialIdHex !== "string" || typeof wrappedUmkB64 !== "string") {
    throw new Error("enroll: bad payload from sub-origin");
  }
  const wrappedUmkBytes = base64ToBytes(wrappedUmkB64);
  return { credentialIdHex, wrappedUmkB64, wrappedUmkBytes };
}

/** Best-effort presence check used by views to decide UI state. */
export async function hasCloudRecovery(username) {
  if (!username) return false;
  try {
    const r = await fetch(`${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`);
    return r.ok;
  } catch {
    return false;
  }
}

// ---- internals ----

/**
 * Drive a sub-origin popup ceremony.
 *
 * Opens the dedicated recovery origin, waits for its READY ping, sends
 * the enrolment payload if any, then resolves on the first matching
 * RESULT message (or rejects on ERROR / timeout / window-closed). The
 * popup is closed afterwards either way.
 */
async function runSubOriginFlow(mode, payload) {
  const url = `${RECOVERY_ORIGIN}/#${mode}`;
  const popup = window.open(url, "flagship-recovery", "noopener=no,popup=yes,width=520,height=720");
  if (!popup) {
    throw new Error("recovery popup was blocked — allow pop-ups on this site");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer = 0;

    const cleanup = () => {
      settled = true;
      window.removeEventListener("message", onMsg);
      if (pollTimer) clearInterval(pollTimer);
      try { popup.close(); } catch { /* ignore */ }
    };
    const fail = (e) => { if (!settled) { cleanup(); reject(e); } };
    const ok = (msg) => { if (!settled) { cleanup(); resolve(msg); } };

    const onMsg = (ev) => {
      if (ev.origin !== RECOVERY_ORIGIN) return;
      const m = ev.data;
      if (!m || typeof m !== "object") return;
      if (m.type === "flagship-recovery-ready") {
        if (mode === "enroll" && payload?.umk) {
          popup.postMessage({
            type: "flagship-recovery-enroll-payload",
            umk: Array.from(payload.umk),
            username: payload.username,
          }, RECOVERY_ORIGIN);
        }
        return;
      }
      if (m.type === "flagship-recovery-error") return fail(new Error(m.reason || "sub-origin error"));
      if (m.type === "flagship-recovery-enroll-result" && mode === "enroll") return ok(m);
      if (m.type === "flagship-recovery-recover-result" && mode === "recover") return ok(m);
    };
    window.addEventListener("message", onMsg);

    // The sub-origin's load handler also self-announces. Send a HELLO
    // from our side too so the message arrives even if the popup was
    // ready before this listener was attached.
    const tryHello = () => {
      if (popup.closed) return fail(new Error("recovery popup closed"));
      try {
        popup.postMessage({ type: "flagship-recovery-hello", mode }, RECOVERY_ORIGIN);
      } catch {
        // The popup may still be loading; ignore.
      }
    };
    tryHello();
    pollTimer = setInterval(tryHello, 500);

    setTimeout(() => fail(new Error("recovery timed out")), POPUP_TIMEOUT_MS);
  });
}

async function uploadRecord({
  session, username, credentialIdHex, wrappedUmkB64,
  fetchTokenHashHex, prfSaltHashHex,
}) {
  const wrappedBytes = base64ToBytes(wrappedUmkB64);
  const wrappedUmkHashHex = await sha256Hex(wrappedBytes);
  const issuedAt = Date.now();
  // canonical-bytes still cover only the original signed fields; the
  // new hashes ride the upload-envelope body, are validated server-side
  // for shape, and are stored alongside the row. We don't extend the
  // signed payload because the upload-record canonical shape is part
  // of @flagship/protocol; bumping its version would force a protocol
  // migration across every device. The IRK signature still guarantees
  // .com isn't fed attacker-substituted ciphertext under a victim's
  // passkey; the extra hashes are *additional* gates the IRK signer
  // controls (since they come from a passphrase only the user knows).
  const canonical = canonicalUpload({
    username,
    credentialIdHex,
    wrappedUmkHashHex,
    issuedAt,
  });
  const sig = await signWithIrk(session.umk, canonical);
  const r = await fetch(`${APEX}/api/recovery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: {
        username,
        credentialId: credentialIdHex,
        wrappedUmk: wrappedUmkB64,
        issuedAt,
        ...(fetchTokenHashHex ? { fetchTokenHash: fetchTokenHashHex } : {}),
        ...(prfSaltHashHex ? { prfSaltHash: prfSaltHashHex } : {}),
      },
      signature: bytesToHex(sig),
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`upload recovery failed: ${r.status} ${txt}`.trim());
  }
  return r.json();
}

// Pinned to packages/protocol/src/auth.ts canonicalUploadRecoveryRecord.
function canonicalUpload({ username, credentialIdHex, wrappedUmkHashHex, issuedAt }) {
  return new TextEncoder().encode(
    [
      "flagship/upload-recovery-record/v1",
      username,
      credentialIdHex,
      wrappedUmkHashHex,
      issuedAt,
    ].join("|"),
  );
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
