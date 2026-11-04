/**
 * A box, simulated in node, against the real gym `.com` and relay (Appendix H scenarios 6, 9, 10; Appendix I section 9).
 * The harness registers a throwaway server whose identity key it holds (`registerSimServer`), so it can sign what a
 * modified box would; `SimBox` then opens the relay's `/tunnel` with a real HELLO v2 (entitlements signed by the
 * account's IRK, the strongest thing any box is entitled under) and answers every relayed stream with a label, never
 * TLS, so a visitor (`RawVisitor`, a plain TCP socket that sends a ClientHello) can tell whether its stream reached
 * the simulated box. Streams are kept open until the relay closes them, which makes "the relay ended this stream"
 * measurable. Used by groups/release03/relayAuthority.ts, relayInstances.ts and relayMesh.ts.
 *
 * Mesh mode (`connect(..., {mesh})`, relay-mesh.md §9): the box offers `mesh-v1`, reads `relayId` / `relayBlessing`
 * from the HELLO_ACK, signs an ATTACHMENT with its STK right after an accepting ACK and every ATTACH_RENEW_MS, and
 * records every MOVE_HINT; `moveSimBox` follows one make-before-break after `checkMoveHint`.
 */
import acme from "acme-client";
import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { bytesToHex } from "@noble/hashes/utils";
import { WebSocket } from "ws";
import {
  ATTACH_RENEW_MS,
  ATTACH_TTL_MS,
  checkMoveHint,
  ed,
  mintDevEntitlements,
  MOVE_OLD_TUNNEL_GRACE_MS,
  recordMoveHint,
  recordMoveTargetFailed,
  signRelayMeshRecord,
  rootEntitlementCertId,
  signRootEntitlement,
  serviceEntitlementCertId,
  signAuthCode,
  signRevocation,
  signServerRegister,
  signServerUnrevocation,
  signServingRecord,
  signTunnelHelloV2,
  type BoxAttachment,
  type CertificateOrder,
  type Keypair,
  type MoveHint,
  type MoveHintRateState,
  type MoveHintRefusal,
  type RelayBlessing,
  type RelayDirectoryBody,
  type ServerRevocation,
  type ServerUnrevocation,
} from "@flagship/protocol";
import {
  attachmentFrame,
  CAPABILITY_MESH_V1,
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_ATTACHMENT,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_MOVE_HINT,
  FRAME_OPEN,
  parseAttachmentResult,
  parseHelloAck,
  parseMoveHintFrame,
  type AttachmentResultPayload,
  type MoveHintFramePayload,
  type ParsedHelloAck,
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
  // Registration takes only an issued serial, demo accounts included (gym 21: "unknown serial").
  const i = await issueAuthCode(code, acct.keys.irk, acct.keys.adminRoot);
  assert(i.status === 200, `auth-code issue ${i.status}: ${short(i.text)}`);
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
  /** The box-authorizing key: the admin root on an admin-pinned account (the relay verifies the root entitlement under it). */
  rootSigner?: Keypair;
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
  // Gym 22: the relay refused an IRK-signed root entitlement on the admin-pinned gym account.
  if (o.rootSigner) bundle.rootEntitlementSig = signRootEntitlement(bundle.rootEntitlement, o.rootSigner);
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

/** Mesh mode for a SimBox (relay-mesh.md §9): which server it attaches as. */
export interface SimBoxMesh {
  server: SimServer;
  /** The registration generation the log holds for it (a new server: 1). */
  regGen?: number;
  /** Sign and send the first attachment right after an accepting ACK that named a relay (default true). */
  autoAttach?: boolean;
}

export class SimBox {
  private buf = new Uint8Array(0);
  readonly streams = new Map<number, { sni: string; closed: boolean }>();
  closedWith: { code: number; reason: string; at: number } | null = null;
  readonly closed: Promise<void>;
  ack: { ok: boolean; reason?: string } | null = null;
  /** The whole HELLO_ACK (mesh fields included). */
  ackFull: ParsedHelloAck | null = null;
  ackAt = 0;
  /** Mesh: the relay holding this tunnel and its blessing, from the ACK. */
  relayId: string | null = null;
  relayBlessing: RelayBlessing | null = null;
  /** Mesh: every MOVE_HINT the relay sent, and every answer to an attachment. */
  readonly hints: Array<MoveHintFramePayload & { at: number }> = [];
  readonly attachResults: Array<AttachmentResultPayload | null> = [];
  private ackWaiters: Array<() => void> = [];
  private attachWaiters: Array<(r: AttachmentResultPayload | null) => void> = [];
  private renew: ReturnType<typeof setInterval> | null = null;

  private constructor(
    readonly ws: WebSocket,
    readonly label: string,
    readonly o: { mesh?: SimBoxMesh; echo?: boolean } = {},
  ) {
    let done!: () => void;
    this.closed = new Promise((r) => (done = r));
    ws.on("close", (code, reason) => {
      this.closedWith = { code, reason: reason.toString(), at: Date.now() };
      if (this.renew) clearInterval(this.renew);
      this.renew = null;
      for (const w of this.ackWaiters.splice(0)) w();
      for (const w of this.attachWaiters.splice(0)) w(null);
      done();
    });
    ws.on("error", () => undefined);
    ws.on("message", (raw: Buffer) => this.onBytes(raw));
  }

  /**
   * Opens `url` (the relay's `wss://…/tunnel`), sends `payload` and waits for the HELLO_ACK (or the close). With
   * `mesh` the HELLO offers `mesh-v1` and, once a mesh relay accepted it, the box attaches (and renews); with `echo`
   * every DATA a visitor sends is written back after the label, so a visitor can check its bytes arrived verbatim.
   */
  static async connect(
    url: string,
    payload: Record<string, unknown>,
    o: { label?: string; headers?: Record<string, string>; ackMs?: number; mesh?: SimBoxMesh; echo?: boolean } = {},
  ): Promise<SimBox> {
    const ws = new WebSocket(url, { headers: o.headers ?? {} });
    const box = new SimBox(ws, o.label ?? "sim", { ...(o.mesh ? { mesh: o.mesh } : {}), ...(o.echo ? { echo: true } : {}) });
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
      ws.once("unexpected-response", (_req, resp) => rej(new Error(`upgrade refused ${resp.statusCode}`)));
    });
    const hello = o.mesh ? withMeshCapability(payload) : payload;
    ws.send(encodeFrame({ streamId: 0, type: FRAME_HELLO, payload: new TextEncoder().encode(JSON.stringify(hello)) }));
    await box.waitAck(o.ackMs ?? 20_000);
    if (o.mesh && box.accepted && box.relayId && o.mesh.autoAttach !== false) {
      await box.attach();
      box.startRenewing();
    }
    return box;
  }

  /** Renew the attachment every ATTACH_RENEW_MS while the tunnel lasts (§5.1). */
  startRenewing(): void {
    if (this.renew || !this.o.mesh) return;
    this.renew = setInterval(() => void this.attach().catch(() => undefined), ATTACH_RENEW_MS);
    this.renew.unref?.();
  }

  async waitAck(ms: number): Promise<void> {
    if (this.ack || this.closedWith) return;
    await Promise.race([new Promise<void>((r) => this.ackWaiters.push(r)), new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
  }

  /** Accepted: an ok HELLO_ACK and the socket still open. */
  get accepted(): boolean {
    return !!this.ack?.ok && !this.closedWith;
  }

  /** Whether the relay answered as a mesh relay (echoed `mesh-v1` and named itself). */
  get meshAcked(): boolean {
    return !!this.relayId && (this.ackFull?.capabilities ?? []).includes(CAPABILITY_MESH_V1);
  }

  /** The attachment this box would sign now for the relay holding its tunnel, with `over` fields. */
  attachmentRecord(over: Partial<BoxAttachment> = {}): BoxAttachment {
    const m = this.o.mesh;
    if (!m) throw new Error("not a mesh SimBox");
    const now = Date.now();
    return { serverFqdn: m.server.fqdn, boxPub: m.server.stkHex, regGen: m.regGen ?? 1, relayId: this.relayId ?? "", attachedAt: this.ackAt, issuedAt: now, notAfter: now + ATTACH_TTL_MS, ...over };
  }

  /** Sign (with the STK, or `signer`) and send an attachment; resolves with the relay's answer (null: none / closed). */
  async attach(over: Partial<BoxAttachment> = {}, signer?: Keypair, ms = 10_000): Promise<AttachmentResultPayload | null> {
    const m = this.o.mesh;
    if (!m) throw new Error("not a mesh SimBox");
    if (this.ws.readyState !== this.ws.OPEN) return null;
    const a = this.attachmentRecord(over);
    const key = signer ?? m.server.stk;
    const signature = signRelayMeshRecord("relay-attachment", a, (msg) => ed.sign(msg, key.privateKey));
    const answer = new Promise<AttachmentResultPayload | null>((r) => {
      this.attachWaiters.push(r);
      setTimeout(() => {
        const i = this.attachWaiters.indexOf(r);
        if (i >= 0) {
          this.attachWaiters.splice(i, 1);
          r(null);
        }
      }, ms).unref?.();
    });
    this.ws.send(encodeFrame(attachmentFrame({ attachment: a as unknown as Record<string, unknown>, signature })));
    return answer;
  }

  /** Waits up to `ms` for a move hint with `reason` (any reason when omitted) received after `since`. */
  async waitHint(reason: MoveHint["reason"] | null, ms: number, since = 0): Promise<(MoveHintFramePayload & { at: number }) | null> {
    const end = Date.now() + ms;
    for (;;) {
      const h = this.hints.find((x) => x.at >= since && (reason === null || (x.hint as { reason?: string }).reason === reason));
      if (h) return h;
      if (Date.now() > end || this.closedWith) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  terminate(): void {
    if (this.renew) clearInterval(this.renew);
    this.renew = null;
    this.ws.terminate();
  }

  /** A clean close (code 1000), as a box leaving a relay after a move. */
  close(reason = "moved"): void {
    if (this.renew) clearInterval(this.renew);
    this.renew = null;
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000, reason);
  }

  private onBytes(raw: Buffer): void {
    const j = new Uint8Array(this.buf.length + raw.length);
    j.set(this.buf);
    j.set(raw, this.buf.length);
    this.buf = j;
    for (;;) {
      const d = decodeFrame(this.buf, { drainNotice: true, ...(this.o.mesh ? { mesh: true } : {}) });
      if (d.kind !== "ok") break;
      this.buf = this.buf.subarray(d.consumed);
      const f = d.frame;
      if (f.type === FRAME_HELLO_ACK) {
        const a = parseHelloAck(f.payload);
        this.ackFull = a;
        this.ack = a as { ok: boolean; reason?: string };
        this.ackAt = Date.now();
        if (a?.ok && this.o.mesh && typeof a.relayId === "string" && (a.capabilities ?? []).includes(CAPABILITY_MESH_V1)) {
          this.relayId = a.relayId;
          this.relayBlessing = (a.relayBlessing ?? null) as RelayBlessing | null;
        }
        for (const w of this.ackWaiters.splice(0)) w();
      } else if (f.type === FRAME_OPEN) {
        const sni = new TextDecoder().decode(f.payload);
        this.streams.set(f.streamId, { sni, closed: false });
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeFrame(dataFrame(f.streamId, new TextEncoder().encode(simAnswer(this.label, sni)))));
      } else if (f.type === FRAME_DATA) {
        if (this.o.echo && this.ws.readyState === this.ws.OPEN && !this.streams.get(f.streamId)?.closed) this.ws.send(encodeFrame(dataFrame(f.streamId, f.payload)));
      } else if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
        const s = this.streams.get(f.streamId);
        if (s) s.closed = true;
      } else if (f.type === FRAME_ATTACHMENT) {
        const r = parseAttachmentResult(f.payload);
        this.attachResults.push(r);
        this.attachWaiters.shift()?.(r);
      } else if (f.type === FRAME_MOVE_HINT) {
        const h = parseMoveHintFrame(f.payload);
        if (h) this.hints.push({ ...h, at: Date.now() });
      }
    }
  }

  /** Closes one stream from the box's side. */
  closeStream(id: number): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeFrame(closeFrame(id, false)));
  }
}

/** The HELLO with `mesh-v1` added to its capabilities (the HELLO signature does not cover them). */
export function withMeshCapability(payload: Record<string, unknown>): Record<string, unknown> {
  const caps = Array.isArray(payload.capabilities) ? (payload.capabilities as string[]) : [];
  return { ...payload, capabilities: caps.includes(CAPABILITY_MESH_V1) ? caps : [...caps, CAPABILITY_MESH_V1] };
}

/** Where a box dials a relay's direct name (§9.3). */
export function relayTunnelUrl(tunnelHost: string): string {
  return `wss://${tunnelHost}:8443/tunnel`;
}

/** The box's §9.3 check of a received hint, against the directory and CA keys the harness holds. */
export function simCheckHint(
  box: SimBox,
  h: MoveHintFramePayload,
  o: { server: SimServer; servicesApex: string; directory: RelayDirectoryBody | null; directoryFetchedAt: number | null; caKeys: readonly string[]; rate: MoveHintRateState; now?: number },
): { ok: true } | { ok: false; reason: MoveHintRefusal | "no-relay" } {
  if (!box.relayId || !box.relayBlessing) return { ok: false, reason: "no-relay" };
  return checkMoveHint({
    hint: h.hint as unknown as MoveHint,
    signature: h.signature,
    target: h.target as unknown as RelayBlessing,
    box: { serverFqdn: o.server.fqdn, boxPub: o.server.stkHex, servicesApex: o.servicesApex },
    current: { relayId: box.relayId, relayKey: box.relayBlessing.relayKey },
    directory: o.directory,
    directoryFetchedAt: o.directoryFetchedAt,
    caKeys: o.caKeys,
    rate: o.rate,
    now: o.now ?? Date.now(),
  });
}

/**
 * Follow a hint make-before-break (§9.3): check it, dial the target's direct name, HELLO (a fresh payload), require an
 * accepting mesh ACK naming the target within 10 s and an accepted attachment there, then keep the old tunnel
 * `graceMs` (default 30 s) and close it. Any failure leaves the box where it was and marks the target failed.
 */
export async function moveSimBox(
  old: SimBox,
  h: MoveHintFramePayload,
  o: {
    server: SimServer;
    servicesApex: string;
    payload: () => Promise<Record<string, unknown>>;
    directory: RelayDirectoryBody | null;
    directoryFetchedAt: number | null;
    caKeys: readonly string[];
    rate: MoveHintRateState;
    graceMs?: number;
    label?: string;
    echo?: boolean;
    /** Where to dial the target (default its direct name, `relayTunnelUrl`); tests dial loopback. */
    url?: (tunnelHost: string, relayId: string) => string;
  },
): Promise<{ ok: true; box: SimBox; rate: MoveHintRateState } | { ok: false; reason: string; rate: MoveHintRateState }> {
  const now = Date.now();
  const check = simCheckHint(old, h, o);
  if (!check.ok) return { ok: false, reason: check.reason, rate: o.rate };
  const hint = h.hint as unknown as MoveHint;
  const target = h.target as unknown as RelayBlessing;
  const rate = recordMoveHint(o.rate, hint.reason, now);
  let next: SimBox | null = null;
  try {
    next = await SimBox.connect(o.url ? o.url(target.tunnelHost, target.relayId) : relayTunnelUrl(target.tunnelHost), await o.payload(), {
      label: o.label ?? old.label,
      ackMs: 10_000,
      mesh: { server: o.server, autoAttach: false },
      ...(o.echo ? { echo: true } : {}),
    });
    if (!next.accepted || next.relayId !== hint.toRelayId) throw new Error(`HELLO on ${hint.toRelayId}: ${JSON.stringify(next.ack ?? next.closedWith)}`);
    const r = await next.attach();
    if (!r?.ok) throw new Error(`attachment on ${hint.toRelayId}: ${JSON.stringify(r)}`);
    next.startRenewing();
  } catch (e) {
    next?.terminate();
    return { ok: false, reason: (e as Error).message, rate: recordMoveTargetFailed(rate, hint.toRelayId, now) };
  }
  const grace = o.graceMs ?? MOVE_OLD_TUNNEL_GRACE_MS;
  setTimeout(() => old.close("moved"), grace).unref?.();
  return { ok: true, box: next, rate };
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
  /** When the TCP connection was made, and the ClientHello it sent (for a verbatim check against an echoing box). */
  readonly openedAt = Date.now();
  sent: Uint8Array = new Uint8Array(0);
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
    v.sent = clientHello(sni);
    sock.write(v.sent);
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
export async function visitSim(ip: string, sni: string, ms = 8_000, o: { talk?: boolean } = {}): Promise<{ label: string | null; tls: boolean; error?: string }> {
  let v: RawVisitor | null = null;
  try {
    v = await RawVisitor.open(ip, sni);
    const a = await v.firstAnswer(ms);
    // A home counts a session toward rebalancing only if the visitor spoke after its ClientHello (relay-mesh §10.1).
    if (a && o.talk) await new Promise<void>((r) => v!.sock.write("fin", () => r()));
    return { label: a?.label ?? null, tls: v.sawTls, ...(a ? {} : { error: "no answer" }) };
  } catch (e) {
    return { label: null, tls: false, error: v ? `after connect: ${(e as Error).message}` : `connect: ${(e as Error).message}` };
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
