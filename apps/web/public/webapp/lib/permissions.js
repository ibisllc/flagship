// "Access & permissions" for one app (SECURITY-HARDENING-PLAN.md 18.5, N05): every key, session and
// grant that can act for this app right now, the work running under each, and a way to end one or
// all of them. The box owns the list (server-daemon authority hub); this reads it and asks the box
// to revoke. Ending a permission stops its running work at once; a job that will not stop is named.

import { escapeHtml } from "./util.js";

export const PERMISSIONS_COPY = Object.freeze({
  title: "Access & permissions",
  none: "Nothing can act for this app right now.",
  revoke: "End this access",
  revokeAll: "End all access",
  stuck: "Some work did not stop yet:",
  ended: (n) => (n === 1 ? "Access ended." : `${n} accesses ended.`),
});

const KIND_LABEL = Object.freeze({
  "owner-session": "Owner session",
  "companion-session": "Browser or companion session",
  "app-api-key": "App API key",
  "mcp-key": "IDE key",
  "build-token": "Build",
  share: "Shared server",
  "member-invite": "Invitation",
  "browser-grant": "Browser access",
  "secret-handle": "Secret",
  "stream-ticket": "Stream",
  job: "Background job",
});

export const permissionKindLabel = (kind) => KIND_LABEL[kind] ?? kind;

const pathFor = (serviceId, tail = "") => `/api/screens/services/${encodeURIComponent(serviceId)}/permissions${tail}`;

/** null when the box predates the page (404). */
export async function fetchPermissions(serviceId, fetchJson) {
  try {
    return await fetchJson(pathFor(serviceId));
  } catch (e) {
    if (e?.status === 404 || e?.status === 503) return null;
    throw e;
  }
}

/** Revoke one grant, or every grant for the app when `grantId` is omitted. */
export async function revokePermission(serviceId, grantId, fetchJson) {
  return fetchJson(pathFor(serviceId, "/revoke"), {
    method: "POST",
    body: JSON.stringify(grantId ? { grantId } : {}),
  });
}

function whenText(ms) {
  return ms ? `until ${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "until you end it";
}

export function renderPermissions(data) {
  if (!data) return "";
  const grants = Array.isArray(data.grants) ? data.grants : [];
  const rows = grants
    .map(
      (g) => `
        <div class="sd-permission mt-2" data-permission="${escapeHtml(g.id)}">
          <div class="weight-600">${escapeHtml(permissionKindLabel(g.kind))} <span class="pill">${escapeHtml(g.capability)}</span>${g.secretAccess ? ' <span class="pill warn">can read secrets</span>' : ""}</div>
          <div class="muted-sm text-xs">${escapeHtml(whenText(g.expiresAt))}</div>
          ${(g.openWork ?? []).map((w) => `<div class="muted-sm text-xs">Running: ${escapeHtml(w)}</div>`).join("")}
          <button type="button" class="secondary mt-1" data-permission-revoke="${escapeHtml(g.id)}">${escapeHtml(PERMISSIONS_COPY.revoke)}</button>
        </div>`,
    )
    .join("");
  const pending = (data.pendingOperations ?? [])
    .map((o) => `<div class="muted-sm text-xs">Waiting: ${escapeHtml(o.kind)} (${escapeHtml(o.state)})</div>`)
    .join("");
  return `
      <h2 class="mt-4">${escapeHtml(PERMISSIONS_COPY.title)}</h2>
      <div class="card">
        ${grants.length === 0 ? `<p class="note">${escapeHtml(PERMISSIONS_COPY.none)}</p>` : rows}
        ${pending}
        ${grants.length > 1 ? `<button type="button" class="secondary full-width mt-2" data-permission-revoke-all>${escapeHtml(PERMISSIONS_COPY.revokeAll)}</button>` : ""}
      </div>`;
}

export function revokeOutcomeText(r) {
  const stuck = Array.isArray(r?.stuckWork) ? r.stuckWork : [];
  const base = PERMISSIONS_COPY.ended(r?.revoked ?? 0);
  return stuck.length ? `${base} ${PERMISSIONS_COPY.stuck} ${stuck.join(", ")}` : base;
}
