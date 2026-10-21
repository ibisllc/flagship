// The server page's Monitoring pane: one grouped card, one row per item
// (icon + name, value), each a button that expands in place to show that
// item's detail. Row order, labels and values match iOS (MonitoringPane.swift)
// and Android: Health, CPU, Memory, Disk, Network, Certificate.

import { escapeHtml } from "./util.js";
import { formatWhen } from "./dateFormat.js";
import { serverHealthVerdict, HEALTH_STALE_AFTER_MIN } from "./serverHealth.js";
import {
  alertTriangleIcon,
  arrowUpDownIcon,
  chevronDownIcon,
  cpuIcon,
  hardDriveIcon,
  heartPulseIcon,
  lockIcon,
  memoryStickIcon,
} from "./icons.js";

import { tr } from "./i18n.js";
export const MONITOR_ROWS = [
  { key: "health", label: tr("Health"), icon: heartPulseIcon },
  { key: "cpu", label: "CPU", icon: cpuIcon },
  { key: "memory", label: tr("Memory"), icon: memoryStickIcon },
  { key: "disk", label: tr("Disk"), icon: hardDriveIcon },
  { key: "network", label: tr("Network"), icon: arrowUpDownIcon },
  { key: "certificate", label: tr("Certificate"), icon: lockIcon },
];

export const METRIC_KEYS = ["cpu", "memory", "disk", "network"];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** "4.0 GB" / "512 MB" / "3 KB" / "12 B", as iOS formats them. */
export function formatBytes(n) {
  const b = num(n);
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (b >= gb) return `${(b / gb).toFixed(1)} GB`;
  if (b >= mb) return `${(b / mb).toFixed(0)} MB`;
  if (b >= kb) return `${(b / kb).toFixed(0)} KB`;
  return `${Math.round(b)} B`;
}

/** "3.0 MB/s" / "129 KB/s" / "12 B/s", as iOS formats them. */
export function formatRate(bps) {
  const b = num(bps);
  const kb = 1024;
  const mb = kb * 1024;
  if (b >= mb) return `${(b / mb).toFixed(1)} MB/s`;
  if (b >= kb) return `${(b / kb).toFixed(0)} KB/s`;
  return `${b.toFixed(0)} B/s`;
}

/** used / total as a fraction in [0, 1]; 0 when total is empty. */
export function fraction(used, total) {
  if (num(total) <= 0) return 0;
  return Math.min(Math.max(num(used) / num(total), 0), 1);
}

const pct = (f) => `${(f * 100).toFixed(0)}%`;

export function diskTone(f) {
  if (f > 0.9) return "err";
  if (f > 0.75) return "warn";
  return "";
}

/** Each metric row's collapsed value and tone. */
export function metricRows(m) {
  const disk = fraction(m.diskUsedBytes, m.diskTotalBytes);
  return {
    cpu: { value: `${num(m.cpuPercent).toFixed(0)}%`, tone: "" },
    memory: { value: tr("{0} of {1}", formatBytes(m.memUsedBytes), formatBytes(m.memTotalBytes)), tone: "" },
    disk: { value: tr("{0} used", pct(disk)), tone: diskTone(disk) },
    network: { value: `↓ ${formatRate(m.netRxBytesPerSec)}  ↑ ${formatRate(m.netTxBytesPerSec)}`, tone: "" },
  };
}

/** A tiny line chart (no axes) of `series`, scaled to `max` or the data's
 *  own peak. Decorative: the numbers beside it carry the meaning. */
export function sparkline(series, { max, label } = {}) {
  const lines = series.filter((s) => Array.isArray(s.values) && s.values.length > 1);
  if (lines.length === 0) return "";
  const peak = max ?? Math.max(1, ...lines.flatMap((s) => s.values.map(num)));
  const polylines = lines.map((s) => {
    const n = s.values.length;
    const pts = s.values
      .map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(32 - (Math.min(num(v), peak) / peak) * 30 - 1).toFixed(2)}`)
      .join(" ");
    return `<polyline class="monitor-spark-${escapeHtml(s.tone)}" points="${pts}"/>`;
  });
  return `<svg class="monitor-spark" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label ?? "")}">${polylines.join("")}</svg>`;
}

function facts(pairs) {
  return `<dl class="monitor-facts">${pairs
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("")}</dl>`;
}

function rates(pairs) {
  return `<div class="monitor-rates">${pairs
    .map(([k, bps, tone]) => `<div><span class="monitor-dot monitor-dot-${tone}" aria-hidden="true"></span><span class="monitor-rate-label">${escapeHtml(k)}</span><strong>${escapeHtml(formatRate(bps))}</strong></div>`)
    .join("")}</div>`;
}

function ring(f) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return `<svg class="monitor-ring monitor-ring-${diskTone(f) || "accent"}" viewBox="0 0 72 72" aria-hidden="true">
    <circle cx="36" cy="36" r="${r}" class="monitor-ring-track"/>
    <circle cx="36" cy="36" r="${r}" class="monitor-ring-fill" stroke-dasharray="${(f * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 36 36)"/>
    <text x="36" y="36" text-anchor="middle" dominant-baseline="central">${pct(f)}</text>
  </svg>`;
}

/** The expanded detail of each metric row. */
export function metricsDetailHtml(m) {
  const mem = fraction(m.memUsedBytes, m.memTotalBytes);
  const disk = fraction(m.diskUsedBytes, m.diskTotalBytes);
  const memTotal = num(m.memTotalBytes);
  return {
    cpu:
      sparkline([{ values: (m.cpuHistory ?? []).map((s) => s.value), tone: "accent" }], { max: 100, label: tr("CPU over the last hour") }) +
      `<p class="note small">${tr("Load {0} · {1} · {2}", num(m.loadAvg1).toFixed(2), num(m.loadAvg5).toFixed(2), num(m.loadAvg15).toFixed(2))}</p>`,
    memory:
      sparkline([{ values: (m.memHistory ?? []).map((s) => s.value), tone: "ok" }], { max: memTotal || undefined, label: tr("Memory over the last hour") }) +
      `<p class="note small">${tr("{0} in use", pct(mem))}</p>`,
    disk:
      `<div class="monitor-disk">${ring(disk)}${facts([
        [tr("Used"), formatBytes(m.diskUsedBytes)],
        [tr("Free"), formatBytes(Math.max(0, num(m.diskTotalBytes) - num(m.diskUsedBytes)))],
        [tr("Total"), formatBytes(m.diskTotalBytes)],
      ])}</div>` +
      rates([[tr("Read"), m.diskIOReadBytesPerSec, "accent"], [tr("Write"), m.diskIOWriteBytesPerSec, "warn"]]),
    network:
      rates([["In", m.netRxBytesPerSec, "ok"], ["Out", m.netTxBytesPerSec, "err"]]) +
      sparkline([
        { values: (m.netHistory ?? []).map((s) => s.read), tone: "ok" },
        { values: (m.netHistory ?? []).map((s) => s.write), tone: "err" },
      ], { label: tr("Network traffic over the last hour") }),
  };
}

/** Certificate row: collapsed value, tone and expanded detail. */
export function certRow({ certNotAfter, certNotBefore, certIssuer, certSans } = {}, now = Date.now()) {
  if (typeof certNotAfter !== "number") {
    return { value: tr("Provisioning"), tone: "", detail: `<p class="note">${tr("No certificate yet. The server is getting one.")}</p>` };
  }
  const expired = certNotAfter <= now;
  const pairs = [[tr("Renews"), formatWhen(certNotAfter, now)]];
  if (typeof certNotBefore === "number") pairs.push([tr("Issued"), formatWhen(certNotBefore, now)]);
  if (typeof certIssuer === "string" && certIssuer) pairs.push([tr("Issuer"), certIssuer]);
  const sans = Array.isArray(certSans) ? certSans : [];
  const sanList = sans.length
    ? `<p class="note small mt-2">${tr("Names covered")}</p><ul class="monitor-sans">${sans.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
    : "";
  return {
    value: expired ? tr("Expired") : tr("Valid until {0}", formatWhen(certNotAfter, now)),
    tone: expired ? "err" : "",
    detail: facts(pairs) + sanList,
  };
}

/** Health row from the pod's health report, or null when there is none. */
export function healthRow(h, now = Date.now()) {
  const verdict = serverHealthVerdict(h, now);
  if (!verdict) return null;
  const stale = Math.floor((now - h.receivedAt) / 60000) >= HEALTH_STALE_AFTER_MIN;
  return {
    value: verdict.ok ? tr("Healthy") : stale ? tr("No report") : tr("Needs attention"),
    tone: verdict.ok ? "" : "warn",
    ok: verdict.ok,
    icon: verdict.ok ? heartPulseIcon : alertTriangleIcon,
    detail: verdict.lines.map((l) => `<p class="note">${escapeHtml(l)}</p>`).join(""),
  };
}

function rowHtml({ key, label, icon }, { value = "…", tone = "", detail = "", hidden = false } = {}) {
  return `
    <div class="monitor-item${hidden ? " hidden" : ""}" data-monitor="${key}" data-tone="${tone}">
      <button type="button" class="monitor-row" id="monitor-${key}-btn" aria-expanded="false" aria-controls="monitor-${key}-detail">
        <span class="monitor-name"><span class="icon">${icon}</span><span>${escapeHtml(label)}</span></span>
        <span class="monitor-value${tone ? ` tone-${tone}` : ""}">${escapeHtml(value)}</span>
        <span class="monitor-chevron" aria-hidden="true">${chevronDownIcon}</span>
      </button>
      <div class="monitor-detail" id="monitor-${key}-detail" role="region" aria-labelledby="monitor-${key}-btn" hidden>${detail}</div>
    </div>`;
}

/**
 * The whole Monitoring section. With `detail` (the box answered), every row;
 * without it, only Health, which comes from `.com`. Health starts hidden and
 * `paintMonitorRow` shows it once a report exists.
 */
export function renderMonitoringSection({ detail = null, now = Date.now() } = {}) {
  const rows = MONITOR_ROWS.filter((r) => detail || r.key === "health").map((r) => {
    if (r.key === "certificate") return rowHtml(r, certRow(detail, now));
    if (r.key === "health") return rowHtml(r, { value: "", hidden: true });
    return rowHtml(r, { detail: `<p class="note">${tr("Loading…")}</p>` });
  });
  return `
      <section class="monitor-section${detail ? "" : " hidden"}" id="monitor-section" aria-labelledby="monitor-heading">
        <h2 class="mt-4" id="monitor-heading">${tr("Monitoring")}</h2>
        <div class="card monitor-pane" id="monitor-pane">${rows.join("")}</div>
      </section>`;
}

function setExpanded(item, open) {
  const btn = item.querySelector(".monitor-row");
  btn.setAttribute("aria-expanded", String(open));
  item.querySelector(".monitor-detail").hidden = !open;
}

/** Update one row's value + detail in place, keeping its expanded state.
 *  `row` null hides it; the section hides while no row is visible. A Health
 *  row with a problem opens the first time it shows. */
export function paintMonitorRow(root, key, row) {
  const item = root?.querySelector?.(`[data-monitor="${key}"]`);
  if (!item) return;
  item.classList.toggle("hidden", !row);
  if (row) {
    const value = item.querySelector(".monitor-value");
    value.textContent = row.value;
    value.className = `monitor-value${row.tone ? ` tone-${row.tone}` : ""}`;
    item.dataset.tone = row.tone ?? "";
    if (row.detail !== undefined) item.querySelector(".monitor-detail").innerHTML = row.detail;
    if (row.icon) item.querySelector(".monitor-name .icon").innerHTML = row.icon;
    if (row.ok === false && item.dataset.autoOpened !== "1") {
      item.dataset.autoOpened = "1";
      setExpanded(item, true);
    }
  }
  const section = item.closest(".monitor-section");
  if (section) section.classList.toggle("hidden", !section.querySelector(".monitor-item:not(.hidden)"));
}

/** One click handler for the pane: a row's button toggles its detail. */
export function wireMonitoringPane(root) {
  const pane = root?.querySelector?.("#monitor-pane");
  if (!pane || pane.dataset.wired === "1") return;
  pane.dataset.wired = "1";
  pane.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.(".monitor-row");
    if (!btn || !pane.contains(btn)) return;
    const item = btn.closest(".monitor-item");
    if (item) setExpanded(item, btn.getAttribute("aria-expanded") !== "true");
  });
}
