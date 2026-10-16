// A long build chat: the newest 40 messages, file blocks collapsed, and the
// page follows the newest message only while the owner hasn't scrolled up
// (iOS VibeTranscript.swift + VibeCodeSessionScreen, Android VibeTranscript.kt).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error plain JS module
import * as vt from "../public/webapp/lib/vibeTranscript.js";

const WEBAPP = resolve(__dirname, "..", "public", "webapp");
const read = (p: string) => readFileSync(resolve(WEBAPP, p), "utf8");

describe("the build chat transcript", () => {
  it("collapses each finished file to one line, and keeps a question's text", () => {
    const text = ["Here you go.", "=== server.js ===", "a", "b", "c", "=== END ===", "=== QUESTION ===", "Which port?", "=== END ===", ""].join("\n");
    expect(vt.compactTranscript(text)).toBe(["Here you go.", "  wrote server.js (3 lines)", "Which port?"].join("\n"));
  });

  it("shows the tail of a file still being written when live", () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const text = ["=== app.js ===", ...body].join("\n");
    const live: string = vt.compactTranscript(text, { live: true });
    expect(live.split("\n")[0]).toBe("  writing app.js… (10 lines)");
    expect(live).toContain("    line 9");
    expect(live).not.toContain("line 3");
    expect(vt.compactTranscript(text)).toBe("  wrote app.js (10 lines)");
  });

  it("keeps the newest 40 messages and says how many were left out", () => {
    const messages = Array.from({ length: 45 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` }));
    const w = vt.transcriptWindow(messages);
    expect(w.hidden).toBe(5);
    expect(w.messages).toHaveLength(40);
    expect(w.messages[0].text).toBe("m5");
    expect(vt.hiddenMessagesText(5)).toBe("… 5 earlier messages not shown");
    expect(vt.hiddenMessagesText(1)).toBe("… 1 earlier message not shown");
    expect(vt.hiddenMessagesText(0)).toBe("");
    expect(vt.transcriptWindow([{ role: "user", text: "=== a ===" }]).messages[0].text).toBe("=== a ===");
  });

  it("counts a scroll near the bottom as following", () => {
    expect(vt.isAtBottom({ scrollTop: 560, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(vt.isAtBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });

  it("the page keeps the owner's place on a poll and offers Jump to latest", () => {
    const view = read("views/vibe-code.js");
    expect(view).toContain("log.scrollTop = followTail ? log.scrollHeight : keepTop;");
    expect(view).not.toMatch(/\n\s*log\.scrollTop = log\.scrollHeight;\n\s*}\n\n\s*\/\/ The composer/);
    expect(view).toContain("transcriptWindow(all)");
    expect(read("index.html")).toContain('id="vc-jump-latest"');
    expect(read("service-worker.js")).toContain('"/lib/vibeTranscript.js"');
    expect(vt.JUMP_TO_LATEST).toBe("Jump to latest");
  });
});
