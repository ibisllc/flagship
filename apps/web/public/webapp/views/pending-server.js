// Pending-server placeholder view. Shown while an in-flight order
// (signed install blob delivered, box not yet phoned home) is sitting
// in localStorage. Lets the user inspect the order + cancel it, which
// IRK-signs an AuthCodeRevoke and POSTs to flagshipserver.com.
//
// MIRRORS: apps/mobile/{ios,android} PendingServerScreen.

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";

registerView("view-pending-server", { tab: "home" });

let currentOrder = null;

/** Surface a pending order. */
export function enterPendingServer(order) {
  currentOrder = order;
  $("pending-server-name").textContent = order.name || "Pending server";
  $("pending-server-fqdn").textContent = order.fqdn || "—";
  $("pending-server-serial").textContent = order.serial || "—";
  show("view-pending-server");
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
    // Drop from local order list so home / activity stop showing it.
    const list = JSON.parse(localStorage.getItem("flagship.pendingOrders") || "[]");
    localStorage.setItem(
      "flagship.pendingOrders",
      JSON.stringify(list.filter((o) => o.serial !== currentOrder.serial)),
    );
    toast(`order cancelled (${escapeHtml(currentOrder.name)})`);
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
  $("pending-server-back")?.addEventListener("click", () => show("view-home"));
}
