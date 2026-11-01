/**
 * A box, simulated in node, against the real gym `.com` and relay (Appendix H scenarios 6, 9, 10; Appendix I section 9).
 * The harness registers a throwaway server whose identity key it holds (`registerSimServer`), so it can sign what a
 * modified box would; `SimBox` then opens the relay's `/tunnel` with a real HELLO v2 (entitlements signed by the
 * account's IRK, the strongest thing any box is entitled under) and answers every relayed stream with a label, never
 * TLS, so a visitor (`RawVisitor`, a plain TCP socket that sends a ClientHello) can tell whether its stream reached
 * the simulated box. Streams are kept open until the relay closes them, which makes "the relay ended this stream"
 * measurable. Used by groups/release03/relayAuthority.ts and relayInstances.ts.
 */
import acme from "acme-client";
import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { bytesToHex } from "@noble/hashes/utils";
import { WebSocket } from "ws";
import {
  ed,
  mintDevEntitlements,
  rootEntitlementCertId,
  serviceEntitlementCertId,
  signAuthCode,
  signRevocation,
  signServerRegister,
  signServerUnrevocation,
  signServingRecord,
  signTunnelHelloV2,
  type CertificateOrder,
  type Keypair,
  type ServerRevocation,
  type ServerUnrevocation,
} from "@flagship/protocol";
import {
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_OPEN,
  parseHelloAck,
} from "@flagship/tunnel-protocol";
import type { Account } from "./fleet.js";
import { authCodeWire, issueAuthCode, newAuthCode } from "./fleet.js";
import { CONTROL, SERVICES, assert, postJson, short, type Resp } from "./harness.js";

const hex = (b: Uint8Array): string => bytesToHex(b);

export interface SimServer {
  label: string;
  fqdn: string;
  stk: Keypair;
  stkHex: string;
}

export function simKey(): Keypair {
  const seed = new Uint8Array(randomBytes(32));
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) } as Keypair;
}

/** Registers `<label>.<user>.<apex>` on the gym `.com` with a key the harness holds (what the box daemon does). */
export async function registerSimServer(acct: Account, label = `sim${randomBytes(3).toString("hex")}`, stk: Keypair = simKey()): Promise<SimServer & { status: number; text: string }> {
  const code = newAuthCode(acct, label);
  if (!acct.demo) {
    const i = await issueAuthCode(code, acct.keys.irk, acct.keys.adminRoot);
    assert(i.status === 200, `auth-code issue ${i.status}: ${short(i.text)}`);
  }
  const request = {
    authCode: code,
    authCodeUserSignature: signAuthCode(code, acct.keys.irk),
    serverIdentityPubKey: stk.publicKey,
    issuedAt: Date.now(),
    nonce: new Uint8Array(randomBytes(16)),
  };
  const r = await postJson(`https://${CONTROL}/api/server/register`, {
    request: {
      authCode: authCodeWire(code),
      authCodeUserSignature: hex(request.authCodeUserSignature),
      serverIdentityPubKey: hex(stk.publicKey),
      issuedAt: request.issuedAt,
      nonce: hex(request.nonce),
    },
    signature: hex(signServerRegister(request, stk)),
  });
  return { label, fqdn: `${label}.${acct.username}.${SERVICES}`, stk, stkHex: hex(stk.publicKey), status: r.status, text: r.text };
}

/** The owner's revocation (IRK-signed, as the apps send it). */
export function revokeServer(acct: Account, fqdn: string, reason: ServerRevocation["reason"] = "lost"): Promise<Resp> {
  const rv = { userId: acct.username, revokedServerId: fqdn, reason, issuedAt: Date.now() } as ServerRevocation;
  return postJson(`https://${CONTROL}/api/server-registry/revoke`, { request: rv, signature: hex(signRevocation(rv, acct.keys.irk)) });
}

/** Un-revoking needs the admin root; `.com` advances the server's registration generation. */
export function unrevokeServer(acct: Account, fqdn: string): Promise<Resp> {
  const u: ServerUnrevocation = { username: acct.username, serverDomain: fqdn, issuedAt: Date.now() };
  return postJson(`https://${CONTROL}/api/server-registry/unrevoke`, { request: u, signature: hex(signServerUnrevocation(u, acct.keys.adminRoot)) });
}

/** A P-256 key and a CSR for `names` (base64url DER), as a box makes them. */
export async function csrFor(names: string[]): Promise<string> {
  const key = await acme.crypto.createPrivateEcdsaKey("P-256");
  const [, pem] = await acme.crypto.createCsr({ commonName: names[0]!, altNames: names }, key);
  return Buffer.from(pem.toString("utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64").toString("base64url");
}

/** POST /api/certificates/orders as the device holding `signer`. */
export async function orderCertificate(o: {
  acct: Account;
  signer: Keypair;
  cls: CertificateOrder["class"];
  names: string[];
  server?: string | null;
  regGen?: number;
  serverWildcardGrant?: { issuedAt: number; signature: string };
}): Promise<Resp> {
  const csr = await csrFor(o.names);
  const ord: CertificateOrder = {
    class: o.cls,
    device: hex(o.signer.publicKey),
    regGen: o.regGen ?? (o.cls === "phone" ? 0 : 1),
    csrSha256: createHash("sha256").update(Buffer.from(csr, "base64url")).digest("hex"),
    requestId: randomBytes(16).toString("hex"),
    issuedAt: Date.now(),
  };
  return postJson(`https://${CONTROL}/api/certificates/orders`, {
    account: o.acct.username,
    ...(o.server === null || o.server === undefined ? {} : { server: o.server }),
    order: ord,
    signature: hex(signServingRecord("certificate-order", ord, (m) => ed.sign(m, o.signer.privateKey))),
    csr,
    ...(o.serverWildcardGrant ? { serverWildcardGrant: o.serverWildcardGrant } : {}),
  });
}

/** A HELLO v2 payload for `server`, entitled by `irk` to its own name plus `canonicals`. */
export async function simHelloPayload(o: {
  username: string;
  server: SimServer;
  irk: Keypair;
  canonicals?: string[];
  serving?: Record<string, unknown>;
  issuedAt?: number;
  helloKey?: Keypair;
}): Promise<Record<string, unknown>> {
  const bundle = mintDevEntitlements({
    irk: o.irk,
    podPubKey: o.server.stk.publicKey,
    username: o.username,
    podCanonical: o.server.fqdn,
    serviceCanonicals: [o.server.fqdn, ...(o.canonicals ?? [])],
  });
  const nonce = new Uint8Array(randomBytes(32));
  const issuedAt = o.issuedAt ?? Date.now();
  const rootId = await rootEntitlementCertId(bundle.rootEntitlement);
  const se = bundle.serviceEntitlement!;
  const svcId = await serviceEntitlementCertId(se);
  const signature = signTunnelHelloV2({ serverId: o.server.fqdn, rootEntitlementCertId: rootId, serviceEntitlementCertId: svcId, nonce, issuedAt }, o.helloKey ?? o.server.stk);
  return {
    version: 2,
    serverId: o.server.fqdn,
    rootEntitlement: { username: o.username, podPubKey: o.server.stkHex, podCanonical: o.server.fqdn, issuedAt: bundle.rootEntitlement.issuedAt },
    rootEntitlementSig: hex(bundle.rootEntitlementSig),
    rootEntitlementCertId: rootId,
    serviceEntitlement: { username: se.username, podPubKey: hex(se.podPubKey), canonicals: se.canonicals, issuedAt: se.issuedAt, expiresAt: se.expiresAt },
    serviceEntitlementSig: hex(bundle.serviceEntitlementSig!),
    serviceEntitlementCertId: svcId,
    nonce: hex(nonce),
    issuedAt,
    signature: hex(signature),
    ...(o.serving ?? {}),
  };
}

/** What a simulated box writes on every stream it is handed: a visitor reading it knows where it landed. */
export const SIM_MARK = "SIMBOX:";

export function simAnswer(label: string, sni: string): string {
  return `${SIM_MARK}${label}:${sni}\n`;
}

/** The label a visitor read, or null when what it read was not a simulated box's answer (a real box's TLS, nothing). */
export function readSimAnswer(received: Buffer): { label: string; sni: string } | null {
  const s = received.toString("latin1");
  if (!s.startsWith(SIM_MARK)) return null;
  const m = /^SIMBOX:([^:\n]*):([^\n]*)\n/.exec(s);
  return m ? { label: m[1]!, sni: m[2]! } : null;
}

export class SimBox {
  private buf = new Uint8Array(0);
  readonly streams = new Map<number, { sni: string; closed: boolean }>();
  closedWith: { code: number; reason: string; at: number } | null = null;
  readonly closed: Promise<void>;
  ack: { ok: boolean; reason?: string } | null = null;
  private ackWaiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket, readonly label: string) {
    let done!: () => void;
    this.closed = new Promise((r) => (done = r));
    ws.on("close", (code, reason) => {
      this.closedWith = { code, reason: reason.toString(), at: Date.now() };
      for (const w of this.ackWaiters.splice(0)) w();
      done();
    });
    ws.on("error", () => undefined);
    ws.on("message", (raw: Buffer) => this.onBytes(raw));
  }

  /** Opens `url` (the relay's `wss://…/tunnel`), sends `payload` and waits for the HELLO_ACK (or the close). */
  static async connect(url: string, payload: Record<string, unknown>, o: { label?: string; headers?: Record<string, string>; ackMs?: number } = {}): Promise<SimBox> {
    const ws = new WebSocket(url, { headers: o.headers ?? {} });
    const box = new SimBox(ws, o.label ?? "sim");
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
      ws.once("unexpected-response", (_req, resp) => rej(new Error(`upgrade refused ${resp.statusCode}`)));
    });
    ws.send(encodeFrame({ streamId: 0, type: FRAME_HELLO, payload: new TextEncoder().encode(JSON.stringify(payload)) }));
    await box.waitAck(o.ackMs ?? 20_000);
    return box;
  }

  async waitAck(ms: number): Promise<void> {
    if (this.ack || this.closedWith) return;
    await Promise.race([new Promise<void>((r) => this.ackWaiters.push(r)), new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
  }

  /** Accepted: an ok HELLO_ACK and the socket still open. */
  get accepted(): boolean {
    return !!this.ack?.ok && !this.closedWith;
  }

  terminate(): void {
    this.ws.terminate();
  }

  private onBytes(raw: Buffer): void {
    const j = new Uint8Array(this.buf.length + raw.length);
    j.set(this.buf);
    j.set(raw, this.buf.length);
    this.buf = j;
    for (;;) {
      const d = decodeFrame(this.buf, { drainNotice: true });
      if (d.kind !== "ok") break;
      this.buf = this.buf.subarray(d.consumed);
      const f = d.frame;
      if (f.type === FRAME_HELLO_ACK) {
        this.ack = parseHelloAck(f.payload) as { ok: boolean; reason?: string };
        for (const w of this.ackWaiters.splice(0)) w();
      } else if (f.type === FRAME_OPEN) {
        const sni = new TextDecoder().decode(f.payload);
        this.streams.set(f.streamId, { sni, closed: false });
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeFrame(dataFrame(f.streamId, new TextEncoder().encode(simAnswer(this.label, sni)))));
      } else if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
        const s = this.streams.get(f.streamId);
        if (s) s.closed = true;
      }
    }
  }

  /** Closes one stream from the box's side. */
  closeStream(id: number): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeFrame(closeFrame(id, false)));
  }
}

// ── visitors ─────────────────────────────────────────────────────────────

/** A minimal TLS 1.2/1.3 ClientHello carrying `sni` (enough for the relay's SNI router). */
export function clientHello(sni: string): Uint8Array {
  const u16 = (v: number) => Buffer.from([(v >> 8) & 255, v & 255]);
  const host = Buffer.from(sni, "ascii");
  const entry = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
  const list = Buffer.concat([u16(entry.length), entry]);
  const ext = Buffer.concat([u16(0), u16(list.length), list]);
  const exts = Buffer.concat([u16(ext.length), ext]);
  const body = Buffer.concat([Buffer.from([3, 3]), randomBytes(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), exts]);
  const hs = Buffer.concat([Buffer.from([1, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), body]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]));
}

/** A visitor at the relay's :443: sends a ClientHello for `sni` and keeps whatever comes back until either side closes. */
export class RawVisitor {
  received = Buffer.alloc(0);
  closedAt: number | null = null;
  readonly closed: Promise<void>;
  private dataWaiters: Array<() => void> = [];

  private constructor(readonly sock: Socket, readonly sni: string) {
    let done!: () => void;
    this.closed = new Promise((r) => (done = r));
    sock.on("data", (d: Buffer) => {
      this.received = Buffer.concat([this.received, d]);
      for (const w of this.dataWaiters.splice(0)) w();
    });
    sock.on("close", () => {
      this.closedAt = Date.now();
      for (const w of this.dataWaiters.splice(0)) w();
      done();
    });
    sock.on("error", () => undefined);
  }

  static async open(ip: string, sni: string, port = 443): Promise<RawVisitor> {
    const sock = netConnect(port, ip);
    await new Promise<void>((res, rej) => {
      sock.once("connect", () => res());
      sock.once("error", rej);
      sock.setTimeout(10_000, () => rej(new Error(`connect ${ip}:${port} timed out`)));
    });
    sock.setTimeout(0);
    const v = new RawVisitor(sock, sni);
    sock.write(clientHello(sni));
    return v;
  }

  /** Waits up to `ms` for a first answer (or the close). */
  async firstAnswer(ms = 8_000): Promise<{ label: string; sni: string } | null> {
    if (this.received.length === 0 && this.closedAt === null) {
      await Promise.race([new Promise<void>((r) => this.dataWaiters.push(r)), new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
    }
    return readSimAnswer(this.received);
  }

  /** What came back looked like a real TLS server (a handshake record), not a simulated box. */
  get sawTls(): boolean {
    return this.received.length > 0 && this.received[0] === 0x16;
  }

  end(): void {
    this.sock.destroy();
  }
}

/** One short visit: which simulated box answered (null when none did). */
export async function visitSim(ip: string, sni: string, ms = 8_000): Promise<{ label: string | null; tls: boolean }> {
  let v: RawVisitor | null = null;
  try {
    v = await RawVisitor.open(ip, sni);
    const a = await v.firstAnswer(ms);
    return { label: a?.label ?? null, tls: v.sawTls };
  } catch {
    return { label: null, tls: false };
  } finally {
    v?.end();
  }
}

// ── relay instances (multi-machine scenarios) ───────────────────────────

/**
 * The gym relay's machine ids, from `GYM_RELAY_INSTANCES` (comma-separated Fly machine ids of the gym relay app,
 * `flyctl machines list -a flagship-services-gym`). A tunnel is pinned to one with Fly's `fly-force-instance-id`
 * header (the :8443 service has an http handler). Fewer than two ids: the multi-instance scenarios skip.
 */
export function relayInstances(env: string | undefined = process.env.GYM_RELAY_INSTANCES): string[] {
  if (!env) return [];
  const ids = env
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) if (!/^[0-9a-z]{6,32}$/.test(id)) throw new Error(`GYM_RELAY_INSTANCES: "${id}" is not a Fly machine id`);
  return [...new Set(ids)];
}

export function pinInstance(id: string): Record<string, string> {
  return { "fly-force-instance-id": id };
}
