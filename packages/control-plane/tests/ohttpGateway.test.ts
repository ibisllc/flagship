import { describe, expect, it } from "vitest";
import {
  encapsulateOhttpRequest,
  encodeBhttpRequest,
  encodeOhttpKeyConfig,
  ohttpGatewayKey,
  ohttpRelayFrom,
  parseOhttpKeys,
  RELAY_FALLBACK_HEADER,
  sendPrivately,
} from "@flagship/protocol";
import { InMemoryRelayHealthStorage } from "@flagship/storage";
import {
  handleOhttpGateway,
  isOhttpTargetAllowed,
  ohttpGatewayKeysFromEnv,
  ohttpKeysResponse,
  privateRelayStatus,
  RELAY_DOWN_MESSAGE,
  runRelayProbe,
  utcDay,
} from "../src/index.js";

const APEX = "flagshipserver.com";
const BOOT = "boot.flagshipserver.com";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const KEY_ENV = `3:${"11".repeat(32)},2:${"22".repeat(32)}`;
const keys = ohttpGatewayKeysFromEnv(KEY_ENV);
const relay = ohttpRelayFrom("https://relay.example.net/flagship", hex(encodeOhttpKeyConfig(keys[0]!)))!;

/** A fake network: the relay forwards to the gateway; everything else is "direct". */
function network(opts: { relayStatus?: number; relayThrows?: boolean } = {}) {
  const seen: Array<{ via: "relay" | "direct"; url: string; headers: Record<string, string>; inner?: Request }> = [];
  const arrivals: string[] = [];
  const dispatch = async (req: Request) => {
    seen[seen.length - 1]!.inner = req;
    const body = req.method === "GET" ? "" : await req.text();
    return new Response(JSON.stringify({ path: new URL(req.url).pathname, host: new URL(req.url).host, body, ua: req.headers.get("x-test") }), {
      status: new URL(req.url).pathname === "/api/ohttp/probe" ? 200 : 201,
      headers: { "content-type": "application/json", "set-cookie": "nope" },
    });
  };
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
    if (url === relay.relayUrl) {
      seen.push({ via: "relay", url, headers: init.headers });
      if (opts.relayThrows) throw new Error("ECONNREFUSED");
      if (opts.relayStatus) return new Response("plan expired", { status: opts.relayStatus });
      return handleOhttpGateway(
        new Request("https://flagshipserver.com/api/ohttp/gateway", { method: "POST", headers: init.headers, body: init.body }),
        { keys, apexHost: APEX, bootHost: BOOT, dispatch, recordArrival: async () => void arrivals.push("ohttp") },
      );
    }
    seen.push({ via: "direct", url, headers: init.headers });
    return new Response(JSON.stringify({ direct: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, arrivals, fetch: fetch as never };
}

describe("the OHTTP gateway", () => {
  it("publishes its keys in application/ohttp-keys, current key first", async () => {
    const res = ohttpKeysResponse(keys);
    expect(res.headers.get("content-type")).toBe("application/ohttp-keys");
    const parsed = parseOhttpKeys(new Uint8Array(await res.arrayBuffer()));
    expect(parsed.map((k) => k.keyId)).toEqual([3, 2]);
    expect(ohttpKeysResponse([]).status).toBe(404);
    expect(ohttpGatewayKeysFromEnv("bad, 300:" + "aa".repeat(32) + ", 4:" + "bb".repeat(32)).map((k) => k.keyId)).toEqual([4]);
  });

  it("carries a register POST end to end and records the arrival", async () => {
    const n = network();
    const res = await sendPrivately(
      { url: "https://flagshipserver.com/api/server/register", headers: [["content-type", "application/json"], ["x-test", "t"]], body: '{"a":1}' },
      { relay, fetch: n.fetch },
    );
    expect(res.path).toBe("ohttp");
    expect(res.status).toBe(201);
    expect(JSON.parse(new TextDecoder().decode(res.body))).toEqual({ path: "/api/server/register", host: APEX, body: '{"a":1}', ua: "t" });
    expect(res.headers).toEqual([["content-type", "application/json"]]);
    expect(n.arrivals).toEqual(["ohttp"]);
    expect(n.seen.map((s) => s.via)).toEqual(["relay"]);
  });

  it("serves the boot-unlock calls on the boot host", async () => {
    const n = network();
    const res = await sendPrivately({ url: "https://boot.flagshipserver.com/api/boot/lease/home.a.flagship.services", method: "GET" }, { relay, fetch: n.fetch });
    expect(res.path).toBe("ohttp");
    expect(JSON.parse(new TextDecoder().decode(res.body)).host).toBe(BOOT);
  });

  it("refuses anything but the setup and unlock paths, inside the encrypted answer", async () => {
    const n = network();
    for (const url of ["https://flagshipserver.com/api/users/a/pods", "https://evil.example/api/server/register", "https://boot.flagshipserver.com/api/server/register"]) {
      const res = await sendPrivately({ url, method: "POST", body: "{}" }, { relay, fetch: n.fetch });
      expect(res.path, url).toBe("ohttp");
      expect(res.status, url).toBe(403);
    }
    expect(n.arrivals).toEqual([]);
  });

  it("strips spoofable headers from the inner request", async () => {
    const n = network();
    await sendPrivately(
      { url: "https://flagshipserver.com/api/order/01ABC/status", headers: [["x-forwarded-for", "1.2.3.4"], ["cf-connecting-ip", "1.2.3.4"], [RELAY_FALLBACK_HEADER, "x"], ["x-test", "ok"]], body: "{}" },
      { relay, fetch: n.fetch },
    );
    const inner = n.seen[0]!.inner!;
    expect(inner.headers.get("x-forwarded-for")).toBeNull();
    expect(inner.headers.get("cf-connecting-ip")).toBeNull();
    expect(inner.headers.get(RELAY_FALLBACK_HEADER)).toBeNull();
    expect(inner.headers.get("x-test")).toBe("ok");
  });

  it("answers plain errors to garbage, the wrong media type and unknown keys", async () => {
    const deps = { keys, apexHost: APEX, bootHost: BOOT, dispatch: async () => new Response("x") };
    const post = (body: Uint8Array, ct = "message/ohttp-req") =>
      handleOhttpGateway(new Request("https://flagshipserver.com/api/ohttp/gateway", { method: "POST", headers: { "content-type": ct }, body }), deps);
    expect((await post(new Uint8Array(5))).status).toBe(400);
    expect((await post(new Uint8Array(5), "application/json")).status).toBe(415);
    const other = ohttpGatewayKey(9, new Uint8Array(32).fill(5));
    const { encapsulated } = encapsulateOhttpRequest(other, encodeBhttpRequest({ method: "GET", scheme: "https", authority: APEX, path: "/api/ohttp/probe", headers: [], body: new Uint8Array(0) }));
    expect((await post(encapsulated)).status).toBe(422);
  });

  it("allows exactly the listed targets", () => {
    const ok = (m: string, a: string, p: string) => isOhttpTargetAllowed(m, a, p, APEX, BOOT);
    expect(ok("POST", APEX, "/api/server/home.a.flagship.services/sealed-luks-key")).toBe(true);
    expect(ok("GET", APEX, "/api/server/register")).toBe(false);
    expect(ok("POST", BOOT, "/api/boot/request")).toBe(true);
    expect(ok("GET", BOOT, "/api/boot/response/home.a.flagship.services/abc_DEF-1")).toBe(true);
    expect(ok("GET", BOOT, "/api/boot/lease/../../x")).toBe(false);
  });
});

describe("the client's fallback to direct", () => {
  it.each([
    [{ relayStatus: 402 }, "relay-402"],
    [{ relayStatus: 503 }, "relay-503"],
    [{ relayThrows: true }, "relay-unreachable"],
  ])("sends the same request directly and marks it (%o)", async (opts, reason) => {
    const n = network(opts);
    const res = await sendPrivately({ url: "https://flagshipserver.com/api/server/register", body: "{}" }, { relay, fetch: n.fetch });
    expect(res.path).toBe("direct");
    expect(res.fallbackReason).toBe(reason);
    expect(n.seen.map((s) => s.via)).toEqual(["relay", "direct"]);
    expect(n.seen[1]!.headers[RELAY_FALLBACK_HEADER]).toBe(reason);
  });

  it("goes direct, marked, when no relay is configured; strict mode refuses instead", async () => {
    const n = network();
    const res = await sendPrivately({ url: "https://flagshipserver.com/api/server/register", body: "{}" }, { relay: null, fetch: n.fetch });
    expect(res).toMatchObject({ path: "direct", fallbackReason: "unconfigured" });
    await expect(
      sendPrivately({ url: "https://flagshipserver.com/api/server/register", body: "{}" }, { relay: null, fetch: n.fetch, fallbackDirect: false }),
    ).rejects.toThrow(/unconfigured/);
  });

  it("does not fall back on the target's own error answer", async () => {
    const n = network();
    const res = await sendPrivately({ url: "https://flagshipserver.com/api/users/a/pods", body: "{}" }, { relay, fetch: n.fetch });
    expect(res).toMatchObject({ path: "ohttp", status: 403 });
    expect(n.seen.map((s) => s.via)).toEqual(["relay"]);
  });
});

describe("private relay status and the daily probe", () => {
  const NOW = Date.UTC(2026, 9, 15, 12);

  it("is ok with only relay arrivals, down with a direct fallback today or yesterday", async () => {
    const s = new InMemoryRelayHealthStorage();
    await s.bump(utcDay(NOW), "ohttp");
    expect(await privateRelayStatus(s, { now: NOW, configured: true })).toMatchObject({ state: "ok", arrivals: { ohttp: 1, directFallback: 0 } });
    expect((await privateRelayStatus(s, { now: NOW, configured: false })).state).toBe("unconfigured");
    await s.bump(utcDay(NOW - 86_400_000), "direct-fallback");
    expect(await privateRelayStatus(s, { now: NOW, configured: true })).toMatchObject({ state: "down", message: RELAY_DOWN_MESSAGE });
  });

  it("records the probe, and a failed probe marks it down and pages once per call", async () => {
    const s = new InMemoryRelayHealthStorage();
    const pages: string[] = [];
    const good = await runRelayProbe({ storage: s, relay, apexHost: APEX, now: () => NOW, fetch: network().fetch });
    expect(good.ok).toBe(true);
    expect((await privateRelayStatus(s, { now: NOW, configured: true })).state).toBe("ok");
    const bad = await runRelayProbe({
      storage: s,
      relay,
      apexHost: APEX,
      now: () => NOW,
      fetch: network({ relayStatus: 402 }).fetch,
      notifyOperator: async (d) => void pages.push(d),
    });
    expect(bad.ok).toBe(false);
    expect(pages).toEqual([bad.detail]);
    expect((await privateRelayStatus(s, { now: NOW, configured: true })).state).toBe("down");
  });
});
