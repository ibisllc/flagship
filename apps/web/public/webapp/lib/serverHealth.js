// The server page's health summary, from the box's latest health report as
// relayed on /pods (`pod.health`, control-plane serverHealth.ts). Copy is
// shared word for word with iOS and Android.

import { escapeHtml } from "./util.js";

export const HEALTH_STALE_AFTER_MIN = 5;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** "3d 4h" / "2h 5m" / "59m". */
export function formatHealthUptime(seconds) {
  const s = Math.max(0, Math.floor(num(seconds)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * @param {any} h  the pod's `health` object, or undefined
 * @param {number} now  ms
 * @returns {{ ok: boolean, lines: string[] } | null}  null when there is no usable report
 */
export function serverHealthVerdict(h, now) {
  if (!h || typeof h !== "object" || typeof h.receivedAt !== "number") return null;
  const staleMin = Math.floor((now - h.receivedAt) / 60000);
  if (staleMin >= HEALTH_STALE_AFTER_MIN) {
    // The rest of the report is as old as this, so it isn't shown.
    return {
      ok: false,
      lines: [`No health report for ${staleMin} min. The server itself may be off or frozen.`],
    };
  }
  const memAvail = num(h.memAvailMB);
  const memTotal = num(h.memTotalMB);
  const disk = num(h.diskUsedPct);
  const daemon = h.daemon && typeof h.daemon === "object" ? h.daemon : {};
  const state = typeof daemon.state === "string" ? daemon.state : "active";
  const restarts = num(daemon.restarts);
  const lastExit = num(daemon.lastExit);
  const oomKills = num(h.oomKills);

  const issues = [];
  if (oomKills > 0) {
    issues.push(`Ran out of memory ${oomKills}× since it started (${memAvail} MB free of ${memTotal} MB now).`);
  }
  if (state !== "active") {
    issues.push(`The server software isn't running (${state}; restarted ${restarts}×, last exit code ${lastExit}).`);
  } else if (restarts >= 3) {
    issues.push(`The server software restarted ${restarts}× since it started (last exit code ${lastExit}).`);
  }
  if (h.tunnel === false) issues.push("Can't reach the Flagship relay.");
  if (disk >= 90) issues.push(`Disk is ${disk}% full.`);

  if (issues.length > 0) return { ok: false, lines: issues };
  return {
    ok: true,
    lines: [
      `Healthy · ${memAvail} MB free of ${memTotal} MB · disk ${disk}% · up ${formatHealthUptime(h.uptimeS)}`,
    ],
  };
}

/** The pod entry's `health` for `fqdn` from a `{ pods }` snapshot, or null. */
export function healthForServer(pods, fqdn) {
  if (!Array.isArray(pods) || typeof fqdn !== "string" || !fqdn) return null;
  const target = fqdn.toLowerCase();
  const pod = pods.find(
    (p) => typeof p?.serverDomain === "string" && p.serverDomain.toLowerCase() === target && !p.revokedAt,
  );
  return pod?.health ?? null;
}

/** The server page's health block: a muted line when healthy, a warning card
 *  under "Server health" otherwise, nothing without a report. */
export function renderHealthCard(verdict) {
  if (!verdict) return "";
  if (verdict.ok) {
    return `<p class="note small" id="server-health-ok">${escapeHtml(verdict.lines[0] ?? "")}</p>`;
  }
  return `
    <h2 class="mt-4">Server health</h2>
    <div class="card warning" id="server-health-issues">
      ${verdict.lines.map((l) => `<p class="note">${escapeHtml(l)}</p>`).join("")}
    </div>`;
}
