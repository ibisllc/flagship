import { createServer, request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { BrowserGrants } from "../../src/browser/policy/grants.js";
import { BrowserGrantRequests, canonicalBrowserGrantAnswer, canonicalBrowserGrantRevoke, normalizeAsk, type BrowserGrantAnswer } from "../../src/browser/grantRequests.js";
import { buildBrowserGrantAlerts } from "../../src/browser/grantAlerts.js";
import { buildBrowserApiHandlers } from "../../src/browser/apiHandlers.js";
import type { HttpRequest } from "../../src/runtime.js";
import { contextSession, ServiceProxies, chromiumEgressFlags } from "../../src/browser/egress.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SERVER = "home.alice.flagship.services";
const owner = new Uint8Array(32).fill(4);

function world() {
  let t = 1_760_000_000_000;
  const grants = new BrowserGrants(() => t);
  const alerts: string[] = [];
  const revoked: string[] = [];
  const req = new BrowserGrantRequests({
    grants,
    serverDomain: SERVER,
    authority: () => ({ username: "alice", ownerIrkPub: ed.getPublicKey(owner) }),
    now: () => t,
    onRequest: (s) => alerts.push(s),
    onRevoked: (s) => revoked.push(s),
  });
  const signRevoke = (serviceId: string, grantId: string, key = owner, at = t) => hex(ed.sign(canonicalBrowserGrantRevoke({ serverDomain: SERVER, serviceId, grantId, issuedAt: at }), key));
  const sign = (id: string, over: Partial<BrowserGrantAnswer> = {}, key = owner) => {
    const p = req.pending().find((x) => x.requestId === id)!;
    const order: BrowserGrantAnswer = { serverDomain: SERVER, requestId: id, serviceId: p.serviceId, decision: "allow", duration: p.duration, capabilities: p.capabilities, origins: p.origins, localNetwork: p.localNetwork, issuedAt: t, ...over };
    return hex(ed.sign(canonicalBrowserGrantAnswer(order), key));
  };
  return { grants, req, alerts, revoked, sign, signRevoke, advance: (ms: number) => (t += ms), now: () => t };
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
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: good })).toMatchObject({ ok: true });
    expect(w.req.status("alice--shop", id)).toBe("allowed");
    expect(w.req.status("alice--other", id)).toBeNull();
    expect(w.grants.live("alice--shop").map((g) => g.origins)).toEqual([["shop.example.com"]]);
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: good })).toMatchObject({ ok: false, status: 404 });
  });

  it("the owner may grant less than was asked, never more, and the signature covers what is granted", async () => {
    const w = world();
    const ask = () => (w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate", "read-dom"], origins: ["a.example.com", "b.example.com"], localNetwork: { kind: "exact", hosts: ["192.168.1.5", "printer.lan"] }, duration: "session" })) as { requestId: string }).requestId;
    const id = ask();
    const narrow = { duration: "once" as const, capabilities: ["navigate"], origins: ["a.example.com"], localNetwork: null };
    // Wider than asked: refused before any signature is looked at.
    for (const wide of [{ duration: "service" }, { capabilities: ["navigate", "download"] }, { origins: ["a.example.com", "c.example.com"] }, { localNetwork: { kind: "whole-lan" } }, { localNetwork: { kind: "exact", hosts: ["10.0.0.9"] } }]) {
      expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id, wide as Partial<BrowserGrantAnswer>), scope: wide }), JSON.stringify(wide)).toMatchObject({ ok: false, status: 400 });
    }
    // A signature over the ask does not stand for a narrower grant, nor the other way round.
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id), scope: narrow })).toMatchObject({ ok: false, status: 403 });
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id, narrow) })).toMatchObject({ ok: false, status: 403 });
    const r = w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id, narrow), scope: narrow });
    expect(r).toMatchObject({ ok: true });
    const g = w.grants.live("alice--shop");
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ duration: "once", capabilities: ["navigate"], origins: ["a.example.com"], localNetwork: null });
    // Keeping one of two local hosts, for the session.
    const id2 = (w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: [], localNetwork: { kind: "exact", hosts: ["192.168.1.5", "printer.lan"] }, duration: "service" })) as { requestId: string }).requestId;
    const lan = { duration: "session" as const, localNetwork: { kind: "exact" as const, hosts: ["printer.lan"] } };
    expect(w.req.answer({ requestId: id2, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id2, lan), scope: lan })).toMatchObject({ ok: true });
    expect(w.grants.live("alice--shop", contextSession("alice--shop")).find((x) => x.duration === "session")?.localNetwork).toEqual({ kind: "exact", hosts: ["printer.lan"] });
  });

  it("lists the grants the owner gave, never the manifest's, and withdraws one on a signed revoke at once", async () => {
    const w = world();
    w.grants.approve({ serviceId: "alice--shop", capabilities: ["navigate"], origins: ["manifest.example.com"], duration: "service" });
    const id = (w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate"], origins: ["shop.example.com"], duration: "service", explanation: "prices" })) as { requestId: string }).requestId;
    const answered = w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id) }) as { ok: true; grantId: string };
    const other = (w.req.ask(normalizeAsk("alice--maps", { capabilities: ["navigate"], origins: ["maps.example.com"], duration: "service" })) as { requestId: string }).requestId;
    w.req.answer({ requestId: other, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(other) });
    expect(w.req.granted("alice--shop")).toEqual([expect.objectContaining({ grantId: answered.grantId, serviceId: "alice--shop", origins: ["shop.example.com"], duration: "service", explanation: "prices" })]);
    expect(w.req.granted()).toHaveLength(2);
    const gid = answered.grantId;
    expect(w.req.revoke({ serviceId: "alice--shop", grantId: gid, issuedAt: w.now() })).toMatchObject({ ok: false, status: 400 });
    expect(w.req.revoke({ serviceId: "alice--shop", grantId: gid, issuedAt: w.now(), signatureHex: w.signRevoke("alice--shop", gid, new Uint8Array(32).fill(9)) })).toMatchObject({ ok: false, status: 403 });
    expect(w.req.revoke({ serviceId: "alice--maps", grantId: gid, issuedAt: w.now(), signatureHex: w.signRevoke("alice--maps", gid) })).toMatchObject({ ok: false, status: 404 });
    expect(w.req.revoke({ serviceId: "alice--shop", grantId: gid, issuedAt: w.now() - 3_600_000, signatureHex: w.signRevoke("alice--shop", gid, owner, w.now() - 3_600_000) })).toMatchObject({ ok: false, status: 400 });
    // The manifest's own grant cannot be withdrawn here.
    const manifestId = w.grants.live("alice--shop").find((g) => g.origins[0] === "manifest.example.com")!.id;
    expect(w.req.revoke({ serviceId: "alice--shop", grantId: manifestId, issuedAt: w.now(), signatureHex: w.signRevoke("alice--shop", manifestId) })).toMatchObject({ ok: false, status: 404 });
    expect(w.req.revoke({ serviceId: "alice--shop", grantId: gid, issuedAt: w.now(), signatureHex: w.signRevoke("alice--shop", gid) })).toEqual({ ok: true });
    expect(w.revoked).toEqual(["alice--shop"]);
    expect(w.grants.live("alice--shop").map((g) => g.origins)).toEqual([["manifest.example.com"]]);
    expect(w.req.granted("alice--shop")).toEqual([]);
    expect(w.req.revoke({ serviceId: "alice--shop", grantId: gid, issuedAt: w.now(), signatureHex: w.signRevoke("alice--shop", gid) })).toMatchObject({ ok: false, status: 404 });
  });

  it("the owner routes: a narrowed answer, the list and the revoke, all behind the owner session", async () => {
    const w = world();
    const handle = buildBrowserApiHandlers({
      browser: {} as never, tabRegistry: {} as never, domainGate: {} as never, phonePipe: {} as never, appAuthTokens: {} as never,
      grantRequests: w.req,
      pairedSessionGate: { check: (r: HttpRequest) => (r.headers.authorization === "Flagship-Session ok" ? null : { status: 401, headers: {}, body: "{}" }) },
    });
    const call = async (method: string, path: string, body?: unknown, auth = "Flagship-Session ok") => {
      const r = await handle({ method, path, headers: { authorization: auth }, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) } as HttpRequest);
      return { status: r!.status, json: JSON.parse(String(r!.body)) as Record<string, unknown> };
    };
    const id = (w.req.ask(normalizeAsk("alice--shop", { capabilities: ["navigate", "read-dom"], origins: ["shop.example.com"], duration: "service" })) as { requestId: string }).requestId;
    expect((await call("GET", "/api/browser/owner/grants", undefined, "nope")).status).toBe(401);
    const narrow = { duration: "session" as const, capabilities: ["navigate"] };
    const answered = await call("POST", "/api/browser/owner/grant-requests/answer", { requestId: id, decision: "allow", issuedAt: w.now(), signature: w.sign(id, narrow), ...narrow });
    expect(answered).toMatchObject({ status: 200, json: { ok: true } });
    const list = await call("GET", "/api/browser/owner/grants?serviceId=alice--shop");
    const grants = list.json.grants as Array<{ grantId: string; duration: string; capabilities: string[] }>;
    expect(grants).toEqual([expect.objectContaining({ grantId: answered.json.grantId, duration: "session", capabilities: ["navigate"] })]);
    expect((await call("GET", "/api/browser/owner/grants?serviceId=alice--other")).json.grants).toEqual([]);
    const gid = grants[0]!.grantId;
    expect((await call("POST", "/api/browser/owner/grants/revoke", { serviceId: "alice--shop", grantId: gid, issuedAt: w.now(), signature: w.signRevoke("alice--shop", gid) })).status).toBe(200);
    expect((await call("GET", "/api/browser/owner/grants")).json.grants).toEqual([]);
  });

  it("a request reaches the owner's open app on the socket and wakes the phone content-free, at most once per app every ten minutes", () => {
    let t = 0;
    const events: unknown[] = [];
    let pushes = 0;
    let on = true;
    const alert = buildBrowserGrantAlerts({ sinks: () => ({ emit: (e) => events.push(e), push: () => void pushes++, alertsEnabled: () => on }), now: () => t });
    alert("alice--shop");
    alert("alice--shop");
    expect(events).toEqual([{ type: "browser-grant-request", serviceId: "alice--shop" }, { type: "browser-grant-request", serviceId: "alice--shop" }]);
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(pushes).toBe(1);
      t += 10 * 60_000;
      for (const s of ["a", "b", "c", "d", "e", "f"]) alert(`alice--${s}`);
      on = false;
      t += 3_600_000;
      alert("alice--zzz");
      return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
        expect(pushes).toBe(5); // one, then four more inside the hour; none with alerts off
        expect(events).toHaveLength(9);
      });
    });
  });

  it("a session grant lives in the app's browser context, and a local-network grant is its own ask", () => {
    const w = world();
    const r = w.req.ask(normalizeAsk("alice--hub", { capabilities: ["navigate"], origins: [], localNetwork: { kind: "exact", hosts: ["192.168.1.5"] }, duration: "session" }));
    const id = (r as { requestId: string }).requestId;
    expect(w.req.pending()[0]!.meaning.join(" ")).toContain("192.168.1.5");
    expect(w.req.answer({ requestId: id, decision: "allow", issuedAt: w.now(), signatureHex: w.sign(id) })).toMatchObject({ ok: true });
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

  const get = (proxyUrl: string, host: string, to = port) =>
    new Promise<number>((resolve) => {
      const u = new URL(proxyUrl);
      const r = request({ host: u.hostname, port: Number(u.port), path: `http://${host}:${to}/`, headers: { host: `${host}:${to}` } }, (res) => {
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
    proxies.allow("alice--shop", "shop.test", ["93.184.216.34"], { scheme: "http", port });
    expect(await get(shop, "shop.test")).toBe(200);
    expect(await get(other, "shop.test")).toBe(403);
    expect(await get(deny, "shop.test")).toBe(403);
    // An address that is never reachable stays refused even when approved.
    proxies.allow("alice--shop", "meta.test", ["169.254.169.254"], { scheme: "http", port });
    expect(await get(shop, "meta.test")).toBe(403);
    // An approval is for one scheme and port: the same host on another port, or as https, is not approved.
    expect(await get(shop, "shop.test", port + 1)).toBe(403);
    proxies.allow("alice--shop", "tls.test", ["93.184.216.34"]);
    expect(await get(shop, "tls.test")).toBe(403);
    await proxies.close("alice--shop");
    expect(await get(shop, "shop.test")).toBe(-1);
    await proxies.closeAll();
    expect(chromiumEgressFlags(deny)).toContain(`--proxy-server=${deny}`);
  });

  it("serves only the addresses it is told to, by default loopback", async () => {
    const proxies = new ServiceProxies({ acceptFrom: () => false, dial: (_a, p) => ({ host: "127.0.0.1", port: p }) });
    const shop = await proxies.proxyFor("alice--shop");
    proxies.allow("alice--shop", "shop.test", ["93.184.216.34"], { scheme: "http", port });
    expect(await get(shop, "shop.test")).toBe(403);
    await proxies.closeAll();
  });
});
