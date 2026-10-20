import { describe, expect, it } from "vitest";
import { WorkerTail } from "../tools/live-e2e/lib/workerTail.js";
import { checkHealth, formatHealth, formatServices, formatSlow, formatWorkers, parseArgs, rowsFromAnalytics, type ServicesStats } from "./ops.js";

describe("ops", () => {
  it("reads its arguments", () => {
    expect(parseArgs([]).command).toBe("all");
    expect(parseArgs(["workers", "--hours", "6", "--script", "flagship-com-gym"])).toMatchObject({ command: "workers", hours: 6, script: "flagship-com-gym" });
    expect(parseArgs(["slow", "--seconds", "30"]).seconds).toBe(30);
    expect(() => parseArgs(["frobnicate"])).toThrow();
    expect(() => parseArgs(["--hours", "500"])).toThrow();
    expect(() => parseArgs(["--seconds", "1"])).toThrow();
  });

  it("says which side is down", async () => {
    const up = (async () => new Response(JSON.stringify({ ok: true, uptimeMs: 600_000 }))) as unknown as typeof fetch;
    const bad = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const rs = [await checkHealth(".com", "u", up), await checkHealth(".services", "u", bad), await checkHealth("x", "u", dead)];
    expect(rs.map((r) => r.ok)).toEqual([true, false, false]);
    const text = formatHealth(rs).join("\n");
    expect(text).toContain("DOWN");
    expect(text).toContain("HTTP 502");
    expect(text).toContain("ECONNREFUSED");
  });

  it("shows missed redirections and points at them", () => {
    const stats: ServicesStats = {
      uptimeSec: 7200,
      tunnelsOnline: 12,
      router: { routed: 500, parked: 4, released: 1, holdTimeouts: 3, noBoxRegistered: 2, noUser: 0, bad: 1, recentMisses: [{ at: "2026-10-20T10:11:12.000Z", domain: "home.alice.flagship.services", kind: "hold-timeout" }] },
    };
    const { lines, hints } = formatServices(stats);
    expect(lines.join("\n")).toContain("home.alice.flagship.services");
    expect(lines.join("\n")).toContain("dropped 3");
    expect(hints.join(" ")).toMatch(/missed redirection/);
    expect(hints.join(" ")).toMatch(/Only 1 of 4/);
  });

  it("flags exceededCpu and slow successful requests from Cloudflare's numbers", () => {
    const rows = rowsFromAnalytics({
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { dimensions: { status: "success" }, sum: { requests: 1000, errors: 0, subrequests: 5000 }, quantiles: { cpuTimeP50: 2500, cpuTimeP99: 14000, wallTimeP99: 80000 } },
        { dimensions: { status: "exceededCpu" }, sum: { requests: 3, errors: 3, subrequests: 10 }, quantiles: { cpuTimeP50: 11000, cpuTimeP99: 12000, wallTimeP99: 90000 } },
      ] }] } },
    });
    const { lines, hints } = formatWorkers("flagship-com", 24, rows);
    expect(lines[0]).toContain("1003 request(s)");
    expect(hints.join(" ")).toMatch(/3 request\(s\) ended "exceededCpu"/);
    expect(hints.join(" ")).toMatch(/14\.0 ms of CPU/);
    expect(formatWorkers("s", 1, []).lines.join(" ")).toContain("nothing recorded");
    expect(rowsFromAnalytics(null)).toEqual([]);
  });

  it("ranks routes by CPU from a live tail and names the ones over 10 ms", () => {
    const tail = new WorkerTail({ cwd: ".", source: () => ({ stop() {} }) });
    void tail.start();
    const ev = (path: string, cpu: number) =>
      JSON.stringify({ outcome: "ok", eventTimestamp: Date.now(), cpuTime: cpu, wallTime: 20, event: { request: { url: `https://x${path}`, method: "GET" }, response: { status: 200 } } });
    tail.ingest(ev("/api/server/abcdef0123456789abcdef/migration", 114));
    tail.ingest(ev("/api/health", 1));
    const { lines, hints } = formatSlow(tail.summary(), 60);
    expect(lines.join("\n")).toContain("migration");
    expect(lines.join("\n").indexOf("migration")).toBeLessThan(lines.join("\n").indexOf("/api/health"));
    expect(hints.join(" ")).toMatch(/114\.0 ms of CPU/);
    expect(formatSlow(new WorkerTail({ cwd: "." }).summary(), 60).lines[0]).toContain("unavailable");
  });
});
