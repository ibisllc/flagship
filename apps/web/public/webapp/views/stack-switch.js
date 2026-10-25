// The server page's "Container stack" (admin devices only; packages/server-daemon/src/archV2Switch.ts):
// which stack the box runs, Move to the new stack (one signed flagship/arch-v2-switch/v1 order, sent
// first as a dry run so the box's plan or refusal shows), Move now (the same order for real), and how
// the move goes while the box restarts.
//
// MIRRORS: iOS StackSwitchCard.swift, Android StackSwitchCard.kt.

import { boxClient } from "../lib/api.js";
import { getSession } from "../lib/state.js";
import { sensitiveSigner } from "../lib/adminRoot.js";
import { toast } from "../lib/toast.js";
import { boxErrorText } from "../lib/humanError.js";
import { escapeHtml } from "../lib/util.js";
import { tr } from "../lib/i18n.js";
import {
  MOVE_NOW,
  PLAN_TITLE,
  STACK_PATH,
  STACK_SWITCH_PATH,
  STARTED,
  TITLE,
  currentLine,
  moveLabel,
  newNonce,
  recordLine,
  roomLine,
  stackSwitchBody,
} from "../lib/stackSwitch.js";

export function stackSlotHtml(serverFqdn) {
  return `<div id="stack-slot" data-fqdn="${escapeHtml(serverFqdn ?? "")}"></div>`;
}

const moving = (st) => st.restarting || st.status?.switch?.state === "installing";

/** The card for one state. Exported for tests. */
export function stackCardHtml(st) {
  const s = st.status;
  if (!s || st.hidden) return "";
  const rec = recordLine(s.switch);
  const plan = st.review;
  return `
    <h2 class="mt-4">${escapeHtml(TITLE)}</h2>
    <div class="card" id="stack-card">
      <p data-stack-current><strong>${escapeHtml(currentLine(s))}</strong></p>
      ${rec ? `<p class="note small${s.switch?.state === "reverted" ? " warn-text" : ""}" data-stack-record>${escapeHtml(rec)}</p>` : ""}
      ${moving(st) ? `<progress class="full-width" data-stack-moving></progress>` : ""}
      ${
        plan
          ? `<div data-stack-plan>
              <p class="small"><strong>${escapeHtml(PLAN_TITLE)}</strong></p>
              <ol class="small">${(plan.steps ?? []).map((x) => `<li data-stack-step>${escapeHtml(x)}</li>`).join("")}</ol>
              ${roomLine(plan) ? `<p class="note small" data-stack-room>${escapeHtml(roomLine(plan))}</p>` : ""}
              ${(plan.blockers ?? []).map((b) => `<p class="note small err-text" data-stack-blocker>${escapeHtml(b.error)}</p>`).join("")}
              <div class="row-2 mt-2">
                <button id="stack-move-now"${(plan.blockers ?? []).length || st.busy ? " disabled" : ""}>${escapeHtml(MOVE_NOW)}</button>
                <button class="secondary" id="stack-cancel">${tr("Cancel")}</button>
              </div>
            </div>`
          : moving(st)
            ? ""
            : `<button class="secondary full-width mt-2" id="stack-move"${st.busy ? " disabled" : ""}>${escapeHtml(moveLabel(s.plan?.target))}</button>`
      }
      ${st.notice ? `<p class="note small ok-text mt-2" data-stack-notice>${escapeHtml(st.notice)}</p>` : ""}
      ${st.error ? `<p class="note small err-text mt-2" data-stack-error>${escapeHtml(st.error)}</p>` : ""}
    </div>`;
}

export async function wireStackSwitch(
  serverFqdn,
  {
    client = boxClient(serverFqdn),
    sign = (bytes) => sensitiveSigner()(getSession()?.umk, bytes),
    now = () => Date.now(),
    pollMs = 3000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const server = String(serverFqdn ?? "").toLowerCase();
  const st = { status: null, hidden: false, review: null, signed: null, busy: false, restarting: false, notice: null, error: null };
  const slot = () => {
    const el = typeof document === "undefined" ? null : document.getElementById("stack-slot");
    return el && el.dataset.fqdn === String(serverFqdn ?? "") ? el : null;
  };

  async function load() {
    try {
      st.status = await client.fetch(STACK_PATH);
      st.hidden = false;
      if (st.status?.switch?.state !== "installing") st.restarting = false;
    } catch (e) {
      if ((e?.status === 404 || e?.status === 405) && !st.restarting) st.hidden = true;
    }
  }

  function render() {
    const el = slot();
    if (!el) return;
    el.innerHTML = stackCardHtml(st);
    el.querySelector("#stack-move")?.addEventListener("click", () => void prepare());
    el.querySelector("#stack-move-now")?.addEventListener("click", () => void confirm());
    el.querySelector("#stack-cancel")?.addEventListener("click", () => cancel());
  }

  const order = (target) => ({ serverDomain: server, target, nonce: newNonce(), issuedAt: now() });

  /** Sign once and ask the box for its plan without changing anything. */
  async function prepare() {
    const target = st.status?.plan?.target;
    if (!target || st.busy) return;
    st.busy = true;
    st.error = null;
    st.notice = null;
    render();
    try {
      const o = order(target);
      const body = await stackSwitchBody(o, sign, { dryRun: true });
      const r = await client.fetch(STACK_SWITCH_PATH, { method: "POST", body: JSON.stringify(body) });
      st.signed = { order: o, signature: body.signature };
      st.review = r?.plan ?? st.status.plan;
    } catch (e) {
      st.error = boxErrorText(e);
    }
    st.busy = false;
    render();
  }

  function cancel() {
    st.signed = null;
    st.review = null;
    render();
  }

  /** Send the order the dry run checked (signed again only near the box's 5-minute limit). */
  async function confirm() {
    const plan = st.review;
    if (!plan || st.busy || (plan.blockers ?? []).length) return;
    st.busy = true;
    st.error = null;
    render();
    try {
      let s = st.signed;
      if (!s || now() - s.order.issuedAt > 4 * 60_000) {
        const o = order(plan.target);
        s = { order: o, signature: (await stackSwitchBody(o, sign)).signature };
      }
      await client.fetch(STACK_SWITCH_PATH, { method: "POST", body: JSON.stringify({ order: s.order, signature: s.signature }) });
      st.signed = null;
      st.review = null;
      st.restarting = true;
      st.notice = STARTED;
      toast(STARTED, "ok");
    } catch (e) {
      st.error = boxErrorText(e);
      toast(st.error, "err");
    }
    st.busy = false;
    await load();
    render();
    void follow();
  }

  /** Read again while the move is under way. */
  async function follow(rounds = 200) {
    for (let n = 0; n < rounds && moving(st); n++) {
      await sleep(pollMs);
      if (!slot() && typeof document !== "undefined") return;
      await load();
      render();
    }
  }

  await load();
  render();
  if (moving(st)) void follow();
  return { load, render, prepare, confirm, cancel, follow, state: st };
}
