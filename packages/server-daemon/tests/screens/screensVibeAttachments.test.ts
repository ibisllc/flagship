/**
 * Scratch chat (vibe-code) over the screens BFF carries attachments:
 *   - POST /api/screens/vibe-code/start accepts + validates attachments,
 *     pushes them into the session, and journals the turn VALUE-FREE.
 *   - caps (count / size / kind) are rejected at the HTTP boundary.
 *   - the journal records a user-message + attachment-added entry whose
 *     summary is name/kind/size ONLY — never the content/base64.
 */

import { describe, expect, it } from "vitest";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import type { HttpRequest } from "../../src/runtime.js";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
}

function fakeGate(token = "tok-good") {
  return {
    has: (t: string) => t === token,
    check: (r: HttpRequest) => {
      const h = r.headers["x-flagship-session"];
      if (typeof h === "string" && h === token) return null;
      return { status: 401, headers: {}, body: JSON.stringify({ error: "unauthorized" }) };
    },
  };
}

function post(path: string, body: unknown): HttpRequest {
  return req({
    method: "POST",
    path,
    headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  });
}

type Recorded = { sessionId: string; text: string; attachmentSummaries: string[] };

function build(recorded: Recorded[]) {
  const reg = new VibeCodeSessionRegistry();
  const handle = buildScreensHttp({
    gate: fakeGate(),
    serverFqdn: SERVER_FQDN,
    username: USERNAME,
    daemonVersion: "test",
    startedAt: 0,
    vibeCode: {
      registry: reg,
      username: USERNAME,
      serverFqdn: SERVER_FQDN,
      recordScratchTurn: (a) => recorded.push(a),
    },
  });
  return { reg, handle };
}

describe("screens BFF — scratch chat attachments", () => {
  it("start accepts attachments, stores them, and journals value-free", async () => {
    const recorded: Recorded[] = [];
    const { reg, handle } = build(recorded);
    const resp = await handle(
      post("/api/screens/vibe-code/start", {
        prompt: "make it look like this",
        attachments: [
          { kind: "image", mediaType: "image/png", dataBase64: PNG_1x1, name: "shot.png" },
          { kind: "text", name: "schema.sql", text: "create table t(id int);" },
        ],
      }),
    );
    expect(resp?.status).toBe(200);
    const { sessionId } = JSON.parse(resp!.body as string);
    const session = reg.get(sessionId)!;
    const msgs = session.messages();
    expect(msgs[0]!.attachments).toHaveLength(2);

    // Journal: one turn record, summaries are name/kind/size, no content.
    expect(recorded).toHaveLength(1);
    const rec = recorded[0]!;
    expect(rec.sessionId).toBe(sessionId);
    expect(rec.attachmentSummaries).toHaveLength(2);
    const joined = rec.attachmentSummaries.join(" | ");
    expect(joined).toContain("shot.png");
    expect(joined).toContain("schema.sql");
    // VALUE-FREE: neither the base64 nor the text body is journaled.
    expect(joined).not.toContain(PNG_1x1);
    expect(joined).not.toContain("create table t");
  });

  it("rejects too many attachments at the HTTP boundary", async () => {
    const recorded: Recorded[] = [];
    const { handle } = build(recorded);
    const many = Array.from({ length: 7 }, () => ({
      kind: "image",
      mediaType: "image/png",
      dataBase64: PNG_1x1,
    }));
    const resp = await handle(post("/api/screens/vibe-code/start", { prompt: "x", attachments: many }));
    expect(resp?.status).toBe(400);
    expect(JSON.parse(resp!.body as string).error).toMatch(/too many/i);
    expect(recorded).toHaveLength(0);
  });

  it("rejects an unsupported attachment media type", async () => {
    const recorded: Recorded[] = [];
    const { handle } = build(recorded);
    const resp = await handle(
      post("/api/screens/vibe-code/start", {
        prompt: "x",
        attachments: [{ kind: "image", mediaType: "image/tiff", dataBase64: PNG_1x1 }],
      }),
    );
    expect(resp?.status).toBe(400);
    expect(JSON.parse(resp!.body as string).error).toMatch(/unsupported/i);
  });

  it("a no-attachments start still works (backward compatible) and journals the text", async () => {
    const recorded: Recorded[] = [];
    const { handle } = build(recorded);
    const resp = await handle(post("/api/screens/vibe-code/start", { prompt: "a habit tracker" }));
    expect(resp?.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attachmentSummaries).toHaveLength(0);
    expect(recorded[0]!.text).toContain("habit tracker");
  });
});
