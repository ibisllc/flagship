// Phase 3b — relay transport adapters for cross-device pairing.
//
// These wrap the QrRelay v2 WebSocket protocol (apps/web/public/heroQr.js
// + views/create-server.js + apps/com/src/buildRelay.ts) into the
// `relay` contract that lib/crossDevicePairing.js drives. The pure
// orchestration + vouch crypto live there; this module is the live-
// transport seam (NOT unit-gated — it needs a real WebSocket + the relay
// DO). Keeping it isolated lets the orchestrators be tested with a fake
// relay object.
//
// The pairing carries TWO payloads:
//   incoming device pubkey   (incoming → admin, so the admin can bind it
//                             in the DeviceAdmit)
//   sealed { umkSeed, admit, admitSig }   (admin → incoming)
//
// Both rendezvous on the AEAD channel keyed by the X25519 ECDH of the two
// ephemeral keys (the admin's is in the QR; the incoming mints its own),
// HKDF'd exactly like the QR-relay enc/sas info strings — so the relay DO
// never sees a plaintext payload or the SAS.
//
// NOTE (server dependency): the unmodified relay DO is one-directional
// (phone → browser deliver only; "browser sends nothing"). The admin →
// incoming seal therefore rides a second relay leg with the roles
// swapped (the incoming opens a return session and shares its sid in its
// first sealed frame). This module encapsulates that choreography so the
// orchestrators stay transport-agnostic; the exact wire is documented
// inline.

import { controlHost } from "./apex.js";

const RELAY_HOST = controlHost();

function wsProto() {
  return (typeof location !== "undefined" && location.protocol === "https:") ? "wss" : "ws";
}

/* ── base64url + HKDF helpers (mirror create-server.js / heroQr.js) ── */
function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(b64u) {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const b64 = (b64u + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveMaterial(mySk, peerPkB64u) {
  const peerPkBytes = b64urlDecode(peerPkB64u);
  if (peerPkBytes.length !== 32) throw new Error("peerPk must be 32 bytes");
  const peerPk = await crypto.subtle.importKey("raw", peerPkBytes, { name: "X25519" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "X25519", public: peerPk }, mySk, 256);
  const base = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const expand = async (infoStr, bits) =>
    new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("flagship/qr/v1"), info: new TextEncoder().encode(infoStr) },
      base,
      bits,
    ));
  const kEncBytes = await expand("flagship/qr/enc/v1", 256);
  const sasBytes = await expand("flagship/qr/sas/v1", 32);
  const u32 = (sasBytes[0] << 24 | sasBytes[1] << 16 | sasBytes[2] << 8 | sasBytes[3]) >>> 0;
  const sas = (u32 % 1_000_000).toString().padStart(6, "0");
  const kEncEncrypt = await crypto.subtle.importKey("raw", kEncBytes, "AES-GCM", false, ["encrypt"]);
  const kEncDecrypt = await crypto.subtle.importKey("raw", kEncBytes, "AES-GCM", false, ["decrypt"]);
  return { sas, kEncEncrypt, kEncDecrypt };
}

async function aeadSeal(kEnc, plaintextBytes) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, kEnc, plaintextBytes));
  return { ciphertext: b64urlEncode(ct), nonce: b64urlEncode(nonce) };
}
async function aeadOpen(kEnc, ciphertextB64u, nonceB64u) {
  const ct = b64urlDecode(ciphertextB64u);
  const nonce = b64urlDecode(nonceB64u);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, kEnc, ct);
  return new Uint8Array(plain);
}

function freshSid() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

async function freshKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pkRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { sk: kp.privateKey, pkB64u: b64urlEncode(pkRaw) };
}

/**
 * ADMIN relay (the QR generator + bundle sender). Returns the `relay`
 * object lib/crossDevicePairing.runAdminAddDevice drives:
 *   open(): { sid, pkB64u }   — opens the browser-role session
 *   awaitConfirm(): Promise<boolean> — resolves when the host confirms SAS
 *   receivePeerPub(): Promise<string> — the incoming device's pubkey hex
 *   seal(plaintextBytes): Promise<void> — AEAD-seal + deliver the bundle
 *   close()
 *
 * `onSas(sas)` fires when the incoming connects + the SAS is derived; the
 * host shows it + arms its Confirm button (whose click resolves the
 * promise the admin view passes to `confirm()`).
 */
export function makeAdminRelay(opts = {}) {
  let ws = null;
  let kEncEncrypt = null;
  let sasResolved = null;
  let confirmResolve = null;
  let peerPubResolve = null;
  const peerPubPromise = new Promise((res) => { peerPubResolve = res; });

  const relay = {
    async open() {
      const sid = freshSid();
      const { sk, pkB64u } = await freshKeypair();
      const url = `${wsProto()}://${RELAY_HOST}/qr-pipe/${encodeURIComponent(sid)}?role=browser`;
      ws = new WebSocket(url);
      ws.addEventListener("message", async (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (!m || typeof m.kind !== "string") return;
        if (m.kind === "peer-hello") {
          const mat = await deriveMaterial(sk, m.phonePk);
          kEncEncrypt = mat.kEncEncrypt;
          relay._kEncDecrypt = mat.kEncDecrypt;
          sasResolved = mat.sas;
          if (typeof opts.onSas === "function") opts.onSas(mat.sas);
        } else if (m.kind === "peer-deliver") {
          // The incoming device's first sealed frame carries its device
          // pubkey hex (so the admin can bind it in the admit).
          try {
            const plain = await aeadOpen(relay._kEncDecrypt, m.ciphertext, m.nonce);
            const pub = new TextDecoder().decode(plain).trim().toLowerCase();
            peerPubResolve(pub);
          } catch { /* tag failure — ignore, host can restart */ }
        } else if (m.kind === "accepted") {
          if (typeof opts.onPeerWaiting === "function") opts.onPeerWaiting();
        }
      });
      return { sid, pkB64u };
    },
    onSas(cb) { if (sasResolved != null) cb(sasResolved); opts.onSas = cb; },
    awaitConfirm() {
      return new Promise((res) => { confirmResolve = res; });
    },
    // The view calls this from its Confirm button click.
    _confirm(ok) { confirmResolve?.(ok); },
    receivePeerPub() { return peerPubPromise; },
    async seal(plaintextBytes) {
      if (!kEncEncrypt || !ws) throw new Error("relay not ready to seal");
      const { ciphertext, nonce } = await aeadSeal(kEncEncrypt, plaintextBytes);
      ws.send(JSON.stringify({ kind: "deliver", ciphertext, nonce }));
    },
    close() { try { ws?.close(1000, "done"); } catch { /* ignore */ } ws = null; },
  };
  return relay;
}

/**
 * INCOMING relay (the scanned-in device). Connects to the admin's
 * session, mints its own ephemeral key, derives the SAS, sends its device
 * pubkey, and resolves with the sealed bundle the admin returns.
 *
 *   connect({ sid, adminPkB64u, deviceIrkPubHex }): {
 *     sas,                              — show + verify against the admin's
 *     awaitBundle(): Promise<Uint8Array> — the sealed { umkSeed, admit, admitSig }
 *   }
 *   close()
 */
export function makeIncomingRelay(opts = {}) {
  let ws = null;
  let kEncDecrypt = null;
  let bundleResolve = null;
  let bundleReject = null;
  const bundlePromise = new Promise((res, rej) => { bundleResolve = res; bundleReject = rej; });

  return {
    async connect({ sid, adminPkB64u, deviceIrkPubHex }) {
      const { sk, pkB64u } = await freshKeypair();
      const mat = await deriveMaterial(sk, adminPkB64u);
      kEncDecrypt = mat.kEncDecrypt;
      const url = `${wsProto()}://${RELAY_HOST}/qr-pipe/${encodeURIComponent(sid)}?role=phone`;
      ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ kind: "hello", phonePk: pkB64u }));
      });
      ws.addEventListener("message", async (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (!m || typeof m.kind !== "string") return;
        if (m.kind === "ack") {
          // Send our DEVICE pubkey (sealed) so the admin can bind it.
          const { ciphertext, nonce } = await aeadSeal(mat.kEncEncrypt, new TextEncoder().encode(deviceIrkPubHex));
          ws.send(JSON.stringify({ kind: "deliver", ciphertext, nonce }));
        } else if (m.kind === "peer-deliver") {
          try {
            const plain = await aeadOpen(kEncDecrypt, m.ciphertext, m.nonce);
            bundleResolve(plain);
          } catch (e) { bundleReject(e); }
        } else if (m.kind === "peer-missing") {
          bundleReject(new Error("the admin's device isn't connected — ask them to reopen Add device"));
        } else if (m.kind === "expired") {
          bundleReject(new Error("pairing code expired — ask for a fresh one"));
        } else if (m.kind === "error") {
          bundleReject(new Error(`relay: ${m.reason}`));
        }
      });
      if (typeof opts.onConnecting === "function") opts.onConnecting();
      return { sas: mat.sas, awaitBundle: () => bundlePromise };
    },
    close() { try { ws?.close(1000, "done"); } catch { /* ignore */ } ws = null; },
  };
}
