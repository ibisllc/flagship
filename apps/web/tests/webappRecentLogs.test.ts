// The app page's "Recent logs": app-detail's `recentLogs`, shown only when the
// box sends lines, as on iOS (ServiceDetailScreen logsAndBackup) and Android.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = () =>
  import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", "views", "service-detail.js")).href);
const VIEW = readFileSync(resolve(__dirname, "..", "public", "webapp", "views", "service-detail.js"), "utf8");

describe("app page — Recent logs", () => {
  it("shows each line, escaped, in one monospace block", async () => {
    const { renderRecentLogs } = await load();
    const html: string = renderRecentLogs(["listening on :8080", "GET /<script> → 200"]);
    expect(html).toContain("Recent logs");
    expect(html).toContain('id="sd-recent-logs"');
    expect(html).toContain("listening on :8080\nGET /&lt;script&gt; → 200");
    expect(html).not.toContain("<script>");
  });

  it("is absent when the box sends no lines (or none at all)", async () => {
    const { renderRecentLogs } = await load();
    expect(renderRecentLogs([])).toBe("");
    expect(renderRecentLogs(undefined)).toBe("");
    expect(renderRecentLogs([42, null])).toBe("");
  });

  it("sits on the app page before Backup", () => {
    const at = VIEW.indexOf("${renderRecentLogs(body.recentLogs)}");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(VIEW.indexOf('<h2 class="mt-4">Backup</h2>'));
  });
});
