import { describe, expect, it } from "vitest";
import { ActivityLog } from "../src/shares/activityLog.js";

describe("activity parameters", () => {
  it("keeps short keys, cut strings and finite numbers, at most 8", () => {
    const log = new ActivityLog(null, () => 1);
    log.note("app.restore.replaced", "notes was restored.", { params: { app: "x".repeat(300), until: 5, bad: Number.NaN, "no-dash": "y", ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])) } });
    const p = log.recent(1)[0]!.params!;
    expect((p.app as string).length).toBe(120);
    expect(p.until).toBe(5);
    expect("bad" in p || "no-dash" in p).toBe(false);
    expect(Object.keys(p).length).toBeLessThanOrEqual(8);
  });
});
