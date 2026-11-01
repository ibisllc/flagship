/**
 * The phone's bare `<account>.<apex>` route through the relay (plan H3; Appendix H acceptance scenarios 6, 7, 8;
 * docs/architecture-v2/phone-route.md). Two relay instances share one ledger (`.com`'s, in memory here, its
 * acquisitions and vacancies pushed to both like the serving feed does) and real SNI routers; phones are simulated in
 * node. Handover is vacancy-only (owner, 2026-11-01): a live holder keeps the route; others wait as standbys.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { FRAME_OPEN, type Frame } from "@flagship/tunnel-protocol";
import { ed, signDeviceCapabilityGrant, type AdminGrantView } from "@flagship/protocol";
import { MemoryPhoneRouteLedger, PhoneRoutes, type PhoneEligibilityRecord } from "../src/tunnel/phoneRoute.js";
import { startPhoneTunnel, type PhoneTunnelHandle } from "../src/tunnel/phoneTunnel.js";
import { TunnelRegistry, type RegisteredTunnel, type StreamCallbacks } from "../src/tunnel/registry.js";
import { startSniRouter, type RunningSniRouter } from "../src/tunnel/sniRouter.js";
import { buildClaimedCanonicals } from "../src/tunnel/tunnelHub.js";
import { ServingGate } from "../src/tunnel/servingGate.js";
import { ServingFeedClient } from "../src/tunnel/servingFeedClient.js";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { SimPhone, isPhoneCert, sayHello, selfSignedPhoneCert } from "../../../tools/live-e2e/lib/phoneSim.js";

const APEX = "flagship.services";
const BARE = `alice.${APEX}`;
const HOME = `home.alice.${APEX}`;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seed = (n: number) => new Uint8Array(32).fill(n);
const ADMIN_ROOT = seed(1);
const ADMIN_PUB = hex(ed.getPublicKey(ADMIN_ROOT));
const PHONE_A = seed(2);
const PHONE_B = seed(3);
const MEMBER = seed(4);
const PHONE_C = seed(6);
const BOX_STK = seed(5);

class Clock {
  t = Date.now();
  now = () => this.t;
}

function grant(device: Uint8Array, scopes: string[], signer: Uint8Array, signerRoot: "admin-root" | "membership", now: number): AdminGrantView {
  const g = {
    grantId: hex(device).slice(0, 32),
    username: "alice",
    deviceId: hex(device).slice(32),
    devicePubKey: ed.getPublicKey(device),
    scopes: scopes as AdminGrantView["grant"]["scopes"],
    issuedAt: now - 60_000,
    expiresAt: now + 30 * 86_400_000,
  };
  return { grant: g, signatureHex: hex(signDeviceCapabilityGrant(g, { privateKey: signer, publicKey: ed.getPublicKey(signer) })), signerRoot };
}

function clientHello(sni: string): Buffer {
  const u16 = (v: number) => Buffer.from([(v >> 8) & 255, v & 255]);
  const host = Buffer.from(sni);
  const entry = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
  const list = Buffer.concat([u16(entry.length), entry]);
  const ext = Buffer.concat([u16(0), u16(list.length), list]);
  const exts = Buffer.concat([u16(ext.length), ext]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0, 0x9c]), Buffer.from([1, 0]), exts]);
  const hs = Buffer.concat([Buffer.from([1, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);
}

function mockBox(podCanonical: string) {
  const sent: Frame[] = [];
  const t: RegisteredTunnel & { sent: Frame[] } = {
    podCanonical,
    sent,
    send: (f) => sent.push(f),
    attachStream: (_id: number, _cb: StreamCallbacks) => undefined,
    detachStream: () => undefined,
    nextStreamId: (() => {
      let n = 1;
      return () => n++;
    })(),
  };
  return t;
}

async function waitFor(pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Relay {
  id: string;
  routes: PhoneRoutes;
  registry: TunnelRegistry;
  box: ReturnType<typeof mockBox>;
  url: string;
  routerPort: number;
  close(): Promise<void>;
}

async function startRelay(id: string, ledger: MemoryPhoneRouteLedger, eligibility: () => PhoneEligibilityRecord | null, clock: Clock): Promise<Relay> {
  const http: Server = createServer();
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const registry = new TunnelRegistry();
  const routes = new PhoneRoutes({
    relayId: id,
    apex: APEX,
    ledger,
    eligibility: async () => eligibility(),
    now: clock.now,
    renewMs: 3_600_000,
    recheckMs: 3_600_000,
    standbyPollMs: 3_600_000,
  });
  registry.setPhoneRoutes(routes);
  // A box of the same account that (somehow) names the bare name among its canonicals: it must never receive it.
  const box = mockBox(HOME);
  registry.register({ tunnel: box, canonicals: [HOME, BARE] });
  const tunnel: PhoneTunnelHandle = startPhoneTunnel(http, routes);
  const router: RunningSniRouter = await startSniRouter(registry, { port: 0, host: "127.0.0.1", holdTimeoutMs: 300, holdPollIntervalMs: 20 });
  return {
    id,
    routes,
    registry,
    box,
    url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/phone-tunnel`,
    routerPort: router.port,
    async close() {
      await tunnel();
      await router.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

/** A TLS visitor of the bare name through `relay`: the answering phone's label, or null. */
function tlsVisit(relay: Relay, ca: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    // Both phones' certificates share one subject (as in the gym): match the peer by fingerprint, not a CA list.
    const s = tlsConnect({ host: "127.0.0.1", port: relay.routerPort, servername: BARE, rejectUnauthorized: false });
    s.setTimeout(3_000, () => s.destroy());
    s.on("secureConnect", () => (isPhoneCert(s.getPeerCertificate().fingerprint256, ca) ? undefined : s.destroy()));
    s.on("secureConnect", () => s.write(`GET /.well-known/flagship-phone HTTP/1.1\r\nhost: ${BARE}\r\n\r\n`));
    s.on("data", (d) => (text += d.toString()));
    s.on("close", () => resolve(/"phone":"([^"]+)"/.exec(text)?.[1] ?? null));
    s.on("error", () => undefined);
  });
}

/** A visitor of `sni` through `relay`: what came back before the relay or phone closed (or `holdMs` passed). */
async function visit(relay: Relay, sni: string, holdMs = 400): Promise<{ data: string; closed: boolean; sock: Socket }> {
  const sock = netConnect(relay.routerPort, "127.0.0.1");
  const v = { data: "", closed: false, sock };
  sock.on("data", (d) => (v.data += d.toString("latin1")));
  sock.on("close", () => (v.closed = true));
  sock.on("error", () => undefined);
  sock.write(clientHello(sni));
  const end = Date.now() + holdMs;
  while (!v.closed && Date.now() < end && v.data.length === 0) await new Promise((r) => setTimeout(r, 10));
  return v;
}

describe("phone route through two relay instances sharing one ledger", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0).reverse()) await c();
  });

  async function world() {
    const clock = new Clock();
    const ledger = new MemoryPhoneRouteLedger(clock.now);
    let grants: AdminGrantView[] = [
      grant(PHONE_A, ["admin"], ADMIN_ROOT, "admin-root", clock.t),
      grant(PHONE_B, ["admin"], ADMIN_ROOT, "admin-root", clock.t),
      grant(PHONE_C, ["admin"], ADMIN_ROOT, "admin-root", clock.t),
      grant(MEMBER, ["browse"], ADMIN_ROOT, "membership", clock.t),
    ];
    const eligibility = () => ({ adminRootPub: ADMIN_PUB, grants });
    const r1 = await startRelay("relay-1", ledger, eligibility, clock);
    const r2 = await startRelay("relay-2", ledger, eligibility, clock);
    ledger.onChange((h, g, vacant) => {
      r1.routes.pushed(h, g, vacant);
      r2.routes.pushed(h, g, vacant);
    });
    cleanup.push(() => r1.close(), () => r2.close());
    const phone = async (relay: Relay, s: Uint8Array, label: string, tls?: { key: string; cert: string }) => {
      const p = await SimPhone.connect(relay.url, { account: "alice", seed: s, label, ...(tls ? { tls } : {}) });
      cleanup.push(() => p.terminate());
      return p;
    };
    return {
      clock,
      ledger,
      r1,
      r2,
      phone,
      revoke(device: Uint8Array) {
        const pub = hex(ed.getPublicKey(device));
        grants = grants.filter((g) => hex(g.grant.devicePubKey) !== pub);
      },
    };
  }

  // ── scenario 6: a box can never hold the bare name ──────────────────────

  it("6: a box's HELLO naming the bare name is refused, its key cannot claim, and the name never routes to it", async () => {
    const w = await world();
    // The hub's claim check refuses a box naming the bare account name, even beside its own valid names.
    expect(buildClaimedCanonicals(HOME, null, [], "alice", APEX).ok).toBe(true);
    const viaGrant = buildClaimedCanonicals(HOME, { canonicals: [BARE] } as never, [], "alice", APEX);
    expect(viaGrant.ok).toBe(false);
    // Even registered with the bare name among its canonicals (a simulated valid certificate and grant), a box is
    // never what the bare name resolves to.
    expect(w.r1.registry.findBySni(HOME)).toBe(w.r1.box);
    expect(w.r1.registry.findBySni(BARE)).toBeUndefined();
    // The box's own key tries the phone tunnel: a correctly signed claim, refused for eligibility.
    const box = await w.phone(w.r1, BOX_STK, "box");
    expect(await box.acquire()).toMatchObject({ type: "refused", code: "not-eligible" });
    // So does a member (non-admin) device, and the bare admin root itself.
    const member = await w.phone(w.r1, MEMBER, "member");
    expect(await member.acquire()).toMatchObject({ type: "refused", code: "not-eligible" });
    const root = await w.phone(w.r1, ADMIN_ROOT, "root");
    expect(await root.acquire()).toMatchObject({ type: "refused", code: "not-eligible" });
    const v = await visit(w.r1, BARE);
    expect(v.data).toBe("");
    await waitFor(() => v.closed);
    expect(w.r1.box.sent.some((f) => f.type === FRAME_OPEN)).toBe(false);
  });

  // ── scenario 7: two admin phones hand the route over ───────────────────

  it("7: a live holder keeps the route: another admin phone is refused route-held with the holder's generation and waits", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    expect(await a.acquire()).toMatchObject({ type: "granted", generation: 1 });
    const v1 = await visit(w.r1, BARE);
    expect(v1.data.startsWith("A:")).toBe(true);
    // The other instance does not hold A's tunnel: it closes, it does not forward to anyone.
    expect((await visit(w.r2, BARE)).data).toBe("");
    const b = await w.phone(w.r2, PHONE_B, "B");
    expect(await b.acquire()).toMatchObject({ type: "refused", code: "route-held", generation: 1 });
    // Asking again changes nothing: no preemption, whatever the phone believes.
    expect(await b.acquire()).toMatchObject({ type: "refused", code: "route-held", generation: 1 });
    expect((await visit(w.r1, BARE)).data.startsWith("A:")).toBe(true);
    expect((await visit(w.r2, BARE)).data).toBe("");
    // A's open stream is untouched.
    const before = v1.data.length;
    v1.sock.write("still here");
    await waitFor(() => v1.data.length > before);
    expect(v1.data.endsWith("A:still here")).toBe(true);
    expect(w.r1.routes.stats().holding + w.r2.routes.stats().standby).toBe(2);
  });

  it("7: the holder's tunnel drops: its streams end with it, every standby on both relays hears route-vacant, the first claim wins", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    await a.acquire();
    const v = await visit(w.r1, BARE);
    expect(v.data.startsWith("A:")).toBe(true);
    const b = await w.phone(w.r2, PHONE_B, "B");
    const c = await w.phone(w.r1, PHONE_C, "C");
    expect(await b.acquire()).toMatchObject({ code: "route-held" });
    expect(await c.acquire()).toMatchObject({ code: "route-held" });
    a.terminate();
    await waitFor(() => v.closed);
    expect(await b.next((m) => m.type === "route-vacant")).toMatchObject({ hostname: BARE, generation: 1 });
    expect(await c.next((m) => m.type === "route-vacant")).toMatchObject({ hostname: BARE, generation: 1 });
    const [cb, cc] = await Promise.all([b.begin(), c.begin()]);
    const [rb, rc] = await Promise.all([b.sendClaim(b.sign(cb)), c.sendClaim(c.sign(cc))]);
    const results = [rb, rc].map((r) => r.type).sort();
    expect(results).toEqual(["granted", "refused"]);
    const winner = rb.type === "granted" ? { phone: "B", relay: w.r2, other: w.r1 } : { phone: "C", relay: w.r1, other: w.r2 };
    expect([rb, rc].find((r) => r.type === "refused")).toMatchObject({ code: "route-held", generation: 2 });
    expect((await visit(winner.relay, BARE)).data.startsWith(`${winner.phone}:`)).toBe(true);
    expect((await visit(winner.other, BARE)).data).toBe("");
  });

  it("7: release then claim: the holder releases (signed), its streams end, the standby is told and claims", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    await a.acquire();
    const v = await visit(w.r1, BARE);
    const b = await w.phone(w.r2, PHONE_B, "B");
    expect(await b.acquire()).toMatchObject({ code: "route-held" });
    // A release signed by another key, or for another generation, is refused.
    const thief = await w.phone(w.r1, PHONE_B, "thief");
    expect(await thief.acquire()).toMatchObject({ code: "route-held" });
    thief.granted = a.granted;
    expect(await thief.release()).toMatchObject({ type: "refused", code: "not-holder" });
    expect(await a.release({ generation: 7 })).toMatchObject({ type: "refused" });
    expect(await a.release()).toMatchObject({ type: "released", generation: 1, confirmed: true });
    await waitFor(() => v.closed);
    expect(await b.next((m) => m.type === "route-vacant")).toMatchObject({ generation: 1 });
    expect(await b.acquire()).toMatchObject({ type: "granted", generation: 2 });
    expect((await visit(w.r2, BARE)).data.startsWith("B:")).toBe(true);
    expect((await visit(w.r1, BARE)).data).toBe("");
    // A, still connected, cannot take it back.
    expect(await a.acquire()).toMatchObject({ type: "refused", code: "route-held", generation: 2 });
  });

  it("7: a stale holder whose lease lapsed cannot retake the route once someone else claimed it", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    const old = await a.begin();
    const oldClaim = a.sign(old);
    expect(await a.sendClaim(oldClaim)).toMatchObject({ type: "granted", generation: 1 });
    // Relay 1 loses `.com` (A suspended, a partition): past the lease the ledger has no holder.
    w.ledger.reachable = false;
    w.clock.t += 61_000;
    await w.r1.routes.renewAll();
    expect(await a.next((m) => m.type === "lost")).toMatchObject({ reason: "contact" });
    w.ledger.reachable = true;
    const b = await w.phone(w.r2, PHONE_B, "B");
    expect(await b.sendClaim(b.sign(await b.begin(), { issuedAt: w.clock.t }))).toMatchObject({ type: "granted", generation: 2 });
    // A's old claim, its renewal, and a fresh claim all fail.
    expect(await a.sendClaim(oldClaim)).toMatchObject({ type: "refused", code: "no-challenge" });
    expect((await w.ledger.apply({ op: "renew", hostname: BARE, generation: 1, sessionId: "any" }))?.ok).toBe(false);
    expect(await a.sendClaim(a.sign(await a.begin(), { issuedAt: w.clock.t }))).toMatchObject({ type: "refused", code: "route-held", generation: 2 });
    expect((await visit(w.r1, BARE)).data).toBe("");
    expect((await visit(w.r2, BARE)).data.startsWith("B:")).toBe(true);
  });

  it("7: simultaneous claims on a vacant route: the first commit wins, the other is refused route-held", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    const b = await w.phone(w.r2, PHONE_B, "B");
    const [ca, cb] = await Promise.all([a.begin(), b.begin()]);
    expect(ca.generation).toBe(1);
    expect(cb.generation).toBe(1);
    expect(await a.sendClaim(a.sign(ca))).toMatchObject({ type: "granted", generation: 1 });
    expect(await b.sendClaim(b.sign(cb))).toMatchObject({ type: "refused", code: "route-held", generation: 1 });
    expect((await visit(w.r1, BARE)).data.startsWith("A:")).toBe(true);
  });

  it("7: a standby relay notices a vacancy whose push was lost by reading the ledger", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    await a.acquire();
    const b = await w.phone(w.r2, PHONE_B, "B");
    await b.acquire();
    // A's tunnel drops while `.com` is unreachable: relay 1's release and the push are both lost.
    w.ledger.reachable = false;
    a.terminate();
    await a.closed;
    w.ledger.reachable = true;
    // Past the lease the ledger has no holder; relay 2's own read finds that.
    w.clock.t += 61_000;
    await w.r2.routes.pollStandby(BARE);
    expect(await b.next((m) => m.type === "route-vacant")).toMatchObject({ generation: 1 });
    expect(await b.sendClaim(b.sign(await b.begin(), { issuedAt: w.clock.t }))).toMatchObject({ type: "granted", generation: 2 });
  });

  it("8: disconnection closes the bare name; nothing is parked or sent to a box", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    await a.acquire();
    a.terminate();
    await a.closed;
    await waitFor(async () => (await w.ledger.read(BARE))?.holder === null);
    for (const r of [w.r1, w.r2]) {
      const v = await visit(r, BARE);
      expect(v.data).toBe("");
      await waitFor(() => v.closed);
      expect(r.box.sent.some((f) => f.type === FRAME_OPEN)).toBe(false);
    }
  });

  it("8: a lease that is no longer confirmed (suspension, lost contact with .com) stops routing; past the lease the route is gone", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    await a.acquire();
    w.ledger.reachable = false;
    w.clock.t += 31_000;
    expect((await visit(w.r1, BARE)).data).toBe("");
    w.clock.t += 30_000;
    await w.r1.routes.renewAll();
    expect(await a.next((m) => m.type === "lost")).toMatchObject({ reason: "contact" });
    w.ledger.reachable = true;
    expect((await w.ledger.read(BARE))?.holder).toBeNull();
    expect((await visit(w.r1, BARE)).data).toBe("");
    expect(w.r1.box.sent.some((f) => f.type === FRAME_OPEN)).toBe(false);
  });

  it("8: replays are refused: a used nonce, another relay's nonce, an old claim, a stale clock", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    const ch = await a.begin();
    const signed = a.sign(ch);
    expect(await a.sendClaim(signed)).toMatchObject({ type: "granted" });
    // The same claim again on the same session: the nonce was single use.
    expect(await a.sendClaim(signed)).toMatchObject({ type: "refused", code: "no-challenge" });
    // Captured and replayed on the other relay (where that session offered something else).
    const thief = await w.phone(w.r2, PHONE_B, "thief");
    await thief.begin();
    expect(await thief.sendClaim(signed)).toMatchObject({ type: "refused", code: "wrong-session" });
    // A claim signed with an old clock.
    const ch2 = await thief.begin();
    expect(await thief.sendClaim(thief.sign(ch2, { issuedAt: w.clock.t - 61_000 }))).toMatchObject({ type: "refused", code: "stale" });
    // A claim for a generation other than the offered one.
    const ch3 = await thief.begin();
    expect(await thief.sendClaim(thief.sign(ch3, { generation: Number(ch3.generation) + 5 }))).toMatchObject({ type: "refused", code: "wrong-generation" });
    expect((await visit(w.r1, BARE)).data.startsWith("A:")).toBe(true);
    expect((await visit(w.r2, BARE)).data).toBe("");
  });

  it("8: revoking the phone drops its claim, closes its streams and tunnel, and never routes to a box", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    await a.acquire();
    const v = await visit(w.r1, BARE);
    expect(v.data.startsWith("A:")).toBe(true);
    w.revoke(PHONE_A);
    const t0 = Date.now();
    await w.r1.routes.eligibilityChanged("alice");
    await a.closed;
    await waitFor(() => v.closed);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(a.closedWith?.code).toBe(4403);
    expect((await w.ledger.read(BARE))?.holder).toBeNull();
    for (const r of [w.r1, w.r2]) expect((await visit(r, BARE)).data).toBe("");
    expect(w.r1.box.sent.some((f) => f.type === FRAME_OPEN)).toBe(false);
    // And it cannot claim again.
    const again = await w.phone(w.r2, PHONE_A, "A2");
    expect(await again.acquire()).toMatchObject({ type: "refused", code: "not-eligible" });
  });

  it("8: .com unreachable at claim time: refused, fail closed", async () => {
    const w = await world();
    const a = await w.phone(w.r1, PHONE_A, "A");
    w.ledger.reachable = false;
    expect(await a.begin()).toMatchObject({ type: "refused", code: "unavailable" });
    expect((await visit(w.r1, BARE)).data).toBe("");
  });

  it("gym run 21, over TLS on one relay: hello, refusal, release, the standby claims and visitors reach it; its drop wakes the released phone", async () => {
    const w = await world();
    const c1 = selfSignedPhoneCert(BARE);
    const c2 = selfSignedPhoneCert(BARE);
    const ca = [c1.cert, c2.cert];
    const p1 = await w.phone(w.r1, PHONE_A, "P1", c1);
    expect(await p1.acquire()).toMatchObject({ type: "granted" });
    expect(await tlsVisit(w.r1, ca)).toBe("P1");
    expect(await sayHello({ ip: "127.0.0.1", port: w.r1.routerPort, hostname: BARE, account: "alice", seed: PHONE_B, ca })).toBe("P1");
    const p2 = await w.phone(w.r1, PHONE_B, "P2", c2);
    expect(await p2.acquire()).toMatchObject({ type: "refused", code: "route-held" });
    expect(await tlsVisit(w.r1, ca)).toBe("P1");
    expect(await p1.release()).toMatchObject({ type: "released" });
    await p2.next((m) => m.type === "route-vacant");
    expect(await p2.acquire()).toMatchObject({ type: "granted", generation: 2 });
    for (let i = 0; i < 3; i++) expect(await tlsVisit(w.r1, ca)).toBe("P2");
    // The released phone kept its tunnel: it is a standby and hears the next vacancy.
    p2.terminate();
    await p2.closed;
    expect(await p1.next((m) => m.type === "route-vacant")).toMatchObject({ generation: 2 });
    expect(await tlsVisit(w.r1, ca)).toBeNull();
  });

  it("TLS ends on the phone: the visitor's TLS peer is the phone's own certificate for exactly the bare name", async () => {
    const w = await world();
    const cert = selfSignedPhoneCert(BARE);
    const a = await w.phone(w.r1, PHONE_A, "A", cert);
    await a.acquire();
    const body = await new Promise<{ peer: string; text: string }>((resolve, reject) => {
      const s = tlsConnect({ host: "127.0.0.1", port: w.r1.routerPort, servername: BARE, ca: cert.cert, checkServerIdentity: () => undefined });
      let text = "";
      s.on("secureConnect", () => s.write(`GET / HTTP/1.1\r\nhost: ${BARE}\r\n\r\n`));
      s.on("data", (d) => (text += d.toString()));
      s.on("end", () => resolve({ peer: s.getPeerCertificate().subject?.CN as string, text }));
      s.on("error", reject);
    });
    expect(body.peer).toBe(BARE);
    expect(body.text).toContain('"phone":"A"');
  });
});

describe("the serving feed carries phone-route pushes and eligibility changes", () => {
  it("routes both frame types to the phone routes and resyncs after a reconnect", async () => {
    const httpServer: Server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const sockets: WsSocket[] = [];
    httpServer.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => sockets.push(ws)));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const calls: string[] = [];
    const client = new ServingFeedClient({
      comBaseUrl: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
      secret: "s",
      relayId: "relay-1",
      revocationKey: "ab".repeat(32),
      gate: new ServingGate({ fetchRecord: async () => null }),
      initialBackoffMs: 20,
      phone: {
        pushed: (h, g, vacant) => void calls.push(`pushed ${h} ${g} ${vacant}`),
        eligibilityChanged: async (u) => void calls.push(`eligibility ${u}`),
        resync: async () => void calls.push("resync"),
      },
    });
    client.start();
    try {
      await waitFor(() => sockets.length === 1);
      sockets[0]!.send(JSON.stringify({ type: "phone-route", hostname: BARE, generation: 7, vacant: true }));
      sockets[0]!.send(JSON.stringify({ type: "phone-eligibility", username: "alice" }));
      await waitFor(() => calls.length === 2);
      expect(calls).toEqual([`pushed ${BARE} 7 true`, "eligibility alice"]);
      sockets[0]!.terminate();
      await waitFor(() => sockets.length === 2);
      sockets[1]!.send(JSON.stringify({ type: "beat", sequence: 0 }));
      await waitFor(() => calls.includes("resync"));
    } finally {
      client.stop();
      for (const s of sockets) s.terminate();
      wss.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  });
});
