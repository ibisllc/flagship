// How one app takes updates (SECURITY-HARDENING-PLAN.md 18.11, N11): manual (the default, chosen
// first), staged (a verified update waits a week, then goes in) or automatic. The two automatic
// modes only ever take an update from the same publisher key that adds no authority; anything else
// waits for the owner. The box enforces that; this only reads the mode and asks to change it.

import { escapeHtml } from "./util.js";

export const UPDATE_MODE_COPY = Object.freeze({
  title: "Updates",
  manual: { label: "Ask me each time", note: "You approve every update." },
  staged: { label: "Wait a week, then update", note: "A verified update from the same publisher is held for a week, then goes in. Anything that asks for more access still waits for you." },
  auto: { label: "Update automatically", note: "A verified update from the same publisher goes in at once. Anything that asks for more access still waits for you." },
  frozen: { label: "Never update", note: "This app stays on the version it is on." },
});

const path = (serviceId) => `/api/screens/services/${encodeURIComponent(serviceId)}/update-mode`;

/** null when the box predates the setting, or the app does not update from a publisher (404/503). */
export async function fetchUpdateMode(serviceId, fetchJson) {
  try {
    return await fetchJson(path(serviceId));
  } catch (e) {
    if (e?.status === 404 || e?.status === 503) return null;
    throw e;
  }
}

export function setUpdateMode(serviceId, mode, fetchJson) {
  return fetchJson(path(serviceId), { method: "POST", body: JSON.stringify({ mode }) });
}

export function renderUpdateMode(data) {
  if (!data) return "";
  const rows = (data.modes ?? []).map((m) => {
    const c = UPDATE_MODE_COPY[m];
    if (!c) return "";
    return `<label class="inline-check mt-2"><input type="radio" name="sd-update-mode" value="${escapeHtml(m)}"${m === data.mode ? " checked" : ""} /> <span><strong>${escapeHtml(c.label)}</strong><br><span class="muted-sm text-xs">${escapeHtml(c.note)}</span></span></label>`;
  });
  return `
      <h2 class="mt-4">${escapeHtml(UPDATE_MODE_COPY.title)}</h2>
      <div class="card" id="sd-update-mode">${rows.join("")}</div>`;
}
