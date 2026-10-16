/**
 * W10 — screens BFF: per-app env-var editor + vibe-code session
 * public state + reply + notifyOwner fan-out hook.
 *
 * Three contracts under test:
 *
 *   1. `/api/screens/services/:appId/env` round-trip (set → list → unset)
 *      — values never appear in any response (set ok-only, list names-only,
 *      unset ok-only).
 *
 *   2. `/api/screens/llm/sessions/:sessionId` public state — model's
 *      pendingRequest surfaces metadata only (no value field). The
 *      structural-no-value invariant from vibeCodeSession.ts is also
 *      asserted here for the BFF layer.
 *
 *   3. VibeCodeSession.notifyOwner fires once on the
 *      streaming → awaiting-tool-response transition.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  serviceEnvValueSha256,
  signServiceEnvChange,
  type ServiceEnvChange,
} from "@flagship/protocol";
import {
  buildScreensHttp,
  type ScreensHttpDeps,
} from "../../src/screens/screensHttp.js";
import {
  InMemoryAppEnvStore,
  type AppEnvStore,
} from "../../src/serviceEnvStore.js";
import {
  VibeCodeSession,
  VibeCodeSessionRegistry,
  type NotifyOwnerCallback,
} from "../../src/llm/vibeCodeSession.js";
import type { HttpRequest } from "../../src/runtime.js";
import { ServicePlatform } from "../../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../../src/serviceRunner.js";
import { swkOps } from "../helpers/keyCustody.js";

const SERVER_FQDN = "home.alice.flagship.services";
const USERNAME = "alice";

function req(over: Partial<HttpRequest>): HttpRequest {
  return {
    method: "GET",
    path: "/",
    headers: {},
    body: Buffer.alloc(0),
    ...over,
  };
}

function fakeGate(token = "tok-good") {
  return {
    has: (t: string) => t === token,
    check: (r: HttpRequest) => {
      const h = r.headers["x-flagship-session"];
      if (typeof h === "string" && h === token) return null;
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "unauthorized" }),
      };
    },
  };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const NOW = 1_000_000;

function realPlatform(store: AppEnvStore, irkPub: Uint8Array): ScreensHttpDeps["servicePlatform"] {
  const swkBytes = new Uint8Array(32);
  swkBytes[0] = 7;
  const cmd: CommandRunner = {
    run: async () => {},
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  return new ServicePlatform({
    host: { username: USERNAME, irkPub },
    swk: swkOps(swkBytes),
    appRunner: new AppRunner(cmd),
    dataProvisioner: null,
    envStore: store,
    serverFqdn: SERVER_FQDN,
    now: () => NOW,
  }) as unknown as ScreensHttpDeps["servicePlatform"];
}

function envHarness(seedByte: number) {
  const store = new InMemoryAppEnvStore();
  const seed = new Uint8Array(32);
  seed[0] = seedByte;
  const irkPub = ed.getPublicKey(seed);
  const handle = buildScreensHttp({
    gate: fakeGate(),
    serverFqdn: SERVER_FQDN,
    username: USERNAME,
    daemonVersion: "test",
    startedAt: 0,
    servicePlatform: realPlatform(store, irkPub),
    appEnvStore: store,
    now: () => NOW,
  });
  let n = 0;
  const change = (op: "set" | "unset", name: string, value?: string, serviceId = "alice--todos"): ServiceEnvChange => ({
    serverId: SERVER_FQDN,
    serviceId,
    op,
    name,
    valueSha256: op === "set" ? serviceEnvValueSha256(value ?? "") : "",
    issuedAt: NOW,
    nonce: (++n + seedByte * 1000).toString(16).padStart(32, "0"),
  });
  const sign = (c: ServiceEnvChange) => hex(signServiceEnvChange(c, { publicKey: irkPub, privateKey: seed }));
  const post = (path: string, body: unknown) =>
    handle(
      req({
        method: "POST",
        path,
        headers: { "x-flagship-session": "tok-good", "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(body)),
      }),
    );
  const names = async (appId: string) => {
    const r = await handle(req({ path: `/api/screens/services/${appId}/env`, headers: { "x-flagship-session": "tok-good" } }));
    return JSON.parse(r!.body as string).names as string[];
  };
  const set = (appId: string, name: string, value: string) => {
    const c = change("set", name, value);
    return post(`/api/screens/services/${appId}/env/set`, { change: c, value, signature: sign(c) });
  };
  const unset = (appId: string, name: string) => {
    const c = change("unset", name);
    return post(`/api/screens/services/${appId}/env/unset`, { change: c, signature: sign(c) });
  };
  return { store, handle, change, sign, post, names, set, unset };
}

describe("W10 — services env-var KV editor", () => {
  const appId = "alice--todos";

  it("round-trip: set → list returns names (no values) → unset", async () => {
    const h = envHarness(0xa1);
    const SECRET_VALUE = "sk-DO-NOT-LEAK-XYZ-123456";
    const setResp = await h.set(appId, "OPENAI_API_KEY", SECRET_VALUE);
    expect(setResp?.status).toBe(200);
    expect(JSON.parse(setResp!.body as string).ok).toBe(true);
    // Crucial invariant: the response body NEVER carries the value.
    expect(setResp!.body as string).not.toContain(SECRET_VALUE);
    expect(await h.names(appId)).toEqual(["OPENAI_API_KEY"]);

    const unsetResp = await h.unset(appId, "OPENAI_API_KEY");
    expect(unsetResp?.status).toBe(200);
    expect(JSON.parse(unsetResp!.body as string).ok).toBe(true);
    expect(await h.names(appId)).toEqual([]);
  });

  it("a second set keeps the first variable, and unset drops only its own name", async () => {
    const h = envHarness(0xa4);
    expect((await h.set(appId, "A_KEY", "one"))?.status).toBe(200);
    expect((await h.set(appId, "B_KEY", "two"))?.status).toBe(200);
    expect(await h.names(appId)).toEqual(["A_KEY", "B_KEY"]);
    expect((await h.set(appId, "A_KEY", "uno"))?.status).toBe(200);
    expect(await h.store.get(appId)).toEqual({ A_KEY: "uno", B_KEY: "two" });

    expect((await h.unset(appId, "A_KEY"))?.status).toBe(200);
    expect(await h.store.get(appId)).toEqual({ B_KEY: "two" });
  });

  it("a replayed unset is refused and can't take away a variable set again", async () => {
    const h = envHarness(0xa5);
    await h.set(appId, "A_KEY", "one");
    const c = h.change("unset", "A_KEY");
    const body = { change: c, signature: h.sign(c) };
    expect((await h.post(`/api/screens/services/${appId}/env/unset`, body))?.status).toBe(200);
    await h.set(appId, "A_KEY", "again");
    const replay = await h.post(`/api/screens/services/${appId}/env/unset`, body);
    expect(replay?.status).toBe(400);
    expect(JSON.parse(replay!.body as string).error).toBe("this change was already applied");
    expect(await h.store.get(appId)).toEqual({ A_KEY: "again" });
  });

  it("an unset signed for one name can't remove another", async () => {
    const h = envHarness(0xa6);
    await h.set(appId, "A_KEY", "one");
    await h.set(appId, "B_KEY", "two");
    const c = h.change("unset", "A_KEY");
    const r = await h.post(`/api/screens/services/${appId}/env/unset`, { change: { ...c, name: "B_KEY" }, signature: h.sign(c) });
    expect(r?.status).toBe(400);
    expect(await h.store.get(appId)).toEqual({ A_KEY: "one", B_KEY: "two" });
  });

  it("refuses a change for another app, the wrong route's op, or a value that isn't the signed one", async () => {
    const h = envHarness(0xa2);
    const other = h.change("set", "FOO", "bar", "alice--other");
    let r = await h.post(`/api/screens/services/${appId}/env/set`, { change: other, value: "bar", signature: h.sign(other) });
    expect(r?.status).toBe(400);
    expect(JSON.parse(r!.body as string).error).toBe("the change names another app");
    const set = h.change("set", "FOO", "bar");
    r = await h.post(`/api/screens/services/${appId}/env/unset`, { change: set, signature: h.sign(set) });
    expect(JSON.parse(r!.body as string).error).toBe("the change is not an unset");
    r = await h.post(`/api/screens/services/${appId}/env/set`, { change: set, value: "DIFFERENT", signature: h.sign(set) });
    expect(r?.status).toBe(400);
    expect(JSON.parse(r!.body as string).error).toBe("the value doesn't match the signed change");
    expect(r!.body as string).not.toContain("DIFFERENT");
    expect(await h.names(appId)).toEqual([]);
  });
});

describe("W10 — vibe-code session public state + reply", () => {
  it("GET surfaces pendingRequest metadata only (no value field)", async () => {
    const reg = new VibeCodeSessionRegistry();
    const sessions: VibeCodeSession[] = [];
    const session = reg.create({ username: USERNAME, serverFqdn: SERVER_FQDN });
    sessions.push(session);
    session.pushUserMessage("Build a thing");
    session.receiveToolUse({
      id: "tu_42",
      name: "requestEnvVar",
      input: {
        name: "OPENAI_API_KEY",
        description: "Your OpenAI key",
        why: "for completions",
        example: "sk-…",
        secret: true,
      },
    });
    const handle = buildScreensHttp({
      gate: fakeGate(),
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      daemonVersion: "test",
      startedAt: 0,
      vibeCode: { registry: reg, username: USERNAME, serverFqdn: SERVER_FQDN },
    });
    const resp = await handle(
      req({
        path: `/api/screens/llm/sessions/${session.meta.sessionId}`,
        headers: { "x-flagship-session": "tok-good" },
      }),
    );
    expect(resp?.status).toBe(200);
    const body = JSON.parse(resp!.body as string);
    expect(body.id).toBe(session.meta.sessionId);
    expect(body.status).toBe("awaiting-tool-response");
    expect(body.pendingRequest.kind).toBe("requestEnvVar");
    expect(body.pendingRequest.payload.name).toBe("OPENAI_API_KEY");
    expect(body.pendingRequest.payload.description).toBe("Your OpenAI key");
    // STRUCTURAL invariant: no "value" field anywhere on the payload.
    expect(body.pendingRequest.payload.value).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("\"value\":");
  });

  it("POST /reply routes a talkToUser reply via pushUserReply", async () => {
    const reg = new VibeCodeSessionRegistry();
    const session = reg.create({ username: USERNAME, serverFqdn: SERVER_FQDN });
    session.pushUserMessage("hi");
    session.receiveToolUse({
      id: "tu_a",
      name: "talkToUser",
      input: { message: "what color?" },
    });
    const handle = buildScreensHttp({
      gate: fakeGate(),
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      daemonVersion: "test",
      startedAt: 0,
      vibeCode: { registry: reg, username: USERNAME, serverFqdn: SERVER_FQDN },
    });
    const resp = await handle(
      req({
        method: "POST",
        path: `/api/screens/llm/sessions/${session.meta.sessionId}/reply`,
        headers: {
          "x-flagship-session": "tok-good",
          "content-type": "application/json",
        },
        body: Buffer.from(JSON.stringify({ text: "blue" })),
      }),
    );
    expect(resp?.status).toBe(200);
    expect(JSON.parse(resp!.body as string).ok).toBe(true);
    expect(session.meta.status).toBe("streaming");
    const conv = session.conversation();
    expect(conv[conv.length - 1]!.content).toBe("blue");
  });

  it("POST /reply routes a requestEnvVar ack with VALUE-FREE payload", async () => {
    const reg = new VibeCodeSessionRegistry();
    const session = reg.create({ username: USERNAME, serverFqdn: SERVER_FQDN });
    session.pushUserMessage("x");
    session.receiveToolUse({
      id: "tu_b",
      name: "requestEnvVar",
      input: {
        name: "STRIPE_KEY",
        description: "Stripe live key",
        why: "billing",
      },
    });
    const envStore = new InMemoryAppEnvStore();
    // Simulate the value having been POSTed to /env/set first.
    await envStore.put("alice-x", { STRIPE_KEY: "sk-FAKE-NEVER-LEAKED" });
    const handle = buildScreensHttp({
      gate: fakeGate(),
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      daemonVersion: "test",
      startedAt: 0,
      vibeCode: { registry: reg, username: USERNAME, serverFqdn: SERVER_FQDN },
      appEnvStore: envStore,
      resolveSessionAppId: () => "alice-x",
    });
    const resp = await handle(
      req({
        method: "POST",
        path: `/api/screens/llm/sessions/${session.meta.sessionId}/reply`,
        headers: {
          "x-flagship-session": "tok-good",
          "content-type": "application/json",
        },
        body: Buffer.from(JSON.stringify({ envVarStatus: "set" })),
      }),
    );
    expect(resp?.status).toBe(200);
    expect(JSON.parse(resp!.body as string).ok).toBe(true);
    expect(session.meta.status).toBe("streaming");
    // The synthetic tool_result that gets fed back to the model is in
    // the conversation history — verify it carries NO value.
    const lastUser = [...session.conversation()]
      .reverse()
      .find((m) => m.role === "user");
    expect(lastUser?.content).toContain("[tool_result:tu_b]");
    expect(lastUser?.content).toContain("\"currentlySet\":true");
    expect(lastUser?.content).not.toContain("sk-FAKE-NEVER-LEAKED");
  });

  it("messages() omits synthetic [tool_result:…] entries from the chat log", async () => {
    const reg = new VibeCodeSessionRegistry();
    const session = reg.create({ username: USERNAME, serverFqdn: SERVER_FQDN });
    session.pushUserMessage("user msg 1");
    session.receiveToolUse({
      id: "tu_c",
      name: "requestEnvVar",
      input: { name: "K", description: "d", why: "w" },
    });
    session.pushEnvVarAck({
      toolUseId: "tu_c",
      ack: { acknowledged: true, name: "K", status: "set", currentlySet: true },
    });
    const handle = buildScreensHttp({
      gate: fakeGate(),
      serverFqdn: SERVER_FQDN,
      username: USERNAME,
      daemonVersion: "test",
      startedAt: 0,
      vibeCode: { registry: reg, username: USERNAME, serverFqdn: SERVER_FQDN },
    });
    const resp = await handle(
      req({
        path: `/api/screens/llm/sessions/${session.meta.sessionId}`,
        headers: { "x-flagship-session": "tok-good" },
      }),
    );
    const body = JSON.parse(resp!.body as string);
    // The synthetic [tool_result:…] entry must be hidden from the chat
    // view — it's model-facing metadata, not a human-visible message.
    for (const m of body.messages) {
      expect(m.text.startsWith("[tool_result:")).toBe(false);
    }
  });
});

describe("W10 — notifyOwner fires on awaiting-tool-response transition", () => {
  it("registry installs the hook onto fresh sessions; hook fires once per tool_use", () => {
    const calls: Array<{ sessionId: string; kind: string; toolUseId: string }> = [];
    const cb: NotifyOwnerCallback = ({ sessionId, kind, toolUseId }) => {
      calls.push({ sessionId, kind, toolUseId });
    };
    const reg = new VibeCodeSessionRegistry();
    reg.setNotifyOwner(cb);
    const s = reg.create({ username: USERNAME, serverFqdn: SERVER_FQDN });
    s.pushUserMessage("Build a Stripe widget");

    // Streaming → awaiting-tool-response = ONE notify fire.
    s.receiveToolUse({
      id: "tu_x",
      name: "requestEnvVar",
      input: { name: "STRIPE_KEY", description: "d", why: "w" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      sessionId: s.meta.sessionId,
      kind: "requestEnvVar",
      toolUseId: "tu_x",
    });

    // Another tool_use mid-pause does NOT re-fire (status was already
    // awaiting-tool-response). Coalescing avoids push flurries.
    s.receiveToolUse({
      id: "tu_y",
      name: "talkToUser",
      input: { message: "hmm" },
    });
    expect(calls).toHaveLength(1);

    // Ack both, return to streaming, then a NEW tool_use re-fires once.
    s.pushEnvVarAck({
      toolUseId: "tu_x",
      ack: { acknowledged: true, name: "STRIPE_KEY", status: "set", currentlySet: true },
    });
    s.pushUserReply({ toolUseId: "tu_y", text: "ok" });
    expect(s.meta.status).toBe("streaming");
    s.receiveToolUse({
      id: "tu_z",
      name: "talkToUser",
      input: { message: "anything else?" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.kind).toBe("talkToUser");
  });

  it("notifyOwner errors do not break the session", () => {
    const reg = new VibeCodeSessionRegistry();
    reg.setNotifyOwner(() => {
      throw new Error("push relay down");
    });
    const s = reg.create({ username: USERNAME, serverFqdn: SERVER_FQDN });
    s.pushUserMessage("x");
    // Must not throw.
    expect(() => {
      s.receiveToolUse({
        id: "tu_e",
        name: "talkToUser",
        input: { message: "?" },
      });
    }).not.toThrow();
    expect(s.meta.status).toBe("awaiting-tool-response");
  });
});
