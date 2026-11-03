import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { client, formatNotices, formatReports, noticeBody, parseArgs } from "./abuse-cases.mjs";

describe("abuse-cases CLI", () => {
  it("parses each verb and refuses bad input", () => {
    expect(parseArgs(["list", "--all"])).toMatchObject({ verb: "list", all: true });
    expect(parseArgs(["notice", "alice", "--category", "phishing", "--action", "take-down", "--hours", "72", "--report", "a".repeat(32)]).flags).toMatchObject({ category: "phishing", hours: "72" });
    expect(() => parseArgs(["notice", "alice", "--category", "boring", "--action", "modify", "--hours", "1", "--subject", "x"])).toThrow(/category/);
    expect(() => parseArgs(["notice", "alice", "--category", "spam", "--action", "modify", "--hours", "0", "--subject", "x"])).toThrow(/hours/);
    expect(() => parseArgs(["notice", "alice", "--category", "spam", "--action", "modify", "--hours", "5"])).toThrow(/--report/);
    expect(() => parseArgs(["suspend", "alice", "--category", "csam"])).toThrow(/--reason/);
    expect(parseArgs(["suspend", "alice", "--category", "csam", "--reason", "x", "--urgent"])).toMatchObject({ urgent: true });
    expect(() => parseArgs(["frobnicate"])).toThrow();
  });

  it("builds the notice from a report", () => {
    const report = { id: "b".repeat(32), subject: "voi.ci/chess", targetKind: "link", serviceId: "alice--chess" };
    expect(noticeBody("alice", { category: "spam", action: "modify", hours: "24" }, report)).toEqual({
      account: "alice",
      reportId: report.id,
      subjectKind: "link",
      subject: "voi.ci/chess",
      serviceId: "alice--chess",
      category: "spam",
      action: "modify",
      deadlineHours: 24,
    });
  });

  it("formats reports and notices, and sends the admin secret", async () => {
    const now = 100 * 3_600_000;
    expect(formatReports([], now)).toEqual(["No reports."]);
    expect(formatReports([{ id: "x", kind: "app", reason: "spam", subject: "a.b.flagship.services", account: "b", targetKind: "app", createdAt: now - 3_600_000, status: "open" }], now)[0]).toContain("1 h ago");
    expect(formatNotices([{ id: "n", account: "b", category: "spam", action: "modify", subjectKind: "app", subject: "s", deadlineAt: now - 1, doneAt: null, withdrawnAt: null }], now)[0]).toContain("DEADLINE PASSED");
    let seen: Record<string, string> = {};
    const call = client({ base: "https://x", secret: "s", fetchFn: (async (_u: string, i: RequestInit) => ((seen = i.headers as Record<string, string>), Response.json({ ok: true }))) as never });
    await call("GET", "stats");
    expect(seen["x-admin-secret"]).toBe("s");
  });
});
