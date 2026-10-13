// The server page's Monitoring pane: one card, one expandable row per item,
// in the same order and with the same labels as iOS and Android.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const webapp = resolve(__dirname, "..", "public", "webapp");

async function load() {
  return import(pathToFileURL(resolve(webapp, "lib", "serverMonitoring.js")).href);
}

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const metrics = {
  collectedAt: NOW,
  cpuPercent: 12.4,
  loadAvg1: 0.12,
  loadAvg5: 0.3,
  loadAvg15: 0.25,
  memUsedBytes: 1.5 * 1024 ** 3,
  memTotalBytes: 4 * 1024 ** 3,
  diskUsedBytes: 41 * 1024 ** 3,
  diskTotalBytes: 100 * 1024 ** 3,
  diskIOReadBytesPerSec: 2048,
  diskIOWriteBytesPerSec: 0,
  netRxBytesPerSec: 12 * 1024,
  netTxBytesPerSec: 3 * 1024,
  cpuHistory: [{ at: 1, value: 10 }, { at: 2, value: 20 }],
  memHistory: [{ at: 1, value: 1e9 }, { at: 2, value: 1.2e9 }],
  ioHistory: [],
  netHistory: [{ at: 1, read: 1, write: 2 }, { at: 2, read: 3, write: 1 }],
};

describe("Monitoring pane", () => {
  it("lists Health, CPU, Memory, Disk, Network, Certificate in that order", async () => {
    const { MONITOR_ROWS, renderMonitoringSection } = await load();
    expect(MONITOR_ROWS.map((r: { label: string }) => r.label)).toEqual([
      "Health", "CPU", "Memory", "Disk", "Network", "Certificate",
    ]);
    const html: string = renderMonitoringSection({ detail: { certNotAfter: NOW + 30 * DAY }, now: NOW });
    const keys = [...html.matchAll(/data-monitor="([a-z]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["health", "cpu", "memory", "disk", "network", "certificate"]);
    expect(html.match(/<div class="card monitor-pane"/g)).toHaveLength(1);
    expect(html).toContain(">Monitoring</h2>");
  });

  it("makes every row a collapsed button that controls its detail region", async () => {
    const { renderMonitoringSection } = await load();
    const html: string = renderMonitoringSection({ detail: {}, now: NOW });
    const buttons = [...html.matchAll(/<button type="button" class="monitor-row"[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect(b).toContain('aria-expanded="false"');
      const controls = /aria-controls="([^"]+)"/.exec(b)?.[1];
      expect(html).toContain(`id="${controls}" role="region"`);
    }
    expect(html.match(/role="region"[^>]*hidden>/g)).toHaveLength(6);
  });

  it("shows only Health, hidden until a report arrives, when the box didn't answer", async () => {
    const { renderMonitoringSection } = await load();
    const html: string = renderMonitoringSection();
    const keys = [...html.matchAll(/data-monitor="([a-z]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["health"]);
    expect(html).toContain('class="monitor-section hidden"');
  });

  it("gives each metric the same short value as iOS", async () => {
    const { metricRows } = await load();
    const gb = 1024 ** 3;
    const v = metricRows({
      ...metrics,
      cpuPercent: 23.4,
      memUsedBytes: 4 * gb, memTotalBytes: 16 * gb,
      diskUsedBytes: 50 * gb, diskTotalBytes: 100 * gb,
      netRxBytesPerSec: 2048, netTxBytesPerSec: 3 * 1024 * 1024,
    });
    expect(v.cpu.value).toBe("23%");
    expect(v.memory.value).toBe("4.0 GB of 16.0 GB");
    expect(v.disk).toEqual({ value: "50% used", tone: "" });
    expect(v.network.value).toBe("↓ 2 KB/s  ↑ 3.0 MB/s");
    const tone = (used: number) => metricRows({ ...metrics, diskUsedBytes: used * gb, diskTotalBytes: 100 * gb }).disk.tone;
    expect([tone(50), tone(80), tone(95)]).toEqual(["", "warn", "err"]);
    expect(metricRows({ ...metrics, diskTotalBytes: 0 }).disk.value).toBe("0% used");
  });

  it("keeps each metric's detail behind its row", async () => {
    const { metricsDetailHtml } = await load();
    const d = metricsDetailHtml(metrics);
    expect(d.cpu).toContain("Load 0.12 · 0.30 · 0.25");
    expect(d.cpu).toContain("<svg");
    expect(d.memory).toContain("38% in use");
    expect(d.disk).toContain("monitor-ring");
    expect(d.disk).toContain("59.0 GB");
    expect(d.disk).toContain("Read");
    expect(d.disk).toContain("2 KB/s");
    expect(d.network).toContain("In");
    expect(d.network).toContain("12 KB/s");
    expect(d.network).toContain("<svg");
  });

  it("says until when the certificate is valid, and lists what it covers", async () => {
    const { certRow } = await load();
    const ok = certRow({ certNotAfter: NOW + 42 * DAY, certNotBefore: NOW - 48 * DAY, certSans: ["a.example", "<b>"] }, NOW);
    expect(ok.value).toMatch(/^Valid until /);
    expect(ok.detail).toContain("Renews");
    expect(ok.detail).toContain("Issued");
    expect(ok.detail).toContain("Names covered");
    expect(ok.detail).toContain("<li>a.example</li>");
    expect(ok.detail).toContain("&lt;b&gt;");
    expect(certRow({ certNotAfter: NOW - 1 }, NOW)).toMatchObject({ value: "Expired", tone: "err" });
    expect(certRow({}, NOW).value).toBe("Provisioning");
  });

  it("reads Healthy, Needs attention or No report, with the report lines as detail", async () => {
    const { healthRow } = await load();
    const report = (over: Record<string, unknown> = {}) => ({
      receivedAt: NOW - 30_000, uptimeS: 3600, memTotalMB: 4096, memAvailMB: 2048, diskUsedPct: 40,
      daemon: { state: "active", restarts: 0, lastExit: 0 }, tunnel: true, oomKills: 0, ...over,
    });
    expect(healthRow(null, NOW)).toBeNull();
    const ok = healthRow(report(), NOW);
    expect(ok).toMatchObject({ value: "Healthy", tone: "", ok: true });
    expect(ok.detail).toContain("disk 40%");
    const bad = healthRow(report({ tunnel: false }), NOW);
    expect(bad).toMatchObject({ value: "Needs attention", tone: "warn", ok: false });
    expect(bad.detail).toContain("Can't reach the Flagship relay.");
    expect(healthRow(report({ receivedAt: NOW - 10 * 60_000 }), NOW)).toMatchObject({ value: "No report", ok: false });
  });
});

describe("server page wiring", () => {
  const src = readFileSync(resolve(webapp, "views", "server-detail.js"), "utf8");

  it("folds the old Cert, Live metrics and Server health blocks into the pane", () => {
    expect(src).not.toContain('<h2 class="mt-4">Cert</h2>');
    expect(src).not.toContain("Live metrics");
    expect(src).not.toContain("renderHealthCard");
    expect(src).toContain("renderMonitoringSection({ detail: body })");
    expect(readFileSync(resolve(webapp, "index.html"), "utf8")).not.toContain('id="server-health"');
  });

  it("the unreachable page keeps the Health row", async () => {
    const { renderUnreachableDetail } = await import(pathToFileURL(resolve(webapp, "views", "server-detail.js")).href);
    const html: string = renderUnreachableDetail({ serverFqdn: "home.a.flagship.services", username: "a", revoked: false, message: "" });
    expect(html).toContain('data-monitor="health"');
    expect(html.indexOf('data-monitor="health"')).toBeLessThan(html.indexOf("Danger zone"));
  });
});
