import { describe, expect, it } from "vitest";
import { WorkerTail, parseTailLine, routeKey } from "../lib/workerTail.js";

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
const ev = (url: string, outcome = "ok", extra: Record<string, unknown> = {}) =>
  line({ outcome, scriptName: "flagship-com-gym", eventTimestamp: 1_000, event: { request: { url, method: "GET" }, response: { status: 200 } }, exceptions: [], logs: [], ...extra });

describe("routeKey", () => {
  it("groups the same route for different accounts and ids", () => {
    expect(routeKey("/api/users/alice/pods")).toBe("/api/users/:x/pods");
    expect(routeKey("/api/users/bob/pods")).toBe("/api/users/:x/pods");
    expect(routeKey("/api/users/alice/apps/aliases")).toBe("/api/users/:x/apps/aliases");
    expect(routeKey("/api/accounts/alice/directory")).toBe("/api/accounts/:x/directory");
    expect(routeKey("/api/health")).toBe("/api/health");
    expect(routeKey("/api/order/0123456789abcdef0123456789abcdef/health")).toBe("/api/order/:id/health");
  });
});

describe("parseTailLine", () => {
  it("reads a request event", () => {
    const e = parseTailLine(ev("https://gym.flagshipserver.com/api/users/a/pods?x=1", "exceededCpu", { cpuTime: 11, wallTime: 40 }));
    expect(e).toMatchObject({ outcome: "exceededCpu", method: "GET", route: "/api/users/:x/pods", status: 200, cpuMs: 11, wallMs: 40 });
  });
  it("reads a scheduled event and keeps exceptions", () => {
    const e = parseTailLine(line({ outcome: "exception", eventTimestamp: 5, event: { cron: "0 * * * *", scheduledTime: 5 }, exceptions: [{ name: "Error", message: "Worker exceeded CPU time limit (1102)" }] }));
    expect(e).toMatchObject({ method: "CRON", route: "0 * * * *" });
    expect(e!.exceptions[0]).toContain("1102");
  });
  it("ignores wrangler's own chatter and broken lines", () => {
    expect(parseTailLine("Successfully created tail, expires at 2026-10-19")).toBeNull();
    expect(parseTailLine("{not json")).toBeNull();
    expect(parseTailLine(line({ nothing: true }))).toBeNull();
  });
});

describe("WorkerTail reads wrangler's pretty-printed events", () => {
  const pretty = (o: unknown) => JSON.stringify(o, null, 4).split("\n");
  it("assembles an event printed over many lines, with its CPU time", async () => {
    const lines = [
      "Successfully created tail, expires at 2026-10-19T04:00:00Z",
      ...pretty({ wallTime: 3, cpuTime: 9, outcome: "ok", eventTimestamp: 7, exceptions: [], event: { request: { url: "https://x/api/users/a/pods", method: "GET" }, response: { status: 200 } } }),
      ...pretty({ wallTime: 30, cpuTime: 11, outcome: "exceededCpu", eventTimestamp: 8, exceptions: [], event: { request: { url: "https://x/api/users/b/stream", method: "GET" }, response: { status: 503 } } }),
    ];
    const t = new WorkerTail({ cwd: ".", source: (on) => { for (const l of lines) on(l); return { stop() {} }; } });
    await t.start();
    const s = t.summary();
    expect(s.events).toBe(2);
    expect(s.exceeded.map((e) => e.route)).toEqual(["/api/users/:x/stream"]);
    expect(s.nearBudget.map((r) => `${r.route} ${r.cpuMsMax}`)).toEqual(["/api/users/:x/stream 11", "/api/users/:x/pods 9"]);
  });
});

describe("WorkerTail per-route CPU percentiles", () => {
  it("reports the median and p95 of cpuTime per route", async () => {
    const lines = [2, 3, 4, 5, 90].map((cpu) => JSON.stringify({ outcome: "ok", cpuTime: cpu, eventTimestamp: 1, event: { request: { url: "https://x/api/users/a/pods", method: "GET" }, response: { status: 200 } } }));
    const t = new WorkerTail({ cwd: ".", source: (on) => { for (const l of lines) on(l); return { stop() {} }; } });
    await t.start();
    const r = t.summary().routes[0]!;
    expect(r).toMatchObject({ n: 5, cpuMsMax: 90, cpuMsP50: 4, cpuMsP95: 90 });
  });
});

describe("WorkerTail", () => {
  const feed = (lines: string[]) =>
    new WorkerTail({
      cwd: ".",
      source: (onLine) => {
        for (const l of lines) onLine(l);
        return { stop() {} };
      },
    });

  it("is clean when every outcome is ok", async () => {
    const t = feed([ev("https://x/api/health"), ev("https://x/api/users/a/pods")]);
    await t.start();
    const s = t.summary();
    expect(s.available).toBe(true);
    expect(s).toMatchObject({ events: 2, outcomes: { ok: 2 }, exceeded: [], error1102: 0 });
  });

  it("reports exceededCpu, exceededResources and a 1102 exception", async () => {
    const t = feed([
      ev("https://x/api/users/a/stream", "exceededCpu"),
      ev("https://x/api/daemon-status", "exceededResources"),
      line({ outcome: "exception", eventTimestamp: 9, event: { request: { url: "https://x/api/users/a/audit", method: "GET" } }, exceptions: [{ name: "Error", message: "Worker exceeded CPU time limit." }] }),
      ev("https://x/api/health"),
    ]);
    await t.start();
    const s = t.summary();
    expect(s.exceeded.map((e) => e.route)).toEqual(["/api/users/:x/stream", "/api/daemon-status", "/api/users/:x/audit"]);
    expect(s.error1102).toBe(1);
  });

  it("says which requests reached the Worker, by a marker in the URL", async () => {
    const t = feed([ev("https://x/app.js?fp=abc123"), ev("https://x/api/health")]);
    await t.start();
    expect(t.seen("fp=abc123", 0)).toHaveLength(1);
    expect(t.seen("fp=zzz", 0)).toHaveLength(0);
    expect(t.seen("fp=abc123", 2_000)).toHaveLength(0);
  });

  it("reports itself unavailable when it never started", () => {
    const t = new WorkerTail({ cwd: "." });
    expect(t.summary()).toMatchObject({ available: false });
  });
});
