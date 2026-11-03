/**
 * The relay mesh in the conformance harness (docs/architecture-v2/relay-mesh.md §14.2): a mock `.com` that publishes
 * the relay log as R2-shaped files sealed to the mesh key (§4.5.1: `head.json`, `log/<page>.json` encrypted per epoch,
 * `directory.json` and `keys/<relayId>.json` in clear), mints the CA-signed directory, answers relay-blessing requests
 * with proof of possession of the relay key (§3.2) and seals `meshKeys` to each relay; a three-relay launcher with any
 * mix of runtimes (the TS hub in process, the Rust binary spawned); mesh boxes speaking raw v1 frames with `mesh-v1`
 * (they sign attachments with their STK); and a harness peer (`PeerSim`) that speaks the bridge protocol (§6) so a
 * scenario can watch announcements and queries, forge items, and open bridged streams.
 *
 * Every relay reads the feed under its own URL prefix (`/feed/<relayId>/v1`), so one relay's feed can be paused while
 * its peers keep theirs (the "head from a peer keeps a relay fresh" case of MESH09).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import {
  accountHash,
  canonicalServingPolicy,
  checkRelayBlessingRequest,
  DIRECTORY_TTL_MS,
  ed,
  FEED_PAGE_ENTRIES,
  makeRelayLogEntry,
  nameHash,
  RELAY_BLESSING_TTL_MS,
  RELAY_LOG_ZERO_TIP,
  relayLogEntryHash,
  relayTunnelHost,
  signRelayBlessing,
  signRelayDirectory,
  signRelayLogEntry,
  signRelayMeshRecord,
  signServiceBlessing,
  type BoxAttachment,
  type Keypair,
  type RelayBlessing,
  type RelayDirectory,
  type RelayKind,
  type RelayLogBody,
  type ServingPolicy,
  type SignedRelayLogEntry,
  type SignedRelayLogHead,
} from "@flagship/protocol";
import { deriveMeshEpochKey, sealRelayFeedObject, sealRelayMeshKeys, type RelayMeshKeys } from "@flagship/control-plane";
import {
  attachmentFrame,
  closeFrame,
  dataFrame,
  encodeFrame,
  decodeFrame,
  FRAME_ATTACHMENT,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_HELLO_ACK,
  FRAME_MOVE_HINT,
  FRAME_OPEN,
  FRAME_PB_MAIL_REQ,
  MailAssembler,
  mailResponseFrames,
  parseAttachmentResult,
  parseHelloAck,
  parseMoveHintFrame,
  type Frame,
  type MoveHintFramePayload,
  type ParsedHelloAck,
} from "@flagship/tunnel-protocol";
import {
  APEX,
  boxIdentity,
  freePort,
  helloPayload,
  hex,
  httpGet,
  IMPLS,
  key,
  MockCom,
  RawBox,
  sleep,
  USAGE_SECRET,
  Visitor,
  clientHello,
  waitFor,
  type Account,
  type BoxIdentity,
  type HelloOptions,
  type RunningRelayTarget,
} from "./harness.js";

/** The hold every refusal path waits out (`HOLD_TIMEOUT`, §7.2): 4 s on both relays. */
export const HOLD_MS = 4_000;

const rand32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export interface MeshRelaySpec {
  relayId: string;
  kind: RelayKind;
  region: string;
  seedHex: string;
  key: Keypair;
  pub: string;
  retired: boolean;
}

/** `.com` with the mesh feed (B's encrypted format), directory, blessings and the signed relay log. */
export class MeshCom extends MockCom {
  readonly ca = key();
  readonly logKey = key();
  readonly meshSeed = hex(rand32());
  epochs: number[] = [1];
  readonly specs = new Map<string, MeshRelaySpec>();
  directoryVersion = 0;
  directory: RelayDirectory | null = null;
  readonly relayBlessings = new Map<string, RelayBlessing>();
  readonly entries: SignedRelayLogEntry[] = [];
  /** Relay ids whose feed answers 503 (`*`: every relay's: the `.com` outage). */
  readonly feedPaused = new Set<string>();
  /** Blessing requests and what they were answered (`code` on a refusal). */
  readonly blessingRequests: Array<{ relayId: string; status: number; code?: string }> = [];

  get logPub(): string {
    return hex(this.logKey.publicKey);
  }

  get caPub(): string {
    return hex(this.ca.publicKey);
  }

  get current(): number {
    return this.epochs[this.epochs.length - 1]!;
  }

  feedUrl(relayId: string): string {
    return `${this.url}/feed/${relayId}/v1`;
  }

  /** Admit a relay (§3.1 `add`): a new directory version, blessed. */
  admit(relayId: string, kind: RelayKind = "full", region = "iad"): MeshRelaySpec {
    const seed = rand32();
    const k = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
    const s: MeshRelaySpec = { relayId, kind, region, seedHex: hex(seed), key: k, pub: hex(k.publicKey), retired: false };
    this.specs.set(relayId, s);
    this.mintDirectory();
    return s;
  }

  /** §3.1 `retire`: a `relay-revoke` entry, a new mesh-key epoch, a new directory without it. */
  retire(relayId: string): void {
    const s = this.specs.get(relayId)!;
    s.retired = true;
    this.append({ kind: "relay-revoke", relayId, relayKey: s.pub });
    this.rotateEpoch();
    this.mintDirectory();
  }

  rotateEpoch(): void {
    this.epochs.push(this.current + 1);
  }

  active(): MeshRelaySpec[] {
    return [...this.specs.values()].filter((s) => !s.retired);
  }

  mintDirectory(): RelayDirectory {
    const now = Date.now();
    this.directoryVersion++;
    this.directory = signRelayDirectory(
      {
        servicesApex: APEX,
        directoryVersion: this.directoryVersion,
        issuedAt: now,
        expiresAt: now + DIRECTORY_TTL_MS,
        relays: this.active().map((s) => ({ relayId: s.relayId, relayKey: s.pub, tunnelHost: relayTunnelHost(s.relayId, APEX), relayKind: s.kind, region: s.region, ipv4: ["127.0.0.1"], ipv6: [] })),
      },
      this.ca,
    );
    for (const s of this.active()) this.relayBlessings.set(s.relayId, this.bless(s));
    for (const s of this.specs.values()) if (s.retired) this.relayBlessings.delete(s.relayId);
    return this.directory;
  }

  bless(s: { relayId: string; pub: string; kind: RelayKind }, o: { issuedAt?: number; expiresAt?: number; ca?: Keypair } = {}): RelayBlessing {
    const issuedAt = o.issuedAt ?? Date.now();
    return signRelayBlessing(
      { relayId: s.relayId, relayKey: s.pub, servicesApex: APEX, tunnelHost: relayTunnelHost(s.relayId, APEX), relayKind: s.kind, nonce: hex(rand32()).slice(0, 32), issuedAt, expiresAt: o.expiresAt ?? issuedAt + RELAY_BLESSING_TTL_MS },
      o.ca ?? this.ca,
    );
  }

  meshKeys(s: MeshRelaySpec): RelayMeshKeys {
    return sealRelayMeshKeys({
      servicesApex: APEX,
      relayId: s.relayId,
      relayKey: s.pub,
      current: this.current,
      epochs: this.epochs.map((epoch) => ({ epoch, key: deriveMeshEpochKey(this.meshSeed, APEX, epoch) })),
    });
  }

  append(body: RelayLogBody): SignedRelayLogEntry {
    const e = makeRelayLogEntry(this.entries.length + 1, Date.now(), body);
    const s = { entry: e, signature: signRelayLogEntry(APEX, e, (m) => ed.sign(m, this.logKey.privateKey)) };
    this.entries.push(s);
    return s;
  }

  head(issuedAt = Date.now()): SignedRelayLogHead {
    const last = this.entries[this.entries.length - 1];
    const head = { servicesApex: APEX, sequence: last?.entry.sequence ?? 0, tipSha256: last ? relayLogEntryHash(APEX, last.entry) : RELAY_LOG_ZERO_TIP, directoryVersion: this.directoryVersion, issuedAt };
    return { head, signature: signRelayMeshRecord("relay-log-head", head, (m) => ed.sign(m, this.logKey.privateKey)) };
  }

  page(n: number): { page: number; entries: SignedRelayLogEntry[] } {
    return { page: n, entries: this.entries.filter((e) => Math.floor(e.entry.sequence / FEED_PAGE_ENTRIES) === n) };
  }

  /** An account with its IRK in the log (`account-authority`, no admin root: the box's admin key is the IRK). */
  override account(username: string): Account {
    const a = super.account(username);
    this.append({ kind: "account-authority", accountHash: accountHash(username), adminRootPub: null, irkPub: hex(a.irk.publicKey), authorityGen: 1 });
    return a;
  }

  /** A box registered in the log (`box-register`) under its pod name. */
  box(a: Account, server: string, services: string[] = [], regGen = 1): BoxIdentity {
    const b = boxIdentity(this, a, server, services);
    this.append({ kind: "box-register", nameHash: nameHash(b.pod), boxPub: hex(b.stk.publicKey), regGen });
    return b;
  }

  revokeBox(b: BoxIdentity, regGen = 1): void {
    this.append({ kind: "box-revoke", boxPub: hex(b.stk.publicKey), regGen });
  }

  /** `.com`'s un-revoke (the owner's, or the operator's unsuspend): a `box-register` for the same key at `regGen`. */
  unrevokeBox(b: BoxIdentity, regGen: number): void {
    this.append({ kind: "box-register", nameHash: nameHash(b.pod), boxPub: hex(b.stk.publicKey), regGen });
  }

  policyHead(b: BoxIdentity, regGen: number, p: ServingPolicy): void {
    this.append({ kind: "policy-head", boxPub: hex(b.stk.publicKey), regGen, policyGen: p.policyGen, policySha256: createHash("sha256").update(canonicalServingPolicy(p)).digest("hex") });
  }

  private paused(relayId: string): boolean {
    return this.feedPaused.has("*") || this.feedPaused.has(relayId);
  }

  protected override async extraRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return true;
    };
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/feed\/([a-z0-9-]+)\/v1\/(.+)$/)) && req.method === "GET") {
      const [who, file] = [m[1]!, m[2]!];
      if (this.paused(who)) return send(503, { error: "paused" });
      if (file === "directory.json") return this.directory ? send(200, { directory: this.directory, blessings: [...this.relayBlessings.values()] }) : send(404, {});
      if (file === "log-key.json") return send(200, { logKey: this.logPub });
      let k: RegExpMatchArray | null;
      if ((k = file.match(/^keys\/([a-z0-9-]+)\.json$/))) {
        const s = this.specs.get(k[1]!);
        return s && !s.retired ? send(200, this.meshKeys(s)) : send(404, {});
      }
      const key = deriveMeshEpochKey(this.meshSeed, APEX, this.current);
      if (file === "head.json") {
        return send(200, await sealRelayFeedObject({ servicesApex: APEX, object: "head", page: null, epoch: this.current, key, plaintext: JSON.stringify(this.head()) }));
      }
      if ((k = file.match(/^log\/(\d+)\.json$/))) {
        const n = Number(k[1]);
        const pg = this.page(n);
        if (pg.entries.length === 0) return send(404, {});
        return send(200, await sealRelayFeedObject({ servicesApex: APEX, object: "log", page: n, epoch: this.current, key, plaintext: JSON.stringify(pg) }));
      }
      return send(404, {});
    }
    if (p === "/api/services/relay-blessing" && req.method === "POST") {
      const b = (await this.readBody(req)) as { relayId?: string; relayKey?: string; servicesApex?: string; issuedAt?: number; signature?: string } | null;
      const refuse = (status: number, code: string) => {
        this.blessingRequests.push({ relayId: String(b?.relayId), status, code });
        return send(status, { error: code, code });
      };
      if (!b || typeof b.relayId !== "string" || typeof b.relayKey !== "string" || typeof b.signature !== "string" || typeof b.issuedAt !== "number") return refuse(400, "relay-blessing-malformed");
      const c = checkRelayBlessingRequest({ relayId: b.relayId, relayKey: b.relayKey, servicesApex: String(b.servicesApex), issuedAt: b.issuedAt }, b.signature, APEX, Date.now());
      if (!c.ok) return refuse(c.reason === "bad-signature" ? 401 : 400, `relay-blessing-${c.reason === "bad-signature" ? "signature" : c.reason}`);
      const s = this.specs.get(b.relayId);
      if (!s || s.retired) return refuse(403, "relay-not-admitted");
      if (s.pub !== b.relayKey) return refuse(403, "relay-key-unknown");
      const relayBlessing = this.bless(s);
      this.relayBlessings.set(s.relayId, relayBlessing);
      const serviceBlessing = signServiceBlessing({ hubKeyPub: s.pub, hubHost: APEX, nonce: hex(rand32()).slice(0, 32), issuedAt: relayBlessing.issuedAt, expiresAt: relayBlessing.expiresAt }, this.ca);
      this.blessingRequests.push({ relayId: s.relayId, status: 200 });
      return send(200, { relayBlessing, serviceBlessing, meshKeys: this.meshKeys(s) });
    }
    return false;
  }
}

// ── the launcher ─────────────────────────────────────────────────────────

export type Impl = "ts" | "rust";

export interface MeshTimings {
  refuseNewMs?: number;
  closeAllMs?: number;
  rebalanceMs?: number;
  feedPollMs?: number;
}

export interface MeshRelay {
  relayId: string;
  impl: Impl;
  spec: MeshRelaySpec;
  target: RunningRelayTarget;
  ports: { hub: number; sni: number; echo: number };
}

export function meshRelayEnv(com: MeshCom, s: MeshRelaySpec, peers: Map<string, number>, t: MeshTimings = {}): Record<string, string> {
  const env: Record<string, string> = {
    FLAGSHIP_MESH: "on",
    FLAGSHIP_RELAY_ID: s.relayId,
    FLAGSHIP_RELAY_KEY_SEED: s.seedHex,
    FLAGSHIP_RELAY_KIND: s.kind,
    FLAGSHIP_RELAY_FEED_URL: com.feedUrl(s.relayId),
    FLAGSHIP_RELAY_LOG_PUB: com.logPub,
    FLAGSHIP_MESH_CA_KEYS: com.caPub,
    FLAGSHIP_MESH_PEER_URLS: [...peers].filter(([id]) => id !== s.relayId).map(([id, port]) => `${id}=ws://127.0.0.1:${port}/mesh`).join(","),
    FLAGSHIP_MESH_FEED_POLL_MS: String(t.feedPollMs ?? 200),
    FLAGSHIP_MESH_MIN_MOVE_MS: "0",
  };
  if (t.refuseNewMs !== undefined) env.FLAGSHIP_SERVING_REFUSE_NEW_MS = String(t.refuseNewMs);
  if (t.closeAllMs !== undefined) env.FLAGSHIP_SERVING_CLOSE_ALL_MS = String(t.closeAllMs);
  if (t.rebalanceMs !== undefined) env.FLAGSHIP_MESH_REBALANCE_MS = String(t.rebalanceMs);
  return env;
}

export const implStarter = (impl: Impl) => IMPLS.find((x) => x.name === impl)!;

/**
 * Start one relay per `layout` entry (each admitted on `com` already) in one mesh: every relay knows where to dial
 * every other one, and the call returns once each answers `/api/health` 200 (blessed, listed, fresh, bridged).
 */
export async function launchMesh(com: MeshCom, layout: Array<{ relayId: string; impl: Impl }>, t: MeshTimings = {}, readyMs = 30_000): Promise<Map<string, MeshRelay>> {
  const ports = new Map<string, { hub: number; sni: number; echo: number }>();
  for (const l of layout) ports.set(l.relayId, { hub: await freePort(), sni: await freePort(), echo: await freePort() });
  const hubs = new Map([...ports].map(([id, p]) => [id, p.hub]));
  const out = new Map<string, MeshRelay>();
  for (const l of layout) {
    const spec = com.specs.get(l.relayId)!;
    const p = ports.get(l.relayId)!;
    const target = await implStarter(l.impl).start(com, { ports: p, meshEnv: meshRelayEnv(com, spec, hubs, t), drainGraceMs: 3_000, usage: { flushMs: 1_000 }, phone: true });
    out.set(l.relayId, { relayId: l.relayId, impl: l.impl, spec, target, ports: p });
  }
  await waitMeshReady([...out.values()], readyMs);
  return out;
}

export async function health(r: MeshRelay): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const h = await httpGet(r.ports.hub, "/api/health");
    return { status: h.status, body: (h.body ?? {}) as Record<string, unknown> };
  } catch {
    return { status: 0, body: {} };
  }
}

export async function meshStats(r: MeshRelay): Promise<Record<string, unknown>> {
  const s = await httpGet(r.ports.hub, "/api/stats", { "x-usage-secret": USAGE_SECRET });
  return ((s.body as Record<string, unknown>)?.mesh ?? {}) as Record<string, unknown>;
}

/** Per-peer `rejected` from `/api/stats` `mesh.peers[]` (both relays name it so). */
export async function rejectedFrom(r: MeshRelay, peer: string): Promise<number> {
  const peers = ((await meshStats(r)).peers ?? []) as Array<{ relayId?: string; rejected?: number }>;
  return peers.find((p) => p.relayId === peer)?.rejected ?? -1;
}

export async function waitMeshReady(relays: MeshRelay[], ms = 30_000): Promise<void> {
  await waitFor(async () => (await Promise.all(relays.map(health))).every((h) => h.status === 200), ms, "every relay mesh-ready").catch(async (e) => {
    const why = await Promise.all(relays.map(async (r) => `${r.relayId}/${r.impl}: ${JSON.stringify((await health(r)).body.mesh ?? (await health(r)).body)} ${r.target.logs.slice(-6).join(" | ")}`));
    throw new Error(`${(e as Error).message}: ${why.join(" ;; ")}`);
  });
}

export async function stopMesh(relays: Map<string, MeshRelay> | null): Promise<void> {
  if (!relays) return;
  for (const r of relays.values()) await r.target.kill().catch(() => undefined);
}

// ── a mesh box ───────────────────────────────────────────────────────────

const td = new TextDecoder();

/** Bytes a box answers a visitor with after its ClientHello ("bulk" mode): `<label>|` then 70 KB. */
export function bulkReply(label: string, n = 70_000): Buffer {
  const body = Buffer.alloc(n);
  for (let i = 0; i < n; i++) body[i] = (i * 31 + label.length) & 0xff;
  return Buffer.concat([Buffer.from(`${label}|`), body]);
}

export interface BoxStream {
  id: number;
  sni: string;
  received: Buffer;
  closed: boolean;
}

/**
 * A box on one relay: raw v1 frames, `mesh-v1` offered (unless `mesh: false`, an old box), its STK signs attachments.
 * It answers visitors itself: "echo" (default) answers each chunk `<label>:<bytes>`; "bulk" answers the first chunk
 * with `bulkReply(label)` and keeps every byte it receives.
 */
export class MeshBox {
  raw!: RawBox;
  ack!: ParsedHelloAck & { relayId?: string; relayBlessing?: RelayBlessing };
  ackAt = 0;
  relayId = "";
  readonly hints: MoveHintFramePayload[] = [];
  /** The tunnel each hint in `hints` arrived on. */
  readonly hintTunnels: RawBox[] = [];
  readonly streams = new Map<number, BoxStream>();
  private mail = new Map<number, MailAssembler>();

  constructor(
    readonly id: BoxIdentity,
    readonly label: string,
    readonly o: { mesh?: boolean; mode?: "echo" | "bulk"; hello?: HelloOptions } = {},
  ) {}

  get pod(): string {
    return this.id.pod;
  }

  get boxPub(): string {
    return hex(this.id.stk.publicKey);
  }

  /** HELLO on `relay`: the account's IRK as the serving admin key, `mesh-v1` unless an old box. */
  async connect(relay: MeshRelay | { ports: { hub: number } }, o: HelloOptions = {}): Promise<this["ack"]> {
    const raw = await RawBox.connect(relay.ports.hub, { mesh: true });
    this.raw = raw;
    raw.onFrame = (f) => this.onFrame(raw, f);
    const caps = this.o.mesh === false ? [] : ["mesh-v1"];
    const h = await helloPayload(this.id, { capabilities: caps, serving: { servingAdminKey: hex(this.id.account.irk.publicKey) }, ...this.o.hello, ...o });
    raw.hello(h.payload);
    this.ack = (await raw.ack()) as this["ack"];
    this.ackAt = Date.now();
    this.relayId = this.ack.relayId ?? "";
    return this.ack;
  }

  /** Sign and send an attachment for this tunnel's relay (or `over`); resolves with the relay's answer frame. */
  async attach(over: Partial<BoxAttachment> = {}, signer: Keypair = this.id.stk): Promise<{ ok: boolean; code?: string }> {
    const now = Date.now();
    const a: BoxAttachment = { serverFqdn: this.pod, boxPub: this.boxPub, regGen: 1, relayId: this.relayId, attachedAt: this.ackAt, issuedAt: now, notAfter: now + 30 * 60_000, ...over };
    const signature = signRelayMeshRecord("relay-attachment", a, (m) => ed.sign(m, signer.privateKey));
    const before = this.raw.frames.filter((f) => f.type === FRAME_ATTACHMENT).length;
    this.raw.send(attachmentFrame({ attachment: a as unknown as Record<string, unknown>, signature }));
    await waitFor(() => this.raw.frames.filter((f) => f.type === FRAME_ATTACHMENT).length > before, 5_000, `${this.label}: attachment answer`);
    const f = this.raw.frames.filter((x) => x.type === FRAME_ATTACHMENT)[before]!;
    return parseAttachmentResult(f.payload) as { ok: boolean; code?: string };
  }

  /** Make-before-break (§9.3): connect to `to`, attach there, then close the old tunnel. */
  async moveTo(to: MeshRelay): Promise<void> {
    const old = this.raw;
    const ack = await this.connect(to);
    if (!ack.ok) throw new Error(`${this.label}: move refused: ${ack.reason}`);
    const r = await this.attach();
    if (!r.ok) throw new Error(`${this.label}: attachment refused on the target: ${r.code}`);
    old.ws.close(1000, "moved");
  }

  close(): void {
    this.raw?.ws.close(1000, "bye");
  }

  /** Frames of one tunnel (`raw`): answers go back on that tunnel, even after the box moved to another. */
  private onFrame(raw: RawBox, f: Frame): void {
    const ws = raw.ws;
    if (f.type === FRAME_HELLO_ACK) return;
    if (f.type === FRAME_OPEN) {
      this.streams.set(f.streamId, { id: f.streamId, sni: td.decode(f.payload), received: Buffer.alloc(0), closed: false });
      return;
    }
    if (f.type === FRAME_DATA) {
      const s = this.streams.get(f.streamId);
      if (!s) return;
      const first = s.received.length === 0;
      s.received = Buffer.concat([s.received, Buffer.from(f.payload)]);
      if (this.o.mode === "bulk") {
        if (first) for (let o = 0, r = bulkReply(this.label); o < r.length; o += 32 * 1024) ws.send(encodeFrame(dataFrame(f.streamId, r.subarray(o, o + 32 * 1024))));
      } else {
        ws.send(encodeFrame(dataFrame(f.streamId, Buffer.concat([Buffer.from(`${this.label}:`), Buffer.from(f.payload)]))));
      }
      return;
    }
    if (f.type === FRAME_CLOSE) {
      const s = this.streams.get(f.streamId);
      if (s && !s.closed) {
        s.closed = true;
        ws.send(encodeFrame(closeFrame(f.streamId, false)));
      }
      return;
    }
    if (f.type === FRAME_PB_MAIL_REQ) {
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
      if (h) {
        this.hints.push(h);
        this.hintTunnels.push(raw);
      }
    }
  }

  /** Close one stream from the box side. */
  closeStream(id: number): void {
    const s = this.streams.get(id);
    if (s && !s.closed) {
      s.closed = true;
      this.raw.ws.send(encodeFrame(closeFrame(id, false)));
    }
  }
}

// ── visitors ─────────────────────────────────────────────────────────────

/** Visit `sni` on a relay's SNI port: what came back and when the relay hung up (-1: still open at `waitMs`). */
export async function visit(r: MeshRelay, sni: string, waitMs = 2_500): Promise<{ text: string; bytes: Buffer; closedAfterMs: number }> {
  const started = Date.now();
  const v = await Visitor.open(r.ports.sni, clientHello(sni));
  const t = await Promise.race([v.done.then(() => Date.now() - started), sleep(waitMs).then(() => -1)]);
  if (t === -1) v.sock.destroy();
  return { text: v.received.toString("latin1"), bytes: v.received, closedAfterMs: t };
}

/** Whether a visitor through `r` reaches the box labelled `label` (an "echo" box). */
export async function reaches(r: MeshRelay, sni: string, label: string, waitMs = 1_500): Promise<boolean> {
  return (await visit(r, sni, waitMs)).text.startsWith(`${label}:`);
}

/** Wait until a visitor through `r` reaches `label` (announcements travel within ~1 s). */
export async function waitReaches(r: MeshRelay, sni: string, label: string, ms = 8_000): Promise<void> {
  await waitFor(() => reaches(r, sni, label, 1_200), ms, `${sni} through ${r.relayId}/${r.impl} reaches ${label}`);
}

// ── a harness peer on the bridge (§6) ───────────────────────────────────

/**
 * Dials a relay's `/mesh` as `relayId` and runs the dialer's side of the handshake with whatever it is told to send
 * (to test refusals), then speaks control messages and v1 frames. Queries are answered "none" so a relay never waits
 * on it, unless `answerQueries` is false.
 */
export class PeerSim {
  readonly msgs: Array<Record<string, unknown>> = [];
  readonly frames: Frame[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;
  serverAuth: Record<string, unknown> | null = null;
  answerQueries = true;
  queryAnswer: (name: string) => unknown[] = () => [];
  private nextStream = 1;

  private constructor(readonly ws: WebSocket, readonly relayId: string) {
    this.closed = new Promise((r) =>
      ws.on("close", (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        r(this.closeInfo);
      }),
    );
    ws.on("error", () => undefined);
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const d = decodeFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
        if (d.kind === "ok") this.frames.push(d.frame);
        return;
      }
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      this.msgs.push(m);
      if (m.type === "query" && this.answerQueries) this.send({ type: "answer", qid: m.qid, items: this.queryAnswer(String(m.name)) });
    });
  }

  /**
   * Dial `r` and authenticate as `o.relayId` (its key signs; `o.blessing` is sent, null allowed). Overrides make a
   * refusal case: `peer` (the peer id named), `at`, `signWith`. Resolves once the relay answered its `mesh-auth`, or
   * closed (see `closeInfo`).
   */
  static async dial(
    r: MeshRelay,
    o: { relayId: string; key: Keypair; blessing: RelayBlessing | null; peer?: string; at?: number; signWith?: Keypair },
  ): Promise<PeerSim> {
    const ws = new WebSocket(`ws://127.0.0.1:${r.ports.hub}/mesh`);
    const sim = new PeerSim(ws, o.relayId);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => {
        ws.terminate();
        rej(new Error("no /mesh upgrade"));
      }, 3_000);
      ws.once("open", () => (clearTimeout(t), res()));
      ws.once("error", (e) => (clearTimeout(t), rej(e)));
    });
    const hello = await sim.next((m) => m.type === "mesh-hello", 5_000);
    const nc = hex(rand32());
    const at = o.at ?? Date.now();
    const peer = o.peer ?? String(hello.relayId);
    const sig = signRelayMeshRecord(
      "relay-bridge-auth",
      { role: "client", signerRelayId: o.relayId, peerRelayId: peer, serverNonce: String(hello.nonce), clientNonce: nc, at },
      (m) => ed.sign(m, (o.signWith ?? o.key).privateKey),
    );
    sim.send({ type: "mesh-auth", v: 1, relayId: o.relayId, peer, nonce: nc, at, blessing: o.blessing, sig });
    await Promise.race([sim.next((m) => m.type === "mesh-auth", 6_000).then((m) => (sim.serverAuth = m)).catch(() => null), sim.closed]);
    return sim;
  }

  get authed(): boolean {
    return this.serverAuth !== null && this.closeInfo === null;
  }

  send(m: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  sendFrame(f: Frame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(f));
  }

  /** `sync` with `.com`'s current head, an empty dump, `sync-done`. */
  sync(com: MeshCom): void {
    this.send({ type: "sync", directoryVersion: com.directoryVersion, head: com.head(), features: [], load: { tunnels: 0, capacity: 10_000 } });
    this.send({ type: "announce", items: [] });
    this.send({ type: "sync-done" });
  }

  async next(match: (m: Record<string, unknown>) => boolean, ms = 5_000, from = 0): Promise<Record<string, unknown>> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.msgs.slice(from).find(match);
      if (m) return m;
      if (Date.now() > end || this.closeInfo) throw new Error(`peer sim ${this.relayId}: no matching message within ${ms} ms (closed: ${JSON.stringify(this.closeInfo)})`);
      await sleep(20);
    }
  }

  /** Open a bridged stream (§6.4; the dialer's ids are odd) with `openBody` and, unless null, the ClientHello as DATA. */
  open(sni: string, openBody: Record<string, unknown> = { sni, kind: "tls", hop: 1 }, first: Uint8Array | null = clientHello(sni)): number {
    const id = this.nextStream;
    this.nextStream += 2;
    this.sendFrame({ streamId: id, type: FRAME_OPEN, payload: new TextEncoder().encode(JSON.stringify(openBody)) });
    if (first) this.sendFrame(dataFrame(id, first));
    return id;
  }

  close(): void {
    this.ws.terminate();
  }
}

/** A peer sim that authenticates as an admitted relay of `com` and syncs. */
export async function joinAs(com: MeshCom, r: MeshRelay, relayId: string): Promise<PeerSim> {
  const s = com.specs.get(relayId)!;
  const sim = await PeerSim.dial(r, { relayId, key: s.key, blessing: com.relayBlessings.get(relayId) ?? com.bless(s) });
  if (!sim.authed) throw new Error(`peer sim ${relayId} was refused by ${r.relayId}: ${JSON.stringify(sim.closeInfo)}`);
  sim.sync(com);
  return sim;
}

export { APEX, sleep, waitFor, hex, key, td };
