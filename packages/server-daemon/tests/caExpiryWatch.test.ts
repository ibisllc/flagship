import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaTrustChain } from "@flagship/protocol";
import { SecuritySliver } from "../src/securitySliver.js";
import { CA_ISSUE_KEY, caLeaseState, reportCaLease } from "../src/caExpiryWatch.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const chainEndingIn = (days: number | null): CaTrustChain => ({ authorizedCaKeys: (t: number) => (days !== null && t < NOW + days * DAY ? ["k"] : []) }) as unknown as CaTrustChain;

describe("CA lease watch", () => {
  it("is quiet far from the end, counts the days near it, and says lapsed after it", () => {
    expect(caLeaseState(chainEndingIn(60), NOW)).toEqual({ state: "ok" });
    expect(caLeaseState(chainEndingIn(10.5), NOW)).toEqual({ state: "soon", daysLeft: 10 });
    expect(caLeaseState(chainEndingIn(2.2), NOW)).toEqual({ state: "soon", daysLeft: 2 });
    expect(caLeaseState(chainEndingIn(null), NOW)).toEqual({ state: "lapsed" });
    expect(caLeaseState(null, NOW)).toEqual({ state: "lapsed" });
  });

  it("raises a high line two weeks out, a critical one in the last days, and clears it when the chain is renewed", async () => {
    const sliver = new SecuritySliver(join(mkdtempSync(join(tmpdir(), "ca-")), "s.json"), () => NOW);
    await sliver.load();
    await reportCaLease(sliver, chainEndingIn(12.5), NOW);
    expect(sliver.lines()).toMatchObject([{ issueKey: CA_ISSUE_KEY, kind: "ca-expiry", severity: "high", state: "active" }]);
    await reportCaLease(sliver, chainEndingIn(2.5), NOW);
    const lines = sliver.lines();
    expect(lines.filter((l) => l.state === "active")).toMatchObject([{ severity: "critical" }]);
    await reportCaLease(sliver, chainEndingIn(90), NOW);
    expect(sliver.lines().every((l) => l.state === "resolved")).toBe(true);
  });

  it("a lapsed lease is critical and says what stops working", async () => {
    const sliver = new SecuritySliver(join(mkdtempSync(join(tmpdir(), "ca-")), "s.json"), () => NOW);
    await sliver.load();
    await reportCaLease(sliver, chainEndingIn(null), NOW);
    expect(sliver.lines()[0]).toMatchObject({ severity: "critical" });
    expect(sliver.lines()[0]!.summary).toContain("paused");
  });
});
