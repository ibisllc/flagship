/**
 * Relay conformance harness (release plan G7 / R7, docs/architecture-v2/relay-transport.md §3 and §7): one scenario
 * list run against the TypeScript hub (`apps/web/src/server.ts` `start()`, in process) and the Rust relay
 * (`rust/crates/flagship-relay`, its binary spawned locally), both pointed at the same mock `.com` over the same
 * internal routes. Boxes are raw WebSocket clients speaking the v1 frames (for exact refusals and stream control) or
 * the real daemon tunnel client (`packages/server-daemon/src/tunnel/tunnelClient.ts`, the "old box" of the
 * mixed-version scenarios); visitors are plain TCP sockets that send a TLS ClientHello.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  canonicalPbMailboxAnnounce,
  deriveSTK,
  deriveSWK,
  ed,
  mintDevEntitlements,
  pbMailboxEpoch,
  pbMailboxId,
  rootEntitlementCertId,
  serviceEntitlementCertId,
  signEntitlementRevocationList,
  signTunnelHelloV2,
  type Keypair,
} from "@flagship/protocol";
import { decodeFrame, encodeFrame, FRAME_HELLO, FRAME_HELLO_ACK, parseHelloAck, type Frame } from "@flagship/tunnel-protocol";
import { emptyPhoneRouteEntry, liveEntry, signDeviceCapabilityGrant, type PhoneRouteEntry } from "@flagship/protocol";
import { applyLedgerOp, type LedgerOp } from "../../apps/web/src/tunnel/phoneRoute.js";
import { createRequire, syncBuiltinESMExports } from "node:module";

export const APEX = "flagship.services";
export const REPO = resolve(import.meta.dirname, "../..");
export const RUST_BIN = process.env.FLAGSHIP_RELAY_BIN ?? resolve(REPO, "rust/target/debug/flagship-relay");
let built: boolean | undefined;
/**
 * S18 needs the test-only `conformance` feature, and any plain `cargo test` rebuilds the same binary without it,
 * so unless FLAGSHIP_RELAY_BIN names a binary, the suite builds its own once (no cargo: the Rust half skips).
 */
export const rustAvailable = (): boolean => {
  if (process.env.FLAGSHIP_RELAY_BIN) return existsSync(RUST_BIN);
  if (built === undefined) {
    const r = spawnSync("cargo", ["build", "-q", "-p", "flagship-relay", "--bin", "flagship-relay", "--features", "conformance"], {
      cwd: resolve(REPO, "rust"),
      stdio: "inherit",
      timeout: 15 * 60_000,
    });
    built = r.status === 0 && existsSync(RUST_BIN);
  }
  return built;
};

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

export function key(): Keypair {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

export async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

// ── mock `.com` ──────────────────────────────────────────────────────────

export interface Account {
  username: string;
  irk: Keypair;
}

export interface ServingRecordBody {
  adminKey: string | null;
  regGen: number;
  revoked?: boolean;
  policy: unknown;
  leases: unknown[];
  delegations: unknown[];
}

export const CONTROL_SECRET = "conformance-control-secret";
export const USAGE_SECRET = "conformance-usage-secret";

/** `.com` as both relays see it: the same internal routes, answers set by the scenario. */
export class MockCom {
  server!: Server;
  wss = new WebSocketServer({ noServer: true });
  port = 0;
  readonly accounts = new Map<string, Account>();
  readonly stks = new Map<string, string>();
  readonly certRevocations = new Map<string, { certIds: string[]; issuedAt: number; signature: string }>();
  readonly evictions = new Map<string, string[]>();
  readonly serving = new Map<string, ServingRecordBody>();
  readonly revocationLog: Array<{ entry: unknown; signature: string }> = [];
  readonly feeds = new Set<WebSocket>();
  readonly acks: number[] = [];
  readonly usage: Array<{ username: string; bytes: number }> = [];
  usageAnswer: (u: string) => unknown = (u) => ({ username: u, admit: true });
  readonly paths: string[] = [];
  blessed: { hubKeyPub: string; hubHost: string } | null = null;
  /** `.com`'s phone-route ledger (the ServingFeed DO's) and each account's admin-grant answer. */
  readonly phoneLedger = new Map<string, PhoneRouteEntry>();
  readonly phoneEligibility = new Map<string, unknown>();
  /** Off: committed acquisitions and vacancies are not pushed (the relays' 15 s ledger re-read must catch them). */
  phonePush = true;
  feedUp = true;
  beatMs = 200;
  private beat: ReturnType<typeof setInterval> | null = null;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createHttpServer((req, res) => void this.handle(req, res));
    this.server.on("upgrade", (req, sock, head) => {
      const authed = req.headers.authorization === `Bearer ${CONTROL_SECRET}`;
      if (!req.url?.startsWith("/api/internal/serving-feed") || !authed || !this.feedUp) {
        sock.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, sock, head, (ws) => this.onFeed(ws));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as { port: number }).port;
    this.beat = setInterval(() => {
      for (const ws of this.feeds) ws.send(JSON.stringify({ type: "beat", sequence: this.revocationLog.length }));
    }, this.beatMs);
  }

  async stop(): Promise<void> {
    if (this.beat) clearInterval(this.beat);
    for (const ws of this.feeds) ws.terminate();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  account(username: string): Account {
    const a = { username, irk: key() };
    this.accounts.set(username, a);
    return a;
  }

  /** The feed goes quiet: every feed socket is dropped and new ones are refused. */
  feedDown(): void {
    this.feedUp = false;
    for (const ws of this.feeds) ws.terminate();
  }

  feedBack(): void {
    this.feedUp = true;
  }

  pushRevocation(signed: { entry: unknown; signature: string }): void {
    this.revocationLog.push(signed);
    for (const ws of this.feeds) ws.send(JSON.stringify({ type: "revocation", ...signed }));
  }

  pushChanged(username: string, boxPub: string): void {
    for (const ws of this.feeds) ws.send(JSON.stringify({ type: "changed", username, boxPub }));
  }

  pushPhoneEligibility(username: string): void {
    for (const ws of this.feeds) ws.send(JSON.stringify({ type: "phone-eligibility", username }));
  }

  private onFeed(ws: WebSocket): void {
    this.feeds.add(ws);
    ws.on("close", () => this.feeds.delete(ws));
    ws.on("message", (raw) => {
      let f: { type?: string; since?: number; sequence?: number };
      try {
        f = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (f.type === "hello") {
        for (const e of this.revocationLog.slice(f.since ?? 0)) ws.send(JSON.stringify({ type: "revocation", ...e }));
        ws.send(JSON.stringify({ type: "beat", sequence: this.revocationLog.length }));
      } else if (f.type === "ack" && typeof f.sequence === "number") {
        this.acks.push(f.sequence);
      }
    });
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "null");
    } catch {
      return null;
    }
  }

  /** Routes a subclass serves first (the mesh feed and relay blessings, mesh.ts); true when it answered. */
  protected extraRoute(_req: IncomingMessage, _res: ServerResponse, _url: URL): Promise<boolean> {
    return Promise.resolve(false);
  }

  protected async readBody(req: IncomingMessage): Promise<unknown> {
    return this.body(req);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    this.paths.push(`${req.method} ${p}`);
    if (await this.extraRoute(req, res, url)) return;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const internal = req.headers.authorization === `Bearer ${CONTROL_SECRET}`;
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/api\/username\/([^/]+)$/))) {
      const a = this.accounts.get(decodeURIComponent(m[1]!));
      return a ? send(200, { username: a.username, irkPub: hex(a.irk.publicKey), adminRootPub: null }) : send(404, { error: "not found" });
    }
    if ((m = p.match(/^\/api\/cert-revocations\/([^/]+)$/))) {
      const u = decodeURIComponent(m[1]!);
      const l = this.certRevocations.get(u);
      return send(200, l ? { username: u, ...l } : { username: u, certIds: [], signature: null });
    }
    if ((m = p.match(/^\/api\/server\/by-domain\/([^/]+)$/))) {
      const stk = this.stks.get(decodeURIComponent(m[1]!).toLowerCase());
      return stk ? send(200, { identityPubKey: stk, revoked: null }) : send(404, { error: "not found" });
    }
    if ((m = p.match(/^\/api\/server\/([^/]+)\/eviction-chain$/))) {
      const list = this.evictions.get(decodeURIComponent(m[1]!).toLowerCase()) ?? [];
      return send(200, { evictions: list.map((s) => ({ orderJson: JSON.stringify({ retiredStkPubHex: s }) })) });
    }
    if (p === "/api/services/hub-blessing" && req.method === "POST") {
      const b = (await this.body(req)) as { hubKeyPub: string; hubHost: string };
      this.blessed = b;
      return send(200, {
        blessing: {
          kind: "ServiceBlessing",
          hubKeyPub: b.hubKeyPub,
          hubHost: b.hubHost,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
          signedBy: "conformance-ca",
          signature: "00".repeat(64),
        },
      });
    }
    if (p === "/api/usage/report" && req.method === "POST") {
      if (req.headers["x-usage-secret"] !== USAGE_SECRET) return send(403, { error: "forbidden" });
      const b = (await this.body(req)) as { items: Array<{ username: string; bytes: number }> };
      this.usage.push(...b.items);
      return send(200, { results: b.items.map((i) => this.usageAnswer(i.username)) });
    }
    if (p === "/api/outbound/check" && req.method === "POST") {
      const b = (await this.body(req)) as { host?: string };
      return send(200, { host: b?.host, allowed: false, reason: "unknown-host" });
    }
    if (p === "/api/outbound/report") return send(200, { ok: true });
    if ((m = p.match(/^\/api\/internal\/serving\/([^/]+)\/([^/]+)$/))) {
      if (!internal) return send(403, { error: "forbidden" });
      const r = this.serving.get(`${decodeURIComponent(m[1]!)}|${decodeURIComponent(m[2]!)}`);
      return r ? send(200, { revoked: false, ...r }) : send(404, { error: "unknown box", code: "serving-unknown-box" });
    }
    if (p === "/api/internal/phone-route/ledger") {
      if (!internal) return send(403, { error: "forbidden" });
      if (req.method === "GET") {
        const h = url.searchParams.get("hostname") ?? "";
        return send(200, { entry: liveEntry(this.phoneLedger.get(h) ?? emptyPhoneRouteEntry(), Date.now()) });
      }
      const op = (await this.body(req)) as LedgerOp;
      const r = applyLedgerOp(this.phoneLedger.get(op.hostname) ?? emptyPhoneRouteEntry(), op, Date.now());
      if (r.ok) this.phoneLedger.set(op.hostname, r.entry);
      if (r.ok && op.op !== "renew" && this.phonePush) {
        for (const ws of this.feeds) ws.send(JSON.stringify({ type: "phone-route", hostname: op.hostname, generation: op.generation, vacant: op.op === "release" }));
      }
      return send(200, r);
    }
    if ((m = p.match(/^\/api\/internal\/phone-route\/([^/]+)\/eligibility$/))) {
      if (!internal) return send(403, { error: "forbidden" });
      const e = this.phoneEligibility.get(decodeURIComponent(m[1]!));
      return e ? send(200, e) : send(404, { error: "unknown account" });
    }
    if (p === "/api/internal/serving-revocations") {
      if (!internal) return send(403, { error: "forbidden" });
      const since = Number(url.searchParams.get("since") ?? 0);
      return send(200, { entries: this.revocationLog.slice(since), sequence: this.revocationLog.length });
    }
    return send(404, { error: "not found" });
  }
}

// ── boxes ────────────────────────────────────────────────────────────────

export interface BoxIdentity {
  account: Account;
  server: string;
  pod: string;
  stk: Keypair;
  services: string[];
}

export function boxIdentity(com: MockCom, account: Account, server: string, services: string[] = []): BoxIdentity {
  const pod = `${server}.${account.username}.${APEX}`;
  const stk = deriveSTK(deriveSWK({ seed: crypto.getRandomValues(new Uint8Array(32)) }, pod));
  com.stks.set(pod, hex(stk.publicKey));
  return { account, server, pod, stk, services: services.map((s) => `${s}.${account.username}.${APEX}`) };
}

export interface HelloOptions {
  issuedAt?: number;
  capabilities?: string[];
  serving?: Record<string, unknown>;
  /** Sign the entitlements with another key than the account's IRK. */
  entitlementKey?: Keypair;
  /** Sign the HELLO with another key than the box's STK. */
  helloKey?: Keypair;
  extraCanonicals?: string[];
}

export async function helloPayload(b: BoxIdentity, o: HelloOptions = {}): Promise<{ payload: Record<string, unknown>; rootId: string; nonce: Uint8Array }> {
  const bundle = mintDevEntitlements({
    irk: o.entitlementKey ?? b.account.irk,
    podPubKey: b.stk.publicKey,
    username: b.account.username,
    podCanonical: b.pod,
    serviceCanonicals: [b.pod, ...b.services, ...(o.extraCanonicals ?? [])],
  });
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const issuedAt = o.issuedAt ?? Date.now();
  const rootId = await rootEntitlementCertId(bundle.rootEntitlement);
  const se = bundle.serviceEntitlement!;
  const svcId = await serviceEntitlementCertId(se);
  const signature = signTunnelHelloV2(
    { serverId: b.pod, rootEntitlementCertId: rootId, serviceEntitlementCertId: svcId, nonce, issuedAt },
    o.helloKey ?? b.stk,
  );
  return {
    rootId,
    nonce,
    payload: {
      version: 2,
      serverId: b.pod,
      rootEntitlement: { username: b.account.username, podPubKey: hex(b.stk.publicKey), podCanonical: b.pod, issuedAt: bundle.rootEntitlement.issuedAt },
      rootEntitlementSig: hex(bundle.rootEntitlementSig),
      rootEntitlementCertId: rootId,
      serviceEntitlement: { username: se.username, podPubKey: hex(se.podPubKey), canonicals: se.canonicals, issuedAt: se.issuedAt, expiresAt: se.expiresAt },
      serviceEntitlementSig: hex(bundle.serviceEntitlementSig!),
      serviceEntitlementCertId: svcId,
      nonce: hex(nonce),
      issuedAt,
      signature: hex(signature),
      ...(o.capabilities ? { capabilities: o.capabilities } : {}),
      ...(o.serving ?? {}),
    },
  };
}

/** `.com`'s eligibility answer: each seed is a device with an admin-root-signed grant of `scopes` (default admin). */
export function phoneEligibility(account: string, adminRoot: Keypair, devices: Array<{ seed: Uint8Array; scopes?: string[]; signerRoot?: "admin-root" | "membership" }>): unknown {
  const now = Date.now();
  return {
    adminRootPub: hex(adminRoot.publicKey),
    grants: devices.map((d) => {
      const pub = ed.getPublicKey(d.seed);
      const g = {
        grantId: hex(pub).slice(0, 32),
        username: account,
        deviceId: hex(pub).slice(32),
        devicePubKey: pub,
        scopes: (d.scopes ?? ["admin"]) as never,
        issuedAt: now - 60_000,
        expiresAt: now + 30 * 86_400_000,
      };
      return {
        grantId: g.grantId,
        username: g.username,
        deviceId: g.deviceId,
        devicePubHex: hex(pub),
        scopes: d.scopes ?? ["admin"],
        issuedAt: g.issuedAt,
        expiresAt: g.expiresAt,
        signatureHex: hex(signDeviceCapabilityGrant(g, adminRoot)),
        signerRoot: d.signerRoot ?? "admin-root",
      };
    }),
  };
}

export function revokeCert(com: MockCom, a: Account, certIds: string[]): void {
  const issuedAt = Date.now();
  const sig = signEntitlementRevocationList({ username: a.username, certIds, issuedAt }, a.irk);
  com.certRevocations.set(a.username, { certIds, issuedAt, signature: hex(sig) });
}

export function mailboxAnnouncement(pik: Keypair): { id: string; ann: { pikPubHex: string; epoch: number; sigHex: string } } {
  const epoch = pbMailboxEpoch(Date.now());
  const pikPubHex = hex(pik.publicKey);
  const sigHex = hex(ed.sign(canonicalPbMailboxAnnounce(pikPubHex, epoch), pik.privateKey));
  return { id: pbMailboxId(pikPubHex, epoch), ann: { pikPubHex, epoch, sigHex } };
}

/** A box speaking raw frames: every frame it receives is kept; tests drive the streams. */
export class RawBox {
  frames: Frame[] = [];
  private buf = new Uint8Array(0);
  private waiters: Array<() => void> = [];
  closed: Promise<{ code: number; reason: string }>;
  closeInfo: { code: number; reason: string } | null = null;
  /** Called with every frame as it arrives (a box that answers streams itself). */
  onFrame: ((f: Frame) => void) | null = null;
  constructor(readonly ws: WebSocket, private readonly decode: { mesh?: boolean } = {}) {
    this.closed = new Promise((r) =>
      ws.on("close", (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        r(this.closeInfo);
        this.wake();
      }),
    );
    ws.on("error", () => undefined);
    ws.on("message", (raw: Buffer) => {
      const j = new Uint8Array(this.buf.length + raw.length);
      j.set(this.buf);
      j.set(raw, this.buf.length);
      this.buf = j;
      for (;;) {
        const d = decodeFrame(this.buf, { drainNotice: true, ...(this.decode.mesh ? { mesh: true } : {}) });
        if (d.kind !== "ok") break;
        this.buf = this.buf.subarray(d.consumed);
        this.frames.push(d.frame);
        this.onFrame?.(d.frame);
      }
      this.wake();
    });
  }

  static async connect(hubPort: number, decode: { mesh?: boolean } = {}): Promise<RawBox> {
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/tunnel`);
    const b = new RawBox(ws, decode);
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
      ws.once("unexpected-response", () => rej(new Error("upgrade refused")));
    });
    return b;
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  send(f: Frame): void {
    this.ws.send(encodeFrame(f));
  }

  hello(payload: Record<string, unknown>): void {
    this.send({ streamId: 0, type: FRAME_HELLO, payload: new TextEncoder().encode(JSON.stringify(payload)) });
  }

  async waitFrame(pred: (f: Frame) => boolean, ms = 5_000, what = "frame"): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const f = this.frames.find(pred);
      if (f) return f;
      const left = end - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await Promise.race([new Promise<void>((r) => this.waiters.push(r)), sleep(Math.min(left, 200))]);
    }
  }

  /** The n-th HELLO_ACK (0-based). */
  async ack(n = 0, ms = 5_000): Promise<{ ok: boolean; reason?: string; capabilities?: string[]; serviceBlessing?: { hubKeyPub?: string }; hubSig?: string }> {
    const end = Date.now() + ms;
    for (;;) {
      const acks = this.frames.filter((f) => f.type === FRAME_HELLO_ACK);
      if (acks.length > n) return parseHelloAck(acks[n]!.payload) as never;
      if (Date.now() > end) throw new Error("timed out waiting for HELLO_ACK");
      await Promise.race([new Promise<void>((r) => this.waiters.push(r)), sleep(100)]);
    }
  }

  close(): void {
    this.ws.terminate();
  }
}

// ── visitors ─────────────────────────────────────────────────────────────

export function clientHello(sni: string): Uint8Array {
  const u16 = (v: number) => new Uint8Array([(v >> 8) & 255, v & 255]);
  const cat = (...p: Uint8Array[]) => {
    const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of p) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  };
  const host = new TextEncoder().encode(sni);
  const entry = cat(new Uint8Array([0]), u16(host.length), host);
  const list = cat(u16(entry.length), entry);
  const ext = cat(u16(0), u16(list.length), list);
  const exts = cat(u16(ext.length), ext);
  const body = cat(new Uint8Array([3, 3]), crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([0]), u16(2), new Uint8Array([0x13, 0x01]), new Uint8Array([1, 0]), exts);
  const hs = cat(new Uint8Array([1]), new Uint8Array([(body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), body);
  return cat(new Uint8Array([0x16, 3, 1]), u16(hs.length), hs);
}

export class Visitor {
  received = Buffer.alloc(0);
  ended = false;
  readonly done: Promise<void>;
  constructor(readonly sock: Socket) {
    this.done = new Promise((r) => {
      sock.on("close", () => {
        this.ended = true;
        r();
      });
    });
    sock.on("data", (d: Buffer) => (this.received = Buffer.concat([this.received, d])));
    sock.on("error", () => undefined);
  }

  static async open(port: number, first?: Uint8Array): Promise<Visitor> {
    const sock = netConnect(port, "127.0.0.1");
    await new Promise<void>((r, j) => {
      sock.once("connect", () => r());
      sock.once("error", j);
    });
    const v = new Visitor(sock);
    if (first) sock.write(first);
    return v;
  }

  write(b: Uint8Array | string): void {
    this.sock.write(b);
  }

  end(): void {
    this.sock.end();
  }
}

// ── the two relays ───────────────────────────────────────────────────────

export interface RelayOptions {
  serving?: { revocationPub: string; refuseNewMs?: number; closeAllMs?: number; checkMs?: number };
  usage?: { flushMs?: number; overQuotaKbps?: number };
  outbound?: boolean;
  drainGraceMs?: number;
  /** The phone route (needs `serving`). */
  phone?: boolean;
  relayId?: string;
  /** A successful outbound splice: `host` resolves to `publicIp`, and a dial to it on 443 reaches `local`. */
  outboundUpstream?: { host: string; publicIp: string; local: string };
  /** Reuse these ports (a restart or a rollback onto the same addresses). */
  ports?: { hub: number; sni: number; echo: number };
  /** The relay mesh (FLAGSHIP_MESH=on): every variable as the relay reads it (mesh.ts `meshRelayEnv`). */
  meshEnv?: Record<string, string>;
}

export interface RunningRelayTarget {
  impl: "ts" | "rust";
  hubPort: number;
  sniPort: number;
  echoPort: number;
  /** Stop accepting, warn `drain-v1` boxes, keep serving `graceMs`, then close the rest (SIGTERM for Rust). */
  drain(): Promise<void>;
  /** Gone at once (a crash or a machine stop). */
  kill(): Promise<void>;
  logs: string[];
}

function relayEnv(com: MockCom, o: RelayOptions, ports: { hub: number; sni: number; echo: number }): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(ports.hub),
    TUNNEL_TCP_PORT: String(ports.sni),
    RELAY_ECHO_PORT: String(ports.echo),
    HOST: "127.0.0.1",
    FLAGSHIP_SURFACE: "services",
    FLAGSHIP_SERVICES_APEX: APEX,
    FLAGSHIP_COM_BASE_URL: com.url,
    SERVICES_CONTROL_SECRET: CONTROL_SECRET,
    FLAGSHIP_HUB_HOST: APEX,
    FLAGSHIP_DRAIN_GRACE_MS: String(o.drainGraceMs ?? 1_000),
    FLAGSHIP_OUTBOUND_RELAY: o.outbound === false ? "off" : "on",
    FLAGSHIP_RELAY_ID: o.relayId ?? "conformance",
    FLAGSHIP_PHONE_ROUTE: o.phone ? "on" : "off",
  };
  if (o.outboundUpstream) {
    const u = o.outboundUpstream;
    env.FLAGSHIP_OUTBOUND_CONFORMANCE_UPSTREAM = `${u.host}=${u.publicIp}=${u.local}`;
  }
  if (o.usage) {
    env.USAGE_REPORT_SECRET = USAGE_SECRET;
    env.USAGE_FLUSH_MS = String(o.usage.flushMs ?? 200);
    if (o.usage.overQuotaKbps) env.FLAGSHIP_OVER_QUOTA_KBPS = String(o.usage.overQuotaKbps);
  }
  if (o.serving) {
    env.FLAGSHIP_SERVING_REVOCATION_PUB = o.serving.revocationPub;
    if (o.serving.refuseNewMs !== undefined) env.FLAGSHIP_SERVING_REFUSE_NEW_MS = String(o.serving.refuseNewMs);
    if (o.serving.closeAllMs !== undefined) env.FLAGSHIP_SERVING_CLOSE_ALL_MS = String(o.serving.closeAllMs);
    env.FLAGSHIP_SERVING_CHECK_MS = String(o.serving.checkMs ?? 100);
  }
  if (o.meshEnv) Object.assign(env, o.meshEnv);
  return env;
}

const RELAY_ENV_KEYS = [
  "PORT", "TUNNEL_TCP_PORT", "RELAY_ECHO_PORT", "HOST", "FLAGSHIP_SURFACE", "FLAGSHIP_SERVICES_APEX", "FLAGSHIP_COM_BASE_URL",
  "SERVICES_CONTROL_SECRET", "FLAGSHIP_HUB_HOST", "FLAGSHIP_DRAIN_GRACE_MS", "FLAGSHIP_OUTBOUND_RELAY", "FLAGSHIP_RELAY_ID",
  "FLAGSHIP_PHONE_ROUTE", "USAGE_REPORT_SECRET", "USAGE_FLUSH_MS", "FLAGSHIP_OVER_QUOTA_KBPS", "FLAGSHIP_SERVING_REVOCATION_PUB",
  "FLAGSHIP_SERVING_REFUSE_NEW_MS", "FLAGSHIP_SERVING_CLOSE_ALL_MS", "FLAGSHIP_SERVING_CHECK_MS", "FLAGSHIP_PB_MAIL",
  "FLAGSHIP_OUTBOUND_CONFORMANCE_UPSTREAM", "FLAGSHIP_MESH", "FLAGSHIP_RELAY_KEY_SEED", "FLAGSHIP_RELAY_KIND",
  "FLAGSHIP_RELAY_FEED_URL", "FLAGSHIP_RELAY_LOG_PUB", "FLAGSHIP_MESH_CA_KEYS", "FLAGSHIP_MESH_PEER_URLS",
  "FLAGSHIP_MESH_FEED_POLL_MS", "FLAGSHIP_MESH_REBALANCE_MS", "FLAGSHIP_MESH_MIN_MOVE_MS", "FLAGSHIP_MESH_ATTACH_TTL_MS",
  "FLAGSHIP_MESH_CAPACITY", "FLAGSHIP_RELAY_FEED_PLAIN", "FLAGSHIP_MESH_CLIENT_KEY_BY_PORT",
];

async function ports(o: RelayOptions): Promise<{ hub: number; sni: number; echo: number }> {
  return o.ports ?? { hub: await freePort(), sni: await freePort(), echo: await freePort() };
}

const nodeRequire = createRequire(import.meta.url);
let unpatchUpstream: (() => void) | null = null;

/**
 * The TS hub's twin of the Rust `conformance` feature: in this process only, `host` resolves to `publicIp` and a dial
 * to it on 443 goes to `local`. Every other lookup and dial is untouched. Undone when the relay stops.
 */
function patchUpstream(u: { host: string; publicIp: string; local: string }): void {
  const dns = nodeRequire("node:dns") as typeof import("node:dns");
  const net = nodeRequire("node:net") as typeof import("node:net");
  const lookup = dns.promises.lookup;
  const connect = net.connect;
  const [lh, lp] = [u.local.slice(0, u.local.lastIndexOf(":")), Number(u.local.slice(u.local.lastIndexOf(":") + 1))];
  (dns.promises as { lookup: unknown }).lookup = (async (host: string, opts: unknown) =>
    host.toLowerCase() === u.host ? [{ address: u.publicIp, family: 4 }] : (lookup as (...a: unknown[]) => unknown)(host, opts)) as never;
  (net as { connect: unknown }).connect = ((...args: unknown[]) => {
    const a = args[0] as { host?: string; port?: number };
    if (typeof a === "object" && a?.host === u.publicIp && a.port === 443) return connect({ host: lh, port: lp });
    return (connect as (...x: unknown[]) => unknown)(...args);
  }) as never;
  syncBuiltinESMExports();
  unpatchUpstream = () => {
    (dns.promises as { lookup: unknown }).lookup = lookup;
    (net as { connect: unknown }).connect = connect;
    syncBuiltinESMExports();
  };
}

export async function startTs(com: MockCom, o: RelayOptions = {}): Promise<RunningRelayTarget> {
  const p = await ports(o);
  if (o.outboundUpstream) patchUpstream(o.outboundUpstream);
  const env = relayEnv(com, o, p);
  for (const k of RELAY_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const logs: string[] = [];
  const { start } = await import("../../apps/web/src/server.js");
  const h = await start({ httpPort: p.hub, tunnelTcpPort: p.sni, relayEchoPort: p.echo, host: "127.0.0.1" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Upgraded tunnel sockets keep the HTTP server open; end them first, as a process exit would.
    await h.drain(0);
    h.app.server.closeAllConnections();
    await h.close();
    unpatchUpstream?.();
    unpatchUpstream = null;
  };
  return {
    impl: "ts",
    hubPort: p.hub,
    sniPort: p.sni,
    echoPort: p.echo,
    logs,
    async drain() {
      await h.drain(Number(env.FLAGSHIP_DRAIN_GRACE_MS));
      await close();
    },
    kill: close,
  };
}

/**
 * freePort() closes its probe before the relay binds, so a parallel test file can take the number in between; the
 * relay then exits with "Address already in use". Ports we picked ourselves are picked again; ports the scenario
 * named (a restart onto the same addresses) are not.
 */
export async function startRust(com: MockCom, o: RelayOptions = {}): Promise<RunningRelayTarget> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startRustOn(com, o, await ports(o));
    } catch (e) {
      if (o.ports || attempt >= 5 || !/Address already in use/.test(String(e))) throw e;
    }
  }
}

async function startRustOn(com: MockCom, o: RelayOptions, p: { hub: number; sni: number; echo: number }): Promise<RunningRelayTarget> {
  const env = relayEnv(com, o, p);
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", ...env };
  const child: ChildProcess = spawn(RUST_BIN, [], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  let ready!: () => void;
  const up = new Promise<void>((r) => (ready = r));
  const onLine = (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line) continue;
      logs.push(line);
      if (line.startsWith("tunnel hub:")) ready();
    }
  };
  child.stdout!.on("data", onLine);
  child.stderr!.on("data", onLine);
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  await Promise.race([
    up,
    exited.then((c) => {
      throw new Error(`flagship-relay exited ${c}: ${logs.join(" | ")}`);
    }),
    sleep(15_000).then(() => {
      throw new Error(`flagship-relay did not start: ${logs.join(" | ")}`);
    }),
  ]);
  return {
    impl: "rust",
    hubPort: p.hub,
    sniPort: p.sni,
    echoPort: p.echo,
    logs,
    async drain() {
      child.kill("SIGTERM");
      await exited;
    },
    async kill() {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

export type Starter = (com: MockCom, o?: RelayOptions) => Promise<RunningRelayTarget>;

export const IMPLS: Array<{ name: "ts" | "rust"; start: Starter; available: () => boolean }> = [
  { name: "ts", start: startTs, available: () => true },
  { name: "rust", start: startRust, available: rustAvailable },
];

/** One HTTP GET to the relay's hub port. */
export async function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

export async function httpPost(port: number, path: string, body: Uint8Array): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers: { "content-type": "application/octet-stream" } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}
