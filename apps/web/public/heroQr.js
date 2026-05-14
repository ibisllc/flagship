// Hero-QR — flagshipserver.com landing, v2 relay protocol.
//
// Behaviour:
//   1. Generate a 128-bit random sessionId AND an ephemeral X25519
//      keypair on page load. No network roundtrip — the QR renders
//      immediately from (sid, pk_b). The QR is fully scannable from
//      this moment, even though no WebSocket is open yet.
//   2. The relay WebSocket is opened LAZILY — only once the QR card
//      has been intersected for ENGAGE_DELAY_MS continuously, OR the
//      user explicitly clicks the card. This is what keeps a marketing
//      drive-by from spawning a Durable Object for every visitor.
//      Background tabs and visitors that scroll past pay zero DO duration.
//   3. Once engaged: open /qr-pipe/<sid>?role=browser. The relay DO
//      responds with {kind:"accepted"} (free sid) or {kind:"rebind"}
//      (collision/consumed). On rebind we regenerate the sid+keys,
//      re-render the QR, and reconnect — invisible to the user except
//      for a one-frame QR swap.
//   4. When the phone connects and sends its public key, the relay
//      forwards {kind:"peer-hello", phonePk}. We derive the X25519
//      shared secret locally; HKDF gives us the 256-bit AEAD key and
//      the 6-digit SAS match code. The match code is never on the wire
//      — both peers compute the same value or detect a MitM mismatch.
//   5. The phone, after the user verifies the codes match, sends a
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
  // Reconnect backoff (same-sid retries; QR unchanged).
  const RECONNECT_INITIAL_MS = 500;
  const RECONNECT_MAX_MS = 30_000;
  // After this much wall-clock time of fruitless reconnects, give up
  // and surface an error — user can reload the page to retry.
  const RECONNECT_GIVE_UP_MS = 5 * 60 * 1000;
  // How long the QR card has to be in-viewport (intersected) before we
  // upgrade from "rendered locally, no DO spawned" to "WS open." This
  // is the gate that protects against drive-by visits, link-preview
  // bots, and crawlers from spawning a 5-minute Durable Object per
  // page load. Set to a value short enough that a real user reaching
  // for their phone never notices, long enough that fast-scroll past
  // the hero costs nothing.
  const ENGAGE_DELAY_MS = 1200;
  // Minimum intersection ratio that counts toward ENGAGE_DELAY_MS.
  const ENGAGE_THRESHOLD = 0.5;

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  let card, canvas, digits, copyBtn, urlBox;
  /** @type {WebSocket|null} */ let ws = null;
  let renewTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = 0;          // current backoff step (ms)
  let reconnectStartedAt = 0;      // wall-clock of first failed attempt
  let intentionalClose = false;    // suppress reconnect for self-close
  let session = null; // { sid, sk, pk, kEnc?, matchCode? }
  let currentUrl = null;
  let copyResetTimer = null;
  let engaged = false;             // becomes true after IO + dwell or click
  let engageTimer = null;          // pending dwell timer (waiting for it to fire)
  /** @type {IntersectionObserver|null} */ let io = null;

  ready(init);

  function init() {
    card = document.getElementById("heroQr");
    canvas = document.getElementById("heroQrCanvas");
    digits = document.getElementById("heroQrDigits");
    copyBtn = document.getElementById("heroQrCopyBtn");
    urlBox = document.getElementById("heroQrUrlBox");
    if (!card || !canvas || !digits) return;

    copyBtn?.addEventListener("click", onCopyClick);
    // Treat any user gesture on the card as explicit intent — open the
    // WS without waiting for the dwell timer. Pointerdown covers mouse,
    // touch, pen; keyboard activation via Enter/Space fires "click" too.
    card.addEventListener("pointerdown", onUserIntent, { once: false });
    card.addEventListener("click", onUserIntent, { once: false });
    // Backgrounded tabs don't get to keep a DO alive. If the user
    // switches away before engaging, we never opened a WS; if they
    // switch away mid-session, close it. We don't auto-reopen — they
    // can click the card to re-engage.
    document.addEventListener("visibilitychange", onVisibilityChange);

    renderPlaceholderMosaic(); // never paint empty
    // Stage 1: prepare the session + render a fully-scannable QR. No
    // network. No DO spawn. The page is now functionally complete for
    // visitors who never engage.
    void prepareSession("init");
    // Stage 2: arm the engagement detector. The WS opens lazily when
    // the user demonstrates intent (viewport dwell or click).
    armEngagement();
  }

  async function onCopyClick() {
    if (!currentUrl) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(currentUrl);
        ok = true;
      }
    } catch (_) { /* fall through to manual select */ }
    if (urlBox) {
      urlBox.value = currentUrl;
      urlBox.classList.add("is-visible");
      if (!ok) {
        urlBox.focus();
        urlBox.select();
      }
    }
    if (ok && copyBtn) {
      copyBtn.classList.add("is-copied");
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => copyBtn.classList.remove("is-copied"), 1400);
    }
  }

  // Generate sid + keypair and render the QR. Does NOT open the WS —
  // that's deferred until engagement. Safe to call on rebind/expired
  // to swap to a fresh session: it will tear down any existing WS and,
  // if still engaged, reopen with the new sid.
  async function prepareSession(why) {
    cancelReconnect();
    closeWs("renew");
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }

    digits.textContent = "— — — — — —";
    digits.classList.add("is-pending");
    card.dataset.state = engaged ? "loading" : "idle";

    let s;
    try {
      s = await freshSession();
    } catch (e) {
      console.warn("hero-qr: keygen failed", e);
      card.dataset.state = "error";
      return;
    }
    session = s;

    // Render the QR from sid + pk_b locally. No network needed. The
    // phone can already scan this — when the user actually engages,
    // the browser-side WS will open at the same sid and find the
    // (possibly already-waiting) phone via name-addressed DO.
    const url = joinUrl(s.sid, s.pkB64u);
    currentUrl = url;
    if (urlBox) urlBox.value = url;
    await renderQrFor(url);

    // If we were already engaged when prepareSession ran (e.g. rebind
    // after the user clicked), immediately open the WS for the fresh
    // sid. Otherwise wait — armEngagement is the trigger.
    if (engaged) openSocketAndArmRenewal(why);

    console.debug?.("hero-qr: prepared", why, s.sid.slice(0, 8));
  }

  function openSocketAndArmRenewal(why) {
    openSocket();
    if (renewTimer) clearTimeout(renewTimer);
    // Pre-emptive renewal — fires only if no phone has connected yet
    // AND the user is still engaged. A backgrounded / scrolled-away
    // visitor doesn't get a fresh DO every 4 minutes.
    renewTimer = setTimeout(() => {
      if (!engaged) return;
      if (!session?.matchCode) void prepareSession("pre-expire");
    }, RENEW_BEFORE_MS);
    console.debug?.("hero-qr: ws-opened", why);
  }

  // The engagement detector. Watches for either:
  //   1. The QR card being ≥ENGAGE_THRESHOLD visible for ≥ENGAGE_DELAY_MS
  //      continuously (a user reaching for their phone naturally has
  //      the card in focus the whole time);
  //   2. A user gesture on the card (pointerdown/click).
  // Either signal flips `engaged = true` exactly once and opens the WS.
  function armEngagement() {
    if (engaged) return;
    if (typeof IntersectionObserver === "undefined") {
      // No IO support (very old browsers / test harnesses): fall back
      // to opening on first user gesture only. Don't auto-open — that
      // would defeat the whole point of the gate.
      card.dataset.state = "idle";
      return;
    }
    let dwellTimer = null;
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= ENGAGE_THRESHOLD) {
          if (dwellTimer || engaged) continue;
          dwellTimer = setTimeout(() => {
            dwellTimer = null;
            engageTimer = null;
            engage("viewport-dwell");
          }, ENGAGE_DELAY_MS);
          engageTimer = dwellTimer;
        } else {
          // Scrolled away before dwell completed — cancel; don't engage.
          if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; engageTimer = null; }
        }
      }
    }, { threshold: [0, ENGAGE_THRESHOLD, 1] });
    io.observe(card);
  }

  function onUserIntent() {
    if (engaged) return;
    engage("user-intent");
  }

  function engage(why) {
    if (engaged) return;
    engaged = true;
    if (engageTimer) { clearTimeout(engageTimer); engageTimer = null; }
    if (io) { try { io.disconnect(); } catch (_) {} io = null; }
    if (!session) {
      // The session is still being prepared; prepareSession will see
      // engaged === true and call openSocketAndArmRenewal itself.
      card.dataset.state = "loading";
      return;
    }
    openSocketAndArmRenewal(why);
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      // Backgrounded — release the DO. Keep the rendered QR; the phone
      // may still arrive, but it'll briefly see peer-missing and retry.
      // We don't auto-reopen when the tab comes back: requiring a click
      // keeps the gate honest if the user toggles between tabs all day.
      if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
      cancelReconnect();
      closeWs("tab-hidden");
      engaged = false;
      armEngagement();
    }
  }

  // Open a WebSocket to the relay using the CURRENT session.sid. Does
  // not touch session or the rendered QR. Safe to call on reconnect.
  function openSocket() {
    if (!session) return;
    if (ws && (ws.readyState === 0 /* CONNECTING */ || ws.readyState === 1 /* OPEN */)) return;
    intentionalClose = false;
    let next;
    try {
      const url = `${PIPE_WS_BASE}/${encodeURIComponent(session.sid)}?role=browser`;
      next = new WebSocket(url);
    } catch (e) {
      console.warn("hero-qr: ws open failed", e);
      scheduleReconnect();
      return;
    }
    ws = next;
    ws.addEventListener("message", (ev) => { if (ws === next) void onWsMessage(ev); });
    ws.addEventListener("close", () => { if (ws === next) onWsClose(); });
    ws.addEventListener("error", () => { /* close handler decides */ });
  }

  function closeWs(reason) {
    intentionalClose = true;
    try { ws?.close(1000, reason || "client-close"); } catch (_) {}
    ws = null;
  }

  function cancelReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectDelay = 0;
    reconnectStartedAt = 0;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const now = Date.now();
    if (reconnectStartedAt === 0) reconnectStartedAt = now;
    if (now - reconnectStartedAt > RECONNECT_GIVE_UP_MS) {
      card.dataset.state = "error";
      console.warn("hero-qr: reconnect budget exhausted");
      return;
    }
    reconnectDelay = reconnectDelay === 0
      ? RECONNECT_INITIAL_MS
      : Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    const jitter = reconnectDelay * (0.7 + Math.random() * 0.3);
    card.dataset.state = session?.matchCode ? "matched-offline" : "reconnecting";
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, jitter);
  }

  function onWsClose() {
    // Self-initiated close (renew, page tear-down) — let it ride.
    if (intentionalClose) { intentionalClose = false; return; }
    // Post-delivery the relay tears the socket down; nothing to do.
    if (session?.delivered) return;
    // Connection dropped while we were waiting/handshaking. Reconnect
    // with the SAME sid; do NOT regenerate the QR until the server
    // affirmatively tells us to via rebind/expired. The same sid +
    // browser pubkey survive a server reboot because the relay DO
    // is name-addressed (idFromName(sid)) and starts empty if reborn.
    scheduleReconnect();
  }

  async function onWsMessage(ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.kind !== "string") return;

    if (m.kind === "accepted") {
      cancelReconnect();
      card.dataset.state = "ready";
      return;
    }
    if (m.kind === "rebind") {
      void prepareSession("rebind");
      return;
    }
    if (m.kind === "expired") {
      void prepareSession("expired");
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
    engaged: () => engaged,
    wsState: () => ws ? ws.readyState : null,
    // Manual engage for tests / future "refresh QR" buttons. Idempotent.
    engage: (why) => engage(why ?? "manual"),
  };
})();
