/**
 * Tests for VibeCodeStreamParser + VibeCodeSession.
 */

import { describe, expect, it } from "vitest";
import {
  VibeCodeSession,
  VibeCodeSessionRegistry,
  VibeCodeStreamParser,
  type VibeCodeEvent,
} from "../../src/llm/vibeCodeSession.js";

function collect(parser: VibeCodeStreamParser): VibeCodeEvent[] {
  const events: VibeCodeEvent[] = [];
  parser.on("event", (e: VibeCodeEvent) => events.push(e));
  return events;
}

describe("VibeCodeStreamParser", () => {
  it("parses a complete structured emit", () => {
    const p = new VibeCodeStreamParser();
    const events = collect(p);
    p.feed(`Some preamble.\n=== flagship.app.json ===\n{"name":"x"}\n=== Dockerfile ===\nFROM node:20\n=== END ===\n`);
    p.end();
    const fileEvents = events.filter((e) => e.kind === "file-complete");
    expect(fileEvents).toHaveLength(2);
    expect((fileEvents[0] as { filename: string }).filename).toBe("flagship.app.json");
    expect(p.snapshot()["flagship.app.json"]).toContain('"name":"x"');
    expect(p.snapshot()["Dockerfile"]).toContain("FROM node:20");
  });

  it("handles content that arrives one character at a time", () => {
    const p = new VibeCodeStreamParser();
    const events = collect(p);
    const stream = `=== flagship.app.json ===\n{}\n=== END ===\n`;
    for (const ch of stream) p.feed(ch);
    p.end();
    expect(events.some((e) => e.kind === "done")).toBe(true);
    expect(p.snapshot()["flagship.app.json"]).toBe("{}\n");
  });

  it("emits chunk events as content streams in", () => {
    const p = new VibeCodeStreamParser();
    const events = collect(p);
    p.feed(`=== flagship.app.json ===\n`);
    p.feed(`{"name":"a"}\n`);
    p.feed(`=== END ===\n`);
    p.end();
    const chunks = events.filter((e) => e.kind === "chunk");
    expect(chunks.length).toBeGreaterThan(0);
    expect((chunks[0] as { filename: string }).filename).toBe("flagship.app.json");
  });

  it("emits 'thinking' events for content outside file boundaries", () => {
    const p = new VibeCodeStreamParser();
    const events = collect(p);
    p.feed(`I'll build a small habit tracker.\n`);
    p.feed(`=== flagship.app.json ===\n{}\n=== END ===\n`);
    p.end();
    const thinking = events.filter((e) => e.kind === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
    expect((thinking[0] as { text: string }).text).toContain("habit tracker");
  });

  it("calling end() without a closing === END === still flushes", () => {
    const p = new VibeCodeStreamParser();
    collect(p);
    p.feed(`=== flagship.app.json ===\n{}\n`);
    p.end();
    expect(p.snapshot()["flagship.app.json"]).toContain("{}");
  });
});

describe("VibeCodeSession", () => {
  it("tracks status transitions and conversation history", () => {
    const s = new VibeCodeSession({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    expect(s.meta.status).toBe("streaming");
    s.pushUserMessage("Build a habit tracker");
    s.feedAssistant(`I'll do that.\n=== flagship.app.json ===\n{}\n=== END ===\n`);
    s.endAssistant();
    expect(s.meta.status).toBe("ready-to-deploy");
    expect(s.conversation()).toHaveLength(2);
    expect(s.manifestJson()).toContain("{}");
  });

  it("treats a text-form QUESTION block as a question, not a finished app", () => {
    // GPT-5 asked in text instead of calling talkToUser; the parser read the
    // block as a file named QUESTION and the session offered Deploy.
    const s = new VibeCodeSession({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    const events: VibeCodeEvent[] = [];
    s.on("event", (e: VibeCodeEvent) => events.push(e));
    s.pushUserMessage("A picture site with uploads and comments");
    s.feedAssistant(
      "=== QUESTION ===\nShould uploads and comments be open to anonymous visitors?\n=== END ===\n",
    );
    s.endAssistant();
    expect(s.meta.status).toBe("awaiting-tool-response");
    expect(s.files()).toEqual({});
    const pending = s.pendingToolUses();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.name).toBe("talkToUser");
    expect(pending[0]!.input.message).toBe("Should uploads and comments be open to anonymous visitors?");
    const talk = events.find((e) => e.kind === "talk-to-user");
    expect(talk && talk.kind === "talk-to-user" ? talk.message : "").toMatch(/anonymous visitors\?$/);

    // The owner's reply resumes the build like any talkToUser answer.
    expect(s.pushUserReply({ toolUseId: pending[0]!.id, text: "Members only for uploads" }).ok).toBe(true);
    expect(s.meta.status).toBe("streaming");
    s.prepareForResume();
    s.feedAssistant("=== flagship.app.json ===\n{}\n=== END ===\n");
    s.endAssistant();
    expect(s.meta.status).toBe("ready-to-deploy");
    expect(Object.keys(s.files())).toEqual(["flagship.app.json"]);
  });

  it("markDeployed flips status + emits event", () => {
    const s = new VibeCodeSession({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    const events: VibeCodeEvent[] = [];
    s.on("event", (e: VibeCodeEvent) => events.push(e));
    s.markDeployed({ serviceId: "alice-habits", url: "https://habits.alice.flagship.services" });
    expect(s.meta.status).toBe("deployed");
    expect(events.find((e) => e.kind === "deployed")).toBeTruthy();
  });

  it("fail() persists the reason on meta so a re-attaching client can recover it", () => {
    const s = new VibeCodeSession({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    const events: VibeCodeEvent[] = [];
    s.on("event", (e: VibeCodeEvent) => events.push(e));
    s.fail("no AI credential set for this session", true);
    expect(s.meta.status).toBe("failed");
    // The live error event still carries the reason...
    const err = events.find((e) => e.kind === "error");
    expect(err && err.kind === "error" ? err.message : "").toBe(
      "no AI credential set for this session",
    );
    // ...AND it survives on meta for clients that attach after the event fired.
    expect(s.meta.failureReason).toBe("no AI credential set for this session");
  });

  it("cancel halts further feeds", () => {
    const s = new VibeCodeSession({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    s.cancel();
    s.feedAssistant("=== flagship.app.json ===\n{}\n=== END ===\n");
    s.endAssistant();
    expect(s.meta.status).toBe("cancelled");
  });

  it("registry assigns unique session ids", () => {
    const reg = new VibeCodeSessionRegistry();
    const a = reg.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    const b = reg.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    expect(a.meta.sessionId).not.toBe(b.meta.sessionId);
    expect(reg.list()).toHaveLength(2);
    expect(reg.get(a.meta.sessionId)).toBe(a);
  });
});
