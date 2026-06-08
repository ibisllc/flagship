// Pending-server placeholder view. Shown while an in-flight order
// (signed install blob delivered, box not yet phoned home) is sitting
// in localStorage. Lets the user inspect the order + cancel it.
//
// Cancelling does TWO things so the chosen name is genuinely freed:
//   1. revokes the install auth-code (IRK-signed AuthCodeRevoke), and
//   2. releases the server name (IRK-signed ReleaseServerName →
//      /api/server/release) — which drops the RCK routing record that
//      otherwise keeps the name reserved after a failed install.
// Revoking the auth-code alone left the name "lost"; the release is the
// piece that lets the user re-use it.
//
// MIRRORS: apps/mobile/{ios,android} PendingServerScreen.

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { getSession } from "../lib/state.js";
import { signWithIrk } from "../keystore.js";
import { releaseServerName } from "../lib/releaseServer.js";
import { get as profileGet, set as profileSet } from "../lib/profilesStore.js";
import { PROVISION_PHASE_TITLES } from "../lib/provisionProgress.js";

registerView("view-pending-server", { tab: "home" });

const CONTROL_PLANE_BASE = "https://flagshipserver.com";
const POLL_INTERVAL_MS = 3_000;
const TERMINAL_PHASES = new Set(["live", "error"]);

let currentOrder = null;
let statusTimer = null;

function clearStatusPoll() {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
}

/** Surface a pending order + subscribe to the canonical provisioning channel
 *  by serial so the card shows live progress and flips to running on `live`. */
export function enterPendingServer(order) {
  currentOrder = order;
  $("pending-server-name").textContent = order.name || "Pending server";
  $("pending-server-fqdn").textContent = order.fqdn || "—";
  $("pending-server-serial").textContent = order.serial || "—";
  show("view-pending-server");
  clearStatusPoll();
  if (order.serial) pollStatus(order.serial).catch(() => {});
}

/** Poll the SINGLE canonical channel for this order's latest phase. On `live`
 *  we drop the pending order (it's now a running server) and return home; on
 *  any other phase we surface the canonical title in the note line. */
async function pollStatus(serial) {
  if (!currentOrder || currentOrder.serial !== serial) return;
  const note = $("pending-server-note");
  try {
    const resp = await fetch(
      `${CONTROL_PLANE_BASE}/api/order/${encodeURIComponent(serial)}/status`,
    );
    if (resp.ok) {
      const body = await resp.json();
      const phase = body && typeof body.phase === "string" ? body.phase : null;
      if (note && phase) {
        const title = PROVISION_PHASE_TITLES[phase] || phase;
        const detail =
          phase === "error" && body.detail ? ` — ${body.detail}` : "";
        note.textContent = `Setup: ${title}${escapeHtml(detail)}`;
      }
      if (phase === "live") {
        // The box is live — it's a running server now, not a pending order.
        const list = JSON.parse(profileGet("pendingOrders") || "[]");
        profileSet(
          "pendingOrders",
          JSON.stringify(list.filter((o) => o.serial !== serial)),
        );
        toast(`${escapeHtml(currentOrder.name || "Your server")} is live`);
        clearStatusPoll();
        currentOrder = null;
        show("view-home");
        return;
      }
      if (phase && TERMINAL_PHASES.has(phase)) {
        clearStatusPoll();
        return;
      }
    }
    // 404 (no record yet) / transient — keep polling.
  } catch (_e) {
    // network blip — keep polling
  }
  statusTimer = setTimeout(() => pollStatus(serial).catch(() => {}), POLL_INTERVAL_MS);
}

async function runCancel() {
  if (!currentOrder) return;
  const ok = confirm(
    `Cancel order for "${currentOrder.name}"? The auth-code will be revoked on flagshipserver.com; the box (if it ever boots) is rejected on first phone-home.`,
  );
  if (!ok) return;
  const btn = $("pending-server-cancel");
  if (btn) { btn.disabled = true; btn.textContent = "cancelling…"; }
  try {
    // Best-effort revoke. The Worker tolerates 404/403 as "already gone"
    // since the success surface for the user is the same.
    const resp = await fetch(
      `https://flagshipserver.com/api/auth-code/${encodeURIComponent(currentOrder.serial)}/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(currentOrder.revokeEnvelope ?? {}),
      },
    );
    if (!resp.ok && resp.status !== 404 && resp.status !== 403) {
      throw new Error(`HTTP ${resp.status}`);
    }
    // Release the name so it can be re-used. The auth-code revoke above
    // kills the install ticket; this drops the RCK routing record (and
    // any active codes / server record server-side) that otherwise keeps
    // the name reserved. Best-effort: an unlocked session is required to
    // sign, and the order must carry the username + fqdn (serverDomain).
    const session = getSession();
    const username = currentOrder.username || session.username;
    const serverDomain = currentOrder.fqdn || currentOrder.serverDomain;
    if (session.umk && session.irk && username && serverDomain) {
      try {
        const out = await releaseServerName({ username, serverDomain, umk: session.umk, signWithIrk });
        if (out && out.pending) {
          // P14 Phase 2 — companion path: surface the pending sheet so
          // the user knows the request is queued (release will happen
          // once the owner approves; the local order is still cleared).
          const { showCompanionPendingSheet, outcomeToastCopy } = await import(
            "../lib/companionPendingSheet.js"
          );
          const result = await showCompanionPendingSheet(out);
          if (result.outcome !== "approved") {
            const { text, kind } = outcomeToastCopy(result.outcome);
            toast(text, kind);
          }
        }
      } catch (e) {
        // Don't fail the whole cancel — the auth-code is already revoked,
        // which voids the install. Surface a soft warning so the user
        // knows the name may still be reserved until a retry/release.
        toast(`name release deferred: ${e.message ?? e}`, "warn");
      }
    }
    // Drop from local order list so home / activity stop showing it.
    const list = JSON.parse(profileGet("pendingOrders") || "[]");
    profileSet(
      "pendingOrders",
      JSON.stringify(list.filter((o) => o.serial !== currentOrder.serial)),
    );
    toast(`order cancelled (${escapeHtml(currentOrder.name)})`);
    clearStatusPoll();
    currentOrder = null;
    show("view-home");
  } catch (e) {
    toast(`cancel failed: ${e.message ?? e}`, "err");
    if (btn) { btn.disabled = false; btn.textContent = "Cancel order"; }
  }
}

export function initPendingServerView() {
  $("pending-server-cancel")?.addEventListener("click", () => {
    runCancel().catch((e) => toast(String(e), "err"));
  });
  $("pending-server-back")?.addEventListener("click", () => {
    clearStatusPoll();
    show("view-home");
  });
}
