// Full-page account audit log (live, .com-backed).
//
// Mirror of the iOS/Android AuditLogScreen + AuditLogViewModel: a
// paginated, newest-first list of every account-level audit event from
// flagshipserver.com (GET /api/users/:u/audit). This is the "see all"
// detail screen reached from the Activity tab's inline "Account events"
// preview.
//
// Distinct from views/audit-log.js: that view targets the daemon BFF
// surface `/api/screens/audit-log` (signed-envelope drill-in, still on
// the v1-launch checklist). THIS view mirrors the mobile apps' LIVE
// feed off the identity plane, which is what ships today — closing the
// webapp ↔ mobile parity gap.

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import { toast } from "../lib/toast.js";
import { get as profileGet } from "../lib/profilesStore.js";
import {
  createAuditLogModel,
  auditKindLabel,
  auditKindIcon,
} from "../lib/auditLog.js";

registerView("view-account-audit");

let model = null;

function activeUsername() {
  try {
    const raw = profileGet("sessionV1");
    if (raw) return JSON.parse(raw).username ?? "";
  } catch {
    /* fall through */
  }
  try {
    return profileGet("username") ?? "";
  } catch {
    return "";
  }
}

function fmtDate(ms) {
  if (typeof ms !== "number") return "—";
  return new Date(ms).toLocaleString();
}

function eventRow(e) {
  return `
    <div class="card" data-audit-seq="${escapeHtml(String(e.seq))}">
      <div class="row">
        <span class="value">
          <span aria-hidden="true">${auditKindIcon(e.eventKind)}</span>
          ${escapeHtml(auditKindLabel(e.eventKind))}
        </span>
        <span class="pill">${escapeHtml(fmtDate(e.postedAt))}</span>
      </div>
      ${e.detail ? `<p class="note small">${escapeHtml(e.detail)}</p>` : ""}
      ${
        e.accountTypeAtEvent
          ? `<p class="faint-sm">account: ${escapeHtml(e.accountTypeAtEvent)}</p>`
          : ""
      }
    </div>
  `;
}

export async function renderAccountAudit() {
  const root = $("account-audit-content");
  if (!root) return;
  const username = activeUsername();
  if (!username) {
    root.innerHTML = `<div class="card placeholder">Sign in to see your account history.</div>`;
    return;
  }
  root.innerHTML = `<div class="card placeholder">Loading account history…</div>`;
  model = createAuditLogModel({ username, pageSize: 30 });
  try {
    await model.load();
  } catch (e) {
    root.innerHTML = `<div class="card placeholder err-text">${escapeHtml(
      e?.message ?? "Couldn't load account history.",
    )}</div>`;
    return;
  }
  paint(root);
}

function paint(root) {
  const events = model?.events ?? [];
  if (!events.length) {
    root.innerHTML = `
      <div class="card placeholder">
        No account events yet — security actions you take (enabling 2FA,
        adding or disconnecting a device, setting up recovery) land here.
      </div>
    `;
    return;
  }
  const more = model?.canLoadMore
    ? `<button class="secondary full-width mt-2" id="account-audit-load-more">Load more</button>`
    : "";
  root.innerHTML = events.map(eventRow).join("") + more;
  $("account-audit-load-more")?.addEventListener("click", async () => {
    try {
      await model.loadMore();
      paint(root);
    } catch (e) {
      toast(String(e?.message ?? e), "err");
    }
  });
}

export async function enterAccountAudit() {
  show("view-account-audit");
  await renderAccountAudit();
}

export function initAccountAuditView() {
  $("account-audit-back")?.addEventListener("click", () => show("view-activity"));
  $("account-audit-refresh")?.addEventListener("click", () => {
    renderAccountAudit().catch((e) => toast(String(e), "err"));
  });
}
