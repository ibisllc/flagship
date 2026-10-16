// The server page's "Debug access" (docs/recipe-delivery-and-remote-install.md
// "Debug access"): an admin device lets one SSH key in as the box's `debug`
// user for 1 hour, 24 hours or 7 days, renews it, or turns it off. While it's
// on, a banner at the top of the page says until when. Other devices see the
// state only. Hidden on a box that doesn't report `debugAccess`.

import { $ } from "../lib/router.js";
import { boxClient } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { isAdminDevice } from "../lib/memberRoles.js";
import { inlineConfirm } from "../lib/modal.js";
import { toast } from "../lib/toast.js";
import { boxErrorText, humanError } from "../lib/humanError.js";
import { formatDateTime } from "../lib/dateFormat.js";
import { escapeHtml } from "../lib/util.js";
import {
  DEBUG_ADMIN_ONLY,
  DEBUG_DEFAULT_DURATION,
  DEBUG_DURATIONS,
  DEBUG_WARNING,
  debugAccessBanner,
  normalizeSshPublicKey,
  turnOffDebugAccess,
  turnOnDebugAccess,
} from "../lib/debugAccess.js";

const KEY_STORE = "flagship.debugKey.";

function rememberedKey(fqdn) {
  try {
    return globalThis.localStorage?.getItem(KEY_STORE + fqdn) ?? "";
  } catch {
    return "";
  }
}

function rememberKey(fqdn, key) {
  try {
    globalThis.localStorage?.setItem(KEY_STORE + fqdn, key);
  } catch {
    /* only a convenience */
  }
}

/** The banner at the top of the server page while debug access is on. */
export function debugAccessBannerHtml(view, now = Date.now()) {
  const line = debugAccessBanner(view, (ms) => formatDateTime(ms, now));
  if (!line) return `<div id="debug-access-banner" class="hidden"></div>`;
  return `<div class="card warning" id="debug-access-banner" role="status"><p class="warn-text">${escapeHtml(line)}</p></div>`;
}

function endedLine(view, now) {
  const e = view?.lastEnded;
  if (!e || typeof e.at !== "number") return "";
  return e.why === "revoked"
    ? `Last turned off ${formatDateTime(e.at, now)}.`
    : `Last ended ${formatDateTime(e.at, now)}.`;
}

/** The "Debug access" section; "" when the box doesn't report it. */
export function debugAccessCardHtml(view, { isAdmin, fqdn = "", now = Date.now() } = {}) {
  if (!view || typeof view.on !== "boolean") return "";
  const on = view.on === true;
  const state = `
    <div class="row">
      <span class="label">Status</span>
      <span class="pill${on ? " warn" : ""}" id="debug-access-pill">${on ? "On" : "Off"}</span>
    </div>
    ${on ? `<div class="row"><span class="label">Until</span><span class="value" id="debug-access-until">${escapeHtml(formatDateTime(view.expiresAt, now))}</span></div>` : ""}
    ${on && view.keyFingerprint ? `<div class="row"><span class="label">Key</span><span class="value mono small" id="debug-access-key">${escapeHtml(view.keyFingerprint)}</span></div>` : ""}
    ${!on && endedLine(view, now) ? `<p class="note small" id="debug-access-ended">${escapeHtml(endedLine(view, now))}</p>` : ""}`;
  const controls = isAdmin
    ? `
      <label class="caption mt-2" for="debug-access-ssh-key">SSH public key</label>
      <textarea id="debug-access-ssh-key" class="full-width" rows="2" spellcheck="false" autocomplete="off" placeholder="ssh-ed25519 AAAA… you@computer">${escapeHtml(rememberedKey(fqdn))}</textarea>
      <label class="caption mt-2" for="debug-access-duration">For</label>
      <select id="debug-access-duration" class="full-width">
        ${DEBUG_DURATIONS.map((d) => `<option value="${d.id}"${d.id === DEBUG_DEFAULT_DURATION ? " selected" : ""}>${escapeHtml(d.label)}</option>`).join("")}
      </select>
      <p class="warn-text small mt-2" id="debug-access-warning">${escapeHtml(DEBUG_WARNING)}</p>
      <p class="err-text small hidden" id="debug-access-error"></p>
      <button id="debug-access-on-btn" class="full-width mt-2">${on ? "Renew" : "Turn on"}</button>
      ${on ? `<button id="debug-access-off-btn" class="danger full-width mt-2">Turn off</button>` : ""}`
    : `<p class="note small mt-2" id="debug-access-admin-only">${escapeHtml(DEBUG_ADMIN_ONLY)}</p>`;
  return `
    <div id="debug-access-section">
      <h2 class="mt-4">Debug access</h2>
      <div class="card" id="debug-access-card">
        <p class="note">Let your own SSH key in as <code>debug</code> on this server's network, for a while. Key only, no password.</p>
        ${state}
        ${controls}
      </div>
    </div>`;
}

function repaint(fqdn, view) {
  const banner = $("debug-access-banner");
  if (banner) banner.outerHTML = debugAccessBannerHtml(view);
  const section = $("debug-access-section");
  if (section) section.outerHTML = debugAccessCardHtml(view, { isAdmin: isAdminDevice(getSession()), fqdn });
  wireDebugAccess({ serverFqdn: fqdn, debugAccess: view });
}

/** The box's own refusal sentence, or ours, never a raw stack. */
export function errorText(e) {
  if (e && typeof e === "object" && ("status" in e || e.rateLimited)) return boxErrorText(e);
  if (e instanceof Error && e.name === "Error" && e.message) return e.message;
  return humanError(e);
}

function showError(msg) {
  const el = $("debug-access-error");
  if (!el) return toast(msg, "err");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function gate(session) {
  if (!isAdminDevice(session)) return DEBUG_ADMIN_ONLY;
  if (!session?.umk) return "Unlock the webapp first.";
  return null;
}

/**
 * Turn on or renew: check the device and the key, ask, sign, send. Resolves
 * to `{ok: true, change, view}`, `{ok: false, error}` (the sentence to show)
 * or `{ok: false, cancelled: true}`. No DOM; `deps` are test seams.
 */
export async function submitDebugOn({ fqdn, rawKey, durationId, renewing }, deps = {}) {
  const session = deps.session ?? getSession();
  const refused = gate(session);
  if (refused) return { ok: false, error: refused };
  const raw = String(rawKey ?? "").trim();
  if (!raw) return { ok: false, error: "Debug access needs an SSH public key." };
  const key = normalizeSshPublicKey(raw);
  if (!key) return { ok: false, error: "That isn't an SSH public key this server can use." };
  const dur = DEBUG_DURATIONS.find((d) => d.id === durationId) ?? DEBUG_DURATIONS.find((d) => d.id === DEBUG_DEFAULT_DURATION);
  const ok = await (deps.confirm ?? inlineConfirm)({
    title: renewing ? "Renew debug access?" : "Turn on debug access?",
    message: `${DEBUG_WARNING} It stays on for ${dur.label}.`,
    okLabel: renewing ? "Renew" : "Turn on",
    danger: true,
  });
  if (!ok) return { ok: false, cancelled: true };
  const fetchJson = deps.fetchJson ?? ((path, init) => boxClient(fqdn).fetch(path, init));
  try {
    const res = await turnOnDebugAccess({ serverDomain: fqdn, sshPublicKey: key, durationMs: dur.ms, fetchJson }, { ...deps, umk: session.umk });
    rememberKey(fqdn, key);
    return { ok: true, change: res?.change ?? "granted", view: res?.debugAccess ?? null };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Turn off: ask, sign the revoke, send. Same result shape as submitDebugOn. */
export async function submitDebugOff({ fqdn }, deps = {}) {
  const session = deps.session ?? getSession();
  const refused = gate(session);
  if (refused) return { ok: false, error: refused };
  const ok = await (deps.confirm ?? inlineConfirm)({
    title: "Turn off debug access?",
    message: "The key stops working now and anyone signed in with it is disconnected.",
    okLabel: "Turn off",
    danger: true,
  });
  if (!ok) return { ok: false, cancelled: true };
  const fetchJson = deps.fetchJson ?? ((path, init) => boxClient(fqdn).fetch(path, init));
  try {
    const res = await turnOffDebugAccess({ serverDomain: fqdn, fetchJson }, { ...deps, umk: session.umk });
    return { ok: true, change: res?.change ?? "revoked", view: res?.debugAccess ?? null };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const DONE = { granted: "Debug access is on.", renewed: "Debug access renewed.", revoked: "Debug access is off.", unchanged: "Debug access is off." };

/** Wire the section's buttons. */
export function wireDebugAccess(body) {
  const fqdn = body?.serverFqdn ?? "";
  const run = async (btn, go) => {
    showError("");
    btn.disabled = true;
    try {
      const r = await go();
      if (r.ok) {
        toast(DONE[r.change] ?? "Done.", "ok");
        if (r.view) repaint(fqdn, r.view);
      } else if (r.error) {
        showError(r.error);
      }
    } finally {
      btn.disabled = false;
    }
  };
  const onBtn = $("debug-access-on-btn");
  onBtn?.addEventListener("click", () =>
    run(onBtn, () =>
      submitDebugOn({
        fqdn,
        rawKey: $("debug-access-ssh-key")?.value,
        durationId: $("debug-access-duration")?.value,
        renewing: body?.debugAccess?.on === true,
      }),
    ),
  );
  const offBtn = $("debug-access-off-btn");
  offBtn?.addEventListener("click", () => run(offBtn, () => submitDebugOff({ fqdn })));
}

