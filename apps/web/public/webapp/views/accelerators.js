// The server page's "GPUs" (packages/server-daemon/src/gpu/http.ts): apps asking to use a GPU
// (Approve signs flagship/gpu-approval/v1 with the sensitive-order key; Decline hides the ask on this
// device) and the approvals in force (Withdraw signs flagship/gpu-approval-withdraw/v1), each GPU with
// its model, memory and state, the app holding it (with Stop, which asks first), and the apps waiting.
// Stop is POST /api/screens/accelerators/stop from this device's session: the box takes no signed
// order for it and refuses a companion. A box with no GPU, or without this screen, shows nothing.
//
// MIRRORS: iOS AcceleratorsCard.swift, Android AcceleratorsCard.kt.

import { boxClient } from "../lib/api.js";
import { inlineConfirm } from "../lib/modal.js";
import { toast } from "../lib/toast.js";
import { boxErrorText } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";
import { getSession } from "../lib/state.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { canSignAdminOrders } from "../lib/addServerGate.js";
import { gpuApprovalBody, gpuApprovalWithdrawBody } from "../lib/gpuApproval.js";
import {
  APPROVALS_ADMIN_ONLY,
  APPROVALS_PATH,
  APPROVALS_WITHDRAW_PATH,
  APPROVE_LABEL,
  DECLINE_LABEL,
  OTHER_SERVER,
  WITHDRAW_LABEL,
  allowedLine,
  approvalKey,
  approvedLine,
  asksLine,
  declinedLine,
  withdrawnLine,
  ACCELERATORS_PATH,
  ACCELERATORS_STOP_PATH,
  PAUSED_LINE,
  SERVICE_ERROR,
  STOP_LABEL,
  STOP_MESSAGE,
  TITLE,
  WAITING_TITLE,
  deviceLine,
  deviceTitle,
  holderLine,
  showsCard,
  stopTitle,
  stoppedLine,
  waitingLine,
} from "../lib/accelerators.js";

/** The empty slot the server page puts after Local AI; `wireAccelerators` fills it. */
export function acceleratorsSlotHtml(serverFqdn) {
  return `<div id="accelerators-slot" data-fqdn="${escapeHtml(serverFqdn ?? "")}"></div>`;
}

/** Requests turned down on this device in this session, by server and installation. The box keeps no
 *  refusal (an app that isn't approved gets no GPU), so Decline sends nothing and hides the ask. */
const declined = new Set();

/** The requests still to answer for this server. */
export function pendingFor(serverFqdn, view) {
  return (view?.pendingApprovals ?? []).filter((r) => !declined.has(`${String(serverFqdn).toLowerCase()}|${approvalKey(r)}`));
}

function approvalsHtml(pending, granted, { canSign, busy }) {
  if (!pending.length && !granted.length) return "";
  const dis = busy ? " disabled" : "";
  return `
      <div data-acc-approvals>
        ${pending
          .map(
            (r) => `
          <div class="mt-2" data-acc-pending="${escapeHtml(r.appId)}">
            <p class="note small warn-text" data-acc-ask>${escapeHtml(asksLine(r))}</p>
            ${
              canSign
                ? `<div class="row-2 mt-1">
                    <button data-acc-approve="${escapeHtml(approvalKey(r))}"${dis}>${escapeHtml(APPROVE_LABEL)}</button>
                    <button class="secondary" data-acc-decline="${escapeHtml(approvalKey(r))}"${dis}>${escapeHtml(DECLINE_LABEL)}</button>
                  </div>`
                : ""
            }
          </div>`,
          )
          .join("")}
        ${granted
          .map(
            (r) => `
          <div class="mt-2" data-acc-granted="${escapeHtml(r.appId)}">
            <p class="note small" data-acc-allowed>${escapeHtml(allowedLine(r))}</p>
            ${canSign ? `<button class="secondary full-width mt-1" data-acc-withdraw="${escapeHtml(approvalKey(r))}"${dis}>${escapeHtml(WITHDRAW_LABEL)}</button>` : ""}
          </div>`,
          )
          .join("")}
        ${canSign ? "" : `<p class="note small" data-acc-admin-only>${escapeHtml(APPROVALS_ADMIN_ONLY)}</p>`}
      </div>`;
}

/** The card for one answer of GET /api/screens/accelerators. Exported for tests. */
export function acceleratorsCardHtml(view, { notice = null, error = null, busy = null, loadError = null, canSign = true, pending = null } = {}) {
  const asks = pending ?? view?.pendingApprovals ?? [];
  const shown = view ? { ...view, pendingApprovals: asks } : view;
  if (!loadError && !showsCard(shown)) return "";
  const devices = view?.devices ?? [];
  const queue = view?.queue ?? [];
  return `
    <h2 class="mt-4">${escapeHtml(TITLE)}</h2>
    <div class="card" id="accelerators-card">
      ${loadError ? `<p class="note small" data-acc-load-error>${escapeHtml(loadError)}</p>` : ""}
      ${approvalsHtml(asks, view?.approvals ?? [], { canSign, busy })}
      ${view?.admissionPaused ? `<p class="note small warn-text" data-acc-paused>${escapeHtml(PAUSED_LINE)}</p>` : ""}
      ${view && !devices.length && view.reason ? `<p class="note small" data-acc-service-error>${escapeHtml(SERVICE_ERROR)}</p>` : ""}
      ${devices
        .map(
          (d) => `
        <div class="mt-2" data-acc-device="${escapeHtml(d.id)}">
          <strong data-acc-name>${escapeHtml(deviceTitle(d))}</strong>
          <p class="note small${d.state === "quarantined" ? " warn-text" : ""}" data-acc-state>${escapeHtml(deviceLine(d))}</p>
          ${(d.holders ?? [])
            .map(
              (h) => `
            <div class="row" data-acc-holder="${escapeHtml(h.allocationId)}">
              <span class="small" data-acc-holder-line>${escapeHtml(holderLine(h))}</span>
              <button class="secondary small" data-acc-stop="${escapeHtml(h.allocationId)}"${busy ? " disabled" : ""}>${escapeHtml(STOP_LABEL)}</button>
            </div>`,
            )
            .join("")}
        </div>`,
        )
        .join("")}
      ${
        queue.length
          ? `<div class="mt-3" data-acc-queue>
              <strong class="small">${escapeHtml(WAITING_TITLE)}</strong>
              ${queue.map((q) => `<p class="note small" data-acc-waiting="${escapeHtml(q.appId)}">${escapeHtml(waitingLine(q))}</p>`).join("")}
            </div>`
          : ""
      }
      ${notice ? `<p class="note small ok-text mt-2" data-acc-notice>${escapeHtml(notice)}</p>` : ""}
      ${error ? `<p class="note small err-text mt-2" data-acc-error>${escapeHtml(error)}</p>` : ""}
    </div>`;
}

const unsupported = (e) => e && typeof e === "object" && (e.status === 404 || e.status === 405);

/**
 * Load this server's GPUs into the slot and wire Stop. The slot is looked up again before each
 * render, so an answer that lands after the owner opened another server's page changes nothing.
 */
export async function wireAccelerators(
  serverFqdn,
  {
    client = boxClient(serverFqdn),
    confirm = inlineConfirm,
    canSign = canSignAdminOrders(),
    sign = (bytes) => sensitiveSigner()(getSession()?.umk, bytes),
    now = () => Date.now(),
  } = {},
) {
  const state = { view: null, notice: null, error: null, busy: null, loadError: null, hidden: false, canSign };
  const server = String(serverFqdn ?? "").toLowerCase();
  const slot = () => {
    const el = typeof document === "undefined" ? null : document.getElementById("accelerators-slot");
    return el && el.dataset.fqdn === String(serverFqdn ?? "") ? el : null;
  };

  async function load() {
    try {
      state.view = await client.fetch(ACCELERATORS_PATH);
      state.loadError = null;
      state.hidden = false;
    } catch (e) {
      if (unsupported(e)) state.hidden = true;
      else if (!state.view) state.loadError = SERVICE_ERROR;
    }
  }

  function render() {
    const el = slot();
    if (!el) return;
    el.innerHTML = state.hidden ? "" : acceleratorsCardHtml(state.view, { ...state, pending: pendingFor(server, state.view) });
    for (const b of el.querySelectorAll("[data-acc-stop]")) {
      b.addEventListener("click", () => void stop(b.getAttribute("data-acc-stop")));
    }
    for (const b of el.querySelectorAll("[data-acc-approve]")) b.addEventListener("click", () => void approve(b.getAttribute("data-acc-approve")));
    for (const b of el.querySelectorAll("[data-acc-decline]")) b.addEventListener("click", () => decline(b.getAttribute("data-acc-decline")));
    for (const b of el.querySelectorAll("[data-acc-withdraw]")) b.addEventListener("click", () => void withdraw(b.getAttribute("data-acc-withdraw")));
  }

  const find = (list, key) => (state.view?.[list] ?? []).find((r) => approvalKey(r) === key);

  /** Signs for the box this page talks to, never for another server a listing names. */
  async function signed(r, done, send) {
    if (state.busy || !r) return false;
    state.notice = null;
    state.error = null;
    if (String(r.server ?? "").toLowerCase() !== server) {
      state.error = OTHER_SERVER;
      render();
      return false;
    }
    state.busy = approvalKey(r);
    render();
    let ok = false;
    try {
      await send(now());
      state.notice = done;
      toast(done, "ok");
      ok = true;
    } catch (e) {
      state.error = boxErrorText(e);
      toast(state.error, "err");
    }
    state.busy = null;
    await load();
    render();
    return ok;
  }

  async function approve(key) {
    const r = find("pendingApprovals", key);
    return signed(r, r && approvedLine(r), async (at) =>
      client.fetch(APPROVALS_PATH, { method: "POST", body: JSON.stringify(await gpuApprovalBody(server, r, at, sign)) }),
    );
  }

  async function withdraw(key) {
    const r = find("approvals", key);
    return signed(r, r && withdrawnLine(r), async (at) =>
      client.fetch(APPROVALS_WITHDRAW_PATH, { method: "POST", body: JSON.stringify(await gpuApprovalWithdrawBody(server, r, at, sign)) }),
    );
  }

  function decline(key) {
    const r = find("pendingApprovals", key);
    if (!r) return;
    declined.add(`${server}|${key}`);
    state.error = null;
    state.notice = declinedLine(r);
    toast(state.notice, "ok");
    render();
  }

  async function stop(allocationId) {
    if (state.busy) return;
    const holder = (state.view?.devices ?? []).flatMap((d) => d.holders ?? []).find((h) => h.allocationId === allocationId);
    if (!holder) return;
    const ok = await confirm({ title: stopTitle(holder), message: STOP_MESSAGE, okLabel: STOP_LABEL, danger: true });
    if (!ok) return;
    state.busy = allocationId;
    state.notice = null;
    state.error = null;
    render();
    try {
      await client.fetch(ACCELERATORS_STOP_PATH, { method: "POST", body: JSON.stringify({ allocationId }) });
      state.notice = stoppedLine(holder);
      toast(state.notice, "ok");
    } catch (e) {
      state.error = boxErrorText(e);
      toast(state.error, "err");
    }
    state.busy = null;
    await load();
    render();
  }

  await load();
  render();
  return { load, render, stop, approve, decline, withdraw, state };
}
