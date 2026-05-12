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
  if (!baseUrl) return toast("pod URL required", "err");
  const btn = $("pod-pair-go");
  btn.disabled = true;
  try {
    await pairWithPod({ baseUrl, label });
    toast("paired with pod");
    await enterPodPair(); // re-render the status card
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function handleUnpair() {
  if (!confirm("Forget this pod from this device?")) return;
  setPodBaseUrl("");
  setSessionToken("");
  toast("unpaired");
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
        <span class="value">paired to <strong>${escapeHtml(baseUrl)}</strong></span>
        <button class="secondary" id="pod-pair-unpair">unpair</button>
      </div>
    `;
    $("pod-pair-unpair")?.addEventListener("click", () => handleUnpair());
  } else {
    status.innerHTML = '<p class="note">not paired with any pod yet</p>';
  }
}
