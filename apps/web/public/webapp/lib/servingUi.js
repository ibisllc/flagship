// The server page's one dead-man line and its editor
// (docs/architecture-v2/issuance-and-lease-records.md §5):
//
//   Stays online until 14 Nov if no admin opens Flagship · 7 days
//   Locks on 14 Nov if no admin opens Flagship · 7 days      (with locking)
//   No time limit                                              (with Never)
//
// Admins tap it to change the setting (a fresh unlock, then a new signed
// `serving-policy/v1`); any other device sees the line only.

import { escapeHtml } from "./util.js";
import { dateLocale, tr } from "./i18n.js";
import { buildOverlay, ensureHost } from "./modal.js";
import { confirmFreshUnlock } from "./freshUnlock.js";
import { toast } from "./toast.js";
import {
  GRACE_MS,
  ServingPolicyError,
  canEditServing,
  fetchServing,
  saveServingPolicy,
  servingView,
} from "./servingAuthority.js";
import { listLeases, revokeLease } from "./leases.js";
import { rememberServingState } from "./bootSuspension.js";

export const SERVING_IF_NO_ADMIN = tr("if no admin opens Flagship");
export const SERVING_NO_LIMIT = tr("No time limit");
export const SERVING_WAITING = tr("Its apps are stopped until an admin opens Flagship");
export const SERVING_FOR = tr("If no admin opens Flagship for:");
export const SERVING_THEN = tr("Then:");
export const SERVING_STOP_APPS = tr("Stop serving its apps");
export const SERVING_LOCK = tr("Stop its apps and lock the server");
export const SERVING_LOCK_NOTE = tr("Locking restarts the server with its disk locked. It starts again only when an admin approves on their phone.");

export function graceLabel(grace) {
  if (grace === "7d") return tr("7 days");
  if (grace === "30d") return tr("30 days");
  return tr("Never");
}

/** "14 Nov" (with the year when it isn't this year), in the reader's language. */
export function servingDate(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date(nowMs).getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(dateLocale(), opts);
}

/** The line's parts: `{lead, rest, grace}` (lead is shown bold). */
export function servingLineParts(view, nowMs = Date.now()) {
  if (!view || view.grace === "indefinite") return { lead: SERVING_NO_LIMIT, rest: "", grace: "" };
  if (typeof view.until !== "number" || view.until <= nowMs) return { lead: SERVING_WAITING, rest: "", grace: graceLabel(view.grace) };
  const date = servingDate(view.until, nowMs);
  const lead = view.onLapse === "lock-server" ? tr("Locks on {0}", date) : tr("Stays online until {0}", date);
  return { lead, rest: SERVING_IF_NO_ADMIN, grace: graceLabel(view.grace) };
}

function lineInnerHtml(view, nowMs) {
  const p = servingLineParts(view, nowMs);
  return `<strong data-serving-lead>${escapeHtml(p.lead)}</strong>${p.rest ? ` ${escapeHtml(p.rest)}` : ""}${p.grace ? ` <span class="serving-grace" data-serving-grace>· ${escapeHtml(p.grace)}</span>` : ""}`;
}

/** The card on the server page; filled by {@link wireServingLine}. Hidden until there is something to show. */
export function servingCardHtml() {
  return `<div class="card hidden" id="serving-card"><div id="serving-line-slot"></div></div>`;
}

/**
 * Before a policy that locks the server is saved: revoke every auto-unlock
 * lease that would outlive its first deadline (SEC-DEADMAN-001), through the
 * boot service. Throws when one can't be revoked; the policy is then not saved.
 */
export async function revokeLeasesOutliving(serverDomain, deadline, deps = {}) {
  const active = await (deps.listLeases ?? listLeases)(serverDomain);
  const tooLong = active.filter((l) => !(typeof l.expiresAt === "number" && l.expiresAt <= deadline));
  for (const l of tooLong) await (deps.revokeLease ?? revokeLease)(serverDomain, l.leaseId, deps);
  return tooLong.map((l) => l.leaseId);
}

/**
 * The editor's Save: a choice that locks the server first drops the auto-unlock
 * leases that would outlive the deadline; if that fails nothing is signed and the
 * error says why. Then the policy is signed and sent (lib/servingAuthority.js).
 */
export async function saveServingChoice({ serverDomain, view, grace, onLapse }, deps = {}) {
  const locks = onLapse === "lock-server" && grace !== "indefinite" && !!GRACE_MS[grace];
  if (locks) {
    const now = (deps.now ?? Date.now)();
    try {
      await revokeLeasesOutliving(serverDomain, now + GRACE_MS[grace], deps);
    } catch (e) {
      throw new ServingPolicyError(tr("Couldn't remove this server's auto-unlock, so locking was not turned on. {0}", String(e?.message || e)), 0, "auto-unlock-revoke");
    }
  }
  return (deps.saveServingPolicy ?? saveServingPolicy)({ serverDomain, view, grace, onLapse }, deps);
}

function paint(view, editable) {
  const slot = document.getElementById("serving-line-slot");
  const card = document.getElementById("serving-card");
  if (!slot || !card) return;
  if (!view) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const inner = lineInnerHtml(view, Date.now());
  slot.innerHTML = editable
    ? `<button type="button" class="serving-line" id="serving-line" data-grace="${escapeHtml(view.grace)}" data-on-lapse="${escapeHtml(view.onLapse)}">${inner}</button>`
    : `<p class="serving-line" id="serving-line" data-grace="${escapeHtml(view.grace)}" data-on-lapse="${escapeHtml(view.onLapse)}">${inner}</p>`;
}

/**
 * Show the line for the server on this page and, on an admin device, open the
 * editor on a tap. `body` is the box's server-detail; `.com`'s row is read too
 * (it has the box key and the relays' deadline).
 */
export async function wireServingLine(body, { pod = null, deps = {} } = {}) {
  const serverDomain = String(body?.serverFqdn ?? "").toLowerCase();
  const username = body?.username;
  const editable = canEditServing();
  let view = servingView({ detail: body?.serving ?? null, pod, serverDomain });
  paint(view, editable);
  if (view) rememberServingState(serverDomain, view);
  const rows = await (deps.fetchServing ?? fetchServing)(username, deps).catch(() => null);
  const row = rows?.find((r) => String(r.serverDomain).toLowerCase() === serverDomain) ?? null;
  if (row) {
    view = servingView({ detail: body?.serving ?? null, row, pod, serverDomain });
    paint(view, editable);
    if (view) rememberServingState(serverDomain, view);
  }
  const slot = document.getElementById("serving-line-slot");
  if (!editable || !slot) return;
  slot.addEventListener("click", async (ev) => {
    if (!ev.target.closest?.("#serving-line")) return;
    const choice = await openServingEditor(view);
    if (!choice) return;
    if (choice.grace === view.grace && choice.onLapse === view.onLapse) return;
    const ok = await (deps.freshUnlock ?? confirmFreshUnlock)({
      title: tr("Change when this server stops"),
      message: tr("This signs a new setting for {0}.", serverDomain.split(".")[0] || serverDomain),
    });
    if (!ok?.ok) {
      if (ok?.error) toast(ok.error, "err");
      return;
    }
    try {
      const r = await saveServingChoice({ serverDomain, view, ...choice }, deps);
      view = {
        ...view,
        grace: r.policy.grace,
        onLapse: r.policy.onLapse,
        policyGen: r.policy.policyGen,
        until: r.policy.grace === "indefinite" ? null : r.until ?? view.until,
      };
      paint(view, editable);
      toast(tr("Saved"), "ok");
    } catch (e) {
      toast(String(e?.message || e), "err");
    }
  });
}

/**
 * The editor sheet. Resolves `{grace, onLapse}` on Save, or null when
 * dismissed. "Never" greys out locking (it needs a time limit).
 */
export function openServingEditor(view) {
  return new Promise((resolve) => {
    let grace = view?.grace ?? "indefinite";
    let onLapse = view?.onLapse === "lock-server" ? "lock-server" : "stop-apps";
    const host = ensureHost();
    const overlay = buildOverlay();
    overlay.setAttribute("aria-label", SERVING_FOR);
    overlay.innerHTML = `
      <div class="modal-card serving-sheet" role="document">
        <p class="caption" id="serving-for-label">${escapeHtml(SERVING_FOR)}</p>
        <div class="fs-segmented" id="serving-grace" role="radiogroup" aria-labelledby="serving-for-label">
          ${["7d", "30d", "indefinite"].map((g) => `<button type="button" role="radio" data-grace="${g}" aria-checked="${g === grace}">${escapeHtml(graceLabel(g))}</button>`).join("")}
        </div>
        <p class="caption mt-3" id="serving-then-label">${escapeHtml(SERVING_THEN)}</p>
        <div class="secure-options" role="radiogroup" aria-labelledby="serving-then-label">
          <label class="secure-option" data-lapse-option="stop-apps">
            <input type="radio" name="serving-lapse" value="stop-apps" />
            <span class="secure-option-text"><span class="secure-option-label">${escapeHtml(SERVING_STOP_APPS)}</span></span>
          </label>
          <label class="secure-option mt-2" data-lapse-option="lock-server">
            <input type="radio" name="serving-lapse" value="lock-server" />
            <span class="secure-option-text"><span class="secure-option-label">${escapeHtml(SERVING_LOCK)}</span></span>
          </label>
        </div>
        <p class="note small mt-2" id="serving-lock-note">${escapeHtml(SERVING_LOCK_NOTE)}</p>
        <div class="row-2 mt-3">
          <button type="button" class="secondary" data-serving-cancel>${escapeHtml(tr("Cancel"))}</button>
          <button type="button" data-serving-save>${escapeHtml(tr("Save"))}</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);
    document.body.classList.add("modal-open");
    const lockInput = overlay.querySelector('input[value="lock-server"]');
    const stopInput = overlay.querySelector('input[value="stop-apps"]');
    const lockOption = overlay.querySelector('[data-lapse-option="lock-server"]');
    const render = () => {
      for (const b of overlay.querySelectorAll("#serving-grace [data-grace]")) {
        b.setAttribute("aria-checked", String(b.getAttribute("data-grace") === grace));
      }
      const never = grace === "indefinite";
      if (never) onLapse = "stop-apps";
      lockInput.disabled = never;
      lockOption.classList.toggle("disabled", never);
      lockOption.setAttribute("aria-disabled", String(never));
      stopInput.checked = onLapse === "stop-apps";
      lockInput.checked = onLapse === "lock-server";
    };
    const close = (v) => {
      overlay.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close(null);
      }
    };
    for (const b of overlay.querySelectorAll("#serving-grace [data-grace]")) {
      b.addEventListener("click", () => {
        grace = b.getAttribute("data-grace");
        render();
      });
    }
    for (const input of [stopInput, lockInput]) {
      input.addEventListener("change", () => {
        if (input.checked && !input.disabled) onLapse = input.value;
        render();
      });
    }
    overlay.querySelector("[data-serving-cancel]").addEventListener("click", () => close(null));
    overlay.querySelector("[data-serving-save]").addEventListener("click", () => close({ grace, onLapse }));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey);
    render();
    queueMicrotask(() => overlay.querySelector('#serving-grace [aria-checked="true"]')?.focus({ preventScroll: true }));
  });
}
