/**
 * HTTP-surface tests for the two new endpoints (`user-reply`, `tool-ack`)
 * plus the existing-endpoint state-machine guards.
 */

import { describe, expect, it } from "vitest";
import { TokenSetSessionGate } from "../../src/alertInboxHttp.js";
import { InMemoryAppEnvStore } from "../../src/appEnvStore.js";
import { buildVibeCodeHttpHandlers } from "../../src/llm/vibeCodeHttp.js";
import { VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import type { HttpRequest } from "../../src/runtime.js";

const SECRET_TOKEN = "phone-paired";
const SECRET_SENTINEL = "DO-NOT-LEAK-VALUE-sk-9b2c";

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

function setup() {
  const registry = new VibeCodeSessionRegistry();
  const gate = new TokenSetSessionGate(new Set([SECRET_TOKEN]));
  const appEnvStore = new InMemoryAppEnvStore();
  return { registry, gate, appEnvStore };
}

describe("vibe-code HTTP — tool endpoints", () => {
  it("tool-ack: 'set' returns value-free ack with currentlySet=true; conversation never contains the value", async () => {
    const { registry, gate, appEnvStore } = setup();
    // Pre-seed the store with the SENTINEL value the owner just set via
    // the signed set-app-env order. The model MUST NEVER see it.
    await appEnvStore.put("alice-stripe", { STRIPE_KEY: SECRET_SENTINEL });

    const handle = buildVibeCodeHttpHandlers({
      registry,
      gate,
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
      appEnvStore,
      resolveAppId: () => "alice-stripe",
    });
    const created = await handle(
      req({ method: "POST", path: "/api/llm/sessions", token: SECRET_TOKEN, body: { prompt: "build" } }),
    );
    const sid = JSON.parse(created!.body.toString()).sessionId as string;
    const session = registry.get(sid)!;
    session.receiveToolUse({
      id: "tu_set",
      name: "requestEnvVar",
      input: { name: "STRIPE_KEY", description: "stripe", why: "billing" },
    });

    const r = await handle(
      req({
        method: "POST",
        path: `/api/llm/sessions/${sid}/tool-ack`,
        token: SECRET_TOKEN,
        body: { toolUseId: "tu_set", status: "set" },
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body.toString()) as { ack: { currentlySet: boolean; name: string } };
    expect(body.ack.currentlySet).toBe(true);
    expect(body.ack.name).toBe("STRIPE_KEY");
    // Sentinel must not be in the HTTP response.
    expect(r!.body.toString()).not.toContain(SECRET_SENTINEL);

    // Conversation history must not contain the sentinel either.
    const conv = session.conversation();
    expect(conv.map((m) => m.content).join("\n")).not.toContain(SECRET_SENTINEL);
  });

  it("tool-ack: 'declined' is value-free + currentlySet honestly false when name absent", async () => {
    const { registry, gate, appEnvStore } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry,
      gate,
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
      appEnvStore,
      resolveAppId: () => "alice-x",
    });
    const c = await handle(req({ method: "POST", path: "/api/llm/sessions", token: SECRET_TOKEN, body: { prompt: "p" } }));
    const sid = JSON.parse(c!.body.toString()).sessionId as string;
    const session = registry.get(sid)!;
    session.receiveToolUse({
      id: "tu_d",
      name: "requestEnvVar",
      input: { name: "MISSING_KEY", description: "x", why: "y" },
    });
    const r = await handle(
      req({
        method: "POST",
        path: `/api/llm/sessions/${sid}/tool-ack`,
        token: SECRET_TOKEN,
        body: { toolUseId: "tu_d", status: "declined" },
      }),
    );
    expect(r?.status).toBe(200);
    const body = JSON.parse(r!.body.toString()) as { ack: { currentlySet: boolean; status: string } };
    expect(body.ack.currentlySet).toBe(false);
    expect(body.ack.status).toBe("declined");
  });

  it("tool-ack: 400 on bad status; 404 on missing tool-use id; 400 when tool is not requestEnvVar", async () => {
    const { registry, gate, appEnvStore } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry,
      gate,
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
      appEnvStore,
      resolveAppId: () => null,
    });
    const c = await handle(req({ method: "POST", path: "/api/llm/sessions", token: SECRET_TOKEN, body: { prompt: "p" } }));
    const sid = JSON.parse(c!.body.toString()).sessionId as string;
    const session = registry.get(sid)!;
    // Bad status.
    let r = await handle(
      req({
        method: "POST",
        path: `/api/llm/sessions/${sid}/tool-ack`,
        token: SECRET_TOKEN,
        body: { toolUseId: "x", status: "garbage" },
      }),
    );
    expect(r?.status).toBe(400);
    // Missing.
    r = await handle(
      req({
        method: "POST",
        path: `/api/llm/sessions/${sid}/tool-ack`,
        token: SECRET_TOKEN,
        body: { toolUseId: "nope", status: "set" },
      }),
    );
    expect(r?.status).toBe(404);
    // Wrong tool kind.
    session.receiveToolUse({ id: "tu_chat", name: "talkToUser", input: { message: "?" } });
    r = await handle(
      req({
        method: "POST",
        path: `/api/llm/sessions/${sid}/tool-ack`,
        token: SECRET_TOKEN,
        body: { toolUseId: "tu_chat", status: "set" },
      }),
    );
    expect(r?.status).toBe(400);
  });

  it("user-reply: flips state back to streaming and appends owner text", async () => {
    const { registry, gate, appEnvStore } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry,
      gate,
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
      appEnvStore,
    });
    const c = await handle(req({ method: "POST", path: "/api/llm/sessions", token: SECRET_TOKEN, body: { prompt: "p" } }));
    const sid = JSON.parse(c!.body.toString()).sessionId as string;
    const session = registry.get(sid)!;
    session.receiveToolUse({ id: "tu_u", name: "talkToUser", input: { message: "what color?" } });
    expect(session.meta.status).toBe("awaiting-tool-response");
    const r = await handle(
      req({
        method: "POST",
        path: `/api/llm/sessions/${sid}/user-reply`,
        token: SECRET_TOKEN,
        body: { toolUseId: "tu_u", text: "blue please" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(session.meta.status).toBe("streaming");
    expect(session.conversation().slice(-1)[0]?.content).toBe("blue please");
  });

  it("user-reply: pasted-secret heuristic fires observational warning (does NOT block)", async () => {
    const { registry, gate, appEnvStore } = setup();
    let warned: { sessionId: string; toolUseId: string } | null = null;
    const handle = buildVibeCodeHttpHandlers({
      registry,
      gate,
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
      appEnvStore,
      onPastedSecretSuspicion: (a) => {
        warned = a;
      },
    });
    const c = await handle(req({ method: "POST", path: "/api/llm/sessions", token: SECRET_TOKEN, body: { prompt: "p" } }));
    const sid = JSON.parse(c!.body.toString()).sessionId as string;
    registry.get(sid)!.receiveToolUse({ id: "tu_w", name: "talkToUser", input: { message: "?" } });
    const r = await handle(
      req({
        method: "POST",
        path: `/api/llm/sessions/${sid}/user-reply`,
        token: SECRET_TOKEN,
        body: { toolUseId: "tu_w", text: "sk-deadbeef0123456789abcdefABCDEF" },
      }),
    );
    expect(r?.status).toBe(200);
    expect(warned).toBeTruthy();
    expect(warned!.sessionId).toBe(sid);
  });

  it("deploy is rejected (409) while awaiting-tool-response", async () => {
    const { registry, gate, appEnvStore } = setup();
    const handle = buildVibeCodeHttpHandlers({
      registry,
      gate,
      username: "alice",
      serverFqdn: "home.alice.flagship.services",
      appEnvStore,
      deploySession: async () => ({ ok: true, appId: "alice-x", url: "https://x.alice.flagship.services" }),
    });
    const c = await handle(req({ method: "POST", path: "/api/llm/sessions", token: SECRET_TOKEN, body: { prompt: "p" } }));
    const sid = JSON.parse(c!.body.toString()).sessionId as string;
    registry.get(sid)!.receiveToolUse({ id: "tu_p", name: "requestEnvVar", input: { name: "X", description: "d", why: "w" } });
    const r = await handle(req({ method: "POST", path: `/api/llm/sessions/${sid}/deploy`, token: SECRET_TOKEN }));
    expect(r?.status).toBe(409);
  });
});
