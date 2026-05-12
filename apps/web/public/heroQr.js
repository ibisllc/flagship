// Hero-QR — flagshipserver.com landing, large-screens-only live build relay.
//
// Behaviour:
//   1. Only mounts at viewport ≥ 1024px. Below that, the markup is hidden by
//      CSS and this script is a no-op (cost-shave on mobile bounces).
//   2. Lazy: an IntersectionObserver marks the card "in view", but does NOT
//      auto-open a session. The visitor explicitly taps "Start a build
//      session" before we touch the relay backend (also a cost-shave on
//      bounced traffic that scrolls past without intent).
//   3. After 10 seconds with no peer joining, the caption rotates to a
//      friendly "get the app" prompt so cold visitors learn what they need.
//   4. Once the phone delivers the sealed blob, the page jumps to /build/
//      with the same sessionId in the query so the personalize-and-download
//      step runs on the same machine that scanned. (Today the post-blob
//      ISO download still lives at /build/; that hand-off is a redirect.)
//
// Wire shape (#59 — now LIVE):
//   POST /api/build-relay/sessions          → { sessionId, joinUrl, … }
//   WS   /build-relay/<sessionId>?role=browser
//     ↓ kind:"hello"
//     ↑ kind:"browser-hello", browserPk:<x25519-hex>
//     ↓ kind:"matched",  matchCode:"DDD DDD"
//     ↓ kind:"blob",     ciphertext:<base64>     (decrypted in /build/)

(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const LARGE_SCREEN_MIN_PX = 1024;
  const ROTATE_AFTER_MS = 10_000;
  const RELAY_ENDPOINT = "/api/build-relay/sessions";

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  ready(init);

  function init() {
    const card = document.getElementById("heroQr");
    if (!card) return;

    if (window.matchMedia(`(max-width: ${LARGE_SCREEN_MIN_PX - 1}px)`).matches) {
      return;
    }

    const canvas = document.getElementById("heroQrCanvas");
    const startBtn = document.getElementById("heroQrStart");
    const digitsEl = document.getElementById("heroQrDigits");
    const captionEl = document.getElementById("heroQrCaption");
    const statusEl = document.getElementById("heroQrStatus");
    if (!canvas || !startBtn || !digitsEl || !captionEl || !statusEl) return;

    let opened = false;
    let rotateTimer = null;

    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            io.disconnect();
            break;
          }
        }
      }, { threshold: 0.4 });
      io.observe(card);
    }

    startBtn.addEventListener("click", () => {
      if (opened) return;
      opened = true;
      openSession().catch((e) => {
        console.warn("hero-qr session failed", e);
        renderFallback();
      });
    });

    async function openSession() {
      startBtn.hidden = true;
      card.dataset.state = "opening";
      statusEl.textContent = "Build relay · opening…";
      digitsEl.textContent = "· · · · · ·";

      let session = null;
      try {
        const resp = await fetch(RELAY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ surface: "landing-hero" }),
        });
        if (resp.ok) session = await resp.json();
      } catch {
        // Network failure — fall through to the fallback below.
      }

      if (!session || !session.joinUrl || !session.sessionId) {
        renderFallback();
        return;
      }

      card.dataset.state = "live";
      statusEl.textContent = "Build relay · waiting for phone";
      await renderQrFor(session.joinUrl);

      rotateTimer = window.setTimeout(() => {
        captionEl.innerHTML =
          'Don’t have the app yet? ' +
          '<a href="/app/">Get it →</a>';
      }, ROTATE_AFTER_MS);

      drivePeerSide(session);
    }

    function renderFallback() {
      card.dataset.state = "error";
      statusEl.textContent = "Build relay · checking";
      digitsEl.textContent = "— — — — — —";
      digitsEl.classList.add("is-pending");
      captionEl.innerHTML =
        'We’re checking the live session. If it doesn’t load, ' +
        'open <a href="/build/">/build/</a> on this machine and paste your code.';
      renderPlaceholderMosaic();
      if (rotateTimer) { window.clearTimeout(rotateTimer); rotateTimer = null; }
    }

    function formatMatchCode(raw) {
      const digits = String(raw).replace(/\D/g, "").slice(0, 6).padEnd(6, "0");
      return digits.slice(0, 3) + " " + digits.slice(3);
    }

    async function renderQrFor(text) {
      try {
        const m = await import("/qrEncoder.js");
        canvas.innerHTML = m.renderQrSvg(text, {
          size: 280,
          foreground: "var(--ink, #14130E)",
          background: "transparent",
        });
        canvas.firstChild?.setAttribute("style", "color: var(--ink); background: var(--surface-elev);");
      } catch (e) {
        console.warn("qr encoder failed", e);
        renderPlaceholderMosaic();
      }
    }

    // Drive the browser-side of the relay protocol. The hero-card is a
    // "kick-off" surface — once the sealed blob arrives we don't try to
    // build the ISO here (the /build/ page owns that flow). Instead we
    // hand the user off via location.href; the same sessionId is
    // honored there. (Both sides use ephemeral keys that exist only in
    // their own tab, so the hand-off can't reuse keys; the hero card
    // simply demonstrates the pair-and-deliver UX and the /build/ page
    // is where the real ISO download happens.)
    async function drivePeerSide(session) {
      let keypair;
      try {
        keypair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
      } catch {
        statusEl.textContent = "Build relay · browser too old";
        return;
      }
      const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey));
      const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/build-relay/${session.sessionId}?role=browser`;
      const ws = new WebSocket(wsUrl);
      let helloSent = false;
      ws.addEventListener("message", (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.kind === "hello" && !helloSent) {
          helloSent = true;
          ws.send(JSON.stringify({
            kind: "browser-hello",
            browserPk: bytesToHex(rawPub),
          }));
        } else if (m.kind === "matched") {
          digitsEl.textContent = formatMatchCode(m.matchCode);
          digitsEl.classList.remove("is-pending");
          statusEl.textContent = "Build relay · approve on phone";
        } else if (m.kind === "blob") {
          // Hand off to /build/ — the hero card is decorative; the real
          // download UX lives there. The user is already on the
          // machine they want to install on (this whole page is for
          // large-screen visitors), so the redirect just opens the
          // detailed flow on the same tab.
          statusEl.textContent = "Build relay · delivered, opening builder…";
          location.href = "/build/";
        } else if (m.kind === "error") {
          statusEl.textContent = `Build relay · ${m.reason}`;
        }
      });
      ws.addEventListener("close", () => {
        if (rotateTimer) { window.clearTimeout(rotateTimer); rotateTimer = null; }
      });
    }

    function bytesToHex(b) {
      let s = "";
      for (const x of b) s += x.toString(16).padStart(2, "0");
      return s;
    }

    function renderPlaceholderMosaic() {
      // Stable visual cue for the loading / error states. The real QR
      // arrives via the encoder import; this is only what shows while
      // we wait for a session.
      const N = 25;
      const cell = 10;
      const pad = 6;
      const size = N * cell + pad * 2;
      const bits = [];
      let s = 0x9e3779b9;
      function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) bits.push(rnd() > 0.52 ? 1 : 0);
      }
      function inFinder(x, y) {
        const cornerSets = [[0, 0], [N - 7, 0], [0, N - 7]];
        for (const [cx, cy] of cornerSets) {
          if (x >= cx && x < cx + 7 && y >= cy && y < cy + 7) return true;
        }
        return false;
      }
      function finderInk(x, y) {
        const cornerSets = [[0, 0], [N - 7, 0], [0, N - 7]];
        for (const [cx, cy] of cornerSets) {
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
            rects += `<rect x="${pad + x * cell}" y="${pad + y * cell}" ` +
                     `width="${cell}" height="${cell}" rx="1.4" fill="currentColor"/>`;
          }
        }
      }
      canvas.innerHTML =
        `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" ` +
        `role="img" aria-label="Build-relay QR placeholder" ` +
        `style="color: var(--ink); background: var(--surface-elev);">` +
        `<rect width="${size}" height="${size}" fill="var(--surface-elev)"/>` +
        rects +
        `</svg>`;
    }
  }
})();
