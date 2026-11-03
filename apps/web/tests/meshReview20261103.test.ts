/**
 * Relay-mesh review 2026-11-03 (relay-mesh.md §5.4, §6.1-§6.3, §7.2, §7.6, §10.3): handshake slots and the client
 * address, a cut peer refused before the acceptor's proof, the dialer's backoff after short-lived bridges, the bridge
 * MAC, excluded-query misses, unknown-account moves, tombstones only for registered subjects (capped per relay),
 * relay-bound mailbox announcements, delivery to a mailbox's next relay, and sync dumps of own items only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import {
  accountHash,
  canonicalPbMailboxAnnounce,
  canonicalPbMailboxAnnounceForRelay,
  ed,
  MESH_HANDSHAKE_MAX_PENDING,
  MESH_HANDSHAKE_MAX_PENDING_PER_IP,
  MESH_HANDSHAKE_RESERVED,
  MESH_KNOWN_ADDRESS_TTL_MS,
  pbMailboxEpoch,
  pbMailboxId,
  sealBridgeText,
  signRelayMeshRecord,
  type AccountMove,
  type AttachmentItem,
  type BoxAttachment,
  type RelayBlessing,
  type RelayWithdraw,
} from "@flagship/protocol";
import { BridgeManager, dialerHandshake, HandshakeQueue, KnownPeerAddresses, PendingHandshakes, type BridgePeer, type HandshakeContext } from "../src/tunnel/mesh/bridge.js";
import { AttachmentStore } from "../src/tunnel/mesh/attachments.js";
import { MeshDirectory } from "../src/tunnel/mesh/directory.js";
import { MeshFeed } from "../src/tunnel/mesh/feed.js";
import { AccountHomes } from "../src/tunnel/mesh/home.js";
import { MeshNode } from "../src/tunnel/mesh/node.js";
import { MeshQuery } from "../src/tunnel/mesh/query.js";
import { clientAddress, flyClientIpTrusted } from "../src/tunnel/phoneTunnel.js";
import { APEX, hex, keypair, MeshFixture, type FixtureRelay } from "./support/meshFixture.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function ctxFor(fx: MeshFixture, r: FixtureRelay, blessing?: RelayBlessing | null): Promise<HandshakeContext> {
  const dir = new MeshDirectory({ servicesApex: APEX, caKeys: () => [fx.caPub] });
  dir.offerFile({ directory: fx.directory, blessings: [] });
  const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
  await feed.poll();
  const b = blessing === undefined ? fx.blessings.get(r.relayId)! : blessing;
  return {
    selfRelayId: r.relayId,
    sign: (m) => ed.sign(m, r.key.privateKey),
    blessing: () => b,
    heldBlessing: (id) => dir.heldBlessing(id),
    caKeys: () => [fx.caPub],
    checkContext: () => ({ servicesApex: APEX, log: feed.state, directory: dir.current, now: Date.now() }),
    now: () => Date.now(),
  };
}

interface Side {
  mgr: BridgeManager;
  port: number;
  ups: BridgePeer[];
  controls: Array<Record<string, unknown>>;
}

async function side(ctx: HandshakeContext, ports: Map<string, number>, peers: string[], o: { onUp?: (p: BridgePeer) => void; firstMs?: number; stableMs?: number; refused?: (id: string) => boolean } = {}): Promise<Side> {
  const http: Server = createServer();
  await new Promise<void>((res) => http.listen(0, "127.0.0.1", () => res()));
  const port = (http.address() as AddressInfo).port;
  ports.set(ctx.selfRelayId, port);
  const s: Side = { mgr: null as unknown as BridgeManager, port, ups: [], controls: [] };
  s.mgr = new BridgeManager({
    ...ctx,
    ...(o.refused ? { refused: o.refused } : {}),
    ...(o.firstMs !== undefined ? { firstMs: o.firstMs } : {}),
    ...(o.stableMs !== undefined ? { stableMs: o.stableMs } : {}),
    knownPeers: new KnownPeerAddresses(),
    trustFlyClientIp: false,
    peers: () => peers.map((id) => ({ relayId: id, tunnelHost: `${id}.tunnel.${APEX}` })),
    peerUrl: (p) => `ws://127.0.0.1:${ports.get(p.relayId)}/mesh`,
    handler: {
      onControl: (_p, m) => s.controls.push(m),
      onOpen: () => undefined,
      onUp: (p) => {
        s.ups.push(p);
        o.onUp?.(p);
      },
      onDown: () => undefined,
    },
  });
  const detach = s.mgr.attach(http);
  cleanup.push(async () => {
    detach();
    await s.mgr.stop();
    http.closeAllConnections?.();
    await new Promise<void>((res) => http.close(() => res()));
  });
  return s;
}

function pair() {
  const fx = new MeshFixture();
  const ra = fx.addRelay("ra");
  const rb = fx.addRelay("rb");
  fx.mintDirectory();
  return { fx, ra, rb };
}

async function rawDial(port: number): Promise<{ ws: WebSocket; q: HandshakeQueue; closed: Promise<{ code: number; reason: string; at: number }> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/mesh`);
  const q = new HandshakeQueue(ws);
  const closed = new Promise<{ code: number; reason: string; at: number }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString(), at: Date.now() })));
  ws.on("error", () => undefined);
  await new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, q, closed };
}

describe("§6.1 handshake slots and the client address", () => {
  it("believes Fly-Client-IP only on Fly or when told to", () => {
    const req = { headers: { "fly-client-ip": "203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } } as unknown as IncomingMessage;
    expect(clientAddress(req, false)).toBe("10.0.0.1");
    expect(clientAddress(req, true)).toBe("203.0.113.9");
    expect(flyClientIpTrusted({})).toBe(false);
    expect(flyClientIpTrusted({ FLY_APP_NAME: "flagship-services" })).toBe(true);
    expect(flyClientIpTrusted({ FLY_ALLOC_ID: "abc" })).toBe(true);
    expect(flyClientIpTrusted({ FLY_APP_NAME: "x", FLAGSHIP_TRUST_FLY_CLIENT_IP: "0" })).toBe(false);
    expect(flyClientIpTrusted({ FLAGSHIP_TRUST_FLY_CLIENT_IP: "1" })).toBe(true);
  });

  it("keeps 16 slots for known peer addresses once the 64 are held", () => {
    const p = new PendingHandshakes();
    let n = 0;
    for (let i = 0; n < MESH_HANDSHAKE_MAX_PENDING; i++) if (p.tryAdd(`10.0.${i >> 2}.${i & 3}`)) n++;
    expect(p.tryAdd("198.51.100.1")).toBeNull();
    expect(p.tryAdd("198.51.100.1", true)).toBe("reserved");
    for (let i = 1; i < MESH_HANDSHAKE_MAX_PENDING_PER_IP; i++) expect(p.tryAdd("198.51.100.1", true)).toBe("reserved");
    expect(p.tryAdd("198.51.100.1", true)).toBeNull();
    let r = MESH_HANDSHAKE_MAX_PENDING_PER_IP;
    for (let i = 0; r < MESH_HANDSHAKE_RESERVED; i++) if (p.tryAdd(`198.51.101.${i}`, true)) r++;
    expect(p.tryAdd("198.51.102.1", true)).toBeNull();
    p.done("198.51.100.1", "reserved");
    expect(p.tryAdd("198.51.100.1", true)).toBe("reserved");
  });

  it("learns a peer's address for 24 h, keeps configured ones, and caps what it learns", () => {
    let t = 1_000;
    const k = new KnownPeerAddresses([" 192.0.2.7 "], () => t);
    expect(k.has("192.0.2.7")).toBe(true);
    expect(k.has("192.0.2.8")).toBe(false);
    k.learn("192.0.2.8");
    expect(k.has("192.0.2.8")).toBe(true);
    t += MESH_KNOWN_ADDRESS_TTL_MS;
    expect(k.has("192.0.2.8")).toBe(false);
    for (let i = 0; i < 300; i++) k.learn(`10.1.${i >> 8}.${i & 255}`);
    expect(k.has("10.1.0.0")).toBe(false);
    expect(k.has("10.1.1.43")).toBe(true);
  });

  it("an acceptor gives the dialer's mesh-auth 2 s, not a whole 5 s step", async () => {
    const { fx, rb } = pair();
    const ports = new Map<string, number>();
    const b = await side(await ctxFor(fx, rb), ports, [], { firstMs: 200 });
    const t0 = Date.now();
    const { closed } = await rawDial(b.port);
    const c = await closed;
    expect(c.code).toBe(4401);
    expect(c.at - t0).toBeLessThan(2_000);
  });
});

describe("§6.1 / §6.2 a cut peer and short-lived bridges", () => {
  it("a peer this relay refuses is answered `revoked` before the acceptor proves itself", async () => {
    const { fx, ra, rb } = pair();
    const ports = new Map<string, number>();
    const b = await side(await ctxFor(fx, rb), ports, [], { refused: (id) => id === "ra" });
    const { ws, q, closed } = await rawDial(b.port);
    const r = await dialerHandshake(ws, "rb", await ctxFor(fx, ra), 5_000, q);
    expect(r.ok).toBe(false);
    expect(await closed).toMatchObject({ code: 4401, reason: "revoked" });
  });

  it("a bridge that drops right after the handshake is redialled with backoff, not in a loop", async () => {
    const { fx, ra, rb } = pair();
    const ports = new Map<string, number>();
    // rb accepts and closes every bridge at once.
    const b = await side(await ctxFor(fx, rb), ports, [], { onUp: (p) => setImmediate(() => p.close(1000, "bye")) });
    const a = await side(await ctxFor(fx, ra), ports, ["rb"], { stableMs: 30_000 });
    a.mgr.start(20);
    await new Promise((r) => setTimeout(r, 1_500));
    // Backoff starts at 1 s: at most a couple of bridges in 1.5 s (the old code redialled every ~50 ms).
    expect(b.ups.length).toBeGreaterThanOrEqual(1);
    expect(b.ups.length).toBeLessThanOrEqual(3);
    expect(a.mgr.dialAttempts("rb")).toBeGreaterThanOrEqual(1);
  });
});

describe("§6.2 the bridge MAC", () => {
  async function authed() {
    const { fx, ra, rb } = pair();
    const ports = new Map<string, number>();
    const b = await side(await ctxFor(fx, rb), ports, []);
    const { ws, q, closed } = await rawDial(b.port);
    const r = await dialerHandshake(ws, "rb", await ctxFor(fx, ra), 5_000, q);
    if (!r.ok) throw new Error(r.reason);
    q.detach();
    await expect.poll(() => b.mgr.peer("ra") !== null, { timeout: 2_000 }).toBe(true);
    return { b, ws, closed, keys: r.keys };
  }

  it("takes a sealed control message and closes 4401 bad-mac on an unsealed one", async () => {
    const { b, ws, closed, keys } = await authed();
    ws.send(sealBridgeText(keys.c2s, 0, JSON.stringify({ type: "ping-test", n: 1 })));
    await expect.poll(() => b.controls.find((m) => m.type === "ping-test"), { timeout: 2_000 }).toMatchObject({ n: 1 });
    ws.send(JSON.stringify({ type: "ping-test", n: 2 }));
    expect(await closed).toMatchObject({ code: 4401, reason: "bad-mac" });
    expect(b.controls.filter((m) => m.type === "ping-test").length).toBe(1);
  });

  it("refuses a replayed message (the sequence number moved on) and one sealed with the other direction's key", async () => {
    const one = await authed();
    const text = sealBridgeText(one.keys.c2s, 0, JSON.stringify({ type: "ping-test" }));
    one.ws.send(text);
    one.ws.send(text);
    expect(await one.closed).toMatchObject({ code: 4401, reason: "bad-mac" });
    const two = await authed();
    two.ws.send(sealBridgeText(two.keys.s2c, 0, JSON.stringify({ type: "ping-test" })));
    expect(await two.closed).toMatchObject({ code: 4401, reason: "bad-mac" });
    expect(two.b.controls.length).toBe(0);
  });
});

describe("§7.2 step 4: a re-query past a refusing relay", () => {
  it("remembers the miss for (name, excluded) and asks again only after it lapses or an announcement", async () => {
    let t = 1_000;
    const sent: unknown[] = [];
    const peer = { relayId: "rc", send: (m: unknown) => sent.push(m) } as unknown as BridgePeer;
    const q = new MeshQuery({ transport: { peers: () => [peer] }, accept: () => false, now: () => t, timeoutMs: 20 });
    const name = `home.alice.${APEX}`;
    expect(await q.ask(name, new Set(["rb"]))).toBeNull();
    expect(sent.length).toBe(1);
    expect(await q.ask(name, new Set(["rb"]))).toBeNull();
    expect(sent.length).toBe(1);
    expect(q.stats.negativeHits).toBe(1);
    // Another excluded set is its own question.
    expect(await q.ask(name, new Set(["rd"]))).toBeNull();
    expect(sent.length).toBe(2);
    q.clearMiss(name);
    expect(await q.ask(name, new Set(["rb"]))).toBeNull();
    expect(sent.length).toBe(3);
    t += 2_000;
    expect(await q.ask(name, new Set(["rb"]))).toBeNull();
    expect(sent.length).toBe(4);
  });
});

describe("§10.3 account moves", () => {
  it("refuses a move for an account this relay holds nothing of, and one whose home is null", () => {
    const fx = new MeshFixture();
    const ra = fx.addRelay("ra");
    fx.addRelay("rc");
    fx.mintDirectory();
    const dir = new MeshDirectory({ servicesApex: APEX, caKeys: () => [fx.caPub] });
    dir.offer(fx.directory);
    let t = 50_000_000;
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    const homes = new AccountHomes({ selfRelayId: "rb", ctx: () => ({ servicesApex: APEX, log: feed.state, directory: dir.current, now: t }), winners: () => [], sign: () => new Uint8Array(64), minMoveMs: 1_000 });
    const move: AccountMove = { accountHash: accountHash("bob"), fromRelayId: "ra", toRelayId: "rc", issuedAt: t, notAfter: t + 60_000 };
    const signature = signRelayMeshRecord("relay-account-move", move, (m) => ed.sign(m, ra.key.privateKey));
    // The old code took the move's own `from` as the home here and accepted it.
    expect(homes.offer({ move, signature }, null, "ra")).toEqual({ ok: false, reason: "unknown-account" });
    expect(homes.offer({ move, signature }, "bob", "ra")).toEqual({ ok: false, reason: "not-home" });
    expect(homes.spacingCount()).toBe(0);
    t += 2_000;
    homes.sweep();
    expect(homes.spacingCount()).toBe(0);
  });
});

describe("§5.4 tombstones", () => {
  async function store(o: { maxTombstonesPerRelay?: number } = {}) {
    const fx = new MeshFixture();
    const ra = fx.addRelay("ra");
    const rb = fx.addRelay("rb");
    fx.mintDirectory();
    const box = keypair();
    const pod = `home.alice.${APEX}`;
    fx.registerBox(pod, hex(box.publicKey));
    for (let i = 0; i < 5; i++) fx.registerBox(`b${i}.alice.${APEX}`, hex(keypair().publicKey));
    const dir = new MeshDirectory({ servicesApex: APEX, caKeys: () => [fx.caPub] });
    dir.offer(fx.directory);
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    await feed.poll();
    const s = new AttachmentStore({ selfRelayId: "rc", servicesApex: APEX, ctx: () => ({ servicesApex: APEX, log: feed.state, directory: dir.current, now: Date.now() }), ...o });
    const now = Date.now();
    const att: BoxAttachment = { serverFqdn: pod, boxPub: hex(box.publicKey), regGen: 1, relayId: "ra", attachedAt: now - 1_000, issuedAt: now - 1_000, notAfter: now + 600_000 };
    const item: AttachmentItem = { kind: "box", attachment: att, signature: signRelayMeshRecord("relay-attachment", att, (m) => ed.sign(m, box.privateKey)) };
    const wd = (subject: string, relay = ra): { withdraw: RelayWithdraw; signature: string } => {
      const w: RelayWithdraw = { subjectKind: "box", subject, relayId: relay.relayId, withdrawnIssuedAt: now, at: now };
      return { withdraw: w, signature: signRelayMeshRecord("relay-withdraw", w, (m) => ed.sign(m, relay.key.privateKey)) };
    };
    return { s, item, wd, pod, rb };
  }

  it("a withdrawn attachment re-announced by a third peer stays withdrawn", async () => {
    const { s, item, wd, pod } = await store();
    expect(s.offerAttachment(item, "ra").ok).toBe(true);
    expect(s.withdraw(wd(pod), "ra")).toBe(true);
    expect(s.winner(pod)).toBeNull();
    expect(s.offerAttachment(item, "rb")).toEqual({ ok: false, reason: "withdrawn" });
  });

  it("keeps no tombstone for a name the log does not register, and caps them per withdrawing relay", async () => {
    const { s, wd } = await store({ maxTombstonesPerRelay: 3 });
    expect(s.withdraw(wd(`ghost.alice.${APEX}`), "ra")).toBe(true);
    expect(s.stats().tombstones).toBe(0);
    const big = await store({ maxTombstonesPerRelay: 3 });
    for (let i = 0; i < 5; i++) expect(big.s.withdraw(big.wd(`b${i}.alice.${APEX}`), "ra")).toBe(true);
    expect(big.s.stats().tombstones).toBe(3);
    expect(big.s.withdraw(big.wd(big.pod, big.rb), "rb")).toBe(true);
    expect(big.s.stats().tombstones).toBe(4);
  });
});

describe("§7.6 relay-bound mailbox announcements", () => {
  const pik = keypair();
  const epoch = pbMailboxEpoch(Date.now());
  const ann = { pikPubHex: hex(pik.publicKey), epoch };
  const signature = hex(ed.sign(canonicalPbMailboxAnnounce(ann.pikPubHex, epoch), pik.privateKey));
  const bound = (relayId: string) => hex(ed.sign(canonicalPbMailboxAnnounceForRelay(ann.pikPubHex, epoch, relayId), pik.privateKey));
  const id = pbMailboxId(ann.pikPubHex, epoch);
  const newStore = () => {
    const fx = new MeshFixture();
    fx.addRelay("ra");
    fx.mintDirectory();
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    return new AttachmentStore({ selfRelayId: "zz", servicesApex: APEX, ctx: () => ({ servicesApex: APEX, log: feed.state, directory: fx.directory, now: Date.now() }) });
  };

  it("a bound announcement goes before a replayed unbound first claim; one naming another relay is refused", () => {
    const s = newStore();
    expect(s.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "rogue" }, "rogue")).toBe(true);
    expect(s.mailboxRelay(id)).toBe("rogue");
    expect(s.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "rb", relaySignature: bound("ra") }, "rb")).toBe(false);
    expect(s.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "ra", relaySignature: bound("ra") }, "ra")).toBe(true);
    expect(s.mailboxRelays(id)).toEqual(["ra", "rogue"]);
    // ra's later unbound re-announcement keeps its binding and its place.
    expect(s.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "ra" }, "ra")).toBe(true);
    expect(s.mailboxRelays(id)).toEqual(["ra", "rogue"]);
    // A second bound relay keeps first-claim order among bound ones, ahead of unbound.
    expect(s.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "rc", relaySignature: bound("rc") }, "rc")).toBe(true);
    expect(s.mailboxRelays(id)).toEqual(["ra", "rc", "rogue"]);
  });

  it("delivery tries the next relay when the holder refuses", async () => {
    const tried: string[] = [];
    const fake = {
      opts: { relayId: "zz" },
      store: { mailboxRelays: () => ["ra", "zz", "rb"] },
      deliverVia: async (relayId: string) => {
        tried.push(relayId);
        return relayId === "rb" ? { status: 200, body: new Uint8Array([1]) } : null;
      },
    };
    const r = await (MeshNode.prototype.deliverRemote as (this: unknown, id: string, e: Uint8Array) => Promise<unknown>).call(fake, id, new Uint8Array(0));
    expect(r).toEqual({ status: 200, body: new Uint8Array([1]) });
    expect(tried).toEqual(["ra", "rb"]);
  });

  it("a sync dump carries only this relay's own phone and mailbox items", () => {
    const fx = new MeshFixture();
    fx.addRelay("ra");
    fx.mintDirectory();
    const feed = new MeshFeed({ servicesApex: APEX, logKey: fx.logPub, source: fx.source() });
    const s = new AttachmentStore({ selfRelayId: "zz", servicesApex: APEX, ctx: () => ({ servicesApex: APEX, log: feed.state, directory: fx.directory, now: Date.now() }) });
    expect(s.offerMailbox({ kind: "mailbox", announce: ann, signature, relayId: "ra" }, "ra")).toBe(true);
    expect(s.dump().filter((i) => (i as { kind: string }).kind === "mailbox")).toEqual([]);
  });
});

describe("§6.4 the holder's wait for a bridged stream's first DATA", () => {
  it("closes a stream whose ClientHello never comes", async () => {
    const { PassThrough } = await import("node:stream");
    const s = Object.assign(new PassThrough(), { kind: "tls", sni: `home.alice.${APEX}` });
    let routed = false;
    const fake = {
      counters: { bridgedIn: 0, refusedIn: {}, firstDataTimeouts: 0 },
      opts: { firstDataWaitMs: 30 },
      routerEntry: () => (routed = true),
    };
    (MeshNode.prototype as unknown as { onBridgedOpen: (p: unknown, s: unknown) => void }).onBridgedOpen.call(fake, { relayId: "ra", refuse: () => undefined }, s);
    await expect.poll(() => s.destroyed, { timeout: 1_000 }).toBe(true);
    expect(fake.counters.firstDataTimeouts).toBe(1);
    expect(routed).toBe(false);
  });
});

describe("§10.1 client keys", () => {
  it("are opaque, one per address, and per address and port only with the test knob", () => {
    const key = (byPort: boolean, a: string, p: number) =>
      (MeshNode.prototype.clientKey as (this: unknown, a: string, p: number) => string).call({ opts: { clientKeyByPort: byPort }, clientSecret: new Uint8Array(32).fill(7) }, a, p);
    expect(key(false, "203.0.113.9", 1)).toMatch(/^[0-9a-f]{16}$/);
    expect(key(false, "203.0.113.9", 1)).toBe(key(false, "203.0.113.9", 2));
    expect(key(true, "203.0.113.9", 1)).not.toBe(key(true, "203.0.113.9", 2));
    expect(key(false, "203.0.113.9", 1)).not.toContain("203");
  });
});
