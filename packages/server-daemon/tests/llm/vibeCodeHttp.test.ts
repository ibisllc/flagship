/**
 * Tests for the vibe-code HTTP surface.
 */

import { describe, expect, it } from "vitest";
import { TokenSetSessionGate } from "../../src/alertInboxHttp.js";
import {
  VibeCodeSessionRegistry,
} from "../../src/llm/vibeCodeSession.js";
import { buildVibeCodeHttpHandlers } from "../../src/llm/vibeCodeHttp.js";
import type { HttpRequest } from "../../src/runtime.js";

function req(args: { method?: string; path: string; token?: string; body?: object }): HttpRequest {
  const headers: Record<string, string> = {};
  if (args.token) headers["authorization"] = `Flagship-Session ${args.token}`;
  return {
    method: args.method ?? "POST",
    path: args.path,
    headers,
    body: args.body ? Buffer.from(JSON.stringify(args.body)) : Buffer.alloc(0),
  };
}

const HOST = "home.alice.flagship.services";
const USER = "alice";
const SECRET = "phone-paired-secret";

function setup() {
  const registry = new VibeCodeSessionRegistry();
  const gate = new TokenSetSessionGate(new Set([SECRET]));
  return { registry, gate };
}

describe("vibe-code HTTP", () => {
  it("returns null for non-/api/llm/sessions paths", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const r = await handle(req({ method: "GET", path: "/api/health" }));
    expect(r).toBeNull();
  });

  it("rejects without paired-session token (401)", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const r = await handle(req({ method: "POST", path: "/api/llm/sessions", body: { prompt: "x" } }));
    expect(r?.status).toBe(401);
  });

  it("POST /api/llm/sessions creates a session", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const r = await handle(req({
      method: "POST",
      path: "/api/llm/sessions",
      token: SECRET,
      body: { prompt: "Build a habit tracker" },
    }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body.toString()) as { sessionId: string };
    expect(body.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(registry.list().length).toBe(1);
  });

  it("400 when prompt is missing", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const r = await handle(req({
      method: "POST", path: "/api/llm/sessions", token: SECRET, body: {},
    }));
    expect(r?.status).toBe(400);
  });

  it("feed + end roundtrip parses files", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const create = await handle(req({
      method: "POST", path: "/api/llm/sessions", token: SECRET,
      body: { prompt: "x" },
    }));
    const sid = JSON.parse(create!.body.toString()).sessionId as string;

    await handle(req({
      method: "POST", path: `/api/llm/sessions/${sid}/feed`, token: SECRET,
      body: { chunk: "=== flagship.app.json ===\n{}\n" },
    }));
    const endR = await handle(req({
      method: "POST", path: `/api/llm/sessions/${sid}/end`, token: SECRET,
    }));
    expect(endR?.status).toBe(200);
    const body = JSON.parse(endR!.body.toString()) as { manifestJson: string };
    expect(body.manifestJson).toContain("{}");
  });

  it("GET returns meta + files + conversation", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const create = await handle(req({
      method: "POST", path: "/api/llm/sessions", token: SECRET,
      body: { prompt: "Build a habit tracker" },
    }));
    const sid = JSON.parse(create!.body.toString()).sessionId as string;
    const r = await handle(req({ method: "GET", path: `/api/llm/sessions/${sid}`, token: SECRET }));
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body.toString()) as { conversation: Array<{ role: string }> };
    expect(body.conversation[0]?.role).toBe("user");
  });

  it("deploy invokes the injected hook + flips status", async () => {
    const { registry, gate } = setup();
    let calls = 0;
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
      deploySession: async () => {
        calls++;
        return { ok: true, appId: "alice--habits", url: "https://habits.alice.flagship.services" };
      },
    });
    const create = await handle(req({
      method: "POST", path: "/api/llm/sessions", token: SECRET,
      body: { prompt: "x" },
    }));
    const sid = JSON.parse(create!.body.toString()).sessionId as string;
    const r = await handle(req({
      method: "POST", path: `/api/llm/sessions/${sid}/deploy`, token: SECRET,
    }));
    expect(r?.status).toBe(200);
    expect(calls).toBe(1);
    expect(registry.get(sid)?.meta.status).toBe("deployed");
  });

  it("503 when deploy hook isn't wired", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const create = await handle(req({
      method: "POST", path: "/api/llm/sessions", token: SECRET,
      body: { prompt: "x" },
    }));
    const sid = JSON.parse(create!.body.toString()).sessionId as string;
    const r = await handle(req({
      method: "POST", path: `/api/llm/sessions/${sid}/deploy`, token: SECRET,
    }));
    expect(r?.status).toBe(503);
  });

  it("cancel marks session cancelled", async () => {
    const { registry, gate } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry, gate, username: USER, serverFqdn: HOST,
    });
    const create = await handle(req({
      method: "POST", path: "/api/llm/sessions", token: SECRET,
      body: { prompt: "x" },
    }));
    const sid = JSON.parse(create!.body.toString()).sessionId as string;
    await handle(req({
      method: "POST", path: `/api/llm/sessions/${sid}/cancel`, token: SECRET,
    }));
    expect(registry.get(sid)?.meta.status).toBe("cancelled");
  });
});
