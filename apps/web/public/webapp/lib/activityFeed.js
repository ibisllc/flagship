// The Activity tab's one list: what a server did (its own log, served at
// /api/screens/activity) merged with the account events from flagshipserver.com,
// newest first. The label / icon table here is the only one for box events;
// the three apps keep theirs in step (parity/features.json: activity-feed).
import { tr } from "./i18n.js";

/** Box event kinds → what the list says. Unknown kinds are shown humanized. */
export const BOX_EVENT_LABELS = Object.freeze({
  "server.update.applied": { label: tr("Server updated"), icon: "⬆️" },
  "server.update.rolled-back": { label: tr("Update rolled back"), icon: "⚠️" },
  "server.update.refused": { label: tr("Update refused"), icon: "⚠️" },
  "server.migration.taken-over": { label: tr("Took over from the old server"), icon: "🚚" },
  "server.decommission.released": { label: tr("Stopped serving"), icon: "⏏️" },
  "server.decommission.awaiting-handoff": { label: tr("Waiting to be wiped"), icon: "⏳" },
  "server.decommission.wiped": { label: tr("Old server wiped"), icon: "🧹" },
  "server.decommission.wipe-failed": { label: tr("Wipe failed"), icon: "⚠️" },
  "server.decommission.stood-down": { label: tr("Hand-off cancelled"), icon: "↩️" },
  "server.decommission.closed": { label: tr("Server retired"), icon: "⏏️" },
  "server.backup.started": { label: tr("Backup started"), icon: "💾" },
  "server.backup.created": { label: tr("Backup ready"), icon: "💾" },
  "server.backup.downloaded": { label: tr("Backup downloaded"), icon: "⬇️" },
  "server.backup.failed": { label: tr("Backup failed"), icon: "⚠️" },
  "server.restore.started": { label: tr("Import started"), icon: "📥" },
  "server.restore.finished": { label: tr("Import finished"), icon: "📥" },
  "server.restore.failed": { label: tr("Import failed"), icon: "⚠️" },
  "app.installed": { label: tr("App installed"), icon: "➕" },
  "app.updated": { label: tr("App redeployed"), icon: "🔁" },
  "app.removed": { label: tr("App removed"), icon: "➖" },
  "share.granted": { label: tr("Shared this server"), icon: "🤝" },
  "share.changed": { label: tr("Changed a share"), icon: "🤝" },
  "share.revoked": { label: tr("Ended a share"), icon: "🤝" },
  "share.left": { label: tr("A person left a share"), icon: "🤝" },
  "share.signed-in": { label: tr("A shared person signed in"), icon: "🤝" },
  "server.update": { label: tr("Server updated by a co-manager"), icon: "⬆️" },
  "server.debug-access.granted": { label: tr("Debug access turned on"), icon: "🔑" },
  "server.debug-access.renewed": { label: tr("Debug access renewed"), icon: "🔑" },
  "server.debug-access.expired": { label: tr("Debug access ended"), icon: "🔒" },
  "server.debug-access.revoked": { label: tr("Debug access turned off"), icon: "🔒" },
  "server.state.corrupt": { label: tr("This server found a damaged settings file and locked it down"), icon: "⚠️" },
});

function humanize(s) {
  const words = String(s ?? "").replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tr("Event");
}

/**
 * One box log entry → a row, or null when it isn't worth a row. The log also
 * records every owner write as a generic `post /api/screens/...` line; those
 * say nothing a person would read, so they are left out.
 */
export function boxEntryRow(e, serverName = "") {
  if (!e || typeof e.ts !== "number") return null;
  const key = e.kind || e.action;
  if (!e.kind && /^(get|post|put|patch|delete) \//i.test(String(e.action))) return null;
  const known = BOX_EVENT_LABELS[key];
  const label = known?.label ?? humanize(key);
  const title = e.actor?.kind === "share" ? tr("{0} by {1}", label, e.actor.label) : label;
  return {
    at: e.ts,
    source: "server",
    server: serverName,
    icon: known?.icon ?? (e.ok === false ? "⚠️" : "•"),
    title,
    detail: e.detail || (e.target && !e.detail ? String(e.target) : ""),
    ok: e.ok !== false,
  };
}

/** Merge rows from every source, newest first. */
export function mergeFeed({ boxes = [], audit = [], auditLabel, auditIcon, auditDetail, limit = 200 }) {
  const rows = [];
  for (const b of boxes) {
    for (const e of b.entries ?? []) {
      const r = boxEntryRow(e, b.serverName);
      if (r) rows.push(r);
    }
  }
  for (const a of audit) {
    rows.push({
      at: a.postedAt,
      source: "account",
      server: "",
      icon: auditIcon(a.eventKind),
      title: auditLabel(a.eventKind),
      detail: auditDetail(a) || "",
      ok: true,
    });
  }
  return rows.filter((r) => typeof r.at === "number").sort((x, y) => y.at - x.at).slice(0, limit);
}
