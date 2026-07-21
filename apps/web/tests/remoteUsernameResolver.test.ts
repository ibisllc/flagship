import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  signClaimUsername,
  type ClaimUsername,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import { InMemoryUsernameRegistry } from "../src/routes/usernameRegistry.js";
import { RemoteUsernameResolver } from "../src/lib/remoteUsernameResolver.js";
import type { FetchLike } from "@flagship/llm-providers";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const harryAdminRoot = deriveIRK({ seed: new Uint8Array(32).fill(12) });

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function buildSignedClaim(username: string, signer = harryIrk) {
  const claim: ClaimUsername = {
    username,
    irkPub: signer.publicKey,
    issuedAt: Date.now(),
  };
  return {
    request: {
      username: claim.username,
      irkPub: bytesToHex(claim.irkPub),
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(signClaimUsername(claim, signer)),
  };
}

function inProcessFetch(app: ReturnType<typeof buildServer>): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const r = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: u.pathname + u.search,
      payload: init?.body ? JSON.parse(init.body) : undefined,
      headers: init?.headers,
    });
    return {
      ok: r.statusCode >= 200 && r.statusCode < 300,
      status: r.statusCode,
      async text() {
        return r.body;
      },
      async json() {
        return JSON.parse(r.body);
      },
    };
  };
}

describe("RemoteUsernameResolver", () => {
  it("fetches an IRK pubkey from .com and caches it", async () => {
    const registry = new InMemoryUsernameRegistry();
    const com = buildServer({ surface: "com", usernameRegistry: registry });
    await com.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });

    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      return inProcessFetch(com)(url, init);
    };
    const resolver = new RemoteUsernameResolver({
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
    });
    const a = await resolver.lookup("harry");
    expect(a).toEqual(harryIrk.publicKey);
    const b = await resolver.lookup("harry");
    expect(b).toEqual(harryIrk.publicKey);
    expect(calls).toBe(1); // second hit was served from cache
  });

  it("returns the admin root from the same cached username record", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async text() { return ""; },
        async json() {
          return {
            irkPub: bytesToHex(harryIrk.publicKey),
            adminRootPub: bytesToHex(harryAdminRoot.publicKey),
          };
        },
      };
    };
    const resolver = new RemoteUsernameResolver({
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
    });

    const authority = await resolver.lookupAuthority("harry");
    expect(authority).toEqual({
      irkPub: harryIrk.publicKey,
      adminRootPub: harryAdminRoot.publicKey,
    });
    expect(await resolver.lookup("harry")).toEqual(harryIrk.publicKey);
    expect(calls).toBe(1);
  });

  it("fails closed on a malformed advertised admin root", async () => {
    const resolver = new RemoteUsernameResolver({
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() { return ""; },
        async json() {
          return { irkPub: bytesToHex(harryIrk.publicKey), adminRootPub: "bad" };
        },
      }),
    });

    expect(await resolver.lookupAuthority("harry")).toBeNull();
    expect(await resolver.lookup("harry")).toBeNull();
  });

  it("returns null and negative-caches unknown usernames", async () => {
    const com = buildServer({ surface: "com" });
    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      return inProcessFetch(com)(url, init);
    };
    const resolver = new RemoteUsernameResolver({
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      negativeCacheTtlMs: 60_000,
    });
    expect(await resolver.lookup("ghost")).toBeNull();
    expect(await resolver.lookup("ghost")).toBeNull();
    expect(calls).toBe(1);
  });

  it("invalidate(username) drops the cache so the next lookup re-fetches", async () => {
    const registry = new InMemoryUsernameRegistry();
    const com = buildServer({ surface: "com", usernameRegistry: registry });
    await com.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      return inProcessFetch(com)(url, init);
    };
    const resolver = new RemoteUsernameResolver({
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
    });
    await resolver.lookup("harry");
    expect(calls).toBe(1);
    resolver.invalidate("harry");
    await resolver.lookup("harry");
    expect(calls).toBe(2);
  });

  it("expires positive entries after cacheTtlMs", async () => {
    const registry = new InMemoryUsernameRegistry();
    const com = buildServer({ surface: "com", usernameRegistry: registry });
    await com.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });
    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls += 1;
      return inProcessFetch(com)(url, init);
    };
    let nowMs = 1_000_000;
    const resolver = new RemoteUsernameResolver({
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl,
      cacheTtlMs: 100,
      now: () => nowMs,
    });
    await resolver.lookup("harry");
    nowMs += 50;
    await resolver.lookup("harry"); // still cached
    expect(calls).toBe(1);
    nowMs += 100;
    await resolver.lookup("harry"); // expired → re-fetch
    expect(calls).toBe(2);
  });

  it("the bridge plugs into a .services-mode resolveUserIrk and routes work end-to-end", async () => {
    // .com hosts the username registry.
    const registry = new InMemoryUsernameRegistry();
    const com = buildServer({ surface: "com", usernameRegistry: registry });
    await com.inject({
      method: "POST",
      url: "/api/username/claim",
      payload: buildSignedClaim("harry"),
    });

    // .services uses the bridge to resolve "harry" → harryIrk.publicKey.
    const resolver = new RemoteUsernameResolver({
      comBaseUrl: "https://flagshipserver.com",
      fetchImpl: inProcessFetch(com),
    });
    const services = buildServer({
      surface: "services",
      resolveUserIrk: (uid) => resolver.lookup(uid),
    });
    // The peer-backup matchmaker route is on .services and consumes
    // resolveUserIrk; if the bridge works, malformed but well-routed calls
    // should reach the matchmaker (e.g. 400 for bad body, NOT 404 for missing route).
    const r = await services.inject({
      method: "POST",
      url: "/api/peer-backup/announce",
      payload: { request: {} },
    });
    expect(r.statusCode).not.toBe(404);
  });
});
