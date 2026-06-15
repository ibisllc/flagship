import { describe, it, expect } from "vitest";
import { anthropic, type FetchLike, type ChatRequest } from "../src/index.js";

interface Captured {
  body: any;
}

function fakeFetch(): { f: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const f: FetchLike = async (_url, init) => {
    calls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
    return {
      ok: true,
      status: 200,
      async text() {
        return "";
      },
      async json() {
        return { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" };
      },
    };
  };
  return { f, calls };
}

describe("anthropic multimodal attachments", () => {
  it("keeps plain string content when there are no attachments (backward compatible)", async () => {
    const { f, calls } = fakeFetch();
    const req: ChatRequest = { model: "claude", messages: [{ role: "user", content: "hello" }] };
    await anthropic.chat(req, { apiKey: "x" }, f);
    expect(calls[0]!.body.messages[0].content).toBe("hello");
  });

  it("translates an image attachment into an Anthropic base64 image block", async () => {
    const { f, calls } = fakeFetch();
    const req: ChatRequest = {
      model: "claude",
      messages: [
        {
          role: "user",
          content: "make it look like this",
          attachments: [{ kind: "image", mediaType: "image/png", dataBase64: "AAAA" }],
        },
      ],
    };
    await anthropic.chat(req, { apiKey: "x" }, f);
    const content = calls[0]!.body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "make it look like this" });
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("translates a text attachment into a labelled text block", async () => {
    const { f, calls } = fakeFetch();
    const req: ChatRequest = {
      model: "claude",
      messages: [
        {
          role: "user",
          content: "use this schema",
          attachments: [{ kind: "text", name: "schema.sql", text: "create table t(id int);" }],
        },
      ],
    };
    await anthropic.chat(req, { apiKey: "x" }, f);
    const content = calls[0]!.body.messages[0].content;
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("schema.sql:");
    expect(content[1].text).toContain("create table t");
  });

  it("omits the leading text block when the message text is empty", async () => {
    const { f, calls } = fakeFetch();
    const req: ChatRequest = {
      model: "claude",
      messages: [{ role: "user", content: "", attachments: [{ kind: "image", mediaType: "image/jpeg", dataBase64: "Zz" }] }],
    };
    await anthropic.chat(req, { apiKey: "x" }, f);
    const content = calls[0]!.body.messages[0].content;
    expect(content.length).toBe(1);
    expect(content[0].type).toBe("image");
  });
});
