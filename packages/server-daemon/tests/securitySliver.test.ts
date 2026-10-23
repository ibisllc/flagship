import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RETENTION_MS, SecuritySliver } from "../src/securitySliver.js";

const DAY = 86_400_000;
async function make(start = 1_000_000) {
  let t = start;
  const dir = await mkdtemp(join(tmpdir(), "sliver-"));
  const s = new SecuritySliver(join(dir, "s.json"), () => t);
  await s.load();
  return { s, dir, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}
const issue = (over: Record<string, unknown> = {}) => ({ issueKey: "pk:chess", kind: "publisher-key" as const, severity: "high" as const, target: "chess", summary: "A new key signed an update", deadline: null, action: "Review", ...over });

describe("security sliver", () => {
  it("keeps independent lines, never merging two issues", async () => {
    const { s } = await make();
    await s.raise(issue());
    await s.raise(issue({ issueKey: "ca", kind: "ca-expiry", severity: "moderate", target: "server", summary: "CA lease ends soon" }));
    await s.raise(issue({ issueKey: "rec", kind: "recovery-attempt", severity: "critical", target: "account", summary: "Recovery started" }));
    expect(s.lines().map((l) => l.issueKey)).toEqual(["rec", "pk:chess", "ca"]); // worst first, all present
  });

  it("an unchanged condition does not notify again; a worse one is a new event", async () => {
    const { s } = await make();
    expect((await s.raise(issue())).notify).toBe(true);
    expect((await s.raise(issue())).notify).toBe(false);
    expect((await s.raise(issue({ severity: "moderate" }))).notify).toBe(false); // lower: just the line
    const esc = await s.raise(issue({ severity: "critical" }));
    expect(esc.notify).toBe(true);
    expect(esc.event.escalatedFrom).toBe("sv1");
    const lines = s.lines();
    expect(lines.filter((l) => l.state === "active")).toHaveLength(1);
    expect(lines.find((l) => l.state === "active")!.severity).toBe("critical");
    expect(lines.find((l) => l.state === "resolved")!.eventId).toBe("sv1"); // the old one is history, kept
  });

  it("shows time remaining against a deadline, from the platform clock", async () => {
    const { s, advance } = await make();
    await s.raise(issue({ deadline: 1_000_000 + 10 * 60_000 }));
    advance(4 * 60_000);
    expect(s.lines()[0]!.remainingMs).toBe(6 * 60_000);
    advance(10 * 60_000);
    expect(s.lines()[0]!.remainingMs).toBeLessThan(0);
  });

  it("a resolved line stays for its severity's retention, and acknowledging does not shorten or restart it", async () => {
    for (const sev of ["critical", "high", "moderate", "low"] as const) {
      const { s, advance } = await make();
      const { event } = await s.raise(issue({ issueKey: `k-${sev}`, severity: sev }));
      await s.resolve(`k-${sev}`);
      advance(RETENTION_MS[sev] - DAY);
      await s.acknowledge(event.eventId);
      expect(s.lines().map((l) => l.issueKey), sev).toEqual([`k-${sev}`]);
      advance(DAY + 1);
      expect(s.lines(), sev).toEqual([]);
      expect(s.history()).toHaveLength(1); // expiry removes it from the sliver, not from the record
    }
    expect(RETENTION_MS).toEqual({ critical: 90 * DAY, high: 30 * DAY, moderate: 14 * DAY, low: 7 * DAY });
  });

  it("an active issue stays however long it has been there", async () => {
    const { s, advance } = await make();
    await s.raise(issue({ severity: "low" }));
    advance(400 * DAY);
    expect(s.lines()).toHaveLength(1);
  });

  it("two issues keep independent clocks across approve and reject", async () => {
    const { s, advance } = await make();
    await s.raise(issue({ issueKey: "a", severity: "high" }));
    await s.raise(issue({ issueKey: "b", severity: "low" }));
    await s.resolve("a");
    advance(8 * DAY);
    expect(s.lines().map((l) => l.issueKey)).toEqual(["b", "a"]); // b still active; a retained (high = 30 days)
    await s.resolve("b");
    advance(8 * DAY);
    expect(s.lines().map((l) => l.issueKey)).toEqual(["a"]); // b's 7 days are over, a's are not
  });

  it("survives a restart, and a lost file says so instead of looking clean", async () => {
    const { s, dir } = await make();
    await s.raise(issue());
    const again = new SecuritySliver(join(dir, "s.json"));
    await again.load();
    expect(again.lines()).toHaveLength(1);
    await writeFile(join(dir, "bad.json"), "{");
    const lost = new SecuritySliver(join(dir, "bad.json"));
    await lost.load();
    expect(lost.lostHistory).toBe(true);
    expect(lost.lines()).toEqual([]);
  });
});
