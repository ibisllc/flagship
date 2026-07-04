// Pod-pair view. Sits in front of all /api/screens/* views.
// The user pastes their pod's base URL; the webapp signs an
// add-paired-session order and persists the resulting token.

import { $, registerView, show } from "../lib/router.js";
import { pairWithPod } from "../lib/podPair.js";
import { getPodBaseUrl, getSessionToken, setPodBaseUrl, setSessionToken } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";

registerView("view-pod-pair");

async function handlePair() {
  const baseUrl = $("pod-pair-base").value.trim();
  const label = $("pod-pair-label").value.trim() || "webapp";
  if (!baseUrl) return toast("Server URL required", "err");
  const btn = $("pod-pair-go");
  btn.disabled = true;
  try {
    await pairWithPod({ baseUrl, label });
    toast("Paired with server");
    await enterPodPair(); // re-render the status card
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function handleUnpair() {
  const { inlineConfirm } = await import("../lib/modal.js");
  const ok = await inlineConfirm({
    title: "Forget this server?",
    message: "Removes the paired-session token from this device. You can re-pair anytime.",
    okLabel: "Forget",
    danger: true,
  });
  if (!ok) return;
  setPodBaseUrl("");
  setSessionToken("");
  toast("Unpaired");
  enterPodPair();
}

export function initPodPairView() {
  $("pod-pair-back")?.addEventListener("click", () => show("view-home"));
  $("pod-pair-go")?.addEventListener("click", () => handlePair());
  $("pod-pair-unpair")?.addEventListener("click", () => handleUnpair());
}

export async function enterPodPair() {
  show("view-pod-pair");
  const status = $("pod-pair-status");
  const baseUrl = getPodBaseUrl();
  const tok = getSessionToken();
  if (baseUrl && tok) {
    status.innerHTML = `
      <div class="row">
        <span class="value">Paired to <strong>${escapeHtml(baseUrl)}</strong></span>
        <button class="secondary" id="pod-pair-unpair">Unpair</button>
      </div>
    `;
    $("pod-pair-unpair")?.addEventListener("click", () => handleUnpair());
  } else {
    status.innerHTML = '<p class="note">Not paired with any server yet</p>';
  }
}
