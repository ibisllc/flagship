// Settings → Peer-backup: this server's peer backup (docs/peer-backup.md).
//
// Peer backup is a backup policy, chosen on the server's Backups page (Peer-
// distributed backups); this page only shows how it is going:
//   - the state (protected, at risk, looking for servers…) and the newest backup's pieces
//   - the servers holding the pieces, as "Server 1..n" (never named) with their last proof
//   - what this server keeps for others
//
//   GET /api/screens/peer-backup/status   → the v2 screen (box: peerNet/engine.ts)

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { screensFetch, ScreensError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { formatWhen } from "../lib/dateFormat.js";
import { PEER_STATUS_PATH, stateTitle, stateNote, holderRows, hostingLines, restoreByLine } from "../lib/peerBackup.js";

import { tr } from "../lib/i18n.js";
registerView("view-peer-backup");

const PILL = { protected: "ok", "at-risk": "err", "waiting-for-peers": "warn", filling: "warn", placing: "warn", leaving: "warn", off: "" };

function placeholder(root, text) {
  root.innerHTML = `<div class="card placeholder">${escapeHtml(text)}</div>`;
}

export function renderStatus(body, { formatTime = formatWhen, now = Date.now() } = {}) {
  const pill = PILL[body.state] ?? "";
  const reason = body.reason ? `<div class="muted-sm">${escapeHtml(String(body.reason))}</div>` : "";
  const total = Number(body.totalBricks) || 0;
  const pieces = total > 0
    ? `<div class="row"><span class="label">${tr("pieces safe")}</span><span class="value">${tr("{0} of {1}", escapeHtml(String(body.healthyBricks ?? 0)), escapeHtml(String(total)))}</span></div>`
    : "";
  const placed = Number.isFinite(body.lastPlacedAt) && body.lastPlacedAt > 0
    ? `<div class="row"><span class="label">${tr("last placed")}</span><span class="value">${escapeHtml(formatTime(body.lastPlacedAt))}</span></div>`
    : "";
  const by = restoreByLine(body.keepUntil, { now, formatTime });
  const stateCard = `
    <div class="card" data-pb-state="${escapeHtml(String(body.state))}">
      <div class="weight-600">${escapeHtml(stateTitle(body.state))} <span class="pill ${pill}">${escapeHtml(String(body.state))}</span></div>
      <div class="muted-sm">${escapeHtml(stateNote(body.state))}</div>
      ${reason}
      ${pieces}${placed}
      ${by ? `<div class="faint-sm">${escapeHtml(by)}</div>` : ""}
    </div>`;
  const rows = holderRows(body, { formatTime });
  const holdersCard = `
    <h3 class="mt-4">${tr("Servers holding your pieces")}</h3>
    ${rows.length === 0
      ? '<div class="card placeholder">None yet. Pieces are placed once your newest backup is ready and enough other servers can hold it.</div>'
      : rows.map((r) => `
        <div class="card" data-pb-holder>
          <div class="weight-600">${escapeHtml(r.label)}</div>
          <div class="faint-sm">${escapeHtml(r.line)}</div>
        </div>`).join("")}`;
  const host = hostingLines(body);
  const hostingCard = host.length === 0
    ? ""
    : `<h3 class="mt-4">${tr("Kept for other servers")}</h3><div class="card">${host.map((l) => `<div class="muted-sm">${escapeHtml(l)}</div>`).join("")}${body.hosting?.reliability != null ? `<div class="faint-sm">${tr("Reliability score: {0} of 100", escapeHtml(String(body.hosting.reliability)))}</div>` : ""}</div>`;
  return stateCard + holdersCard + hostingCard;
}

export async function renderPeerBackup() {
  const root = $("peer-backup-content");
  if (!root) return;
  placeholder(root, tr("Loading peer backup status…"));
  let body;
  try {
    body = await screensFetch(PEER_STATUS_PATH);
  } catch (e) {
    if (e instanceof ScreensError) {
      if (e.status === 404) return placeholder(root, tr("Peer backup isn't available on this server yet. Update the server to get it."));
      if (e.status === 503) return placeholder(root, tr("Peer backup isn't set up on this server yet."));
      root.innerHTML = `<div class="card"><p class="err-text">${escapeHtml(e.message)}</p></div>`;
      return;
    }
    throw e;
  }
  if (body?.v !== 2) {
    return placeholder(root, tr("This server runs an older peer backup. Update the server to see its new status here."));
  }
  root.innerHTML = renderStatus(body);
}

export function initPeerBackupView() {
  $("peer-backup-back")?.addEventListener("click", () => show("view-settings-tab"));
  $("peer-backup-refresh")?.addEventListener("click", () => {
    renderPeerBackup().catch((e) => { console.error(e); toast(humanError(e), "err"); });
  });
}

export async function enterPeerBackup() {
  show("view-peer-backup");
  await renderPeerBackup();
}
