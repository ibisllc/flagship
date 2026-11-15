import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_LOG_GENESIS, orgBoxLogEntryHash } from "@flagship/protocol";
import { ActivityLog } from "../src/shares/activityLog.js";

/** The chain an auditor recomputes from the file: the base line, then every entry line. */
function recompute(path: string): { seq: number; hash: string } {
  let head = { seq: 0, hash: ORG_LOG_GENESIS };
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const o = JSON.parse(line) as { base?: { seq: number; hash: string }; seq: number };
    if (o.base) {
      head = o.base;
      continue;
    }
    head = { seq: o.seq, hash: orgBoxLogEntryHash(o.seq, head.hash, createHash("sha256").update(line).digest("hex")) };
  }
  return head;
}

describe("the box Activity chain an org box signs (docs/enterprise-accounts.md §11)", () => {
  it("chains every line, survives a reload, and keeps the chain across a trim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "activity-chain-"));
    try {
      const path = join(dir, "activity.jsonl");
      let t = 1;
      const log = new ActivityLog(path, () => t++);
      expect(log.head()).toEqual({ seq: 0, hash: ORG_LOG_GENESIS });
      for (let i = 0; i < 2300; i++) log.note("app.installed", `app ${i}`);
      await log.flush();
      const head = log.head();
      expect(head.seq).toBe(2300);
      // The file starts with the base of the trimmed chain; recomputing it gives the same head.
      expect(readFileSync(path, "utf8").split("\n")[0]).toMatch(/^\{"base":/);
      expect(recompute(path)).toEqual(head);
      const again = new ActivityLog(path, () => t++);
      await again.load();
      expect(again.head()).toEqual(head);
      again.note("org.recipe.verified", "ok");
      await again.flush();
      expect(again.head().seq).toBe(2301);
      expect(recompute(path)).toEqual(again.head());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rewritten line changes the head", async () => {
    const a = new ActivityLog(null, () => 5);
    const b = new ActivityLog(null, () => 5);
    a.note("x", "one");
    b.note("x", "two");
    expect(a.head().seq).toBe(b.head().seq);
    expect(a.head().hash).not.toBe(b.head().hash);
  });
});
