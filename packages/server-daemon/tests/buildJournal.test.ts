import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileBuildJournal,
  InMemoryBuildJournal,
  redactSecrets,
  type BuildJournal,
} from "../src/buildmodes/buildJournal.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "journal-"));
}

let clock = 1_700_000_000_000;
const tick = () => (clock += 1000);

function suite(name: string, make: () => BuildJournal) {
  describe(name, () => {
    it("assigns monotonic 1-based seq and unix-ms ts", async () => {
      const j = make();
      const a = await j.append("b1", { mode: "scratch", kind: "session-started", actor: "owner", summary: "start" });
      const b = await j.append("b1", { mode: "scratch", kind: "user-message", actor: "owner", summary: "hi" });
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(b.ts).toBeGreaterThan(a.ts);
      expect(a.buildId).toBe("b1");
    });

    it("reads back entries in order", async () => {
      const j = make();
      await j.append("b2", { mode: "git", kind: "git-clone", actor: "system", summary: "cloning" });
      await j.append("b2", { mode: "git", kind: "fitness-check", actor: "system", summary: "conformant" });
      const entries = await j.read("b2");
      expect(entries.map((e) => e.kind)).toEqual(["git-clone", "fitness-check"]);
    });

    it("isolates builds from each other", async () => {
      const j = make();
      await j.append("x", { mode: "mcp", kind: "mcp-connected", actor: "ide", summary: "cursor" });
      await j.append("y", { mode: "scratch", kind: "session-started", actor: "owner", summary: "s" });
      expect((await j.read("x")).length).toBe(1);
      expect((await j.read("y")).length).toBe(1);
      expect(await j.read("nope")).toEqual([]);
    });

    it("summaries are newest-first and carry the late-bound serviceId", async () => {
      const j = make();
      await j.append("older", { mode: "scratch", kind: "session-started", actor: "owner", summary: "s" });
      await j.append("newer", { mode: "git", kind: "git-clone", actor: "system", summary: "c" });
      await j.append("newer", { mode: "git", kind: "deployed", actor: "system", summary: "live", serviceId: "harry-notes" });
      const list = await j.list();
      expect(list[0]!.buildId).toBe("newer");
      expect(list[0]!.serviceId).toBe("harry-notes");
      expect(list[0]!.lastKind).toBe("deployed");
      expect(list[0]!.entryCount).toBe(2);
      expect(list[1]!.buildId).toBe("older");
      expect(list[1]!.serviceId).toBeUndefined();
    });

    it("redacts secret-shaped tokens in summary and detail", async () => {
      const j = make();
      const e = await j.append("sec", {
        mode: "mcp",
        kind: "mcp-call",
        actor: "ide",
        summary: "set OPENAI_API_KEY=sk-abcdefghij0123456789",
        detail: "token ghp_0123456789012345678901234567890123",
      });
      expect(e.summary).not.toContain("sk-abcdefghij");
      expect(e.summary).toContain("«redacted»");
      expect(e.detail).toContain("«redacted»");
      expect(e.detail).not.toContain("ghp_");
    });

    it("forget drops a build", async () => {
      const j = make();
      await j.append("gone", { mode: "scratch", kind: "session-started", actor: "owner", summary: "s" });
      await j.forget("gone");
      expect(await j.read("gone")).toEqual([]);
    });
  });
}

suite("InMemoryBuildJournal", () => new InMemoryBuildJournal(tick));
suite("FileBuildJournal", () => new FileBuildJournal(tempDir(), tick));

describe("FileBuildJournal persistence", () => {
  it("survives a restart: seq continues and entries reload", async () => {
    const dir = tempDir();
    const a = new FileBuildJournal(dir, tick);
    await a.append("persist", { mode: "scratch", kind: "session-started", actor: "owner", summary: "one" });
    await a.append("persist", { mode: "scratch", kind: "user-message", actor: "owner", summary: "two" });

    // Fresh instance over the same dir = simulated daemon restart.
    const b = new FileBuildJournal(dir, tick);
    const reloaded = await b.read("persist");
    expect(reloaded.length).toBe(2);
    const next = await b.append("persist", { mode: "scratch", kind: "assistant-message", actor: "ai", summary: "three" });
    expect(next.seq).toBe(3);
  });

  it("tolerates a torn final line", async () => {
    const dir = tempDir();
    const j = new FileBuildJournal(dir, tick);
    await j.append("torn", { mode: "git", kind: "git-clone", actor: "system", summary: "ok" });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, "torn.jsonl"), '{"seq":2,"ts":1,"bui');
    const entries = await j.read("torn");
    expect(entries.length).toBe(1);
  });
});

describe("redactSecrets", () => {
  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("wrote src/index.js (1.2 KB)")).toBe("wrote src/index.js (1.2 KB)");
  });
  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz123456";
    expect(redactSecrets(`bearer ${jwt}`)).toContain("«redacted»");
  });
});
