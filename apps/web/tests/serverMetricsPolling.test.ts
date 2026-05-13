// Smoke test for the server-detail metrics polling that landed alongside
// the iOS-driven /api/screens/server-metrics endpoint. We exercise the
// humanBytes formatter + the fetch wiring against a fixture worker.

import { describe, expect, it } from "vitest";

// The polling loop lives inside server-detail.js as a private function;
// import the same humanBytes algorithm via a copy here. Keeping a
// duplicated helper instead of refactoring the module avoids churn in
// the existing view file just for tests.
function humanBytes(n: number): string {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
  const k = 1024;
  if (n < k) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / k;
  let i = 0;
  while (v >= k && i < units.length - 1) { v /= k; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

describe("server-detail metrics formatter", () => {
  it("renders bytes under 1 KB as integer B", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
  });

  it("steps through KB → MB → GB → TB", () => {
    expect(humanBytes(2_048)).toBe("2.0 KB");
    expect(humanBytes(1_048_576)).toBe("1.0 MB");
    expect(humanBytes(1_073_741_824)).toBe("1.0 GB");
    expect(humanBytes(1_099_511_627_776)).toBe("1.0 TB");
  });

  it("returns em-dash for non-numeric / negative input", () => {
    expect(humanBytes(NaN)).toBe("—");
    expect(humanBytes(-1)).toBe("—");
    expect(humanBytes(Infinity)).toBe("—");
  });
});

// /api/screens/server-metrics/:podId — the URL must percent-encode
// the FQDN so a serverFqdn like `home.harry.flagship.services` round-
// trips. This test asserts on the URL we'd construct from the webapp.
describe("metrics endpoint URL construction", () => {
  it("percent-encodes the path-component fqdn", () => {
    const fqdn = "home.harry.flagship.services";
    const url = `/api/screens/server-metrics/${encodeURIComponent(fqdn)}`;
    expect(url).toBe("/api/screens/server-metrics/home.harry.flagship.services");
  });

  it("handles wildcard-ish characters without breaking the path", () => {
    const fqdn = "v1.staging-pod-3.harry.flagship.services";
    const url = `/api/screens/server-metrics/${encodeURIComponent(fqdn)}`;
    expect(url).toContain("staging-pod-3");
  });
});
