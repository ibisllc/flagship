import { createServer, request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { BrowserGrants } from "../../src/browser/policy/grants.js";
import { BrowserGrantRequests, canonicalBrowserGrantAnswer, normalizeAsk, type BrowserGrantAnswer } from "../../src/browser/grantRequests.js";
import { contextSession, ServiceProxies, chromiumEgressFlags } from "../../src/browser/egress.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SERVER = "home.alice.flagship.services";
const owner = new Uint8Array(32).fill(4);

function world() {
  let t = 1_760_000_000_000;
  const grants = new BrowserGrants(() => t);
  const alerts: string[] = [];
  const req = new BrowserGrantRequests({
    grants,
    serverDomain: SERVER,
    authority: () => ({ username: "alice", ownerIrkPub: ed.getPublicKey(owner) }),
    now: () => t,
    onRequest: (s) => alerts.push(s),
  });
  const sign = (id: string, over: Partial<BrowserGrantAnswer> = {}, key = owner) => {
    const p = req.pending().find((x) => x.requestId === id)!;
    const order: BrowserGrantAnswer = { serverDomain: SERVER, requestId: id, serviceId: p.serviceId, decision: "allow", duration: p.duration, capabilities: p.capabilities, origins: p.origins, localNetwork: p.localNetwork, issuedAt: t, ...over };
    return hex(ed.sign(canonicalBrowserGrantAnswer(order), key));
  };
  return { grants, req, alerts, sign, advance: (ms: number) => (t += ms), now: () => t };
}

describe("browser grants beyond the manifest", () => {
  it("normalizes what an app asks for and refuses what is not a site", () => {
    const a = normalizeAsk("alice--shop", { capabilities: ["navigate", "navigate"], origins: ["Shop.Example.com", "*.cdn.example.com"], duration: "once", explanation: "x" });
    expect(a).toMatchObject({ capabilities: ["navigate"], origins: ["*.cdn.example.com", "shop.example.com"], localNetwork: null });
    expect(normalizeAsk("s", { capabilities: ["navigate"], origins: [], localNetwork: { kind: "exact", hosts: ["192.168.1.5", "printer.lan"] }, duration: "session" }).localNetwork).toEqual({ kind: "exact", hosts: ["192.168.1.5", "printer.lan"] });
    for (const bad of [
      { capabilities: [], origins: ["a.com"], duration: "once" },
      { capabilities: ["root"], origins: ["a.com"], duration: "once" },
      { capabilities: ["navigate"], origins: ["10.0.0.1"], duration: "once" },
      { capabilities: ["navigate"], origins: ["*"], duration: "once" },
      { capabilities: ["navigate"], origins: ["a.com"], duration: "forever" },
      { capabilities: ["navigate"], origins: [], duration: "once" },
      { capabilities: ["navigate"], origins: [], localNetwork: { kind: "exact", hosts: ["a|b"] }, duration: "once" },
    ]) expect(() => normalizeAsk("s", bad as Record<string, unknown>), JSON.stringify(bad)).toThrow();
  });

  it("grants only on the owner's signature over exactly what was shown, once", () => {
    const w = world();
    const r = w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: ["shop.example.com"], duration: "once" }));
    expect(r.ok).toBe(true);
    const id = (r as { requestId: string }).requestId;
    expect(w.alerts).toEqual(["alice--shop"]);
    expect(w.req.pending()[0]!.meaning[0]).toContain("shop.example.com only");
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now() })).toMatchObject({ ok: false, status: 400 });
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id, { origins: ["*.example.com"] }) })).toMatchObject({ ok: false, status: 403 });
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id, {}, new Uint8Array(32).fill(9)) })).toMatchObject({ ok: false, status: 403 });
    const good = w.sign(id);
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: good })).toEqual({ ok: true });
    expect(w.req.status("alice--shop", id)).toBe("allowed");
    expect(w.req.status("alice--other", id)).toBeNull();
    expect(w.grants.live("alice--shop").map((g) => g.origins)).toEqual([["shop.example.com"]]);
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: good })).toMatchObject({ ok: false, status: 404 });
  });

  it("a session grant lives in the app's browser context, and a local-network grant is its own ask", () => {
    const w = world();
    const r = w.req.ask(normalizeAsk("alice--hub", { capabilities: ["navigate"], origins: [], localNetwork: { kind: "exact", hosts: ["192.168.1.5"] }, duration: "session" }));
    const id = (r as { requestId: string }).requestId;
    expect(w.req.pending()[0]!.meaning.join(" ")).toContain("192.168.1.5");
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id) })).toEqual({ ok: true });
    expect(w.grants.live("alice--hub")).toHaveLength(0);
    expect(w.grants.live("alice--hub", contextSession("alice--hub"))).toHaveLength(1);
    w.grants.endSession(contextSession("alice--hub"));
    expect(w.grants.live("alice--hub", contextSession("alice--hub"))).toHaveLength(0);
  });

  it("after a no, the same ask cools down longer each time; other asks and other apps are not held up", () => {
    const w = world();
    const ask = () => w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: ["ads.example.com"], duration: "once" }));
    const deny = () => {
      const r = ask();
      expect(r.ok).toBe(true);
      expect(w.req.answer({ requestId: (r as { requestId: string }).requestId, decision: "deny" })).toEqual({ ok: true });
    };
    deny();
    expect(ask()).toMatchObject({ ok: false, status: 429, retryAfterMs: 60_000 });
    expect(w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: ["help.example.com"], duration: "once" })).ok).toBe(true);
    expect(w.req.ask(normalizeAsk("alice--other", { capabilities: ["navigate"], origins: ["ads.example.com"], duration: "once" })).ok).toBe(true);
    w.advance(60_001);
    deny();
    expect(ask()).toMatchObject({ status: 429, retryAfterMs: 600_000 });
    w.advance(600_001);
    deny();
    expect(ask()).toMatchObject({ retryAfterMs: 3_600_000 });
  });

  it("holds one copy of a repeated ask and at most five per app", () => {
    const w = world();
    const a = normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: ["a.example.com"], duration: "once" });
    expect(w.req.ask(a)).toEqual(w.req.ask(a));
    for (const h of ["b", "c", "d", "e"]) expect(w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: [`${h}.example.com`], duration: "once" })).ok).toBe(true);
    expect(w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: ["f.example.com"], duration: "once" }))).toMatchObject({ ok: false, status: 409 });
    w.req.forgetService("alice--shop");
    expect(w.req.pending()).toHaveLength(0);
  });
});

describe("one pinning proxy per app context", () => {
  let upstream: Server;
  let port = 0;
  beforeAll(async () => {
    upstream = createServer((_q, s) => s.end("ok"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    port = (upstream.address() as { port: number }).port;
  });
  afterAll(() => upstream.close());

  const get = (proxyUrl: string, host: string) =>
    new Promise<number>((resolve) => {
      const u = new URL(proxyUrl);
      const r = request({ host: u.hostname, port: Number(u.port), path: `http://${host}:${port}/`, headers: { host: `${host}:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", () => resolve(-1));
      r.end();
    });

  it("an approval for one app never opens the host to another, and the deny-all proxy approves nothing", async () => {
    const proxies = new ServiceProxies({ dial: (_a, p) => ({ host: "127.0.0.1", port: p }) });
    const shop = await proxies.proxyFor("alice--shop");
    const other = await proxies.proxyFor("alice--other");
    const deny = await proxies.denyAll();
    proxies.allow("alice--shop", "shop.test", ["93.184.216.34"]);
    expect(await get(shop, "shop.test")).toBe(200);
    expect(await get(other, "shop.test")).toBe(403);
    expect(await get(deny, "shop.test")).toBe(403);
    // An address that is never reachable stays refused even when approved.
    proxies.allow("alice--shop", "meta.test", ["169.254.169.254"]);
    expect(await get(shop, "meta.test")).toBe(403);
    await proxies.close("alice--shop");
    expect(await get(shop, "shop.test")).toBe(-1);
    await proxies.closeAll();
    expect(chromiumEgressFlags(deny)).toContain(`--proxy-server=${deny}`);
  });

  it("serves only the addresses it is told to, by default loopback", async () => {
    const proxies = new ServiceProxies({ acceptFrom: () => false, dial: (_a, p) => ({ host: "127.0.0.1", port: p }) });
    const shop = await proxies.proxyFor("alice--shop");
    proxies.allow("alice--shop", "shop.test", ["93.184.216.34"]);
    expect(await get(shop, "shop.test")).toBe(403);
    await proxies.closeAll();
  });
});
