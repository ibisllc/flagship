import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_REASON,
  SESSION_IDLE_EVICT_MS,
  SESSION_RETENTION_MS,
  VibeCodeSessionRegistry,
  fileVibeCodeSessionStore,
} from "../../src/llm/vibeCodeSession.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vibe-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const APP = "Building it.\n=== flagship.app.json ===\n{\"name\":\"todo\"}\n=== server.js ===\nconsole.log(1)\n=== END ===\n";

function restart(dir: string, now = () => Date.now(), onDelete?: (id: string) => void) {
  return new VibeCodeSessionRegistry(fileVibeCodeSessionStore(dir), { saveDelayMs: 0, now, onDelete });
}

describe("vibe-code sessions survive a daemon restart", () => {
  it("a ready-to-deploy build comes back with its files and conversation", () => {
    const dir = tmp();
    const before = restart(dir);
    const s = before.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    s.pushUserMessage("a todo app");
    s.feedAssistant(APP);
    s.endAssistant();
    expect(s.meta.status).toBe("ready-to-deploy");
    before.flush();

    const after = restart(dir);
    expect(after.list().map((m) => [m.sessionId, m.status])).toEqual([[s.meta.sessionId, "ready-to-deploy"]]);
    const back = after.get(s.meta.sessionId)!;
    expect(back.meta.status).toBe("ready-to-deploy");
    expect(back.files()["server.js"]).toBe("console.log(1)\n");
    expect(back.messages().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("a question waiting for the owner is still waiting, with the same pending tool", () => {
    const dir = tmp();
    const before = restart(dir);
    const s = before.create({ username: "alice", serverFqdn: "h" });
    s.pushUserMessage("an app");
    s.receiveToolUse({ id: "t1", name: "talkToUser", input: { message: "Which colour?" } });
    before.flush();

    const back = restart(dir).get(s.meta.sessionId)!;
    expect(back.meta.status).toBe("awaiting-tool-response");
    expect(back.pendingRequest()).toMatchObject({ kind: "talkToUser", toolUseId: "t1" });
    expect(back.pushUserReply({ toolUseId: "t1", text: "blue" }).ok).toBe(true);
  });

  it("a build cut off mid-stream comes back failed with the reason", () => {
    const dir = tmp();
    const before = restart(dir);
    const s = before.create({ username: "alice", serverFqdn: "h" });
    s.feedAssistant("=== server.js ===\nconst a");
    before.flush();

    const after = restart(dir);
    expect(after.list()[0]).toMatchObject({ status: "failed", failureReason: INTERRUPTED_REASON });
    expect(after.get(s.meta.sessionId)!.meta.status).toBe("failed");
  });

  it("listing reads only the small meta files, never the code", () => {
    const dir = tmp();
    const r = restart(dir);
    const s = r.create({ username: "alice", serverFqdn: "h" });
    s.feedAssistant(APP);
    r.flush();
    const files = readdirSync(dir).sort();
    expect(files).toEqual([`${s.meta.sessionId}.json`, `${s.meta.sessionId}.meta.json`]);
    expect(readFileSync(join(dir, `${s.meta.sessionId}.meta.json`), "utf8")).not.toContain("console.log");
  });

  it("finished sessions leave memory after a day and disk after a month", () => {
    const dir = tmp();
    let t = 1_000_000;
    const deleted: string[] = [];
    const r = restart(dir, () => t, (id) => deleted.push(id));
    const s = r.create({ username: "alice", serverFqdn: "h" });
    s.fail("docker build failed");
    r.flush();

    t += SESSION_IDLE_EVICT_MS + 1;
    r.sweep();
    expect(readdirSync(dir)).toHaveLength(2);
    expect(r.get(s.meta.sessionId)?.meta.failureReason).toBe("docker build failed");

    t += SESSION_RETENTION_MS + 1;
    r.sweep();
    r.sweep();
    expect(readdirSync(dir)).toHaveLength(0);
    expect(r.list()).toEqual([]);
    expect(deleted).toEqual([s.meta.sessionId]);
  });

  it("ignores ids that aren't session ids", () => {
    const r = restart(tmp());
    expect(r.get("../../etc/passwd")).toBeUndefined();
  });
});
