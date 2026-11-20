// The one-time "Get your own voi.ci page" intro (owner, 2026-11-20). Shown once per account on this browser, only
// after creating a new account (never after joining one, signing in again or restoring): createAccount marks it
// pending, and Home shows it the first time it opens for that account, after the creation steps. The optional promo
// line is server config (GET /api/voici/promo), not an app string. Set it up opens the Social tab's Profile.

import { controlApex } from "./apex.js";
import { currentLanguage, tr } from "./i18n.js";
import { buildOverlay, ensureHost } from "./modal.js";
import { escapeHtml } from "./util.js";

export const voiciIntroKey = (username) => `flagship.voici.intro.${String(username).toLowerCase()}`;

function store(s) {
  if (s) return s;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A new account was created here: its intro waits for the first Home. */
export function markVoiciIntroPending(username, storage) {
  const s = store(storage);
  if (!username || !s) return;
  try {
    if (s.getItem(voiciIntroKey(username)) !== "shown") s.setItem(voiciIntroKey(username), "pending");
  } catch {
    /* storage blocked: no intro */
  }
}

/** True once, when the account's intro is pending; it is recorded as shown at the same time. */
export function takeVoiciIntro(username, storage) {
  const s = store(storage);
  if (!username || !s) return false;
  try {
    if (s.getItem(voiciIntroKey(username)) !== "pending") return false;
    s.setItem(voiciIntroKey(username), "shown");
    return true;
  } catch {
    return false;
  }
}

/** `.com`'s promo for this language, or null (none configured, offline, any error). */
export async function fetchVoiciPromo({ fetchImpl = globalThis.fetch, baseUrl = controlApex(), lang = currentLanguage(), timeoutMs = 5000 } = {}) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(`${baseUrl}/api/voici/promo?lang=${encodeURIComponent(lang || "en")}`, { cache: "no-store", ...(ctl ? { signal: ctl.signal } : {}) });
    if (!r.ok) return null;
    const body = await r.json();
    const p = body?.promo;
    return p && typeof p.text === "string" && p.text.trim() ? { text: p.text.trim(), until: typeof p.until === "string" ? p.until : null } : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The intro sheet. Resolves "setup" or "later". The promo callout is added when `promo` resolves to one.
 * @param {{ username: string, promo?: Promise<{text: string}|null> }} opts
 */
export function openVoiciIntro({ username, promo = Promise.resolve(null) }) {
  return new Promise((resolve) => {
    const host = ensureHost();
    const overlay = buildOverlay();
    overlay.innerHTML = `
      <div class="modal-card voici-intro" role="document" data-testid="voici-intro">
        <h3 class="modal-title" id="voici-intro-title">${escapeHtml(tr("Get your own voi.ci page"))}</h3>
        <p class="modal-message">${escapeHtml(tr("Set up voi.ci/{0} to send and receive private messages and calls, and to post updates. No phone number or email needed, and it's protected against quantum computers.", username))}</p>
        <p class="callout-promo" data-testid="voici-intro-promo" hidden></p>
        <div class="row-2 mt-3">
          <button class="secondary" data-testid="voici-intro-later" data-intro-later>${escapeHtml(tr("Not now"))}</button>
          <button data-testid="voici-intro-setup" data-intro-setup>${escapeHtml(tr("Set it up"))}</button>
        </div>
      </div>`;
    overlay.setAttribute("aria-labelledby", "voici-intro-title");
    host.appendChild(overlay);
    document.body.classList.add("modal-open");
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      overlay.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close("later");
      }
    };
    overlay.querySelector("[data-intro-setup]").addEventListener("click", () => close("setup"));
    overlay.querySelector("[data-intro-later]").addEventListener("click", () => close("later"));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close("later");
    });
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => overlay.querySelector("[data-intro-setup]")?.focus({ preventScroll: true }));
    void Promise.resolve(promo).then((p) => {
      const line = overlay.querySelector("[data-testid=voici-intro-promo]");
      if (!done && line && p?.text) {
        line.textContent = p.text;
        line.hidden = false;
      }
    });
  });
}

/** Home's hook: the intro for a new account, once. Set it up opens the Social tab's Profile. */
export async function maybeShowVoiciIntro(username, deps = {}) {
  if (!takeVoiciIntro(username, deps.storage)) return null;
  const pick = await (deps.open ?? openVoiciIntro)({ username, promo: (deps.fetchPromo ?? fetchVoiciPromo)() });
  if (pick === "setup") {
    const enter = deps.enterYourPage ?? (async () => (await import("../views/messages.js")).enterYourPage());
    await enter();
  }
  return pick;
}
