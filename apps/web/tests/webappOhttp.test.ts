// The webapp's OHTTP client (lib/ohttp.js) against the shared vectors
// (packages/protocol/test-vectors/ohttp) and the relay failure rules
// (docs/outbound-proxy.md "Failure handling").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decapsulateOhttpRequest, encapsulateOhttpResponse, ohttpGatewayKey } from "@flagship/protocol";
import * as O from "../public/webapp/lib/ohttp.js";

const dir = resolve(__dirname, "../../../packages/protocol/test-vectors/ohttp");
const V = JSON.parse(readFileSync(resolve(dir, "vectors.json"), "utf8"));
const S = JSON.parse(readFileSync(resolve(dir, "spend-route.json"), "utf8"));
const te = new TextEncoder();
const h = O.fromHex;

describe("webapp OHTTP vectors", () => {
  it("reproduces RFC 9458 Appendix A", () => {
    const cfg = O.parseOhttpKeyConfig(h(V.rfc9458.keyConfigHex))!;
    const { encapsulated, context } = O.encapsulateOhttpRequest(cfg, h(V.rfc9458.bhttpRequestHex), h(V.rfc9458.ephemeralSecretHex));
    expect(O.toHex(encapsulated)).toBe(V.rfc9458.encapsulatedRequestHex);
    expect(O.toHex(O.decapsulateOhttpResponse(context, h(V.rfc9458.encapsulatedResponseHex)))).toBe(V.rfc9458.bhttpResponseHex);
  });

  for (const c of V.cases) {
    it(`case ${c.name}`, () => {
      const cfg = O.ohttpKeyConfigFromHex(V.gateway.keyConfigHex)!;
      const bh = O.encodeBhttpRequest({ ...c.request, body: te.encode(c.request.bodyText) });
      expect(O.toHex(bh)).toBe(c.bhttpRequestHex);
      const { encapsulated, context } = O.encapsulateOhttpRequest(cfg, bh, h(c.ephemeralSecretHex));
      expect(O.toHex(encapsulated)).toBe(c.encapsulatedRequestHex);
      const res = O.decodeBhttpResponse(O.decapsulateOhttpResponse(context, h(c.encapsulatedResponseHex)));
      expect(res.status).toBe(c.response.status);
      expect(res.headers).toEqual(c.response.headers);
      expect(new TextDecoder().decode(res.body)).toBe(c.response.bodyText);
    });
  }

  it("refuses the negatives", () => {
    const cfg = O.ohttpKeyConfigFromHex(V.gateway.keyConfigHex)!;
    const c0 = V.cases[0];
    const { context } = O.encapsulateOhttpRequest(cfg, h(c0.bhttpRequestHex), h(c0.ephemeralSecretHex));
    for (const n of V.negatives.responses) expect(() => O.decapsulateOhttpResponse(context, h(n.encapsulatedResponseHex))).toThrow();
    for (const k of V.negatives.keyConfigs) expect(O.parseOhttpKeyConfig(h(k.hex))).toBeNull();
  });

  it("spend route, backoff, lapse, hosts and config", () => {
    for (const r of S.route) expect(O.ohttpSpendMayGoDirect(r.kind, r.lapseInMs)).toBe(r.mayGoDirect);
    for (const b of S.backoff) expect(O.relayRetryAfterMs(b.failures)).toBe(b.retryAfterMs);
    for (const l of S.lapse) expect(O.planLapseInMs(l.paidUntil, l.graceMs, l.now)).toBe(l.lapseInMs);
    for (const x of S.relayHosts) expect(O.isForbiddenRelayHost(x.host, "flagshipserver.com")).toBe(x.forbidden);
    for (const c of S.config) expect(O.parseOhttpPublicConfig(c.input, c.controlApex)).toEqual(c.expected);
  });
});

describe("webapp sendThroughRelays against a gateway", () => {
  const gw = ohttpGatewayKey(V.gateway.keyId, h(V.gateway.secretHex));
  const config = { v: 1, keyConfigHex: V.gateway.keyConfigHex, relays: [{ url: "https://relay.test/", operator: "R", interim: false }] };
  const req = { url: "https://flagshipserver.com/api/vouchers/redeem", method: "POST", headers: [["content-type", "application/json"]] as [string, string][], body: te.encode("{}") };
  const mk = (state: { relay: "up" | "down" | "502" }, seen: string[]) => async (url: string, init: RequestInit) => {
    seen.push(`${url}#${(init.headers as Record<string, string>)["x-flagship-relay-fallback"] ?? ""}`);
    if (url.startsWith("https://relay.test")) {
      if (state.relay === "down") throw new TypeError("Failed to fetch");
      if (state.relay === "502") return new Response("", { status: 502 });
      const g = decapsulateOhttpRequest([gw], init.body as Uint8Array);
      const inner = new Uint8Array([1, 0x40, 200, 0, 2, 0x6f, 0x6b, 0]);
      return new Response(encapsulateOhttpResponse(g.context, inner), { status: 200, headers: { "content-type": "message/ohttp-res" } });
    }
    return new Response("{}", { status: 200 });
  };

  it("relay up: through the relay; body decrypts", async () => {
    const seen: string[] = [];
    const r = await O.sendThroughRelays(req, { config, mayGoDirect: () => false, fetch: mk({ relay: "up" }, seen) as never });
    expect(r.path).toBe("ohttp");
    expect(new TextDecoder().decode(r.body)).toBe("ok");
  });

  it("relay down or gateway down: waits (throws) unless allowed, then direct and marked; recovers", async () => {
    const state = { relay: "down" as "up" | "down" | "502" };
    const seen: string[] = [];
    const f = mk(state, seen) as never;
    await expect(O.sendThroughRelays(req, { config, mayGoDirect: () => false, fetch: f })).rejects.toMatchObject({ reason: "relay-unreachable" });
    state.relay = "502";
    await expect(O.sendThroughRelays(req, { config, mayGoDirect: () => false, fetch: f })).rejects.toMatchObject({ reason: "relay-502" });
    const d = await O.sendThroughRelays(req, { config, mayGoDirect: () => true, fetch: f });
    expect(d.path).toBe("direct");
    expect(seen.at(-1)).toBe("https://flagshipserver.com/api/vouchers/redeem#relay-502");
    state.relay = "up";
    expect((await O.sendThroughRelays(req, { config, mayGoDirect: () => false, fetch: f })).path).toBe("ohttp");
  });

  it("no relay configured: direct, marked unconfigured", async () => {
    const seen: string[] = [];
    const r = await O.sendThroughRelays(req, { config: { v: 1, keyConfigHex: null, relays: [] }, mayGoDirect: () => true, fetch: mk({ relay: "up" }, seen) as never });
    expect(r.fallbackReason).toBe("unconfigured");
    expect(seen).toEqual(["https://flagshipserver.com/api/vouchers/redeem#"]);
  });
});
