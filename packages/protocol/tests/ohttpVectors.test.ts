import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decapsulateOhttpRequest,
  decapsulateOhttpResponse,
  decodeBhttpResponse,
  encapsulateOhttpRequest,
  encodeBhttpRequest,
  encapsulateOhttpResponse,
  isForbiddenRelayHost,
  ohttpGatewayKey,
  ohttpKeyConfigFromHex,
  ohttpSpendMayGoDirect,
  parseOhttpKeyConfig,
  parseOhttpPublicConfig,
  planLapseInMs,
  relayRetryAfterMs,
  RelayUnavailableError,
  RELAY_FALLBACK_HEADER,
  sendThroughRelays,
} from "../src/index.js";

const dir = join(__dirname, "../test-vectors/ohttp");
const V = JSON.parse(readFileSync(join(dir, "vectors.json"), "utf8"));
const S = JSON.parse(readFileSync(join(dir, "spend-route.json"), "utf8"));
const h = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const x = (b: Uint8Array) => Buffer.from(b).toString("hex");
const te = new TextEncoder();

describe("OHTTP shared vectors", () => {
  const cfg = ohttpKeyConfigFromHex(V.gateway.keyConfigHex)!;
  const gw = ohttpGatewayKey(V.gateway.keyId, h(V.gateway.secretHex));

  it("the RFC 9458 example still reproduces", () => {
    const c = parseOhttpKeyConfig(h(V.rfc9458.keyConfigHex))!;
    const { encapsulated, context } = encapsulateOhttpRequest(c, h(V.rfc9458.bhttpRequestHex), h(V.rfc9458.ephemeralSecretHex));
    expect(x(encapsulated)).toBe(V.rfc9458.encapsulatedRequestHex);
    expect(x(decapsulateOhttpResponse(context, h(V.rfc9458.encapsulatedResponseHex)))).toBe(V.rfc9458.bhttpResponseHex);
  });

  for (const c of V.cases) {
    it(`case ${c.name}: client bytes, gateway and response`, () => {
      const bhttp = encodeBhttpRequest({ ...c.request, body: te.encode(c.request.bodyText) });
      expect(x(bhttp)).toBe(c.bhttpRequestHex);
      const { encapsulated, context } = encapsulateOhttpRequest(cfg, bhttp, h(c.ephemeralSecretHex));
      expect(x(encapsulated)).toBe(c.encapsulatedRequestHex);
      const g = decapsulateOhttpRequest([gw], encapsulated);
      expect(x(encapsulateOhttpResponse(g.context, h(c.bhttpResponseHex), h(c.responseNonceHex)))).toBe(c.encapsulatedResponseHex);
      const res = decodeBhttpResponse(decapsulateOhttpResponse(context, h(c.encapsulatedResponseHex)));
      expect(res.status).toBe(c.response.status);
      expect(new TextDecoder().decode(res.body)).toBe(c.response.bodyText);
      expect(res.headers).toEqual(c.response.headers);
    });
  }

  it("refuses the negative responses and key configurations", () => {
    const c0 = V.cases[0];
    const { context } = encapsulateOhttpRequest(cfg, h(c0.bhttpRequestHex), h(c0.ephemeralSecretHex));
    for (const n of V.negatives.responses) expect(() => decapsulateOhttpResponse(context, h(n.encapsulatedResponseHex))).toThrow();
    for (const k of V.negatives.keyConfigs) expect(parseOhttpKeyConfig(h(k.hex))).toBeNull();
  });
});

describe("spend routing and relay config vectors", () => {
  it("route", () => {
    for (const r of S.route) expect(ohttpSpendMayGoDirect(r.kind, r.lapseInMs)).toBe(r.mayGoDirect);
  });
  it("lapse, backoff, hosts, config", () => {
    for (const l of S.lapse) expect(planLapseInMs(l.paidUntil, l.graceMs, l.now)).toBe(l.lapseInMs);
    for (const b of S.backoff) expect(relayRetryAfterMs(b.failures)).toBe(b.retryAfterMs);
    for (const c of S.relayHosts) expect(isForbiddenRelayHost(c.host, "flagshipserver.com")).toBe(c.forbidden);
    for (const c of S.config) expect(parseOhttpPublicConfig(c.input, c.controlApex)).toEqual(c.expected);
  });
});

describe("sendThroughRelays: failure handling", () => {
  const gw = ohttpGatewayKey(V.gateway.keyId, h(V.gateway.secretHex));
  const cfg = ohttpKeyConfigFromHex(V.gateway.keyConfigHex)!;
  const res = (status: number, body: Uint8Array, ct: string) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n === "content-type" ? ct : null), forEach: (cb: (v: string, k: string) => void) => cb(ct, "content-type") },
    arrayBuffer: async () => body.slice().buffer,
  });
  // A working relay+gateway; `down` relays throw; `direct` answers plain JSON.
  const fetchFor = (down: Set<string>, seen: string[]) => async (url: string, init: { headers: Record<string, string>; body?: Uint8Array }) => {
    seen.push(url + (init.headers[RELAY_FALLBACK_HEADER] ? `#${init.headers[RELAY_FALLBACK_HEADER]}` : ""));
    if (down.has(url)) throw new Error("ECONNREFUSED");
    if (url.startsWith("https://relay")) {
      const g = decapsulateOhttpRequest([gw], init.body!);
      const inner = new Uint8Array([1, 0x40, 200, 0, 0, 0]);
      return res(200, encapsulateOhttpResponse(g.context, inner), "message/ohttp-res");
    }
    return res(200, te.encode("{}"), "application/json");
  };
  const req = { url: "https://flagshipserver.com/api/vouchers/redeem", method: "POST", body: "{}" };

  it("uses the first relay that answers, the second when the first is down", async () => {
    const seen: string[] = [];
    const r = await sendThroughRelays(req, {
      keyConfig: cfg,
      relays: ["https://relay-a/", "https://relay-b/"],
      mayGoDirect: () => false,
      fetch: fetchFor(new Set(["https://relay-a/"]), seen) as never,
    });
    expect(r.path).toBe("ohttp");
    expect(r.relay).toBe("https://relay-b/");
    expect(seen).toEqual(["https://relay-a/", "https://relay-b/"]);
  });

  it("relay down: throws when not allowed direct, goes direct marked when allowed", async () => {
    const down = new Set(["https://relay-a/"]);
    await expect(
      sendThroughRelays(req, { keyConfig: cfg, relays: ["https://relay-a/"], mayGoDirect: () => false, fetch: fetchFor(down, []) as never }),
    ).rejects.toBeInstanceOf(RelayUnavailableError);
    const seen: string[] = [];
    const r = await sendThroughRelays(req, { keyConfig: cfg, relays: ["https://relay-a/"], mayGoDirect: () => true, fetch: fetchFor(down, seen) as never });
    expect(r.path).toBe("direct");
    expect(r.fallbackReason).toBe("relay-unreachable");
    expect(seen[1]).toBe(`${req.url}#relay-unreachable`);
  });

  it("gateway down (the relay answers 502): same as relay down; recovers when it comes back", async () => {
    let gatewayUp = false;
    const f = async (url: string, init: { headers: Record<string, string>; body?: Uint8Array }) => {
      if (url.startsWith("https://relay") && !gatewayUp) return res(502, new Uint8Array(0), "text/plain");
      return fetchFor(new Set(), [])(url, init);
    };
    await expect(sendThroughRelays(req, { keyConfig: cfg, relays: ["https://relay-a/"], mayGoDirect: () => false, fetch: f as never })).rejects.toMatchObject({
      reason: "relay-502",
    });
    gatewayUp = true;
    const r = await sendThroughRelays(req, { keyConfig: cfg, relays: ["https://relay-a/"], mayGoDirect: () => false, fetch: f as never });
    expect(r.path).toBe("ohttp");
  });

  it("no relay configured: direct, marked unconfigured, if allowed", async () => {
    const seen: string[] = [];
    const r = await sendThroughRelays(req, { keyConfig: null, relays: [], mayGoDirect: () => true, fetch: fetchFor(new Set(), seen) as never });
    expect(r.fallbackReason).toBe("unconfigured");
    expect(seen).toEqual([`${req.url}#unconfigured`]);
  });
});
