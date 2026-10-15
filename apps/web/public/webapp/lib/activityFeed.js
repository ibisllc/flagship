// The Activity tab's one list: what a server did (its own log, served at
// /api/screens/activity) merged with the account events from flagshipserver.com,
// newest first. The label / icon table here is the only one for box events;
// the three apps keep theirs in step (parity/features.json: activity-feed).

/** Box event kinds → what the list says. Unknown kinds are shown humanized. */
export const BOX_EVENT_LABELS = Object.freeze({
  "server.update.applied": { label: "Server updated", icon: "⬆️" },
  "server.update.rolled-back": { label: "Update rolled back", icon: "⚠️" },
  "server.update.refused": { label: "Update refused", icon: "⚠️" },
  "server.migration.taken-over": { label: "Took over from the old server", icon: "🚚" },
  "server.decommission.released": { label: "Stopped serving", icon: "⏏️" },
  "server.decommission.awaiting-handoff": { label: "Waiting to be wiped", icon: "⏳" },
  "server.decommission.wiped": { label: "Old server wiped", icon: "🧹" },
  "server.decommission.wipe-failed": { label: "Wipe failed", icon: "⚠️" },
  "server.decommission.stood-down": { label: "Hand-off cancelled", icon: "↩️" },
  "server.decommission.closed": { label: "Server retired", icon: "⏏️" },
  "server.backup.started": { label: "Backup started", icon: "💾" },
  "server.backup.created": { label: "Backup ready", icon: "💾" },
  "server.backup.downloaded": { label: "Backup downloaded", icon: "⬇️" },
  "server.backup.failed": { label: "Backup failed", icon: "⚠️" },
  "server.restore.started": { label: "Import started", icon: "📥" },
  "server.restore.finished": { label: "Import finished", icon: "📥" },
  "server.restore.failed": { label: "Import failed", icon: "⚠️" },
  "app.installed": { label: "App installed", icon: "➕" },
  "app.updated": { label: "App redeployed", icon: "🔁" },
  "app.removed": { label: "App removed", icon: "➖" },
  "share.granted": { label: "Shared this server", icon: "🤝" },
  "share.changed": { label: "Changed a share", icon: "🤝" },
  "share.revoked": { label: "Ended a share", icon: "🤝" },
  "share.left": { label: "A person left a share", icon: "🤝" },
  "share.signed-in": { label: "A shared person signed in", icon: "🤝" },
  "server.update": { label: "Server updated by a co-manager", icon: "⬆️" },
});

function humanize(s) {
  const words = String(s ?? "").replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Event";
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
  const by = e.actor?.kind === "share" ? ` by ${e.actor.label}` : "";
  return {
    at: e.ts,
    source: "server",
    server: serverName,
    icon: known?.icon ?? "•",
    title: `${known?.label ?? humanize(key)}${by}`,
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
