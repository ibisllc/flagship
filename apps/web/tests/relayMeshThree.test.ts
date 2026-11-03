/**
 * The relay mesh in process (docs/architecture-v2/relay-mesh.md §14): three TS relays (`ra`, `rb`, `rc`) on loopback,
 * each with its own HTTP server (`/tunnel`, `/phone-tunnel`, `/mesh`), SNI router and mesh node, wired exactly as
 * `start()` wires them (`wireMeshRelay`), reading one mock `.com` feed. Boxes are WebSocket clients speaking the v1
 * frames with `mesh-v1` (they sign attachments with their STK and follow move hints); phones are `SimPhone`s that
 * present their admin grant in `begin`; visitors are plain TCP sockets sending a ClientHello.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { WebSocket } from "ws";
import {
  ATTACH_TTL_MS,
  canonicalPbMailboxAnnounce,
  ed,
  pbMailboxEpoch,
  pbMailboxId,
  mintDevEntitlements,
  rootEntitlementCertId,
  serviceEntitlementCertId,
  signDeviceCapabilityGrant,
  signRelayMeshRecord,
  signTunnelHelloV2,
  type BoxAttachment,
  type Keypair,
  type ServingPolicy,
} from "@flagship/protocol";
import {
  attachmentFrame,
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_ATTACHMENT,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_MOVE_HINT,
  FRAME_OPEN,
  FRAME_PB_MAIL_REQ,
  MailAssembler,
  mailboxAnnounceFrame,
  mailResponseFrames,
  parseAttachmentResult,
  parseHelloAck,
  parseMoveHintFrame,
  type Frame,
  type MoveHintFramePayload,
  type ParsedHelloAck,
} from "@flagship/tunnel-protocol";
import { TunnelRegistry } from "../src/tunnel/registry.js";
import { MailboxRegistry } from "../src/tunnel/mailboxRelay.js";
import { MeshNode } from "../src/tunnel/mesh/node.js";
import { RelayBlessingProvider } from "../src/tunnel/hubBlessingProvider.js";
import { outboundRelayFromEnv, wireMeshRelay } from "../src/server.js";
import { APEX, hex, keypair, MeshFixture, type FixtureRelay } from "./support/meshFixture.js";
import { lease, policy, type Ed } from "./support/serving.js";
import { connect as tlsConnect } from "node:tls";
import { SimPhone, isPhoneCert, selfSignedPhoneCert } from "../../../tools/live-e2e/lib/phoneSim.js";

const HOLD_MS = 1_000;
const REFUSE_NEW_MS = 1_500;
const CLOSE_ALL_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Relay {
  fx: FixtureRelay;
  id: string;
  http: Server;
  httpPort: number;
  sniPort: number;
  node: MeshNode;
  blessing: RelayBlessingProvider;
  wired: Awaited<ReturnType<typeof wireMeshRelay>>;
  mailboxes: MailboxRegistry;
}

const fx = new MeshFixture();
const relays = new Map<string, Relay>();
const ports = new Map<string, number>();

async function listen(f: FixtureRelay): Promise<Server> {
  const http = createServer();
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  ports.set(f.relayId, (http.address() as AddressInfo).port);
  return http;
}

async function startRelay(f: FixtureRelay, http: Server): Promise<Relay> {
  const httpPort = ports.get(f.relayId)!;
  const blessing = new RelayBlessingProvider({
    keypair: f.key,
    relayId: f.relayId,
    servicesApex: APEX,
    comBaseUrl: "http://127.0.0.1:1",
    caKeys: () => [fx.caPub],
    log: () => undefined,
  });
  expect(blessing.adopt(fx.blessings.get(f.relayId))).toBe(true);
  const registry = new TunnelRegistry({ apex: APEX });
  const node = new MeshNode({
    relayId: f.relayId,
    relayKind: f.kind,
    servicesApex: APEX,
    logKey: fx.logPub,
    caKeys: () => [fx.caPub],
    blessing,
    feedSource: fx.source(),
    registry,
    peerUrl: (p) => `ws://127.0.0.1:${ports.get(p.relayId)}/mesh`,
    feedPollMs: 100,
    refuseNewMs: REFUSE_NEW_MS,
    closeAllMs: CLOSE_ALL_MS,
    queryTimeoutMs: 400,
    legacyWaitMs: 300,
    directoryPollMs: 500,
    minMoveMs: 0,
  });
  const mailboxes = new MailboxRegistry();
  const wired = await wireMeshRelay({ httpServer: http, registry, node, blessing, servicesApex: APEX, mailboxes, tunnelTcpPort: 0, host: "127.0.0.1", holdTimeoutMs: HOLD_MS, checkMs: 100, outboundRelay: outboundRelayFromEnv("http://127.0.0.1:1", {}) });
  wired.start();
  const r: Relay = { fx: f, id: f.relayId, http, httpPort, sniPort: wired.router!.port, node, blessing, wired, mailboxes };
  relays.set(f.relayId, r);
  return r;
}

const allBoxes: SimBox[] = [];

async function stopRelay(r: Relay): Promise<void> {
  // Upgraded sockets are not closed by the HTTP server: hang up every box still on this relay first.
  for (const b of allBoxes) if (b.port === r.httpPort) b.ws?.terminate();
  await r.wired.stop();
  r.http.closeAllConnections?.();
  await new Promise<void>((res) => r.http.close(() => res()));
  relays.delete(r.id);
}

// ── a box ──────────────────────────────────────────────────────────────────

class SimBox {
  ws!: WebSocket;
  frames: Frame[] = [];
  ack!: ParsedHelloAck;
  ackAt = 0;
  hints: MoveHintFramePayload[] = [];
  closedCode: number | null = null;
  relayId = "";
  port = 0;
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private mail = new Map<number, MailAssembler>();

  constructor(
    readonly pod: string,
    readonly user: string,
    readonly stk: Keypair,
    readonly admin: Keypair,
    readonly label: string,
    readonly o: { mesh?: boolean; serviceCanonicals?: string[]; serving?: Record<string, unknown> } = {},
  ) {
    allBoxes.push(this);
  }

  get boxPub(): string {
    return hex(this.stk.publicKey);
  }

  async connect(relay: Relay): Promise<ParsedHelloAck> {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/tunnel`);
    this.ws = ws;
    this.port = relay.httpPort;
    this.frames = [];
    this.closedCode = null;
    let buf = new Uint8Array(0);
    let resolveAck!: (a: ParsedHelloAck) => void;
    const ack = new Promise<ParsedHelloAck>((r) => (resolveAck = r));
    ws.on("close", (code) => {
      if (this.ws === ws) this.closedCode = code;
    });
    ws.on("error", () => undefined);
    ws.on("message", (raw: Buffer) => {
      const joined = new Uint8Array(buf.length + raw.length);
      joined.set(buf);
      joined.set(raw, buf.length);
      buf = joined;
      for (;;) {
        const d = decodeFrame(buf, { mesh: true });
        if (d.kind !== "ok") break;
        buf = buf.subarray(d.consumed);
        this.onFrame(ws, d.frame, resolveAck);
      }
    });
    await new Promise<void>((r) => ws.on("open", () => r()));
    const bundle = mintDevEntitlements({ irk: this.admin, podPubKey: this.stk.publicKey, username: this.user, podCanonical: this.pod, serviceCanonicals: this.o.serviceCanonicals ?? [`x.${this.pod}`] });
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const issuedAt = Date.now();
    const rootId = await rootEntitlementCertId(bundle.rootEntitlement);
    const svcId = await serviceEntitlementCertId(bundle.serviceEntitlement!);
    const signature = signTunnelHelloV2({ serverId: this.pod, rootEntitlementCertId: rootId, serviceEntitlementCertId: svcId, nonce, issuedAt }, this.stk);
    const se = bundle.serviceEntitlement!;
    const payload = {
      version: 2,
      serverId: this.pod,
      rootEntitlement: { username: this.user, podPubKey: this.boxPub, podCanonical: this.pod, issuedAt: bundle.rootEntitlement.issuedAt },
      rootEntitlementSig: hex(bundle.rootEntitlementSig),
      rootEntitlementCertId: rootId,
      serviceEntitlement: { username: this.user, podPubKey: hex(se.podPubKey), canonicals: se.canonicals, issuedAt: se.issuedAt, expiresAt: se.expiresAt },
      serviceEntitlementSig: hex(bundle.serviceEntitlementSig!),
      serviceEntitlementCertId: svcId,
      nonce: hex(nonce),
      issuedAt,
      signature: hex(signature),
      capabilities: this.o.mesh === false ? [] : ["mesh-v1"],
      servingAdminKey: hex(this.admin.publicKey),
      ...(this.o.serving ?? {}),
    };
    ws.send(encodeFrame({ streamId: 0, type: FRAME_HELLO, payload: new TextEncoder().encode(JSON.stringify(payload)) }));
    this.ack = await ack;
    this.ackAt = Date.now();
    this.relayId = this.ack.relayId ?? "";
    return this.ack;
  }

  /** Sign and send an attachment for the relay this tunnel is on (or `over` fields); resolves with the relay's answer. */
  async attach(over: Partial<BoxAttachment> = {}, signer: Keypair = this.stk): Promise<unknown> {
    const now = Date.now();
    const a: BoxAttachment = { serverFqdn: this.pod, boxPub: this.boxPub, regGen: 1, relayId: this.relayId, attachedAt: this.ackAt, issuedAt: now, notAfter: now + ATTACH_TTL_MS, ...over };
    const signature = signRelayMeshRecord("relay-attachment", a, (m) => ed.sign(m, signer.privateKey));
    const answer = this.next((f) => f.type === FRAME_ATTACHMENT);
    this.ws.send(encodeFrame(attachmentFrame({ attachment: a as unknown as Record<string, unknown>, signature })));
    return parseAttachmentResult((await answer).payload);
  }

  next(match: (f: Frame) => boolean, ms = 5_000): Promise<Frame> {
    const had = this.frames.find(match);
    if (had) {
      this.frames.splice(this.frames.indexOf(had), 1);
      return Promise.resolve(had);
    }
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`${this.label}: no matching frame within ${ms} ms`));
        }
      }, ms).unref?.();
    });
  }

  close(): void {
    this.ws.close(1000, "bye");
  }

  /** Make-before-break (§9.3): connect to `to`, attach there, then close the old tunnel. */
  async moveTo(to: Relay): Promise<void> {
    const old = this.ws;
    await this.connect(to);
    expect(await this.attach()).toEqual({ ok: true });
    old.close(1000, "moved");
  }

  private onFrame(ws: WebSocket, f: Frame, resolveAck: (a: ParsedHelloAck) => void): void {
    if (f.type === FRAME_HELLO_ACK) return resolveAck(parseHelloAck(f.payload)!);
    if (f.type === FRAME_OPEN) return;
    if (f.type === FRAME_DATA) {
      // The box's "TLS server": answer each chunk with `<label>:<bytes>`.
      ws.send(encodeFrame(dataFrame(f.streamId, Buffer.concat([Buffer.from(`${this.label}:`), Buffer.from(f.payload)]))));
      return;
    }
    if (f.type === FRAME_CLOSE) {
      ws.send(encodeFrame(closeFrame(f.streamId, false)));
      return;
    }
    if (f.type === FRAME_PB_MAIL_REQ) {
      // The box's mailbox: answer `MAIL:<envelope>`.
      let asm = this.mail.get(f.streamId);
      if (!asm) this.mail.set(f.streamId, (asm = new MailAssembler("req")));
      const r = asm.push(f.payload);
      if (r.done) {
        this.mail.delete(f.streamId);
        for (const fr of mailResponseFrames(f.streamId, 200, Buffer.concat([Buffer.from("MAIL:"), Buffer.from(r.body)]))) ws.send(encodeFrame(fr));
      }
      return;
    }
    if (f.type === FRAME_MOVE_HINT) {
      const h = parseMoveHintFrame(f.payload);
      if (h) this.hints.push(h);
    }
    const w = this.waiters.find((x) => x.match(f));
    if (w) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve(f);
    } else this.frames.push(f);
  }
}

// ── a visitor ──────────────────────────────────────────────────────────────

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

/** Visit `sni` through a relay's SNI port: the bytes that came back and how long until the relay closed. */
async function visit(relay: Relay, sni: string, waitMs = 3_000): Promise<{ text: string; closedAfterMs: number }> {
  const started = Date.now();
  const sock = netConnect(relay.sniPort, "127.0.0.1");
  const chunks: Buffer[] = [];
  sock.on("data", (c: Buffer) => chunks.push(c));
  sock.on("error", () => undefined);
  sock.write(clientHello(sni));
  const closed = new Promise<number>((r) => sock.once("close", () => r(Date.now() - started)));
  const t = await Promise.race([closed, sleep(waitMs).then(() => -1)]);
  // Got an answer and the stream is still open: hang up.
  if (t === -1) sock.destroy();
  return { text: Buffer.concat(chunks).toString("latin1"), closedAfterMs: t === -1 ? -1 : t };
}

async function reaches(relay: Relay, sni: string, label: string): Promise<boolean> {
  const r = await visit(relay, sni, 1_500);
  return r.text.startsWith(`${label}:`);
}

function adminGrant(device: Uint8Array, account: string, signer: Keypair, grantId: string) {
  const now = Date.now();
  const g = {
    grantId,
    username: account,
    deviceId: hex(device).slice(32),
    devicePubKey: ed.getPublicKey(device),
    scopes: ["admin"] as never,
    issuedAt: now - 60_000,
    expiresAt: now + 30 * 86_400_000,
  };
  const signatureHex = hex(signDeviceCapabilityGrant(g, signer));
  return { grant: { grantId, username: account, deviceId: g.deviceId, devicePubHex: hex(g.devicePubKey), scopes: ["admin"], issuedAt: g.issuedAt, expiresAt: g.expiresAt }, signatureHex, signerRoot: "admin-root" };
}

/** One account with its admin key (also its IRK here) registered in the log. */
function account(name: string): Keypair {
  const admin = keypair();
  fx.authority(name, hex(admin.publicKey), hex(admin.publicKey));
  return admin;
}

function box(pod: string, user: string, admin: Keypair, label: string, o: ConstructorParameters<typeof SimBox>[5] = {}): SimBox {
  const stk = keypair();
  fx.registerBox(pod, hex(stk.publicKey));
  return new SimBox(pod, user, stk, admin, label, o);
}

const R = (id: string): Relay => relays.get(id)!;
const synced = () => waitFor(() => [...relays.values()].every((r) => r.node.feed.state.sequence === fx.entries.length && r.node.fresh()), 5_000, "every relay synced");

describe("relay mesh: three relays in one process", () => {
  beforeAll(async () => {
    const a = fx.addRelay("ra", "full", "iad");
    const b = fx.addRelay("rb", "full", "iad");
    const c = fx.addRelay("rc", "full", "ams");
    fx.mintDirectory();
    const servers = await Promise.all([a, b, c].map((f) => listen(f)));
    for (const [i, f] of [a, b, c].entries()) await startRelay(f, servers[i]!);
    await waitFor(() => [...relays.values()].every((r) => r.node.readiness().ready && r.node.bridges.live().length === 2), 15_000, "every relay mesh-ready and fully bridged").catch((e) => {
      throw new Error(`${(e as Error).message}: ${JSON.stringify([...relays.values()].map((r) => [r.id, r.node.readiness(), r.node.stats().feed, r.node.bridges.handshakeFailures]))}`);
    });
  }, 20_000);

  afterAll(async () => {
    for (const r of [...relays.values()]) await stopRelay(r);
  });

  it("every relay is mesh-ready: blessed, listed, fresh and bridged to both peers", () => {
    for (const r of relays.values()) {
      expect(r.node.readiness()).toEqual({ ready: true, reasons: [] });
      expect(r.node.bridges.live().map((p) => p.relayId).sort()).toEqual(["ra", "rb", "rc"].filter((x) => x !== r.id));
    }
  });

  it("a visitor on relay A reaches a box held by relay B over the bridge (and through C)", async () => {
    const admin = account("alice");
    const b1 = box(`home.alice.${APEX}`, "alice", admin, "B1");
    await synced();
    const ack = await b1.connect(R("rb"));
    expect(ack.ok).toBe(true);
    expect(ack.capabilities).toContain("mesh-v1");
    // Gym run 28: a mesh relay must still carry the boxes' AI calls (`outbound-v1`), as the relay with the mesh off does.
    expect(ack.capabilities).toContain("outbound-v1");
    expect(ack.relayId).toBe("rb");
    expect(await b1.attach()).toEqual({ ok: true });
    R("rb").node.flushAnnouncements();
    await waitFor(() => R("ra").node.store.winner(b1.pod)?.attachment.relayId === "rb" && R("rc").node.store.winner(b1.pod)?.attachment.relayId === "rb", 3_000, "announced");
    const viaA = await visit(R("ra"), b1.pod, 1_500);
    expect(viaA.text.startsWith("B1:")).toBe(true);
    // The box got the ClientHello verbatim: its echo carries the same bytes back.
    expect(Buffer.from(viaA.text.slice(3), "latin1").equals(clientHello(b1.pod))).toBe(true);
    expect(await reaches(R("rc"), b1.pod, "B1")).toBe(true);
    // Box-scoped names under the pod route the same way.
    expect(await reaches(R("ra"), `x.${b1.pod}`, "B1")).toBe(true);
    expect(R("ra").node.counters.forwarded).toBeGreaterThan(0);
    expect(R("rb").node.counters.bridgedIn).toBeGreaterThan(0);
    b1.close();
  });

  it("attachment precedence and withdrawal: the newest relay wins, the superseded one withdraws, a closed tunnel withdraws", async () => {
    const admin = account("dora");
    const d1 = box(`home.dora.${APEX}`, "dora", admin, "D1");
    await synced();
    await d1.connect(R("ra"));
    expect(await d1.attach()).toEqual({ ok: true });
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.winner(d1.pod)?.attachment.relayId === "ra", 3_000, "ra wins");
    // The same box moves to rc (make-before-break): its newer attachment wins everywhere, ra withdraws its own.
    const first = d1.ws;
    await d1.connect(R("rc"));
    await sleep(5);
    expect(await d1.attach()).toEqual({ ok: true });
    R("rc").node.flushAnnouncements();
    await waitFor(() => ["ra", "rb", "rc"].every((id) => R(id).node.store.winner(d1.pod)?.attachment.relayId === "rc"), 3_000, "rc wins everywhere");
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.own(d1.pod) === null && !R("ra").node.store.ownWins(d1.pod), 3_000, "ra superseded");
    // ra now forwards like an entry relay, even with the old tunnel still open.
    expect(await reaches(R("ra"), d1.pod, "D1")).toBe(true);
    first.close();
    // Closing rc's tunnel withdraws rc's attachment: no relay keeps a live winner.
    d1.close();
    await waitFor(() => d1.closedCode !== null, 2_000, "closed");
    await sleep(50);
    R("rc").node.flushAnnouncements();
    await waitFor(() => ["ra", "rb", "rc"].every((id) => R(id).node.store.winner(d1.pod) === null), 3_000, "withdrawn everywhere");
    const miss = await visit(R("rb"), d1.pod, 4_000);
    expect(miss.text).toBe("");
    // A miss (log says registered, nobody holds it: query, then drop) closes at the hold time, not sooner.
    expect(miss.closedAfterMs).toBeGreaterThanOrEqual(HOLD_MS - 50);
  });

  it("refuses a forged attachment from a peer and a box's attachment naming another relay", async () => {
    const admin = account("frank");
    const f1 = box(`home.frank.${APEX}`, "frank", admin, "F1");
    const thief = keypair();
    await synced();
    await f1.connect(R("ra"));
    // Naming another relay, or signed by a key that is not the box's: refused by the holder.
    expect(await f1.attach({ relayId: "rb" })).toEqual({ ok: false, code: "mismatch" });
    expect(await f1.attach({}, thief)).toEqual({ ok: false, code: "mismatch" });
    expect(await f1.attach()).toEqual({ ok: true });
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rc").node.store.winner(f1.pod)?.attachment.relayId === "ra", 3_000, "announced");
    // rb announces a forged attachment that would steal the name: every peer verifies and drops it.
    const now = Date.now();
    const forged: BoxAttachment = { serverFqdn: f1.pod, boxPub: f1.boxPub, regGen: 1, relayId: "rb", attachedAt: now, issuedAt: now, notAfter: now + 60_000 };
    const before = R("rb").node.bridges.peer("rc")!;
    const rcPeerRb = R("rc").node.bridges.peer("rb")!;
    const rejected = rcPeerRb.rejected;
    before.send({ type: "announce", items: [{ kind: "box", attachment: forged, signature: signRelayMeshRecord("relay-attachment", forged, (m) => ed.sign(m, thief.privateKey)) }] });
    await waitFor(() => rcPeerRb.rejected > rejected, 2_000, "rejected");
    expect(R("rc").node.store.winner(f1.pod)?.attachment.relayId).toBe("ra");
    expect(await reaches(R("rc"), f1.pod, "F1")).toBe(true);
    f1.close();
  });

  it("a revocation reaches every relay well within the deadline: the holder closes, every entry refuses, HELLO is refused", async () => {
    const admin = account("rita");
    const r1 = box(`home.rita.${APEX}`, "rita", admin, "R1");
    await synced();
    await r1.connect(R("ra"));
    expect(await r1.attach()).toEqual({ ok: true });
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.winner(r1.pod) !== null && R("rc").node.store.winner(r1.pod) !== null, 3_000, "announced");
    expect(await reaches(R("rb"), r1.pod, "R1")).toBe(true);
    const t0 = Date.now();
    fx.append({ kind: "box-revoke", boxPub: r1.boxPub, regGen: 1 });
    await waitFor(() => r1.closedCode !== null, 3_000, "holder closed the tunnel");
    await waitFor(() => ["ra", "rb", "rc"].every((id) => R(id).node.store.winner(r1.pod) === null), 3_000, "dropped everywhere");
    expect(Date.now() - t0).toBeLessThan(65_000);
    expect(r1.closedCode).toBe(1008);
    expect((await visit(R("rc"), r1.pod, 2_500)).text).toBe("");
    for (const id of ["ra", "rb", "rc"]) {
      const again = new SimBox(r1.pod, "rita", r1.stk, admin, "R1");
      const ack = await again.connect(R(id));
      expect(ack.ok).toBe(false);
      again.ws.terminate();
    }
  });

  it("an un-revoke is a box-register at the next regGen: the box serves again at it until revoked again; a re-sent register brings nothing back", async () => {
    const admin = account("una");
    const u1 = box(`back.una.${APEX}`, "una", admin, "U1");
    fx.append({ kind: "box-revoke", boxPub: u1.boxPub, regGen: 1 });
    await synced();
    for (const id of ["ra", "rb", "rc"]) {
      const refused = new SimBox(u1.pod, "una", u1.stk, admin, "U1");
      expect((await refused.connect(R(id))).ok, `revoked at regGen 1 on ${id}`).toBe(false);
      refused.ws.terminate();
    }
    fx.registerBox(u1.pod, u1.boxPub, 2);
    await synced();
    expect((await u1.connect(R("ra"))).ok).toBe(true);
    expect(await u1.attach({ regGen: 1 })).toEqual({ ok: false, code: "mismatch" });
    expect(await u1.attach({ regGen: 2 })).toEqual({ ok: true });
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rc").node.store.winner(u1.pod) !== null, 3_000, "announced");
    expect(await reaches(R("rc"), u1.pod, "U1")).toBe(true);

    fx.append({ kind: "box-revoke", boxPub: u1.boxPub, regGen: 2 });
    await waitFor(() => u1.closedCode !== null, 3_000, "holder closed the tunnel");
    fx.registerBox(u1.pod, u1.boxPub, 2);
    await synced();
    await waitFor(() => ["ra", "rb", "rc"].every((id) => R(id).node.store.winner(u1.pod) === null), 3_000, "dropped everywhere");
    for (const id of ["ra", "rb", "rc"]) {
      const again = new SimBox(u1.pod, "una", u1.stk, admin, "U1");
      expect((await again.connect(R(id))).ok, `revoked at regGen 2 on ${id}`).toBe(false);
      again.ws.terminate();
    }
  });

  it("account home: a second box landing elsewhere is hinted co-locate, moves, and the shortened name answers from every entry", async () => {
    const admin = account("bob");
    const app = `notes.bob.${APEX}`;
    const b1 = box(`home.bob.${APEX}`, "bob", admin, "BOB1", { serviceCanonicals: [app] });
    const b2 = box(`cabin.bob.${APEX}`, "bob", admin, "BOB2", { serviceCanonicals: [app] });
    await synced();
    await b1.connect(R("ra"));
    expect(await b1.attach()).toEqual({ ok: true });
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.winner(b1.pod) !== null, 3_000, "b1 announced");
    await sleep(10);
    await b2.connect(R("rb"));
    expect(await b2.attach()).toEqual({ ok: true });
    // rb is not bob's home (ra has the earliest attachment of the tie): b2 is told to co-locate there.
    await waitFor(() => b2.hints.length > 0, 3_000, "co-locate hint");
    const h = b2.hints[0]!;
    expect(h.hint).toMatchObject({ reason: "co-locate", fromRelayId: "rb", toRelayId: "ra", serverFqdn: b2.pod, boxPub: b2.boxPub });
    expect((h.target as { relayId?: string }).relayId).toBe("ra");
    await b2.moveTo(R("ra"));
    R("ra").node.flushAnnouncements();
    await waitFor(() => ["ra", "rb", "rc"].every((id) => R(id).node.homes.homeOf("bob") === "ra"), 3_000, "home ra");
    for (const id of ["ra", "rb", "rc"]) {
      const v = await visit(R(id), app, 1_500);
      expect(v.text.startsWith("BOB1:") || v.text.startsWith("BOB2:")).toBe(true);
    }
    b1.close();
    b2.close();
  });

  it("an account move from the home: peers accept it, the boxes get locality hints", async () => {
    const admin = account("mia");
    const m1 = box(`home.mia.${APEX}`, "mia", admin, "MIA1");
    await synced();
    await m1.connect(R("rb"));
    expect(await m1.attach()).toEqual({ ok: true });
    R("rb").node.flushAnnouncements();
    await waitFor(() => R("rc").node.homes.homeOf("mia") === "rb", 3_000, "home rb");
    R("rb").node.moveAccount("mia", "rc");
    await waitFor(() => m1.hints.some((x) => (x.hint as { reason?: string }).reason === "locality"), 3_000, "locality hint");
    await m1.moveTo(R("rc"));
    R("rc").node.flushAnnouncements();
    await waitFor(() => ["ra", "rb", "rc"].every((id) => R(id).node.homes.homeOf("mia") === "rc"), 3_000, "home rc everywhere");
    // A move signed by a relay that is not the home is refused.
    const fake = { accountHash: (await import("@flagship/protocol")).accountHash("mia"), fromRelayId: "ra", toRelayId: "ra" === "ra" ? "rb" : "ra", issuedAt: Date.now(), notAfter: Date.now() + 60_000 };
    const sig = signRelayMeshRecord("relay-account-move", fake, (m) => ed.sign(m, fx.relays[0]!.key.privateKey));
    const rbPeerRa = R("rb").node.bridges.peer("ra")!;
    const was = rbPeerRa.rejected;
    R("ra").node.bridges.peer("rb")!.send({ type: "account-move", move: fake, signature: sig });
    await waitFor(() => rbPeerRa.rejected > was, 2_000, "move refused");
    expect(R("rb").node.homes.homeOf("mia")).toBe("rc");
    m1.close();
  });

  it("the phone's bare name: one holder across relays, visitors through every relay, vacancy hands it over", async () => {
    const admin = account("carol");
    await synced();
    const seedA = crypto.getRandomValues(new Uint8Array(32));
    const seedB = crypto.getRandomValues(new Uint8Array(32));
    const gA = adminGrant(seedA, "carol", admin, hex(crypto.getRandomValues(new Uint8Array(32))));
    const gB = adminGrant(seedB, "carol", admin, hex(crypto.getRandomValues(new Uint8Array(32))));
    const pa = await SimPhone.connect(`ws://127.0.0.1:${R("rb").httpPort}/phone-tunnel`, { account: "carol", seed: seedA, label: "PA" });
    pa.send({ type: "begin", account: "carol", grants: [gA] });
    const ch = await pa.next((m) => m.type === "challenge" || m.type === "refused");
    expect(ch.type).toBe("challenge");
    expect(await pa.sendClaim(pa.sign(ch))).toMatchObject({ type: "granted" });
    R("rb").node.flushAnnouncements();
    const bare = `carol.${APEX}`;
    await waitFor(() => R("ra").node.store.phoneWinner(bare)?.grant.holderRelayId === "rb" && R("rc").node.store.phoneWinner(bare) !== null, 3_000, "phone announced");
    for (const id of ["ra", "rb", "rc"]) expect(await reaches(R(id), bare, "PA")).toBe(true);
    // A second eligible phone on rc is refused while the first holds the name.
    const pb = await SimPhone.connect(`ws://127.0.0.1:${R("rc").httpPort}/phone-tunnel`, { account: "carol", seed: seedB, label: "PB" });
    pb.send({ type: "begin", account: "carol", grants: [gB] });
    const ch2 = await pb.next((m) => m.type === "challenge" || m.type === "refused");
    expect(ch2.type).toBe("challenge");
    expect(await pb.sendClaim(pb.sign(ch2))).toMatchObject({ type: "refused", code: "route-held" });
    // A phone without the grant chain is not eligible on a mesh relay.
    const pc = await SimPhone.connect(`ws://127.0.0.1:${R("ra").httpPort}/phone-tunnel`, { account: "carol", seed: seedB, label: "PC" });
    expect(await pc.acquire()).toMatchObject({ type: "refused", code: "not-eligible" });
    pc.close();
    // The holder leaves: the vacancy reaches the standby on another relay, which claims.
    pa.close();
    await pb.next((m) => m.type === "route-vacant", 5_000);
    pb.send({ type: "begin", account: "carol", grants: [gB] });
    const ch3 = await pb.next((m) => m.type === "challenge" || m.type === "refused");
    expect(await pb.sendClaim(pb.sign(ch3))).toMatchObject({ type: "granted" });
    R("rc").node.flushAnnouncements();
    await waitFor(() => R("ra").node.store.phoneWinner(bare)?.grant.holderRelayId === "rc", 3_000, "new holder announced");
    expect(await reaches(R("ra"), bare, "PB")).toBe(true);
    // Revoking the holder's grant in the log ends its route and its tunnel (4403).
    fx.append({ kind: "device-grant-revoke", grantId: gB.grant.grantId, devicePub: gB.grant.devicePubHex });
    await pb.closed;
    expect(pb.closedWith?.code).toBe(4403);
  });

  it("a phone that ends TLS itself: a real TLS handshake for its bare name completes through every relay with the phone's own certificate", async () => {
    // The live gym's relay-mesh group visits the phone this way; the raw sim ClientHello cannot prove a TLS endpoint
    // (it offers a TLS 1.3-only suite without supported_versions, so a real stack answers handshake_failure).
    const admin = account("tess");
    await synced();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const g = adminGrant(seed, "tess", admin, hex(crypto.getRandomValues(new Uint8Array(32))));
    const bare = `tess.${APEX}`;
    const cert = selfSignedPhoneCert(bare);
    const p = await SimPhone.connect(`ws://127.0.0.1:${R("rb").httpPort}/phone-tunnel`, { account: "tess", seed, label: "PT", tls: cert });
    p.send({ type: "begin", account: "tess", grants: [g] });
    const ch = await p.next((m) => m.type === "challenge" || m.type === "refused");
    expect(await p.sendClaim(p.sign(ch))).toMatchObject({ type: "granted" });
    R("rb").node.flushAnnouncements();
    await waitFor(() => R("ra").node.store.phoneWinner(bare)?.grant.holderRelayId === "rb" && R("rc").node.store.phoneWinner(bare) !== null, 3_000, "phone announced");
    const handshake = (relay: Relay) =>
      new Promise<boolean>((resolve) => {
        const s = tlsConnect({ host: "127.0.0.1", port: relay.sniPort, servername: bare, rejectUnauthorized: false });
        const finish = (v: boolean) => {
          s.destroy();
          resolve(v);
        };
        s.setTimeout(3_000, () => finish(false));
        s.on("secureConnect", () => finish(isPhoneCert(s.getPeerCertificate()?.fingerprint256, [cert.cert])));
        s.on("error", () => finish(false));
      });
    for (const id of ["ra", "rb", "rc"]) expect(await handshake(R(id)), `TLS through ${id}`).toBe(true);
    p.close();
  });

  it("an old box (no mesh-v1) gets no mesh fields, is announced by its full holder as legacy, and is reachable everywhere", async () => {
    const admin = account("olga");
    const o1 = box(`home.olga.${APEX}`, "olga", admin, "OLD", { mesh: false });
    await synced();
    const ack = await o1.connect(R("ra"));
    expect(ack.ok).toBe(true);
    expect(ack.relayId).toBeUndefined();
    expect(ack.relayBlessing).toBeUndefined();
    expect(ack.capabilities ?? []).not.toContain("mesh-v1");
    await waitFor(() => R("ra").node.store.own(o1.pod)?.kind === "legacy", 2_000, "legacy signed");
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rc").node.store.winner(o1.pod)?.kind === "legacy", 3_000, "legacy announced");
    expect(await reaches(R("rc"), o1.pod, "OLD")).toBe(true);
    // An ATTACHMENT frame on a tunnel that did not negotiate mesh-v1 is not a frame type: the tunnel closes.
    const now = Date.now();
    const a: BoxAttachment = { serverFqdn: o1.pod, boxPub: o1.boxPub, regGen: 1, relayId: "ra", attachedAt: now, issuedAt: now, notAfter: now + 60_000 };
    o1.ws.send(encodeFrame(attachmentFrame({ attachment: a as unknown as Record<string, unknown>, signature: signRelayMeshRecord("relay-attachment", a, (m) => ed.sign(m, o1.stk.privateKey)) })));
    await waitFor(() => o1.closedCode !== null, 2_000, "closed");
    expect(o1.closedCode).toBe(1002);
  });

  it("a peer-backup mailbox held behind another relay is delivered over the bridge (pb-mail stream)", async () => {
    const admin = account("pam");
    const p1 = box(`home.pam.${APEX}`, "pam", admin, "PAM");
    await synced();
    await p1.connect(R("ra"));
    expect(p1.ack.capabilities).toContain("pb-mail-v1");
    const pik = keypair();
    const epoch = pbMailboxEpoch(Date.now());
    const sigHex = hex(ed.sign(canonicalPbMailboxAnnounce(hex(pik.publicKey), epoch), pik.privateKey));
    p1.ws.send(encodeFrame(mailboxAnnounceFrame([{ pikPubHex: hex(pik.publicKey), epoch, sigHex }])));
    const id = pbMailboxId(hex(pik.publicKey), epoch);
    await waitFor(() => R("ra").mailboxes.hasLocal(id), 2_000, "local mailbox");
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").mailboxes.has(id), 3_000, "mailbox announced");
    expect(R("rb").mailboxes.hasLocal(id)).toBe(false);
    const envelope = Buffer.alloc(200_000, 7);
    const r = await R("rb").mailboxes.deliver(id, envelope);
    expect(r?.status).toBe(200);
    expect(Buffer.from(r!.body).subarray(0, 5).toString()).toBe("MAIL:");
    expect(Buffer.from(r!.body).subarray(5).equals(envelope)).toBe(true);
    p1.close();
  });

  it("a relay leaving: its mesh boxes get retire hints and reconnect elsewhere; visitors follow", async () => {
    const admin = account("lea");
    const l1 = box(`home.lea.${APEX}`, "lea", admin, "LEA1");
    await synced();
    await l1.connect(R("ra"));
    expect(await l1.attach()).toEqual({ ok: true });
    R("ra").node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.winner(l1.pod) !== null, 3_000, "announced");
    R("ra").node.beginDrain(200);
    expect(R("ra").node.readiness().reasons).toContain("draining");
    await waitFor(() => l1.hints.some((x) => (x.hint as { reason?: string }).reason === "retire"), 3_000, "retire hint");
    const to = (l1.hints.find((x) => (x.hint as { reason?: string }).reason === "retire")!.hint as { toRelayId: string }).toRelayId;
    expect(["rb", "rc"]).toContain(to);
    await l1.moveTo(R(to));
    R(to).node.flushAnnouncements();
    await waitFor(() => R("rb").node.store.winner(l1.pod)?.attachment.relayId === to, 3_000, "moved");
    expect(await reaches(R("rb"), l1.pod, "LEA1")).toBe(true);
    // ra stops: its bridges go down; visitors through the others still reach the box.
    await stopRelay(R("ra"));
    await waitFor(() => R("rb").node.bridges.peer("ra") === null, 3_000, "bridge down");
    expect(await reaches(R("rc"), l1.pod, "LEA1")).toBe(true);
    l1.close();
  });

  it("the .com outage rule: stale → 503 and only exempt HELLOs; past close-all only indefinite-policy boxes keep serving", async () => {
    const adminI = account("ivy");
    const adminT = account("tom");
    const adminT_: Ed = { priv: adminT.privateKey, pub: hex(adminT.publicKey) };
    /** A time-limited box: a 7 d policy the log's head names, and a live lease, both in its HELLO. */
    const limited = (server: string, label: string): SimBox => {
      const stk = keypair();
      const pod = `${server}.tom.${APEX}`;
      fx.registerBox(pod, hex(stk.publicKey));
      const p = policy({ account: "tom", box: hex(stk.publicKey), admin: adminT_, grace: "7d", server });
      fx.policyHead(hex(stk.publicKey), 1, p.record as ServingPolicy);
      const l = lease(p, adminT_, Date.now(), Date.now() + 60 * 60_000);
      return new SimBox(pod, "tom", stk, adminT, label, { serving: { servingPolicy: p, servingLeases: [l] } });
    };
    const ivy = box(`home.ivy.${APEX}`, "ivy", adminI, "IVY");
    const tom = limited("home", "TOM");
    const lateTom = limited("late", "LATET");
    const lateIvy = box(`late.ivy.${APEX}`, "ivy", adminI, "LATEI");
    await synced();
    expect((await ivy.connect(R("rb"))).ok).toBe(true);
    expect(await ivy.attach()).toEqual({ ok: true });
    expect((await tom.connect(R("rb"))).ok).toBe(true);
    // Both serve apps: Tom's HELLO policy matches the log's head and his lease is live.
    expect(R("rb").wired.gate.stats().serving).toBeGreaterThanOrEqual(2);
    R("rb").node.flushAnnouncements();
    await waitFor(() => R("rc").node.store.winner(ivy.pod) !== null, 3_000, "ivy announced");
    fx.paused = true;
    await waitFor(() => !R("rb").node.fresh() && !R("rc").node.fresh(), REFUSE_NEW_MS + 2_000, "stale");
    expect(R("rb").node.readiness().reasons).toContain("stale");
    // Past 60 s: a time-limited box is told to try again; a box whose log-verified policy has no limit is taken.
    expect(await lateTom.connect(R("rc"))).toMatchObject({ ok: false, reason: "try-again" });
    lateTom.ws.terminate();
    expect((await lateIvy.connect(R("rc"))).ok).toBe(true);
    // Past 10 min: time-limited tunnels close; exempt ones stay, and a stale entry still forwards to them.
    await waitFor(() => tom.closedCode !== null, CLOSE_ALL_MS + 2_000, "time-limited box closed");
    expect(tom.closedCode).toBe(1013);
    await sleep(300);
    expect(ivy.closedCode).toBeNull();
    expect(lateIvy.closedCode).toBeNull();
    expect(await reaches(R("rc"), ivy.pod, "IVY")).toBe(true);
    fx.paused = false;
    await waitFor(() => R("rb").node.fresh(), 3_000, "fresh again");
    await waitFor(() => R("rb").node.readiness().ready, 3_000, "ready again");
    ivy.close();
    lateIvy.close();
  });
});
