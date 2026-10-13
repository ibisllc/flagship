// Box health on the server page: the verdict copy is shared word for word with
// iOS and Android (ServerHealthVerdictTest.kt), so these strings are pinned.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function load() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "serverHealth.js");
  return import(pathToFileURL(path).href);
}

const NOW = 1_800_000_000_000;

function healthy(over: Record<string, unknown> = {}, daemon: Record<string, unknown> = {}) {
  return {
    v: 1,
    domain: "home.alice.flagship.services",
    at: NOW - 30_000,
    uptimeS: 3 * 86_400 + 4 * 3_600 + 120,
    memTotalMB: 3900,
    memAvailMB: 2100,
    swapUsedMB: 0,
    oomKills: 0,
    daemon: { state: "active", restarts: 0, lastExit: 0, ...daemon },
    tunnel: true,
    diskUsedPct: 41,
    receivedAt: NOW - 30_000,
    ...over,
  };
}

describe("serverHealthVerdict", () => {
  it("shows nothing without a report", async () => {
    const { serverHealthVerdict } = await load();
    expect(serverHealthVerdict(undefined, NOW)).toBeNull();
    expect(serverHealthVerdict({}, NOW)).toBeNull();
  });

  it("a stale report hides everything else", async () => {
    const { serverHealthVerdict } = await load();
    const v = serverHealthVerdict(
      healthy({ receivedAt: NOW - 7 * 60_000 - 5_000, oomKills: 2, tunnel: false }),
      NOW,
    );
    expect(v).toEqual({
      ok: false,
      lines: ["No health report for 7 min. The server itself may be off or frozen."],
    });
    expect(serverHealthVerdict(healthy({ receivedAt: NOW - 299_999 }), NOW).ok).toBe(true);
  });

  it("out of memory plus repeated restarts", async () => {
    const { serverHealthVerdict } = await load();
    expect(serverHealthVerdict(healthy({ oomKills: 3 }, { restarts: 4, lastExit: 137 }), NOW).lines).toEqual([
      "Ran out of memory 3× since it started (2100 MB free of 3900 MB now).",
      "The server software restarted 4× since it started (last exit code 137).",
    ]);
    expect(serverHealthVerdict(healthy({}, { restarts: 2 }), NOW).ok).toBe(true);
  });

  it("a stopped daemon takes precedence over the restart count", async () => {
    const { serverHealthVerdict } = await load();
    expect(serverHealthVerdict(healthy({}, { state: "failed", restarts: 5, lastExit: 1 }), NOW).lines).toEqual([
      "The server software isn't running (failed; restarted 5×, last exit code 1).",
    ]);
  });

  it("relay down and disk full", async () => {
    const { serverHealthVerdict } = await load();
    expect(serverHealthVerdict(healthy({ tunnel: false }), NOW).lines).toEqual(["Can't reach the Flagship relay."]);
    expect(serverHealthVerdict(healthy({ diskUsedPct: 90 }), NOW).lines).toEqual(["Disk is 90% full."]);
    expect(serverHealthVerdict(healthy({ diskUsedPct: 89 }), NOW).ok).toBe(true);
  });

  it("healthy line and uptime formats", async () => {
    const { serverHealthVerdict, formatHealthUptime } = await load();
    expect(serverHealthVerdict(healthy(), NOW)).toEqual({
      ok: true,
      lines: ["Healthy · 2100 MB free of 3900 MB · disk 41% · up 3d 4h"],
    });
    expect(formatHealthUptime(86_400)).toBe("1d 0h");
    expect(formatHealthUptime(2 * 3_600 + 5 * 60 + 59)).toBe("2h 5m");
    expect(formatHealthUptime(3_600)).toBe("1h 0m");
    expect(formatHealthUptime(3_599)).toBe("59m");
    expect(formatHealthUptime(30)).toBe("0m");
  });
});

describe("health card", () => {
  it("finds the pod's report by domain, case-insensitively, skipping revoked rows", async () => {
    const { healthForServer } = await load();
    const h = healthy();
    const pods = [
      { serverDomain: "home.alice.flagship.services", revokedAt: 1, health: { receivedAt: 0 } },
      { serverDomain: "Home.Alice.flagship.services", health: h },
      { serverDomain: "work.alice.flagship.services" },
    ];
    expect(healthForServer(pods, "home.alice.flagship.services")).toBe(h);
    expect(healthForServer(pods, "work.alice.flagship.services")).toBeNull();
    expect(healthForServer(undefined, "home.alice.flagship.services")).toBeNull();
  });
});
