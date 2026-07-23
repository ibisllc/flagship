// Phase 3b — relay transport adapters for cross-device pairing.
//
// These wrap the QrRelay v2 WebSocket protocol (apps/com/src/buildRelay.ts)
// into the
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
// (phone → browser deliver only; "browser sends nothing") AND single-shot
// (it marks the session consumed + tears down BOTH sockets the instant the
// phone delivers its first frame — see apps/com/src/buildRelay.ts
// onPhoneMessage). So the admin (role=browser) CANNOT send the sealed
// bundle on leg-1: the DO rejects a browser-role inbound frame ("browser
// sends nothing"), and even a phone-role frame would arrive on a leg the
// incoming's pubkey-deliver already consumed.
//
// The admin → incoming seal therefore rides a SECOND relay leg with the
// roles SWAPPED, exactly as this header always promised but the code never
// implemented (proven live against the deployed DO in
// tools/live-e2e/device-add-relay-probe.ts):
//
//   leg-1  sid_A (from the QR):  admin = browser, incoming = phone.
//          The incoming's ONE allowed `deliver` carries, sealed under the
//          SAS-verified leg-1 key, BOTH its device pubkey AND the
//          coordinates of the return leg it has just opened:
//          { devicePubHex, returnSid, returnPkB64u }.
//   leg-2  sid_B (minted by the incoming): incoming = browser (LISTENER,
//          opened before it sends the leg-1 frame so it is ready), admin =
//          phone (SENDER). The admin opens sid_B as phone, hellos, and
//          delivers the sealed { umkSeed, admit, admitSig } — sealed under
//          the SAME SAS-verified leg-1 key, so leg-2's own ECDH is not a
//          trust input and the bundle's confidentiality + authenticity are
//          still anchored to the code the human compared.
//
// This module encapsulates that choreography so the orchestrators
// (lib/crossDevicePairing.js) stay transport-agnostic — the `relay`
// contract they drive is unchanged.

import { controlHost } from "./apex.js";

const RELAY_HOST = controlHost();

function wsProto() {
  return (typeof location !== "undefined" && location.protocol === "https:") ? "wss" : "ws";
}

/* ── base64url + HKDF helpers shared with the native pairing clients ── */
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
  let ws = null;            // leg-1 (browser)
  let leg2Ws = null;        // leg-2 (phone — bundle sender)
  let kEncEncrypt = null;   // SAS-verified leg-1 key (used for BOTH legs)
  let kEncDecrypt = null;
  let sasResolved = null;
  let confirmResolve = null;
  let peerPubResolve = null;
  // The return-leg coordinates the incoming shares inside its leg-1 frame.
  let returnSid = null;
  let returnPkB64u = null;
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
          kEncDecrypt = mat.kEncDecrypt;
          sasResolved = mat.sas;
          if (typeof opts.onSas === "function") opts.onSas(mat.sas);
        } else if (m.kind === "peer-deliver") {
          // The incoming device's ONE allowed leg-1 frame carries, sealed
          // under the SAS-verified key, its device pubkey hex AND the
          // return-leg coordinates ({ devicePubHex, returnSid, returnPkB64u }).
          try {
            const plain = await aeadOpen(kEncDecrypt, m.ciphertext, m.nonce);
            const text = new TextDecoder().decode(plain).trim();
            const obj = JSON.parse(text);
            const pub = String(obj.devicePubHex || "").trim().toLowerCase();
            const deviceId = String(obj.deviceId || "").trim().toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(pub) || !/^[0-9a-f]{32}$/.test(deviceId)) return;
            returnSid = obj.returnSid || null;
            returnPkB64u = obj.returnPkB64u || null;
            peerPubResolve({ devicePubHex: pub, deviceId });
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
    // Seal the bundle on LEG-2 (roles swapped): the admin connects the
    // incoming's return sid as the PHONE (sender) and delivers the bundle.
    // The bundle is AEAD-sealed under the SAS-verified leg-1 key, so the
    // human-compared code still anchors its confidentiality + authenticity.
    async seal(plaintextBytes) {
      if (!kEncEncrypt) throw new Error("relay not ready to seal (no SAS-verified key)");
      if (!returnSid || !returnPkB64u) {
        throw new Error("the other device didn't open a return channel — ask it to reopen the pairing link");
      }
      const { ciphertext, nonce } = await aeadSeal(kEncEncrypt, plaintextBytes);
      const url = `${wsProto()}://${RELAY_HOST}/qr-pipe/${encodeURIComponent(returnSid)}?role=phone`;
      leg2Ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        const timer = setTimeout(() => done(reject, new Error("timed out delivering keys to the other device")), 20_000);
        leg2Ws.addEventListener("open", async () => {
          // The DO gates `deliver` behind a phone `hello`; leg-2's own ECDH
          // is unused (the bundle uses the leg-1 key), but the hello must be
          // a syntactically valid phonePk, so mint a throwaway one.
          try {
            const eph = await freshKeypair();
            leg2Ws.send(JSON.stringify({ kind: "hello", phonePk: eph.pkB64u }));
          } catch (e) { clearTimeout(timer); done(reject, e); }
        });
        leg2Ws.addEventListener("message", (ev) => {
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          if (!m || typeof m.kind !== "string") return;
          if (m.kind === "ack") {
            leg2Ws.send(JSON.stringify({ kind: "deliver", ciphertext, nonce }));
          } else if (m.kind === "delivered") {
            clearTimeout(timer); done(resolve);
          } else if (m.kind === "peer-missing") {
            clearTimeout(timer); done(reject, new Error("the other device's return channel isn't connected"));
          } else if (m.kind === "error") {
            clearTimeout(timer); done(reject, new Error(`relay: ${m.reason}`));
          } else if (m.kind === "expired") {
            clearTimeout(timer); done(reject, new Error("pairing code expired — ask for a fresh one"));
          }
        });
        leg2Ws.addEventListener("error", () => { clearTimeout(timer); done(reject, new Error("return channel error")); });
      });
    },
    close() {
      try { ws?.close(1000, "done"); } catch { /* ignore */ } ws = null;
      try { leg2Ws?.close(1000, "done"); } catch { /* ignore */ } leg2Ws = null;
    },
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
  let ws = null;            // leg-1 (phone)
  let returnWs = null;      // leg-2 (browser — bundle receiver)
  let kEncDecrypt = null;   // SAS-verified leg-1 key (used for BOTH legs)
  let bundleResolve = null;
  let bundleReject = null;
  const bundlePromise = new Promise((res, rej) => { bundleResolve = res; bundleReject = rej; });

  return {
    async connect({ sid, adminPkB64u, deviceIrkPubHex, deviceId }) {
      const { sk, pkB64u } = await freshKeypair();
      const mat = await deriveMaterial(sk, adminPkB64u);
      kEncDecrypt = mat.kEncDecrypt;

      // Pre-open the RETURN leg (sid_B) as the BROWSER so it is listening
      // before we tell the admin about it — the admin will connect it as
      // phone the moment it reads sid_B from our leg-1 frame. The bundle
      // arrives here as `peer-deliver`, decrypted under the leg-1 key.
      const returnSid = freshSid();
      const returnEph = await freshKeypair();
      returnWs = new WebSocket(`${wsProto()}://${RELAY_HOST}/qr-pipe/${encodeURIComponent(returnSid)}?role=browser`);
      returnWs.addEventListener("message", async (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (!m || typeof m.kind !== "string") return;
        if (m.kind === "peer-deliver") {
          try {
            const plain = await aeadOpen(kEncDecrypt, m.ciphertext, m.nonce);
            bundleResolve(plain);
          } catch (e) { bundleReject(e); }
        } else if (m.kind === "expired") {
          bundleReject(new Error("pairing code expired — ask for a fresh one"));
        } else if (m.kind === "rebind") {
          bundleReject(new Error("return channel collision — reopen the pairing link"));
        }
        // peer-hello on the return leg is the admin's throwaway hello; ignore.
      });
      await new Promise((resolve) => {
        if (returnWs.readyState === WebSocket.OPEN) return resolve();
        returnWs.addEventListener("open", () => resolve(), { once: true });
        returnWs.addEventListener("error", () => resolve(), { once: true });
      });

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
          // Our ONE allowed leg-1 frame: our DEVICE pubkey + the return-leg
          // coordinates, sealed under the SAS-verified key. (leg-1 is then
          // consumed by the DO; the bundle comes back on the return leg.)
          const payload = new TextEncoder().encode(JSON.stringify({
            devicePubHex: String(deviceIrkPubHex).toLowerCase(),
            deviceId: String(deviceId).toLowerCase(),
            returnSid,
            returnPkB64u: returnEph.pkB64u,
          }));
          const { ciphertext, nonce } = await aeadSeal(mat.kEncEncrypt, payload);
          ws.send(JSON.stringify({ kind: "deliver", ciphertext, nonce }));
        } else if (m.kind === "peer-missing") {
          bundleReject(new Error("the admin's device isn't connected — ask them to reopen Add device"));
        } else if (m.kind === "expired") {
          bundleReject(new Error("pairing code expired — ask for a fresh one"));
        } else if (m.kind === "error") {
          bundleReject(new Error(`relay: ${m.reason}`));
        }
        // peer-deliver no longer arrives on leg-1 (the bundle is leg-2).
      });
      if (typeof opts.onConnecting === "function") opts.onConnecting();
      return { sas: mat.sas, awaitBundle: () => bundlePromise };
    },
    close() {
      try { ws?.close(1000, "done"); } catch { /* ignore */ } ws = null;
      try { returnWs?.close(1000, "done"); } catch { /* ignore */ } returnWs = null;
    },
  };
}
