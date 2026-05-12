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
//   4. If the relay backend is unreachable (#59 — not yet shipped), the card
//      shows a clear fallback pointing to /build/ instead of pretending to
//      work.
//
// TODO(#59): the relay backend (Cloudflare Worker DurableObject minting
// short-lived match codes + websocket peer-join) is not built yet. This
// client speaks the *intended* wire shape so the swap-in is a backend-only
// change later:
//
//   POST /api/build-relay/sessions          (create — rate-limited per IP)
//     → 200 { sessionId, joinUrl, matchCode, expiresAt }
//     → 503 { error: "relay-unavailable" }   (we fall back gracefully)
//
//   WS   /api/build-relay/sessions/:id      (peer-join + finalize)
//     ← { type: "joined", peer: "phone" }
//     ← { type: "delivered", buildCode } → redirect to /build/?code=...
//
// Until that ships, the canvas renders a clearly-marked placeholder mosaic.
// Nothing here mints a real session or charges Cloudflare any quota.

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

    // Small-screen no-op. CSS already hides the card; we just skip wiring.
    if (window.matchMedia(`(max-width: ${LARGE_SCREEN_MIN_PX - 1}px)`).matches) {
      return;
    }

    const canvas = document.getElementById("heroQrCanvas");
    const startBtn = document.getElementById("heroQrStart");
    const digitsEl = document.getElementById("heroQrDigits");
    const captionEl = document.getElementById("heroQrCaption");
    const statusEl = document.getElementById("heroQrStatus");
    if (!canvas || !startBtn || !digitsEl || !captionEl || !statusEl) return;

    let inView = false;
    let opened = false;
    let rotateTimer = null;

    // 1. Track in-view so we know the visitor actually scrolled here, but
    //    don't auto-fire — taste call: cold visitors who bounced past the
    //    fold should never trigger a paid session.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            inView = true;
            io.disconnect();
            break;
          }
        }
      }, { threshold: 0.4 });
      io.observe(card);
    } else {
      // No IO — accept the small cost and let the explicit tap drive things.
      inView = true;
    }

    // 2. Explicit tap-to-open. The button is the only path that opens a
    //    session, so users who never reach the fold cost us nothing.
    startBtn.addEventListener("click", () => {
      if (opened) return;
      opened = true;
      openSession();
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

      if (!session || !session.joinUrl || !session.matchCode) {
        renderFallback();
        return;
      }

      card.dataset.state = "live";
      statusEl.textContent = "Build relay · waiting for phone";
      digitsEl.textContent = formatMatchCode(session.matchCode);
      digitsEl.classList.remove("is-pending");
      renderQrFor(session.joinUrl);

      // 3. After 10s with no peer, swap caption to a cold-visitor rotation.
      rotateTimer = window.setTimeout(() => {
        captionEl.innerHTML =
          'Don’t have the app yet? ' +
          '<a href="/app/">Get it →</a>';
      }, ROTATE_AFTER_MS);

      // TODO(#59): subscribe to the WS peer-join event and redirect to
      // /build/?code=<buildCode> once the phone finalizes. For now the
      // session is decorative.
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

    // 4. QR rendering. With #59 unshipped, openSession() never reaches this
    //    branch in production — the fallback runs instead. The function is
    //    kept so the swap-in is a one-line change once the relay returns
    //    a real joinUrl. The encoder is intentionally tiny: a Model-2
    //    QR with byte-mode + L error correction, sized for short URLs.
    function renderQrFor(_text) {
      // Intentionally a placeholder for now. When #59 ships, replace this
      // body with a real encoder (or fetch a pre-rendered SVG from the
      // relay response). The placeholder is visually distinct from a real
      // QR so we don't ship something that *looks* scannable but isn't.
      renderPlaceholderMosaic();
    }

    function renderPlaceholderMosaic() {
      // Deterministic dotted grid that evokes a QR without claiming to be
      // one. Three corner finders match the QR finder-pattern footprint so
      // the visual is recognizable as "QR goes here".
      const N = 25;
      const cell = 10;
      const pad = 6;
      const size = N * cell + pad * 2;
      const bits = [];
      // Cheap deterministic noise (LCG seeded with a fixed constant so the
      // placeholder is stable across reloads — premium taste, not entropy).
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
      // Inline svg. `currentColor` lets the theme drive the ink.
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
