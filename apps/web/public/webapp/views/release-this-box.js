// The server page's "Release this box" on a retail box (docs/retail-box-setup.md §8.2). Shown only
// when server-detail carries `retail`. An admin device signs flagship/box-release/v1 with the
// admin root after a fresh unlock; other devices see why they can't.

import { $ } from "../lib/router.js";
import { boxClient } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { isAdminDevice } from "../lib/memberRoles.js";
import { confirmFreshUnlock } from "../lib/freshUnlock.js";
import { humanError } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";
import {
  BOX_RELEASE_PATH,
  RELEASE_ADMIN_ONLY,
  RELEASE_DONE,
  RELEASE_SUGGESTION,
  RELEASE_TITLE,
  RELEASE_WARNING,
  makeBoxRelease,
  releaseRefusal,
  signBoxRelease,
} from "../lib/releaseThisBox.js";
import { tr } from "../lib/i18n.js";

const STK = /^[0-9a-f]{64}$/i;

/** The section; "" on a box that is not a retail box. */
export function releaseThisBoxCardHtml(retail, { isAdmin }) {
  if (!retail || typeof retail.stkPubHex !== "string" || !STK.test(retail.stkPubHex)) return "";
  const controls = isAdmin
    ? `<p class="err-text small hidden" id="release-box-error"></p>
       <button id="release-box-btn" class="danger full-width mt-2">${escapeHtml(RELEASE_TITLE)}</button>`
    : `<p class="note small mt-2" id="release-box-admin-only">${escapeHtml(RELEASE_ADMIN_ONLY)}</p>`;
  return `
    <div id="release-box-section">
      <h2 class="mt-4">${escapeHtml(RELEASE_TITLE)}</h2>
      <div class="card" id="release-box-card">
        <p class="note">${escapeHtml(RELEASE_WARNING)}</p>
        <p class="note small">${escapeHtml(RELEASE_SUGGESTION)}</p>
        ${controls}
      </div>
    </div>`;
}

function codeOf(e) {
  const b = e && typeof e === "object" ? e.body : null;
  const c = b && typeof b === "object" ? (b.code ?? b.error) : null;
  return typeof c === "string" && c.startsWith("release-") ? c : null;
}

/**
 * Ask, sign with the admin root, send. Resolves to `{ok: true}`, `{ok: false, error}` or
 * `{ok: false, cancelled: true}`. No DOM; `deps` are test seams.
 */
export async function submitRelease({ fqdn, stkPubHex }, deps = {}) {
  const session = deps.session ?? getSession();
  if (!isAdminDevice(session)) return { ok: false, error: RELEASE_ADMIN_ONLY };
  if (!session?.umk) return { ok: false, error: tr("Unlock the webapp first.") };
  const unlocked = await (deps.freshUnlock ?? confirmFreshUnlock)(
    { title: tr("Release this box?"), message: RELEASE_WARNING, okLabel: tr("Wipe and release") },
    { session },
  );
  if (!unlocked.ok) return unlocked.cancelled ? { ok: false, cancelled: true } : { ok: false, error: unlocked.error };
  const order = makeBoxRelease({ serverDomain: fqdn, stkPubHex, issuedAt: (deps.now ?? Date.now)(), ...(deps.random ? { random: deps.random } : {}) });
  const fetchJson = deps.fetchJson ?? ((path, init) => boxClient(fqdn).fetch(path, init));
  try {
    const body = await signBoxRelease(order, session.adminRootSeed, deps.sign);
    await fetchJson(BOX_RELEASE_PATH, { method: "POST", body: JSON.stringify(body) });
    return { ok: true };
  } catch (e) {
    const code = codeOf(e);
    return { ok: false, error: code ? releaseRefusal(code) : humanError(e) };
  }
}

/** Wire the section's button. */
export function wireReleaseThisBox(body) {
  const btn = $("release-box-btn");
  if (!btn) return;
  const fqdn = body?.serverFqdn ?? "";
  const stkPubHex = body?.retail?.stkPubHex ?? "";
  btn.addEventListener("click", async () => {
    const err = $("release-box-error");
    if (err) err.classList.add("hidden");
    btn.disabled = true;
    try {
      const r = await submitRelease({ fqdn, stkPubHex });
      if (r.ok) {
        const card = $("release-box-card");
        if (card) card.innerHTML = `<p class="note" id="release-box-done"><strong>${escapeHtml(RELEASE_DONE)}</strong></p>`;
        return;
      }
      if (r.error && err) {
        err.textContent = r.error;
        err.classList.remove("hidden");
      }
    } finally {
      btn.disabled = false;
    }
  });
}
