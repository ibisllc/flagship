import { describe, expect, it } from "vitest";
import { WorkerTail } from "../tools/live-e2e/lib/workerTail.js";
import { checkHealth, formatDns, formatMesh, meshView, relaysFromDirectory, formatHealth, formatServices, formatSlow, formatVoici, formatWorkers, parseArgs, probeWildcard, rowsFromAnalytics, type DnsLookup, type ServicesStats } from "./ops.js";

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

  it("asks public resolvers for a name nobody registered and flags NXDOMAIN, NODATA and a wrong address", async () => {
    const lookup: DnsLookup = async (server, name, type) => {
      if (server === "8.8.8.8" && name.startsWith("home.")) throw Object.assign(new Error("no"), { code: "ENODATA" });
      if (server === "9.9.9.9" && type === "A") return ["203.0.113.9"];
      if (type === "AAAA") return ["2a09:8280:1::110:d2b6:0"];
      return ["149.248.216.86"];
    };
    const probes = await probeWildcard("flagship.services", ["1.1.1.1", "8.8.8.8", "9.9.9.9"], lookup, () => "abc");
    expect(probes).toHaveLength(6);
    expect(probes[0]!.name).toBe("canary-abc.flagship.services");
    expect(probes[1]!.name).toBe("home.canary-abc.flagship.services");
    const { lines, hints } = formatDns(probes, "149.248.216.86", "2a09:8280:1::110:d2b6:0");
    expect(lines.filter((l) => l.includes("BAD"))).toHaveLength(3);
    expect(hints.join(" ")).toMatch(/8\.8\.8\.8 answered home\.canary-abc\.flagship\.services with ENODATA/);
    expect(hints.join(" ")).toMatch(/9\.9\.9\.9 answered .* with 203\.0\.113\.9/);
    const clean = formatDns(await probeWildcard("flagship.services", ["1.1.1.1"], async (_s, _n, t) => (t === "A" ? ["149.248.216.86"] : ["2a09:8280:1::110:d2b6:0"])), "149.248.216.86", "2a09:8280:1::110:d2b6:0");
    expect(clean.hints).toEqual([]);
  });

  it("reads the mesh from either relay's shapes and points at what is wrong", () => {
    expect(parseArgs(["mesh"]).command).toBe("mesh");
    const dir = { directory: { relays: [
      { relayId: "iad1", tunnelHost: "iad1.tunnel.flagship.services", relayKind: "full", region: "iad" },
      { relayId: "ams1", tunnelHost: "ams1.tunnel.flagship.services", relayKind: "full", region: "ams" },
      { relayId: "upc-fra1", tunnelHost: "upc-fra1.tunnel.flagship.services", relayKind: "full", region: "fra" },
    ] } };
    const relays = relaysFromDirectory(dir);
    expect(relays.map((r) => r.relayId)).toEqual(["iad1", "ams1", "upc-fra1"]);
    expect(relaysFromDirectory({ relays: [{ relayId: "a1", tunnelHost: "a1.tunnel.x" }, { relayId: 3 }] })).toHaveLength(1);
    // TS relay: health `mesh.reasons`, stats `feed` / `directory` / `store` / `homes` / `peers`.
    const ts = meshView(
      { ok: true, mesh: { ready: true, reasons: [] } },
      { mesh: { ready: true, reasons: [], draining: false, feed: { sequence: 40, headAgeMs: 3_000 }, directory: { version: 7 }, store: { boxItems: 12, phoneItems: 1 }, homes: { moves: 2 }, localBoxes: 5,
        peers: [{ relayId: "ams1", opens: 4, opensIn: 1, refusals: { "not-holder": 1 }, rejected: 0, lastHeardMs: 900 }] } },
    );
    expect(ts).toMatchObject({ ready: true, headAgeMs: 3_000, directoryVersion: 7, boxItems: 12, accountMoves: 2, localBoxes: 5 });
    expect(ts.peers[0]).toMatchObject({ relayId: "ams1", opens: 5, refusals: 1 });
    // Rust relay: health `mesh.readiness` (one word), stats `state` and per-peer counters.
    const rust = meshView(
      { ok: false, mesh: { relayId: "upc-fra1", ready: false, readiness: "stale" } },
      { mesh: { ready: false, readiness: "stale", state: { sequence: 38, headAgeMs: 75_000, directoryVersion: 6, boxItems: 11, phoneItems: 0, localBoxes: 2, accountMoves: 0, draining: false },
        peers: [{ relayId: "iad1", opens: 2, refusals: 0, rejected: 3, lastHeardMs: 2_000 }] } },
    );
    expect(rust).toMatchObject({ ready: false, reasons: ["stale"], headAgeMs: 75_000, directoryVersion: 6 });
    const { lines, hints } = formatMesh(
      [
        { relay: relays[0]!, health: { status: 200, body: { mesh: { ready: true, reasons: [] } } }, stats: { status: 200, body: { mesh: { feed: { sequence: 40, headAgeMs: 3_000 }, directory: { version: 7 }, store: { boxItems: 12, phoneItems: 1 }, peers: [{ relayId: "ams1", rejected: 0 }, { relayId: "upc-fra1", rejected: 0 }] } } } },
        { relay: relays[1]!, health: { error: "ECONNREFUSED" }, stats: null },
        { relay: relays[2]!, health: { status: 503, body: { mesh: { ready: false, readiness: "stale" } } }, stats: { status: 200, body: { mesh: { state: { sequence: 38, headAgeMs: 75_000, directoryVersion: 6 }, peers: [{ relayId: "iad1", rejected: 3 }] } } } },
      ],
      "test",
    );
    const text = lines.join("\n");
    expect(text).toContain("mesh-ready");
    expect(text).toContain("DOWN");
    expect(text).toContain("not ready: stale");
    expect(text).toContain("no bridge to: ams1");
    const h = hints.join(" ");
    expect(h).toMatch(/ams1 does not answer/);
    expect(h).toMatch(/upc-fra1 is not mesh-ready \(stale\)/);
    expect(h).toMatch(/75 s old/);
    expect(h).toMatch(/rejected 3 item\(s\) from iad1/);
    expect(h).toMatch(/different directory versions \(6, 7\)/);
    expect(formatMesh([], "x").hints.join(" ")).toMatch(/lists no relay/);
  });

  it("flags a voi.ci report older than 24 h and a missing or ending abuse key", () => {
    const now = Date.UTC(2026, 10, 2);
    const base = { now, enabled: true, openReports: 1, oldestOpenReportAt: now - 3600_000, reportsLast7Days: 2, bans: 0, bannedPseudonyms: 0, takedowns: 0, takedownsPurgePending: 0, enrollments: { ios: 1, android: 2, none: 3 }, newRecipientsToday: 4, abuseKey: { epoch: 2, notAfter: now + 60 * 86_400_000 }, purgeConfigured: true };
    expect(parseArgs(["voici"]).command).toBe("voici");
    const calm = formatVoici(base);
    expect(calm.hints).toEqual([]);
    expect(calm.lines.join("\n")).toContain("web/unattested 3");
    const late = formatVoici({ ...base, oldestOpenReportAt: now - 30 * 3600_000, abuseKey: null });
    expect(late.hints.join(" ")).toMatch(/30 h old/);
    expect(late.hints.join(" ")).toMatch(/no abuse key/);
    expect(formatVoici({ ...base, abuseKey: { epoch: 2, notAfter: now + 86_400_000 } }).hints.join(" ")).toMatch(/ends within 14 days/);
  });
});
