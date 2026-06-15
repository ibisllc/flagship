/**
 * Multimodal chat for scratch — attachments thread through the session
 * into the ChatRequest, the HTTP surface enforces caps, and the build
 * journal records turns + attachments VALUE-FREE (name/kind/size only,
 * never the content/base64).
 */

import { describe, expect, it } from "vitest";
import type {
  Attachment,
  ChatRequest,
  ChatStreamEvent,
  ProviderConfig,
  StreamingLLMProvider,
} from "@flagship/llm-providers";
import {
  MAX_ATTACHMENTS_PER_TURN,
  summarizeAttachment,
  validateAttachments,
} from "../../src/llm/vibeCodeAttachments.js";
import {
  VibeCodeSession,
  VibeCodeSessionRegistry,
} from "../../src/llm/vibeCodeSession.js";
import { buildVibeCodeStartStreaming } from "../../src/llm/vibeCodeStartStreaming.js";
import { InMemoryAppEnvStore } from "../../src/serviceEnvStore.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function img(over = false): Attachment {
  const data = over ? "A".repeat(6 * 1024 * 1024 * 2) : PNG_1x1;
  return { kind: "image", mediaType: "image/png", dataBase64: data, name: "shot.png" };
}

describe("validateAttachments — caps + kinds", () => {
  it("accepts an empty / absent payload", () => {
    expect(validateAttachments(undefined)).toEqual({ ok: true, attachments: [] });
    expect(validateAttachments([])).toEqual({ ok: true, attachments: [] });
  });

  it("accepts a small image + text attachment", () => {
    const r = validateAttachments([
      img(),
      { kind: "text", name: "schema.sql", text: "create table t(id int);" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attachments).toHaveLength(2);
  });

  it("rejects more than the per-turn cap", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 1 }, () => img());
    const r = validateAttachments(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too many/i);
  });

  it("rejects an oversize image (>4 MB decoded)", () => {
    const r = validateAttachments([img(true)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/i);
  });

  it("rejects an oversize text attachment (>256 KB)", () => {
    const r = validateAttachments([{ kind: "text", text: "x".repeat(300 * 1024) }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/i);
  });

  it("rejects an unsupported image media type", () => {
    const r = validateAttachments([
      { kind: "image", mediaType: "image/tiff", dataBase64: PNG_1x1 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsupported/i);
  });

  it("rejects an unknown attachment kind", () => {
    const r = validateAttachments([{ kind: "video", url: "x" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown attachment kind/i);
  });
});

describe("summarizeAttachment — VALUE-FREE", () => {
  it("an image summary is name + media type + byte size, never the base64", () => {
    const a = img();
    const s = summarizeAttachment(a);
    expect(s).toContain("shot.png");
    expect(s).toContain("image/png");
    expect(s).toMatch(/bytes/);
    // The actual base64 content NEVER appears.
    expect(s).not.toContain(PNG_1x1);
  });

  it("a text summary is name + byte size, never the text body", () => {
    const a: Attachment = { kind: "text", name: "schema.sql", text: "SECRET-BODY-create-table" };
    const s = summarizeAttachment(a);
    expect(s).toContain("schema.sql");
    expect(s).toMatch(/bytes/);
    expect(s).not.toContain("SECRET-BODY");
  });
});

describe("VibeCodeSession — attachments ride the user turn", () => {
  it("pushUserMessage stores attachments and messages() surfaces them", () => {
    const s = new VibeCodeSession({ username: "alice", serverFqdn: "h.alice.flagship.services" });
    s.pushUserMessage("make it look like this", [img()]);
    const msgs = s.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.attachments).toHaveLength(1);
    expect(msgs[0]!.attachments![0]!.kind).toBe("image");
  });

  it("an empty attachments array is normalized away", () => {
    const s = new VibeCodeSession({ username: "a", serverFqdn: "h" });
    s.pushUserMessage("hi", []);
    expect(s.messages()[0]!.attachments).toBeUndefined();
  });
});

/** A capturing fake StreamingLLMProvider. */
function capturingProvider(): {
  provider: StreamingLLMProvider;
  capture: { request?: ChatRequest };
} {
  const capture: { request?: ChatRequest } = {};
  const provider: StreamingLLMProvider = {
    name: "fake",
    async chatStream(req: ChatRequest, _cfg: ProviderConfig, onEvent: (e: ChatStreamEvent) => void) {
      capture.request = req;
      onEvent({ kind: "end" });
    },
  };
  return { provider, capture };
}

describe("buildVibeCodeStartStreaming — attachments reach the ChatRequest", () => {
  it("the user message on the wire carries the attachments", async () => {
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      provider,
      config: { apiKey: "k" },
      resolveAppId: () => null,
      appEnvStore: new InMemoryAppEnvStore(),
      context: {
        username: "alice",
        hostname: "home",
        tier: "free",
        availableProviders: ["anthropic"],
      },
      existingAppsSnapshot: () => [],
      defaultModel: "claude-haiku",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await startStreaming({
      sessionId: session.meta.sessionId,
      prompt: "build me a thing like this",
      attachments: [img()],
    });

    const userMsg = capture.request!.messages.find((m) => m.role === "user")!;
    expect(userMsg.attachments).toHaveLength(1);
    expect(userMsg.attachments![0]).toMatchObject({ kind: "image", mediaType: "image/png" });
  });

  it("no attachments ⇒ a plain user message (backward compatible)", async () => {
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      provider,
      config: { apiKey: "k" },
      resolveAppId: () => null,
      appEnvStore: new InMemoryAppEnvStore(),
      context: {
        username: "alice",
        hostname: "home",
        tier: "free",
        availableProviders: ["anthropic"],
      },
      existingAppsSnapshot: () => [],
      defaultModel: "m",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "x" });
    const userMsg = capture.request!.messages.find((m) => m.role === "user")!;
    expect(userMsg.attachments).toBeUndefined();
  });
});
