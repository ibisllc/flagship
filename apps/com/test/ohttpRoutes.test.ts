import { describe, expect, it } from "vitest";
import { boxProxyLaneAuth, ed, ohttpRelayFrom, parseOhttpKeys, sendPrivately, signBoxProxy } from "@flagship/protocol";
import { D1Storage } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { route, type RouteEnv } from "../src/route.js";
import { relayFromEnv } from "../src/ohttpRoutes.js";
import { memoryRateLimits } from "./rateLimitFakes.js";

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
  it("serves the relay config (never a Cloudflare relay), with a key", async () => {
    const env = makeEnv({
      OHTTP_RELAY_URL: undefined,
      OHTTP_RELAYS: JSON.stringify([
        { url: "https://privacy-gateway.cloudflare.com/flagship", operator: "CF", interim: false },
        { url: "https://flagship-ohttp-relay.fly.dev/", operator: "Flagship (interim)", interim: true },
      ]),
    });
    const res = await route(new Request("https://flagshipserver.com/api/ohttp/config"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const c = (await res.json()) as { keyConfigHex: string; relays: Array<{ url: string; interim: boolean }> };
    expect(c.relays).toEqual([{ url: "https://flagship-ohttp-relay.fly.dev/", operator: "Flagship (interim)", interim: true }]);
    expect(c.keyConfigHex).toMatch(/^01/);
    const none = await route(new Request("https://flagshipserver.com/api/ohttp/config"), makeEnv({ OHTTP_GATEWAY_KEYS: undefined }));
    expect(await none.json()).toEqual({ v: 1, keyConfigHex: null, relays: [] });
  });

  it("takes the box's lane calls through the gateway against D1: report, /pods, the owner's order, the poll", async () => {
    const sqlite = createSqliteD1();
    const env = makeEnv({ DB: sqlite as never });
    const db = new D1Storage(sqlite as never);
    const irk = { privateKey: new Uint8Array(32).fill(1), publicKey: ed.getPublicKey(new Uint8Array(32).fill(1)) };
    const stk = new Uint8Array(32).fill(2);
    const D = "home.alice.flagship.services";
    await db.usernames.put({ username: "alice", irkPubHex: Buffer.from(irk.publicKey).toString("hex"), claimedAt: 1 });
    await db.servers.put({ serverDomain: D, username: "alice", identityPubKeyHex: Buffer.from(ed.getPublicKey(stk)).toString("hex"), registeredAt: 1 });
    const relay = relayFromEnv(env)!;
    const alertPath = `/api/server/${D}/proxy-alert`;
    const body = new TextEncoder().encode(JSON.stringify({ state: "failing", code: "auth", since: Date.now() }));
    const rep = await sendPrivately(
      { url: `https://flagshipserver.com${alertPath}`, method: "POST", headers: [["authorization", boxProxyLaneAuth(D, "POST", alertPath, Date.now(), body, stk)], ["content-type", "application/json"]], body },
      { relay, fetch: relayInto(env) },
    );
    expect(rep).toMatchObject({ path: "ohttp", status: 200 });
    expect((await db.boxProxyLane.alertsForUser("alice"))[0]).toMatchObject({ state: "failing", code: "auth" });
    // The owner's app leaves "turn it off" directly at .com.
    const off = { serverDomain: D, kind: "none" as const, host: "", port: 0, auth: false, fallbackDirect: false, issuedAt: Date.now(), nonce: "ab".repeat(32) };
    const dep = await route(
      new Request(`https://flagshipserver.com/api/server/${D}/proxy-order`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proxy: off, signature: signBoxProxy(off, irk) }),
      }),
      env,
    );
    expect(dep.status).toBe(200);
    const orderPath = `/api/server/${D}/proxy-order`;
    const poll = await sendPrivately(
      { url: `https://flagshipserver.com${orderPath}`, method: "GET", headers: [["authorization", boxProxyLaneAuth(D, "GET", orderPath, Date.now(), new Uint8Array(0), stk)]] },
      { relay, fetch: relayInto(env) },
    );
    expect(poll).toMatchObject({ path: "ohttp", status: 200 });
    expect(JSON.parse(new TextDecoder().decode(poll.body)).order.proxy).toEqual(off);
    sqlite.close();
  });


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
    const { ns, calls } = memoryRateLimits({ policy: () => false });
    const env = makeEnv({ RATE_LIMITS: ns });
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
    expect([...calls].sort()).toEqual([
      "provision-status|ip|relay:order:ORDER123",
      `server-register|ip|relay:irk:${irk}`,
      `server-register|irk|${irk}`,
    ]);
  });
});

describe("rate-limit keys for relayed requests", () => {
  it("keys a relayed spend by the account it pays for, a lane call by its server, and direct calls by address", async () => {
    const { clientKey, markRelayed, endpointFor } = await import("../src/rateLimit.js");
    const relayed = markRelayed(new Request("https://flagshipserver.com/api/vouchers/redeem", { method: "POST" }));
    expect(clientKey(relayed, "vouchers-redeem", "/api/vouchers/redeem", undefined, { username: "Alice" })).toBe("relay:redeem:alice");
    expect(clientKey(relayed, "vouchers-redeem", "/api/vouchers/redeem", undefined, {})).toBe("relay");
    const path = "/api/server/home.alice.flagship.services/proxy-order";
    expect(endpointFor("GET", path)).toBe("box-proxy-lane");
    expect(endpointFor("POST", "/api/server/home.alice.flagship.services/proxy-alert")).toBe("box-proxy-lane");
    const lane = markRelayed(new Request(`https://flagshipserver.com${path}`));
    expect(clientKey(lane, "box-proxy-lane", path, undefined)).toBe("relay:lane:home.alice.flagship.services");
    const direct = new Request("https://flagshipserver.com/api/vouchers/redeem", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" } });
    expect(clientKey(direct, "vouchers-redeem", "/api/vouchers/redeem", undefined, { username: "alice" })).toBe("198.51.100.7");
  });
});
