import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalPqKeyBinding,
  hybridSigKeygen,
  hybridSign,
  verifyPqKeyBinding,
  type PqKeyBindingWire,
  type PqSessionIdentity,
} from "@flagship/protocol";
import { PqChannelServer, SiblingPqPins, pqSessionFetch, pqStrictGuard } from "../src/pqChannel.js";
import type { HttpRequest, HttpResponse } from "../src/runtime.js";

const NOW = Date.now();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function party(role: "box-stk" | "device", subject: string, a: number) {
  const { publicKey, secretKey } = hybridSigKeygen(new Uint8Array(32).fill(a), new Uint8Array(32).fill(a + 1));
  const st = { role, subjectId: subject, ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: NOW - 1000 };
  const wire: PqKeyBindingWire = { v: 1, ...st, signature: hex(hybridSign(secretKey, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st))) };
  const binding = verifyPqKeyBinding(wire, { role, subjectId: subject, ed25519PubHex: st.ed25519PubHex, now: NOW });
  const identity: PqSessionIdentity = { binding, sign: (p, m) => hybridSign(secretKey, p, m) };
  return { wire, binding, identity, stk: st.ed25519PubHex };
}

const BOX = "home.alice.flagship.services";
const SIB = "home2.alice.flagship.services";
const box = party("box-stk", BOX, 0x10);
const sib = party("box-stk", SIB, 0x20);

const req = (method: string, path: string, body: unknown = "", headers: Record<string, string> = {}): HttpRequest => ({
  method,
  path,
  headers,
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});

function world(opts: { strict: boolean; browsers: boolean; trustSibling?: boolean }) {
  const seen: Array<{ path: string; via: string | null }> = [];
  // The box's handler chain: the guards first, like runtime.dispatchHttp.
  const dispatch = async (r: HttpRequest): Promise<HttpResponse> => {
    for (const g of [guard, (x: HttpRequest) => server.handle(x)]) {
      const out = await g(r);
      if (out) return out;
    }
    seen.push({ path: r.path, via: server.channelOf(r)?.role ?? null });
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ path: r.path, got: r.body.toString() }) };
  };
  const server: PqChannelServer = new PqChannelServer({
    self: () => box.identity,
    lookup: (role, subject, kid) => (opts.trustSibling !== false && role === "box-stk" && subject === SIB && kid === sib.binding.keyIdHex ? sib.binding : null),
    dispatch,
  });
  const guard = pqStrictGuard({ strict: () => opts.strict, browsersAllowed: () => opts.browsers, channelOf: (r) => server.channelOf(r) });
  // A fetch that lands on this box's handler chain, as the relay would.
  const wire: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const r = req(init?.method ?? "GET", url.pathname + url.search, String(init?.body ?? ""), Object.fromEntries(new Headers(init?.headers).entries()));
    const out: HttpResponse = await dispatch(r);
    return new Response(out.body as string, { status: out.status, headers: out.headers });
  };
  return { server, guard, wire, seen, dispatch };
}

describe("PQ channel on the box", () => {
  it("carries a box-to-box request over the session and marks it as such", async () => {
    const w = world({ strict: true, browsers: false });
    const f = pqSessionFetch({ identity: () => sib.identity, responder: async (h) => (h === BOX ? box.binding : null), fetchImpl: w.wire });
    const r = await f(`https://${BOX}/api/access-sync/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ digest: "x" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: "/api/access-sync/pull", got: '{"digest":"x"}' });
    expect(w.seen).toEqual([{ path: "/api/access-sync/pull", via: "box-stk" }]);
    // A second call reuses the session.
    expect((await f(`https://${BOX}/api/access-sync/push`, { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("refuses box-to-box sync outside the channel while strict, and lets it through otherwise", async () => {
    const strict = world({ strict: true, browsers: true });
    const r = await strict.dispatch(req("POST", "/api/access-sync/pull", "{}"));
    expect(r.status).toBe(403);
    expect(JSON.parse(String(r.body)).code).toBe("pq-channel-required");
    const compat = world({ strict: false, browsers: false });
    expect((await compat.dispatch(req("POST", "/api/access-sync/pull", "{}"))).status).toBe(200);
  });

  it("lets a browser session through under strict only when the owner said so", async () => {
    const s = { authorization: "Flagship-Session abc" };
    expect((await world({ strict: true, browsers: false }).dispatch(req("GET", "/api/screens/home", "", s))).status).toBe(403);
    expect((await world({ strict: true, browsers: true }).dispatch(req("GET", "/api/screens/home", "", s))).status).toBe(200);
    expect((await world({ strict: false, browsers: false }).dispatch(req("GET", "/api/screens/home", "", s))).status).toBe(200);
    // A request with no session is not private: the public surface stays up.
    expect((await world({ strict: true, browsers: false }).dispatch(req("GET", "/api/health"))).status).toBe(200);
  });

  it("refuses an initiator it does not trust, and never sends in the clear when the responder is unknown", async () => {
    const w = world({ strict: true, browsers: false, trustSibling: false });
    const f = pqSessionFetch({ identity: () => sib.identity, responder: async () => box.binding, fetchImpl: w.wire });
    await expect(f(`https://${BOX}/api/access-sync/pull`, { method: "POST", body: "{}" })).rejects.toThrow(/unknown-initiator/);
    const g = pqSessionFetch({ identity: () => sib.identity, responder: async () => null, fetchImpl: w.wire });
    await expect(g(`https://${BOX}/api/access-sync/pull`, { method: "POST", body: "{}" })).rejects.toThrow(/unknown-initiator/);
    expect(w.seen).toEqual([]);
  });

  it("refuses an inner request aimed back at the session endpoints and a replayed record", async () => {
    const w = world({ strict: true, browsers: false });
    const f = pqSessionFetch({ identity: () => sib.identity, responder: async () => box.binding, fetchImpl: w.wire });
    const nested = await f(`https://${BOX}/api/pq-session/hello`, { method: "POST", body: "{}" });
    expect(nested.status).toBe(400);
    expect(((await nested.json()) as { code: string }).code).toBe("session-malformed");
    let last: string | null = null;
    const spy: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/call")) last = String(init?.body);
      return w.wire(input, init);
    };
    const g = pqSessionFetch({ identity: () => sib.identity, responder: async () => box.binding, fetchImpl: spy });
    expect((await g(`https://${BOX}/api/access-sync/pull`, { method: "POST", body: "{}" })).status).toBe(200);
    const again = await w.dispatch(req("POST", "/api/pq-session/call", last!));
    expect(JSON.parse(String(again.body)).code).toBe("replay");
  });
});

describe("sibling PQ pins", () => {
  it("pins the first ML-DSA key under the STK /pods names and refuses another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pq-pins-"));
    let served: unknown = sib.wire;
    const pins = new SiblingPqPins({ path: join(dir, "pins.json"), fetchBinding: async () => served });
    expect((await pins.bindingFor(SIB, sib.stk))?.keyIdHex).toBe(sib.binding.keyIdHex);
    expect(pins.known(SIB, sib.binding.keyIdHex)).not.toBeNull();
    // Another STK for the same server is a key change: refused.
    expect(await pins.bindingFor(SIB, box.stk)).toBeNull();
    // A fresh process reads the pin and refuses a swapped ML-DSA key under the same STK.
    const other = party("box-stk", SIB, 0x30);
    served = { ...other.wire, ed25519PubHex: sib.stk };
    const again = new SiblingPqPins({ path: join(dir, "pins.json"), fetchBinding: async () => served });
    await again.load();
    expect(await again.bindingFor(SIB, sib.stk)).toBeNull();
  });
});
