import { describe, expect, it } from "vitest";
import { describeLatency, latencyStats, securityHeaderGaps, uncachedProbe } from "../lib/freePlan.js";

const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe("latencyStats", () => {
  it("takes the first sample as cold and the rest as warm", () => {
    expect(latencyStats([300, 50, 70, 60, 400])).toEqual({ n: 5, coldMs: 300, warmMedianMs: 60, warmMaxMs: 400 });
    expect(latencyStats([120])).toEqual({ n: 1, coldMs: 120, warmMedianMs: 120, warmMaxMs: 120 });
    expect(describeLatency("irk", latencyStats([300, 50, 70]))).toBe("irk cold 300 ms, warm median 50 ms (max 70, n=3)");
  });
  it("refuses no samples", () => {
    expect(() => latencyStats([])).toThrow();
  });
});

describe("securityHeaderGaps", () => {
  const good = {
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "referrer-policy": "no-referrer",
  };
  it("is empty when framing, sniffing, HSTS and referrer are covered", () => {
    expect(securityHeaderGaps(headers(good))).toEqual([]);
    expect(securityHeaderGaps(headers({ ...good, "content-security-policy": "", "x-frame-options": "DENY" }))).toEqual([]);
  });
  it("names each missing header", () => {
    expect(securityHeaderGaps(headers({}))).toHaveLength(4);
    expect(securityHeaderGaps(headers({ ...good, "x-content-type-options": "" }))).toEqual(["x-content-type-options: nosniff"]);
    expect(securityHeaderGaps(headers({ ...good, "content-security-policy": "default-src 'self'" }))[0]).toContain("framing");
  });
});

describe("uncachedProbe", () => {
  it("adds a marker the static file ignores", () => {
    expect(uncachedProbe("https://x/app.js", "t1")).toBe("https://x/app.js?fp=t1");
    expect(uncachedProbe("https://x/a?b=1", "t1")).toBe("https://x/a?b=1&fp=t1");
  });
});
