// Hero-QR — flagshipserver.com landing, v2 relay protocol.
//
// Behaviour:
//   1. Generate a 128-bit random sessionId AND an ephemeral X25519
//      keypair on page load. No network roundtrip — the QR renders
//      immediately from (sid, pk_b).
//   2. Open a WebSocket to /qr-pipe/<sid>?role=browser. The relay DO
//      responds with {kind:"accepted"} (free sid) or {kind:"rebind"}
//      (collision/consumed). On rebind we regenerate the sid+keys,
//      re-render the QR, and reconnect — invisible to the user except
//      for a one-frame QR swap.
//   3. When the phone connects and sends its public key, the relay
//      forwards {kind:"peer-hello", phonePk}. We derive the X25519
//      shared secret locally; HKDF gives us the 256-bit AEAD key and
//      the 6-digit SAS match code. The match code is never on the wire
//      — both peers compute the same value or detect a MitM mismatch.
//   4. The phone, after the user verifies the codes match, sends a
//      {kind:"deliver", ciphertext, nonce} frame which the relay
//      forwards as {kind:"peer-deliver", …}. We AEAD-decrypt; on
//      tag-fail we discard. On success we stash the recipe in
//      sessionStorage and navigate to /build/ to finish the ISO write.
//
// See: memory/project_qr_relay_protocol_v2.md
//
// Element ids consumed (declared in apps/web/public/index.html):
//   heroQr            container — receives data-state attr
//   heroQrCanvas      target for the rendered QR svg
//   heroQrDigits      6-digit match code (pending until peer-hello)

(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const QR_URL_BASE = `${location.origin}/qr`;
  const PIPE_WS_BASE = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/qr-pipe`;
  const RECIPE_HANDOFF_KEY = "flagship:qr:recipe";

  // Pre-emptive renewal a bit before the relay's 5-min TTL kicks in.
  const RENEW_BEFORE_MS = 4 * 60 * 1000;

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }
  ready(init);

  let card, canvas, digits;
  /** @type {WebSocket|null} */ let ws = null;
  let renewTimer = null;
  let session = null; // { sid, sk, pk, kEnc?, matchCode? }

  function init() {
    card = document.getElementById("heroQr");
    canvas = document.getElementById("heroQrCanvas");
    digits = document.getElementById("heroQrDigits");
    if (!card || !canvas || !digits) return;

    renderPlaceholderMosaic(); // never paint empty
    void renew("init");
  }

  // Generate a fresh sid + keypair, re-render the QR, open a WS.
  async function renew(why) {
    try { ws?.close(); } catch (_) {}
    ws = null;
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }

    digits.textContent = "— — — — — —";
    digits.classList.add("is-pending");
    card.dataset.state = "loading";

    let s;
    try {
      s = await freshSession();
    } catch (e) {
      console.warn("hero-qr: keygen failed", e);
      card.dataset.state = "error";
      return;
    }
    session = s;

    // Render the QR from sid + pk_b locally. No network needed.
    await renderQrFor(joinUrl(s.sid, s.pkB64u));

    // Open the relay WS in the background.
    try {
      const url = `${PIPE_WS_BASE}/${encodeURIComponent(s.sid)}?role=browser`;
      ws = new WebSocket(url);
    } catch (e) {
      console.warn("hero-qr: ws open failed", e);
      card.dataset.state = "error";
      return;
    }

    ws.addEventListener("message", onWsMessage);
    ws.addEventListener("close", onWsClose);
    ws.addEventListener("error", () => {
      // Browsers don't surface error details. The close handler will
      // decide whether to renew.
    });

    // Pre-emptive renewal — fires only if no phone has connected yet.
    renewTimer = setTimeout(() => {
      if (!session?.matchCode) void renew("pre-expire");
    }, RENEW_BEFORE_MS);

    console.debug?.("hero-qr: opened", why, s.sid.slice(0, 8));
  }

  function onWsClose() {
    // If the close arrives before we matched a phone, regenerate.
    // After a successful handover the WS is supposed to close.
    if (session && !session.delivered) {
      // Brief defer so the close after a "rebind" message lands first.
      setTimeout(() => {
        if (!session?.matchCode) void renew("close-before-match");
      }, 50);
    }
  }

  async function onWsMessage(ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.kind !== "string") return;

    if (m.kind === "accepted") {
      card.dataset.state = "ready";
      return;
    }
    if (m.kind === "rebind") {
      void renew("rebind");
      return;
    }
    if (m.kind === "expired") {
      void renew("expired");
      return;
    }
    if (m.kind === "error") {
      console.warn("hero-qr: server error", m.reason);
      return;
    }
    if (m.kind === "peer-hello") {
      await onPeerHello(m.phonePk);
      return;
    }
    if (m.kind === "peer-deliver") {
      await onPeerDeliver(m.ciphertext, m.nonce);
      return;
    }
  }

  // Compute the shared secret and the SAS match code locally. The
  // match code is NEVER on the wire — its only existence is on both
  // peers' screens, where the user visually compares them.
  async function onPeerHello(phonePkB64u) {
    if (!session) return;
    try {
      const phonePkBytes = b64urlDecode(phonePkB64u);
      if (phonePkBytes.length !== 32) throw new Error("phonePk must be 32 bytes");
      const peerKey = await crypto.subtle.importKey(
        "raw", phonePkBytes, { name: "X25519" }, false, []
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: "X25519", public: peerKey }, session.sk, 256,
      );
      session.kEnc = await deriveKey(sharedBits, "flagship/qr/enc/v1", 256);
      const matchBits = await deriveBits(sharedBits, "flagship/qr/sas/v1", 32);
      session.matchCode = matchCodeFromBytes(matchBits);
      digits.textContent = formatMatchCode(session.matchCode);
      digits.classList.remove("is-pending");
      card.dataset.state = "matched";
    } catch (e) {
      console.warn("hero-qr: peer-hello failed", e);
      card.dataset.state = "error";
    }
  }

  async function onPeerDeliver(ciphertextB64u, nonceB64u) {
    if (!session?.kEnc) {
      console.warn("hero-qr: peer-deliver before peer-hello");
      return;
    }
    try {
      const ciphertext = b64urlDecode(ciphertextB64u);
      const nonce = b64urlDecode(nonceB64u);
      const aesKey = await crypto.subtle.importKey(
        "raw", session.kEnc, "AES-GCM", false, ["decrypt"]
      );
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce }, aesKey, ciphertext,
      );
      const recipeBytes = new Uint8Array(plain);
      // The recipe is opaque to this surface — we stash it for /build/
      // to read and run the personalize-and-write-ISO step.
      sessionStorage.setItem(RECIPE_HANDOFF_KEY, b64urlEncode(recipeBytes));
      session.delivered = true;
      card.dataset.state = "delivered";
      // Hand off to the build flow.
      setTimeout(() => { location.href = "/build/?via=qr"; }, 200);
    } catch (e) {
      // AEAD tag failure means either a MitM, key mismatch, or a
      // tampered relay. Silently discard; user will retry by reloading.
      console.warn("hero-qr: deliver decrypt failed", e);
      card.dataset.state = "error";
      digits.textContent = "TAMPERED";
      digits.classList.add("is-pending");
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Crypto helpers
  // ────────────────────────────────────────────────────────────────

  async function freshSession() {
    const sidBytes = crypto.getRandomValues(new Uint8Array(16));
    const sid = b64urlEncode(sidBytes);
    const kp = await crypto.subtle.generateKey(
      { name: "X25519" }, true, ["deriveBits"]
    );
    const pkRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    return {
      sid,
      sk: kp.privateKey,
      pkB64u: b64urlEncode(pkRaw),
      kEnc: null,
      matchCode: null,
      delivered: false,
    };
  }

  async function deriveBits(sharedBits, infoStr, lengthBits) {
    const base = await crypto.subtle.importKey(
      "raw", sharedBits, "HKDF", false, ["deriveBits"]
    );
    return new Uint8Array(await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode("flagship/qr/v1"),
        info: new TextEncoder().encode(infoStr),
      },
      base,
      lengthBits,
    ));
  }

  async function deriveKey(sharedBits, infoStr, lengthBits) {
    return deriveBits(sharedBits, infoStr, lengthBits);
  }

  function matchCodeFromBytes(bytes) {
    // First 4 bytes as big-endian uint32 → mod 1_000_000 → 6-digit string.
    const u32 = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
    return (u32 % 1_000_000).toString().padStart(6, "0");
  }

  function formatMatchCode(digits) {
    return digits.slice(0, 3) + " " + digits.slice(3);
  }

  function joinUrl(sid, pkB64u) {
    return `${QR_URL_BASE}?s=${encodeURIComponent(sid)}&k=${encodeURIComponent(pkB64u)}`;
  }

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

  // ────────────────────────────────────────────────────────────────
  // QR rendering
  // ────────────────────────────────────────────────────────────────

  async function renderQrFor(text) {
    try {
      const m = await import("/qrEncoder.js");
      canvas.innerHTML = m.renderQrSvg(text, {
        size: 280,
        foreground: "#0A0A09",
        background: "transparent",
      });
    } catch (e) {
      console.warn("hero-qr: qr encoder failed", e);
      renderPlaceholderMosaic();
    }
  }

  function renderPlaceholderMosaic() {
    const N = 25;
    const cell = 10;
    const pad = 6;
    const size = N * cell + pad * 2;
    let seed = 0x9e3779b9;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; }
    const bits = [];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) bits.push(rnd() > 0.52 ? 1 : 0);
    function inFinder(x, y) {
      const corners = [[0, 0], [N - 7, 0], [0, N - 7]];
      for (const [cx, cy] of corners)
        if (x >= cx && x < cx + 7 && y >= cy && y < cy + 7) return true;
      return false;
    }
    function finderInk(x, y) {
      const corners = [[0, 0], [N - 7, 0], [0, N - 7]];
      for (const [cx, cy] of corners) {
        if (x >= cx && x < cx + 7 && y >= cy && y < cy + 7) {
          const rx = x - cx, ry = y - cy;
          const edge = rx === 0 || rx === 6 || ry === 0 || ry === 6;
          const inner = rx >= 2 && rx <= 4 && ry >= 2 && ry <= 4;
          return edge || inner;
        }
      }
      return false;
    }
    let rects = "";
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let on = false;
        if (inFinder(x, y)) on = finderInk(x, y);
        else on = bits[y * N + x] === 1;
        if (on) {
          rects += `<rect x="${pad + x * cell}" y="${pad + y * cell}" width="${cell}" height="${cell}" rx="1.4" fill="#0A0A09"/>`;
        }
      }
    }
    canvas.innerHTML =
      `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" ` +
      `role="img" aria-label="QR placeholder">` +
      rects +
      `</svg>`;
  }

  // Expose a tiny surface for the webapp/test harness to peek.
  window.flagshipHeroQr = {
    sid: () => session?.sid ?? null,
    pkB64u: () => session?.pkB64u ?? null,
    matchCode: () => session?.matchCode ?? null,
  };
})();
