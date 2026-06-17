import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  guardedFetch,
  guardedStreamingFetch,
  UnsafeBaseUrlError,
} from "../src/index.js";

/**
 * SSRF hardening at the fetch layer: the production fetchers resolve +
 * classify the host before connect and re-validate every redirect Location
 * before following it. Tests mock both `globalThis.fetch` (so no socket is
 * opened) and the resolver (so no DNS is done).
 */

const realFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = vi.fn(impl as typeof globalThis.fetch) as unknown as typeof globalThis.fetch;
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

/** A 3xx redirect Response with a Location header. */
function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("guardedFetch — connect-time host resolution", () => {
  it("rejects a public URL that resolves to loopback before opening a socket", async () => {
    const f = mockFetch(async () => new Response("should not be reached"));
    const fetchLike = guardedFetch({ resolve: async () => ["127.0.0.1"] });
    await expect(fetchLike("https://localtest.me/v1", { method: "POST" })).rejects.toBeInstanceOf(
      UnsafeBaseUrlError,
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a public URL that resolves to the metadata IP", async () => {
    const f = mockFetch(async () => new Response("nope"));
    const fetchLike = guardedFetch({ resolve: async () => ["169.254.169.254"] });
    await expect(fetchLike("https://evil.example.com")).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    expect(f).not.toHaveBeenCalled();
  });

  it("passes through to a public host that resolves public", async () => {
    const f = mockFetch(async () => new Response("ok-body", { status: 200 }));
    const fetchLike = guardedFetch({ resolve: async () => ["1.2.3.4"] });
    const res = await fetchLike("https://api.anthropic.com/v1/messages", { method: "POST" });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("ok-body");
    expect(f).toHaveBeenCalledTimes(1);
    // The guard issues redirect:"manual" so a 3xx can't be auto-followed.
    expect((f.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
  });
});

describe("guardedFetch — redirect re-validation", () => {
  it("BLOCKS a 302 → internal redirect (the redirect-bypass)", async () => {
    // First hop resolves public; the server then 302s to the metadata IP.
    const f = mockFetch(async (url) => {
      if (url === "https://api.example.com/start") {
        return redirectTo("http://169.254.169.254/latest/meta-data/");
      }
      return new Response("LEAKED METADATA", { status: 200 });
    });
    const resolve = async (host: string) =>
      host === "api.example.com" ? ["1.2.3.4"] : ["169.254.169.254"];
    const fetchLike = guardedFetch({ resolve });
    await expect(fetchLike("https://api.example.com/start")).rejects.toBeInstanceOf(
      UnsafeBaseUrlError,
    );
    // The first hop ran; the redirect target was rejected before a second hop.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("BLOCKS a 302 → http://127.0.0.1:5432 redirect", async () => {
    const f = mockFetch(async (url) => {
      if (url === "https://api.example.com/start") {
        return redirectTo("http://127.0.0.1:5432/");
      }
      return new Response("postgres", { status: 200 });
    });
    const resolve = async (host: string) =>
      host === "api.example.com" ? ["1.2.3.4"] : ["127.0.0.1"];
    const fetchLike = guardedFetch({ resolve });
    await expect(fetchLike("https://api.example.com/start")).rejects.toBeInstanceOf(
      UnsafeBaseUrlError,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("FOLLOWS a 302 → another public host (re-validated, allowed)", async () => {
    const f = mockFetch(async (url) => {
      if (url === "https://a.example.com/start") return redirectTo("https://b.example.com/final");
      return new Response("final-body", { status: 200 });
    });
    const fetchLike = guardedFetch({ resolve: async () => ["1.2.3.4"] });
    const res = await fetchLike("https://a.example.com/start");
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("final-body");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("gives up after too many redirects", async () => {
    let n = 0;
    mockFetch(async () => redirectTo(`https://hop${n++}.example.com/next`));
    const fetchLike = guardedFetch({ resolve: async () => ["1.2.3.4"] });
    await expect(fetchLike("https://start.example.com/x")).rejects.toThrow(/too many redirects/);
  });
});

describe("guardedFetch — LAN/self-host override preserved", () => {
  it("allows an allowlisted internal host (resolver skipped)", async () => {
    let resolved = false;
    const f = mockFetch(async () => new Response("ollama-ok", { status: 200 }));
    const fetchLike = guardedFetch({
      guard: { allowHttp: true, hostAllowlist: ["ollama.lan"] },
      resolve: async () => {
        resolved = true;
        return ["127.0.0.1"];
      },
    });
    const res = await fetchLike("http://ollama.lan:11434/api/chat", { method: "POST" });
    expect(res.ok).toBe(true);
    expect(resolved).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("allows a resolved-private host when allowPrivate + allowHttp are set", async () => {
    const f = mockFetch(async () => new Response("ollama-ok", { status: 200 }));
    const fetchLike = guardedFetch({
      guard: { allowHttp: true, allowPrivate: true },
      resolve: async () => ["192.168.1.50"],
    });
    const res = await fetchLike("http://ollama.lan:11434/api/chat", { method: "POST" });
    expect(res.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("guardedStreamingFetch", () => {
  it("blocks a resolve-to-internal target and never opens the socket", async () => {
    const f = mockFetch(async () => new Response("data: x\n\n", { status: 200 }));
    const sf = guardedStreamingFetch({ resolve: async () => ["127.0.0.1"] });
    await expect(sf("https://localtest.me/v1")).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    expect(f).not.toHaveBeenCalled();
  });

  it("streams SSE lines from a public host", async () => {
    mockFetch(async () => new Response("data: a\ndata: b\n", { status: 200 }));
    const sf = guardedStreamingFetch({ resolve: async () => ["1.2.3.4"] });
    const res = await sf("https://api.anthropic.com/v1/messages", { method: "POST" });
    expect(res.ok).toBe(true);
    const lines: string[] = [];
    for await (const l of res.lines()) lines.push(l);
    expect(lines).toEqual(["data: a", "data: b"]);
  });

  it("blocks a 302 → internal on the streaming path", async () => {
    const f = mockFetch(async (url) => {
      if (url === "https://api.example.com/start") return redirectTo("http://127.0.0.1:6379/");
      return new Response("redis", { status: 200 });
    });
    const resolve = async (host: string) =>
      host === "api.example.com" ? ["1.2.3.4"] : ["127.0.0.1"];
    const sf = guardedStreamingFetch({ resolve });
    await expect(sf("https://api.example.com/start")).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
