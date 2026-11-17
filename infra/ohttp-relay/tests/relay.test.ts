// The interim OHTTP relay (infra/ohttp-relay): forwards only the encapsulated
// bytes to the fixed gateway, never the client's headers or address; CORS only
// for the webapp's origins; size, type and rate limits; and an end-to-end round
// trip through `.com`'s real gateway handler.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ohttpRelayFrom, sendPrivately } from "@flagship/protocol";
import { createRelay, relayConfigFromEnv, MAX_BODY } from "../relay.mjs";
import { route, type RouteEnv } from "../../../apps/com/src/route.js";
import { relayFromEnv } from "../../../apps/com/src/ohttpRoutes.js";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

async function start(cfgOver: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const cfg = relayConfigFromEnv({ PORT: "0", GATEWAY_URL: "https://flagshipserver.com/api/ohttp/gateway", ...cfgOver });
  const s = createRelay(cfg, fetchImpl ? { fetch: fetchImpl } : {});
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  closers.push(() => s.close());
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
}

describe("the interim OHTTP relay", () => {
  it("round-trips a request through .com's gateway, forwarding nothing about the client", async () => {
    const env: RouteEnv = {
      SERVICES_BASE_URL: "https://flagship.services",
      ASSETS: { fetch: async () => new Response("asset") },
      OHTTP_GATEWAY_KEYS: `1:${"42".repeat(32)}`,
      OHTTP_RELAY_URL: "https://relay.example.net/",
    };
    const seen: Array<Record<string, string>> = [];
    const url = await start({}, (async (u: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return route(new Request(u, { method: "POST", headers: init.headers, body: init.body as BodyInit }), env);
    }) as never);
    expect(relayFromEnv(env)).not.toBeNull();
    const keyHex = ((await (await route(new Request("https://flagshipserver.com/api/ohttp/config"), env)).json()) as { keyConfigHex: string }).keyConfigHex;
    const res = await sendPrivately(
      { url: "https://flagshipserver.com/api/ohttp/probe", method: "GET", headers: [["cookie", "secret=1"]] },
      {
        relay: ohttpRelayFrom("https://relay.test/", keyHex)!,
        fallbackDirect: false,
        // The client "reaches" the relay over plain http on loopback, with headers it shouldn't pass on.
        fetch: (async (_u: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) =>
          fetch(url, { method: "POST", headers: { ...init.headers, "x-forwarded-for": "203.0.113.9", cookie: "a=b", origin: "https://evil.example" }, body: init.body })) as never,
      },
    );
    expect(res.path).toBe("ohttp");
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ "content-type": "message/ohttp-req" }]);
  });

  it("answers CORS only for the webapp's origins", async () => {
    const url = await start({ ALLOWED_ORIGINS: "https://webapp.flagshipserver.com" });
    const ok = await fetch(url, { method: "OPTIONS", headers: { origin: "https://webapp.flagshipserver.com" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://webapp.flagshipserver.com");
    const bad = await fetch(url, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses the wrong type, too much data, other methods, and too many requests from one address", async () => {
    const gw = (async () => new Response(new Uint8Array(32), { status: 200, headers: { "content-type": "message/ohttp-res" } })) as never;
    const url = await start({ PER_IP_PER_MINUTE: "3" }, gw);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(415);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "message/ohttp-req" }, body: new Uint8Array(MAX_BODY + 1) })).status).toBe(413);
    const post = () => fetch(url, { method: "POST", headers: { "content-type": "message/ohttp-req" }, body: new Uint8Array(40) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });

  it("says 502 when the gateway answers something that isn't OHTTP, 504 when it can't be reached", async () => {
    const bad = await start({}, (async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) as never);
    expect((await fetch(bad, { method: "POST", headers: { "content-type": "message/ohttp-req" }, body: new Uint8Array(40) })).status).toBe(502);
    const down = await start({}, (async () => {
      throw new Error("ECONNREFUSED");
    }) as never);
    expect((await fetch(down, { method: "POST", headers: { "content-type": "message/ohttp-req" }, body: new Uint8Array(40) })).status).toBe(504);
  });
});
