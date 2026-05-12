import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { ed, signDns01Publish, type Dns01PublishRequest } from "@flagship/protocol";

import handler, { _internal, type Env } from "../src/index.js";

const APEX = "flagship.services";
const SECRET_TOKEN = "super-secret-do-not-leak-XYZ123";
const ZONE = "zone-id-xyz";
const IPV4 = "149.248.216.86";

interface CapturedFetch {
  url: string;
  method: string;
  authHeader: string | null;
  body: string | null;
}

let calls: CapturedFetch[] = [];
const realFetch = globalThis.fetch;

function makeEnv(): Env {
  return {
    CLOUDFLARE_DNS_API_TOKEN: SECRET_TOKEN,
    CLOUDFLARE_SERVICES_ZONE_ID: ZONE,
    MAIN_WORKER_URL: "https://main.example",
    FLAGSHIP_APEX: APEX,
    SERVICES_PASSTHROUGH_IPV4: IPV4,
    RPC_REPLAY_WINDOW_MS: "300000",
  };
}

function kp(seed: number) {
  const sk = new Uint8Array(32).fill(seed);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

beforeEach(() => {
  calls = [];
  _internal.ipBuckets.clear();
  globalThis.fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = (init?.headers ?? (input instanceof Request ? input.headers : new Headers())) as
      | Record<string, string>
      | Headers;
    const auth = headers instanceof Headers
      ? headers.get("authorization")
      : ((headers as Record<string, string>).authorization
          ?? (headers as Record<string, string>).Authorization
          ?? null);
    const body = init?.body ? String(init.body) : null;
    calls.push({ url, method, authHeader: auth, body });
    // Default mock: main-worker pubkey lookups return pod identity for harry.
    if (url.startsWith("https://main.example/api/server/by-domain/")) {
      const id = decodeURIComponent(url.slice("https://main.example/api/server/by-domain/".length));
      const mock = serverLookups.get(id);
      if (!mock) return new Response(JSON.stringify({ error: "unknown" }), { status: 404 });
      return new Response(JSON.stringify(mock), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://main.example/api/users/")) {
      const username = decodeURIComponent(url.slice("https://main.example/api/users/".length).split("/")[0]!);
      const mock = userLookups.get(username);
      if (!mock) return new Response(JSON.stringify({ error: "unknown" }), { status: 404 });
      return new Response(JSON.stringify(mock), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // CF API: by default return a synthetic success.
    if (url.startsWith("https://api.cloudflare.com/")) {
      const cf = cfNextResponse.shift();
      if (cf) return cf;
      return new Response(
        JSON.stringify({ success: true, result: { id: "cf-mocked-id" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unmocked", { status: 500 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  serverLookups.clear();
  userLookups.clear();
  cfNextResponse.length = 0;
});

const serverLookups = new Map<string, { identityPubKey: string; revoked: unknown }>();
const userLookups = new Map<string, { binding: { pubKey: string } }>();
const cfNextResponse: Response[] = [];

describe("dns-broker Worker entry", () => {
  it("answers 404 for non-/rpc paths", async () => {
    const r = await handler.fetch(
      new Request("https://b/notrpc", { method: "POST" }),
      makeEnv(),
    );
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('{"ok":false}');
  });

  it("answers 503 when CF token isn't configured", async () => {
    const env = makeEnv();
    delete env.CLOUDFLARE_DNS_API_TOKEN;
    const r = await handler.fetch(
      new Request("https://b/rpc", { method: "POST", body: "{}" }),
      env,
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('{"ok":false}');
  });

  it("answers 400 for invalid JSON", async () => {
    const r = await handler.fetch(
      new Request("https://b/rpc", { method: "POST", body: "not-json" }),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it("denies a forged publishTxtChallenge with a generic 403 body that doesn't leak the token", async () => {
    const podKey = kp(40);
    const wrongKey = kp(41);
    const serverId = `home.harry.${APEX}`;
    serverLookups.set(serverId, { identityPubKey: toHex(wrongKey.publicKey), revoked: null });
    const recordValue = "x";
    const hash = sha256(new TextEncoder().encode(recordValue));
    const recordName = `_acme-challenge.${serverId}`;
    const claim: Dns01PublishRequest = {
      serverId,
      recordName,
      recordValueHash: hash,
      issuedAt: Date.now(),
    };
    const sig = signDns01Publish(claim, podKey);
    const body = {
      kind: "publishTxtChallenge",
      recordName,
      recordValue,
      authority: {
        type: "pod",
        serverId,
        recordValueHashHex: toHex(hash),
        issuedAt: claim.issuedAt,
        signatureHex: toHex(sig),
      },
    };
    const r = await handler.fetch(
      new Request("https://b/rpc", { method: "POST", body: JSON.stringify(body) }),
      makeEnv(),
    );
    expect(r.status).toBe(403);
    const text = await r.text();
    expect(text).toBe('{"ok":false}');
    expect(text).not.toContain(SECRET_TOKEN);
    // No CF call must have been made
    expect(calls.filter((c) => c.url.startsWith("https://api.cloudflare.com/"))).toHaveLength(0);
  });

  it("accepts a valid publishTxtChallenge, calls CF with the token, and returns recordId — never the token", async () => {
    const podKey = kp(42);
    const serverId = `home.harry.${APEX}`;
    serverLookups.set(serverId, { identityPubKey: toHex(podKey.publicKey), revoked: null });
    const recordValue = "x";
    const hash = sha256(new TextEncoder().encode(recordValue));
    const recordName = `_acme-challenge.${serverId}`;
    const claim: Dns01PublishRequest = {
      serverId,
      recordName,
      recordValueHash: hash,
      issuedAt: Date.now(),
    };
    const sig = signDns01Publish(claim, podKey);
    const body = {
      kind: "publishTxtChallenge",
      recordName,
      recordValue,
      authority: {
        type: "pod",
        serverId,
        recordValueHashHex: toHex(hash),
        issuedAt: claim.issuedAt,
        signatureHex: toHex(sig),
      },
    };
    cfNextResponse.push(
      new Response(
        JSON.stringify({ success: true, result: { id: "cf-rec-AAA" } }),
        { status: 200 },
      ),
    );
    const r = await handler.fetch(
      new Request("https://b/rpc", { method: "POST", body: JSON.stringify(body) }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    const resp = (await r.json()) as { ok: boolean; recordId?: string };
    expect(resp.ok).toBe(true);
    expect(resp.recordId).toBe("cf-rec-AAA");
    // Response body must not contain the token.
    const cfCalls = calls.filter((c) => c.url.startsWith("https://api.cloudflare.com/"));
    expect(cfCalls.length).toBe(1);
    expect(cfCalls[0]!.authHeader).toBe(`Bearer ${SECRET_TOKEN}`);
    // None of the response surfaces should carry the token.
    expect(JSON.stringify(resp)).not.toContain(SECRET_TOKEN);
  });

  it("publishARecord refuses arbitrary IPs even when the signature is valid for that body", async () => {
    const podKey = kp(50);
    const serverId = `home.dave.${APEX}`;
    serverLookups.set(serverId, { identityPubKey: toHex(podKey.publicKey), revoked: null });
    const evilIp = "192.0.2.5";
    const issuedAt = Date.now();
    // The daemon would never sign this in practice (its signing helper
    // pins targetIp), but the test confirms the broker doesn't trust
    // the caller's IP regardless of whether a sig is valid for it.
    const { canonicalPublishABytes } = await import("../src/policy.js");
    const msg = canonicalPublishABytes({ serverId, targetIp: evilIp, recordType: "A", issuedAt });
    const sig = ed.sign(msg, podKey.privateKey);
    const body = {
      kind: "publishARecord",
      serverId,
      recordType: "A",
      targetIp: evilIp,
      issuedAt,
      signatureHex: toHex(sig),
    };
    const r = await handler.fetch(
      new Request("https://b/rpc", { method: "POST", body: JSON.stringify(body) }),
      makeEnv(),
    );
    expect(r.status).toBe(403);
    const cfCalls = calls.filter((c) => c.url.startsWith("https://api.cloudflare.com/"));
    expect(cfCalls.length).toBe(0);
  });

  it("publishARecord with the allowlisted IP succeeds and yields a recordId", async () => {
    const podKey = kp(51);
    const serverId = `home.dave.${APEX}`;
    serverLookups.set(serverId, { identityPubKey: toHex(podKey.publicKey), revoked: null });
    const issuedAt = Date.now();
    const { canonicalPublishABytes } = await import("../src/policy.js");
    const msg = canonicalPublishABytes({ serverId, targetIp: IPV4, recordType: "A", issuedAt });
    const sig = ed.sign(msg, podKey.privateKey);
    const body = {
      kind: "publishARecord",
      serverId,
      recordType: "A",
      targetIp: IPV4,
      issuedAt,
      signatureHex: toHex(sig),
    };
    // List by name returns empty (no existing record), then create succeeds.
    cfNextResponse.push(
      new Response(JSON.stringify({ success: true, result: [] }), { status: 200 }),
      new Response(
        JSON.stringify({ success: true, result: { id: "cf-A-rec-NEW" } }),
        { status: 200 },
      ),
    );
    const r = await handler.fetch(
      new Request("https://b/rpc", { method: "POST", body: JSON.stringify(body) }),
      makeEnv(),
    );
    expect(r.status).toBe(200);
    const resp = (await r.json()) as { ok: boolean; recordId?: string };
    expect(resp.ok).toBe(true);
    expect(resp.recordId).toBe("cf-A-rec-NEW");
  });

  it("publishARecord refuses to overwrite an existing record with a different content", async () => {
    const podKey = kp(52);
    const serverId = `home.f.${APEX}`;
    serverLookups.set(serverId, { identityPubKey: toHex(podKey.publicKey), revoked: null });
    const issuedAt = Date.now();
    const { canonicalPublishABytes } = await import("../src/policy.js");
    const msg = canonicalPublishABytes({ serverId, targetIp: IPV4, recordType: "A", issuedAt });
    const sig = ed.sign(msg, podKey.privateKey);
    const body = {
      kind: "publishARecord",
      serverId,
      recordType: "A",
      targetIp: IPV4,
      issuedAt,
      signatureHex: toHex(sig),
    };
    // List returns an existing record pointing at a different IP.
    cfNextResponse.push(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "existing", content: "1.2.3.4" }],
        }),
        { status: 200 },
      ),
    );
    const r = await handler.fetch(
      new Request("https://b/rpc", { method: "POST", body: JSON.stringify(body) }),
      makeEnv(),
    );
    expect(r.status).toBe(502);
  });

  it("rate-limits a single IP after the burst is exhausted", async () => {
    _internal.ipBuckets.clear();
    const bad = new Request("https://b/rpc", {
      method: "POST",
      body: "{}",
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    let lastStatus = 0;
    for (let i = 0; i < _internal.RATE_LIMIT_BURST + 5; i++) {
      const r = await handler.fetch(bad.clone(), makeEnv());
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("logs the denial reason via console.warn but never via the response body", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await handler.fetch(
        new Request("https://b/rpc", { method: "POST", body: JSON.stringify({ kind: "unknown" }) }),
        makeEnv(),
      );
      expect(r.status).toBe(403);
      expect(await r.text()).toBe('{"ok":false}');
      // The reason ("malformed") is in the server-side log but not the body.
      const logged = spy.mock.calls.flat().join(" ");
      expect(logged).toContain("denied");
    } finally {
      spy.mockRestore();
    }
  });
});
