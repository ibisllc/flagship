import { describe, expect, it } from "vitest";
import {
  buildScreensHttp,
  type ScreensHttpDeps,
} from "../../src/screens/screensHttp.js";
import type { ServerMetricsProvider } from "../../src/screens/serverMetrics.js";
import type { ServerMetricsResponse } from "../../src/screens/types.js";
import type { HttpRequest } from "../../src/runtime.js";

const SERVER_FQDN = "home.alice.flagship.services";

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
}

function gate(token = "tok-good") {
  return {
    has(t: string) { return t === token; },
    check(r: HttpRequest) {
      return r.headers["x-flagship-session"] === token
        ? null
        : { status: 401, headers: {}, body: "{}" };
    },
  };
}

const COMMON: Omit<ScreensHttpDeps, "gate"> = {
  serverFqdn: SERVER_FQDN,
  username: "alice",
  daemonVersion: "0.0.1-test",
  startedAt: 1_000,
  now: () => 5_000,
};

function deterministicProvider(values: Partial<ServerMetricsResponse> = {}): ServerMetricsProvider {
  return {
    async snapshot() {
      const cpuHistory = Array.from({ length: 60 }, (_, i) => ({
        at: 5_000 - (59 - i) * 60_000,
        value: 23.5,
      }));
      const ioHistory = Array.from({ length: 60 }, (_, i) => ({
        at: 5_000 - (59 - i) * 60_000,
        read: 0,
        write: 0,
      }));
      return {
        collectedAt: 5_000,
        cpuPercent: 23.5,
        loadAvg1: 0.5, loadAvg5: 0.6, loadAvg15: 0.7,
        memUsedBytes: 4 * 1024 ** 3,
        memTotalBytes: 16 * 1024 ** 3,
        diskUsedBytes: 50 * 1024 ** 3,
        diskTotalBytes: 256 * 1024 ** 3,
        diskIOReadBytesPerSec: 0,
        diskIOWriteBytesPerSec: 0,
        netRxBytesPerSec: 0,
        netTxBytesPerSec: 0,
        cpuHistory,
        memHistory: cpuHistory,
        ioHistory,
        netHistory: ioHistory,
        ...values,
      };
    },
  };
}

describe("screens HTTP — P1.21 server-metrics", () => {
  it("returns the injected snapshot for any podId", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      serverMetrics: deterministicProvider(),
    });
    const r = await handle(req({
      path: "/api/screens/server-metrics/home",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as ServerMetricsResponse;
    expect(body.cpuPercent).toBe(23.5);
    expect(body.cpuHistory).toHaveLength(60);
    expect(body.memTotalBytes).toBeGreaterThan(body.memUsedBytes);
  });

  it("URL-decodes the podId param", async () => {
    let seenCount = 0;
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      serverMetrics: {
        async snapshot() {
          seenCount++;
          return (await deterministicProvider().snapshot());
        },
      },
    });
    const r = await handle(req({
      path: "/api/screens/server-metrics/home%2Falice",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(200);
    expect(seenCount).toBe(1);
  });

  it("returns 400 when podId is missing", async () => {
    const handle = buildScreensHttp({
      ...COMMON,
      gate: gate(),
      serverMetrics: deterministicProvider(),
    });
    const r = await handle(req({
      path: "/api/screens/server-metrics/",
      headers: { "x-flagship-session": "tok-good" },
    }));
    expect(r?.status).toBe(400);
  });

  it("falls back to the default provider when none is injected (smoke test, exits cleanly)", async () => {
    const handle = buildScreensHttp({ ...COMMON, gate: gate() });
    const r = await handle(req({
      path: "/api/screens/server-metrics/home",
      headers: { "x-flagship-session": "tok-good" },
    }));
    // Whether the test runs on Linux (/proc reader) or darwin (os.cpus
    // reader), the response shape is the same.
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body as string) as ServerMetricsResponse;
    expect(body.cpuHistory).toHaveLength(60);
    expect(body.memHistory).toHaveLength(60);
    expect(body.ioHistory).toHaveLength(60);
    expect(body.netHistory).toHaveLength(60);
    expect(body.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(body.cpuPercent).toBeLessThanOrEqual(100);
  }, 10_000);
});
