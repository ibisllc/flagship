import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEndpointsCachePath,
  parseServicesEndpoints,
  resolveServicesEndpoints,
  type ServicesEndpoints,
} from "../src/servicesEndpoints.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flagship-endpoints-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FRESH: ServicesEndpoints = {
  version: 1,
  tunnelHub: "wss://hub-new.example:8443/tunnel",
  passthroughIPv4: "1.2.3.4",
  passthroughIPv6: "::1",
  siblings: [],
  issuedAt: new Date().toISOString(),
};

const CACHED: ServicesEndpoints = {
  version: 1,
  tunnelHub: "wss://hub-old.example:8443/tunnel",
  passthroughIPv4: "9.9.9.9",
  passthroughIPv6: null,
  siblings: [],
  issuedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
};

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  return async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === "string" ? url : (url as URL).toString();
    return handler(u);
  };
}

describe("parseServicesEndpoints", () => {
  it("accepts a well-formed payload", () => {
    expect(parseServicesEndpoints(FRESH)).toEqual(FRESH);
  });

  it("rejects a payload missing tunnelHub", () => {
    expect(parseServicesEndpoints({ version: 1 })).toBeNull();
  });

  it("rejects a tunnelHub that isn't ws://* or wss://*", () => {
    expect(
      parseServicesEndpoints({ ...FRESH, tunnelHub: "https://oops" }),
    ).toBeNull();
  });

  it("tolerates unknown sibling shapes (forward-compat for inter-services peering)", () => {
    const out = parseServicesEndpoints({
      ...FRESH,
      siblings: [{ wsUrl: "wss://x", pubKeyHex: "ab" }, "junk", { future: true }],
    });
    expect(out).not.toBeNull();
    expect(out!.siblings.length).toBe(3);
  });
});

describe("resolveServicesEndpoints", () => {
  const cachePath = () => join(dir, "services-endpoints.json");
  const fallback = { tunnelHub: "wss://fallback.example/tunnel" };
  const baseUrl = "https://flagshipserver.com";

  it("source=live when the control plane responds and writes the cache", async () => {
    const r = await resolveServicesEndpoints({
      controlPlaneBaseUrl: baseUrl,
      cachePath: cachePath(),
      fallback,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify(FRESH), { status: 200 })),
    });
    expect(r.source).toBe("live");
    expect(r.endpoints.tunnelHub).toBe(FRESH.tunnelHub);
    const cached = JSON.parse(readFileSync(cachePath(), "utf8"));
    expect(cached.tunnelHub).toBe(FRESH.tunnelHub);
  });

  it("source=cache when live fetch fails and a cache exists", async () => {
    writeFileSync(cachePath(), JSON.stringify(CACHED));
    const r = await resolveServicesEndpoints({
      controlPlaneBaseUrl: baseUrl,
      cachePath: cachePath(),
      fallback,
      fetchImpl: fakeFetch(() => {
        throw new Error("network unreachable");
      }),
    });
    expect(r.source).toBe("cache");
    expect(r.endpoints.tunnelHub).toBe(CACHED.tunnelHub);
  });

  it("source=fallback when live fails and no cache exists", async () => {
    const r = await resolveServicesEndpoints({
      controlPlaneBaseUrl: baseUrl,
      cachePath: cachePath(),
      fallback,
      fetchImpl: fakeFetch(() => new Response("nope", { status: 502 })),
    });
    expect(r.source).toBe("fallback");
    expect(r.endpoints.tunnelHub).toBe(fallback.tunnelHub);
  });

  it("source=fallback on a malformed live payload (rather than blindly trusting it)", async () => {
    const r = await resolveServicesEndpoints({
      controlPlaneBaseUrl: baseUrl,
      cachePath: cachePath(),
      fallback,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ version: 1, tunnelHub: "https://wrong-scheme" }), { status: 200 })),
    });
    expect(r.source).toBe("fallback");
  });

  it("strips trailing slashes from controlPlaneBaseUrl", async () => {
    let captured = "";
    const r = await resolveServicesEndpoints({
      controlPlaneBaseUrl: "https://flagshipserver.com//",
      cachePath: cachePath(),
      fallback,
      fetchImpl: fakeFetch((u) => {
        captured = u;
        return new Response(JSON.stringify(FRESH), { status: 200 });
      }),
    });
    expect(r.source).toBe("live");
    expect(captured).toBe("https://flagshipserver.com/api/services/endpoints");
  });

  it("times out a hung control plane and falls through to cache", async () => {
    writeFileSync(cachePath(), JSON.stringify(CACHED));
    const r = await resolveServicesEndpoints({
      controlPlaneBaseUrl: baseUrl,
      cachePath: cachePath(),
      fallback,
      timeoutMs: 50,
      fetchImpl: (async (_url: any, init?: any) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }) as typeof fetch,
    });
    expect(r.source).toBe("cache");
  });
});

describe("defaultEndpointsCachePath", () => {
  it("places the cache inside the daemon's data dir", () => {
    expect(defaultEndpointsCachePath("/var/flagship")).toBe("/var/flagship/services-endpoints.json");
  });
});
