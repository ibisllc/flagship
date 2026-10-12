import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveSWK } from "@flagship/protocol";
import {
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_OUTBOUND_CREDIT,
  OUTBOUND_INITIAL_WINDOW,
  OUTBOUND_STREAM_ID_BASE,
  parseOutboundCredit,
  type Frame,
} from "@flagship/tunnel-protocol";
import {
  defaultStreamingRegistry,
  ProviderRegistry,
  UnsafeBaseUrlError,
  type ChatStreamEvent,
  type FetchLike,
  type StreamingFetchLike,
} from "@flagship/llm-providers";
import { swkOps } from "./helpers/keyCustody.js";
import {
  isLocalEndpoint,
  LlmHarness,
  parseRelayFlag,
  routeProviderFetch,
} from "../src/llmHarness.js";
import { OutboundStream, RELAY_UNAVAILABLE_MESSAGE } from "../src/tunnel/outboundStream.js";
import type { ProviderRelay } from "../src/tunnel/relayFetch.js";
import { FileBuildCredentialStore } from "../src/llm/buildCredentialStore.js";
import { superviseTunnelClient } from "../src/tunnel/tunnelClient.js";

const swk = swkOps(deriveSWK({ seed: new Uint8Array(32).fill(3) }, "srv-relay"));

function spyFetch(name: string, calls: string[]): FetchLike {
  return async (url) => {
    calls.push(`${name} ${url}`);
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  };
}

describe("relay routing for a provider call", () => {
  const route = (over: Partial<Parameters<typeof routeProviderFetch>[0]> = {}) => {
    const calls: string[] = [];
    const f = routeProviderFetch<FetchLike>({
      direct: spyFetch("direct", calls),
      relayed: spyFetch("relay", calls),
      relayAvailable: () => true,
      wantsRelay: true,
      resolveHost: async () => {
        throw new Error("must not resolve a provider's own host");
      },
      ...(over as object),
    } as Parameters<typeof routeProviderFetch<FetchLike>>[0]);
    return { f, calls };
  };

  it("relay on (the default) sends a public provider through the relay", async () => {
    const { f, calls } = route();
    await f("https://api.anthropic.com/v1/messages");
    expect(calls).toEqual(["relay https://api.anthropic.com/v1/messages"]);
  });

  it("relay off goes direct", async () => {
    const { f, calls } = route({ wantsRelay: false });
    await f("https://api.anthropic.com/v1/messages");
    expect(calls).toEqual(["direct https://api.anthropic.com/v1/messages"]);
  });

  it("relay on but unavailable fails closed and never goes direct", async () => {
    const errors: string[] = [];
    for (const over of [{ relayAvailable: () => false }, { relayed: undefined }]) {
      const { f, calls } = route({ ...over, onRelayError: (e) => errors.push(e.code) });
      await expect(f("https://api.openai.com/v1/chat/completions")).rejects.toThrow(RELAY_UNAVAILABLE_MESSAGE);
      expect(calls).toEqual([]);
    }
    expect(errors).toEqual(["unavailable", "unavailable"]);
  });

  it("local endpoints are always direct, even with the relay on and unavailable", async () => {
    for (const url of [
      "http://localhost:11434/api/chat",
      "http://127.0.0.1:11434/api/chat",
      "http://192.168.1.20:11434/api/chat",
      "http://[fd00::5]:11434/api/chat",
      "http://ollama:11434/api/chat",
      "http://gpu-box.lan:11434/api/chat",
      "http://studio.local:11434/api/chat",
    ]) {
      const { f, calls } = route({ relayAvailable: () => false });
      await f(url);
      expect(calls, url).toEqual([`direct ${url}`]);
    }
  });

  it("an owner baseUrl whose name resolves to a LAN address is direct; only that host is resolved", async () => {
    const resolved: string[] = [];
    const { f, calls } = route({
      baseUrl: "https://llm.myhouse.example",
      resolveHost: async (h: string) => {
        resolved.push(h);
        return ["192.168.4.4"];
      },
    });
    await f("https://llm.myhouse.example/v1/chat/completions");
    expect(calls).toEqual(["direct https://llm.myhouse.example/v1/chat/completions"]);
    expect(resolved).toEqual(["llm.myhouse.example"]);
  });

  it("the relay path keeps the promo host pin", async () => {
    const { f, calls } = route({ guard: { exclusiveHost: "coder.runpod.example" } });
    await expect(f("https://evil.example/v1/chat/completions")).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    await f("https://coder.runpod.example/v1/chat/completions");
    expect(calls).toEqual(["relay https://coder.runpod.example/v1/chat/completions"]);
  });

  it("isLocalEndpoint does not resolve without a resolver", async () => {
    expect(await isLocalEndpoint("https://api.anthropic.com/")).toBe(false);
    expect(await isLocalEndpoint("not a url")).toBe(false);
  });
});

describe("LlmHarness with the relay", () => {
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    'data: {"type":"message_stop"}',
  ];

  function fakeRelay(available: boolean, seen: string[]): ProviderRelay {
    const streamingFetch: StreamingFetchLike = async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        lines: async function* () {
          for (const l of sse) yield l;
        },
      };
    };
    return { available: () => available, fetch: spyFetch("relay", seen), streamingFetch };
  }

  it("streams through the relay for a default (relay-on) key", async () => {
    const seen: string[] = [];
    const h = new LlmHarness({ swk, streamingRegistry: defaultStreamingRegistry, relay: fakeRelay(true, seen) });
    const events: ChatStreamEvent[] = [];
    const out = await h.chatStream(
      { provider: "anthropic", apiKey: "sk-x" },
      { model: "m", messages: [{ role: "user", content: "hello" }] },
      (e) => events.push(e),
    );
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(events.some((e) => e.kind === "delta" && e.text === "hi")).toBe(true);
  });

  it("reports relay-unavailable with the owner-facing reason", async () => {
    const seen: string[] = [];
    const h = new LlmHarness({ swk, streamingRegistry: defaultStreamingRegistry, relay: fakeRelay(false, seen) });
    const out = await h.chatStream(
      { provider: "anthropic", apiKey: "sk-x" },
      { model: "m", messages: [{ role: "user", content: "hello" }] },
      () => {},
    );
    expect(out).toEqual({ ok: false, reason: "relay-unavailable", message: RELAY_UNAVAILABLE_MESSAGE });
    expect(seen).toEqual([]);
  });

  it("a harness with no relay wired fails relay-on keys rather than going direct", async () => {
    const registry = new ProviderRegistry([
      {
        name: "probe",
        chat: async (_req, _cfg, f) => {
          await f!("https://api.provider.example/v1");
          return { content: "", model: "m" };
        },
      },
    ]);
    const h = new LlmHarness({ swk, registry });
    await expect(
      h.chatWithCredential({ provider: "probe", apiKey: "k" }, { model: "m", messages: [] }),
    ).rejects.toThrow(RELAY_UNAVAILABLE_MESSAGE);
  });
});

describe("the relay flag on saved credentials", () => {
  it("parses absent / boolean / garbage", () => {
    expect(parseRelayFlag(undefined)).toBeUndefined();
    expect(parseRelayFlag(null)).toBeUndefined();
    expect(parseRelayFlag(false)).toBe(false);
    expect(parseRelayFlag(true)).toBe(true);
    expect(parseRelayFlag("false")).toBe("invalid");
    expect(parseRelayFlag(0)).toBe("invalid");
  });

  it("survives the sealed build-credential store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-cred-"));
    try {
      const s = new FileBuildCredentialStore(dir, swk);
      await s.put("0123456789abcdef", { provider: "openai", apiKey: "k", relay: false });
      await s.put("fedcba9876543210", { provider: "openai", apiKey: "k" });
      const reloaded = new FileBuildCredentialStore(dir, swk);
      await reloaded.load();
      expect(await reloaded.get("0123456789abcdef")).toEqual({ provider: "openai", apiKey: "k", relay: false });
      expect(await reloaded.get("fedcba9876543210")).toEqual({ provider: "openai", apiKey: "k" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("OutboundStream flow control (box side)", () => {
  const ID = OUTBOUND_STREAM_ID_BASE + 9;

  it("never sends more than the hub's credit, and resumes on credit", async () => {
    const frames: Frame[] = [];
    const s = new OutboundStream(ID, (f) => frames.push(f), () => {});
    let flushed = false;
    s.write(Buffer.alloc(OUTBOUND_INITIAL_WINDOW + 1000, 1), () => {
      flushed = true;
    });
    const dataBytes = () => frames.filter((f) => f.type === FRAME_DATA).reduce((n, f) => n + f.payload.length, 0);
    expect(dataBytes()).toBe(0); // not open yet
    s.markOpen();
    expect(dataBytes()).toBe(OUTBOUND_INITIAL_WINDOW);
    await new Promise((r) => setImmediate(r));
    expect(flushed).toBe(false);
    s.addCredit(1000);
    expect(dataBytes()).toBe(OUTBOUND_INITIAL_WINDOW + 1000);
    await new Promise((r) => setImmediate(r));
    expect(flushed).toBe(true);
    s.end();
    await new Promise((r) => setImmediate(r));
    expect(frames.at(-1)?.type).toBe(FRAME_CLOSE);
  });

  it("grants credit only as the reader consumes, and fails a hub that overruns", async () => {
    const frames: Frame[] = [];
    const s = new OutboundStream(ID, (f) => frames.push(f), () => {});
    s.markOpen();
    s.pause();
    for (let i = 0; i < 8; i++) s.receive(new Uint8Array(32 * 1024));
    await new Promise((r) => setImmediate(r));
    const credited = () =>
      frames.filter((f) => f.type === FRAME_OUTBOUND_CREDIT).reduce((n, f) => n + parseOutboundCredit(f.payload)!, 0);
    const before = credited();
    expect(before).toBeLessThan(OUTBOUND_INITIAL_WINDOW);
    s.on("data", () => {});
    s.resume();
    await new Promise((r) => setTimeout(r, 20));
    expect(credited()).toBe(OUTBOUND_INITIAL_WINDOW);

    const t = new OutboundStream(ID + 1, () => {}, () => {});
    const err = new Promise<Error>((r) => t.on("error", r));
    t.pause();
    t.receive(new Uint8Array(OUTBOUND_INITIAL_WINDOW));
    t.receive(new Uint8Array(1));
    expect((await err).message).toMatch(/flow control/);
  });
});

describe("supervised tunnel client without a live hub", () => {
  it("reports the relay unavailable", async () => {
    const sup = superviseTunnelClient({
      hubUrl: "ws://127.0.0.1:1/tunnel",
      signingKey: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) },
      getEntitlements: () => {
        throw new Error("unused");
      },
      resolveBackend: () => null,
      initialJitterMs: 60_000,
    });
    expect(sup.outboundAvailable()).toBe(false);
    await expect(sup.openOutbound("api.anthropic.com", 443)).rejects.toThrow(RELAY_UNAVAILABLE_MESSAGE);
    await sup.close();
  });
});
