import { describe, expect, it } from "vitest";
import { ohttpRelayFrom, parseOhttpKeys, sendPrivately } from "@flagship/protocol";
import { route, type RouteEnv } from "../src/route.js";
import { relayFromEnv } from "../src/ohttpRoutes.js";

const KEYS = `1:${"42".repeat(32)}`;

function makeEnv(overrides: Partial<RouteEnv> = {}): RouteEnv {
  return {
    SERVICES_BASE_URL: "https://flagship.services",
    ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) },
    OHTTP_GATEWAY_KEYS: KEYS,
    OHTTP_RELAY_URL: "https://relay.example.net/flagship",
    ...overrides,
  };
}

/** The relay, in-process: it forwards to the Worker's gateway path. */
function relayInto(env: RouteEnv) {
  return (async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
    if (url !== env.OHTTP_RELAY_URL) throw new Error(`unexpected direct fetch to ${url}`);
    return route(new Request("https://flagshipserver.com/api/ohttp/gateway", { method: "POST", headers: init.headers, body: init.body }), env);
  }) as never;
}

describe("the Worker's OHTTP endpoints", () => {
  it("publishes the gateway key at /.well-known/ohttp-keys", async () => {
    const res = await route(new Request("https://flagshipserver.com/.well-known/ohttp-keys"), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/ohttp-keys");
    expect(parseOhttpKeys(new Uint8Array(await res.arrayBuffer())).map((k) => k.keyId)).toEqual([1]);
  });

  it("runs a decrypted request through its own router and seals the answer", async () => {
    const env = makeEnv();
    const relay = relayFromEnv(env)!;
    const res = await sendPrivately({ url: "https://flagshipserver.com/api/ohttp/probe", method: "GET" }, { relay, fetch: relayInto(env) });
    expect(res).toMatchObject({ path: "ohttp", status: 200 });
    expect(JSON.parse(new TextDecoder().decode(res.body))).toEqual({ ok: true });
  });

  it("refuses non-setup paths inside the sealed answer", async () => {
    const env = makeEnv();
    const res = await sendPrivately({ url: "https://flagshipserver.com/api/users/alice/pods", method: "GET" }, { relay: relayFromEnv(env)!, fetch: relayInto(env) });
    expect(res).toMatchObject({ path: "ohttp", status: 403 });
  });

  it("has no relay (and no published key) until the owner configures one", async () => {
    const env = makeEnv({ OHTTP_GATEWAY_KEYS: undefined });
    expect(relayFromEnv(env)).toBeNull();
    expect((await route(new Request("https://flagshipserver.com/.well-known/ohttp-keys"), env)).status).toBe(404);
    expect(relayFromEnv(makeEnv({ OHTTP_RELAY_URL: undefined }))).toBeNull();
    expect(ohttpRelayFrom("http://insecure.example", "00")).toBeNull();
  });

  it("keys relayed rate limits on the order or the signer, never one shared address", async () => {
    const keys: string[] = [];
    const env = makeEnv({ RATE_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) } });
    const relay = relayFromEnv(env)!;
    const status = await sendPrivately(
      {
        url: "https://flagshipserver.com/api/order/ORDER123/status",
        method: "POST",
        headers: [["content-type", "application/json"], ["cf-connecting-ip", "203.0.113.9"]],
        body: new TextEncoder().encode("{}"),
      },
      { relay, fetch: relayInto(env) },
    );
    expect(status).toMatchObject({ path: "ohttp", status: 429 });
    const irk = "ab".repeat(32);
    await sendPrivately(
      {
        url: "https://flagshipserver.com/api/server/register",
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(JSON.stringify({ request: { authCode: { userPubKey: irk } } })),
      },
      { relay, fetch: relayInto(env) },
    );
    expect(keys).toEqual([
      "provision-status|ip|60|relay:order:ORDER123",
      `server-register|ip|3600|relay:irk:${irk}`,
    ]);
  });
});
