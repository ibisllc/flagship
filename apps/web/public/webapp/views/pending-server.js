// Pending-server view: a server whose recipe was made but which hasn't come
// online yet. Opened from its Home card (and from Create a server once the
// recipe downloads), like iOS/Android's PendingServerScreen: the setup
// checklist, the address, how to write the USB, and Cancel order.
//
// Progress comes from the order's own status channel
// (`/api/order/<serial>/status`) when this browser made the recipe and kept
// its serial; otherwise from the account's `/pods` pending entry, which
// carries the same phase. Cancelling releases the name (admin-root-signed
// ReleaseServerName, Home's Delete server), which also voids the recipe.
//
// MIRRORS: apps/mobile/{ios,android} PendingServerScreen.

import { $, registerView, show } from "../lib/router.js";
import { getSession } from "../lib/state.js";
import { humanError } from "../lib/humanError.js";
import { toast } from "../lib/toast.js";
import { get as profileGet, set as profileSet } from "../lib/profilesStore.js";
import { PROVISION_PHASE_TITLES, renderProgressDetail } from "../lib/provisionProgress.js";
import { controlApex } from "../lib/apex.js";

registerView("view-pending-server", { tab: "home" });

const POLL_INTERVAL_MS = 3_000;
const TERMINAL_PHASES = new Set(["live", "error"]);
const MAX_REMEMBERED = 20;

let currentOrder = null;
let statusTimer = null;

function clearStatusPoll() {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
}

function rememberedOrders() {
  try {
    const list = JSON.parse(profileGet("pendingOrders") || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function sameFqdn(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/** Keep a just-made recipe's serial so its pending view can follow the
 *  order's own status channel. */
export function rememberPendingOrder({ serial, fqdn, name }) {
  if (!serial || !fqdn) return;
  const list = rememberedOrders().filter((o) => !sameFqdn(o.fqdn, fqdn));
  list.unshift({ serial, fqdn, name: name ?? null, createdAt: Date.now() });
  profileSet("pendingOrders", JSON.stringify(list.slice(0, MAX_REMEMBERED)));
}

function forgetPendingOrder(fqdn) {
  profileSet("pendingOrders", JSON.stringify(rememberedOrders().filter((o) => !sameFqdn(o.fqdn, fqdn))));
}

/** The serial this browser kept for the order at `fqdn`, if any. */
export function rememberedSerial(fqdn) {
  return rememberedOrders().find((o) => sameFqdn(o.fqdn, fqdn))?.serial ?? null;
}

/** Open the pending view for an order `{ name, fqdn, phase?, serial?, detail? }`. */
export function enterPendingServer(order) {
  clearStatusPoll();
  currentOrder = {
    ...order,
    serial: order.serial || rememberedSerial(order.fqdn),
  };
  $("pending-server-name").textContent = currentOrder.name || "New server";
  $("pending-server-fqdn").textContent = currentOrder.fqdn || "—";
  const cancel = $("pending-server-cancel");
  if (cancel) {
    cancel.disabled = false;
    cancel.textContent = "Cancel order";
  }
  paint(currentOrder.phase ?? null, currentOrder.detail ?? null);
  show("view-pending-server");
  void poll(currentOrder);
}

function paint(phase, detail) {
  const note = $("pending-server-note");
  if (note) {
    note.textContent = phase
      ? phase === "error" && detail
        ? `${PROVISION_PHASE_TITLES.error}: ${detail}`
        : PROVISION_PHASE_TITLES[phase] || phase
      : "Waiting for the server to start. Write the recipe to a USB stick with Flagship Studio, then boot the server from it.";
  }
  const progress = $("pending-server-progress");
  if (progress) {
    progress.innerHTML = renderProgressDetail({
      phase,
      lastError: phase === "error" ? detail || "" : undefined,
    });
  }
}

/** One status read: the order's own channel when its serial is known, else
 *  the account's pending list. */
async function readStatus(order) {
  if (order.serial) {
    const resp = await fetch(`${controlApex()}/api/order/${encodeURIComponent(order.serial)}/status`);
    if (resp.status === 404) return { phase: null };
    if (!resp.ok) return null;
    const body = await resp.json();
    return {
      phase: typeof body?.phase === "string" ? body.phase : null,
      detail: typeof body?.detail === "string" ? body.detail : null,
    };
  }
  const username = getSession().username;
  if (!username) return null;
  const { fetchPodInventory } = await import("./home.js");
  const inv = await fetchPodInventory(username);
  if (inv.status !== "ok") return null;
  const entry = inv.pending.find((p) => sameFqdn(p.fqdn, order.fqdn));
  if (!entry) return { gone: true };
  return { phase: entry.phase ?? null, detail: null };
}

async function poll(order) {
  if (order !== currentOrder) return;
  clearStatusPoll();
  let status = null;
  try {
    status = await readStatus(order);
  } catch {
    status = null; // a network blip: keep polling
  }
  if (order !== currentOrder) return;
  if (status?.gone || status?.phase === "live") {
    // It came online (or was removed from another device): Home lists it as
    // a server now.
    forgetPendingOrder(order.fqdn);
    currentOrder = null;
    const { enterHome } = await import("./home.js");
    await enterHome();
    return;
  }
  if (status) paint(status.phase, status.detail);
  if (status?.phase && TERMINAL_PHASES.has(status.phase)) return;
  statusTimer = setTimeout(() => void poll(order), POLL_INTERVAL_MS);
}

async function runCancel() {
  const order = currentOrder;
  if (!order?.fqdn) return;
  const { deleteDeadServer } = await import("./home.js");
  const done = await deleteDeadServer(order.fqdn, $("pending-server-cancel"), { label: "Cancel order" });
  if (!done || order !== currentOrder) return;
  forgetPendingOrder(order.fqdn);
  clearStatusPoll();
  currentOrder = null;
  show("view-home");
}

export function initPendingServerView() {
  $("pending-server-cancel")?.addEventListener("click", () => {
    runCancel().catch((e) => toast(humanError(e), "err"));
  });
  $("pending-server-back")?.addEventListener("click", async () => {
    clearStatusPoll();
    currentOrder = null;
    const { enterHome } = await import("./home.js");
    await enterHome();
  });
}
