/**
 * The carrier between harnesses on different boxes (SECURITY-HARDENING-PLAN.md 17.5-17.6).
 *
 * Outbound: a frame is JSON, hashed, and sent to the target lead's `/api/chat/wire` under a statement the
 * sending box signs with its server key (`flagship/chat-wire/v1`). Inbound: the receiver checks the
 * statement is addressed to it, recent, names the body that arrived and was not seen before, finds the
 * sender's registered key at `.com`, verifies the signature, and only then hands the frame to its
 * harness with that key as the peer. Every authenticated frame is answered the same way, so a sender
 * learns nothing about listeners, approvals or apps; an unauthenticated one is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { chatWireBodySha256, chatWireFresh, signChatWire, verifyChatWire, type ChatWirePurpose, type ChatWireStatement } from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { ChatProof } from "./admission.js";
import type { ChatTransport, WireFrame } from "./harness.js";
import type { ChatPeerDirectory } from "./peerDirectory.js";
import { MAX_BODY_BYTES } from "./types.js";

const J = { "content-type": "application/json" } as const;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const ID = /^[A-Za-z0-9_-]{16,80}$/;
/** A frame is a message body plus a small envelope. */
export const MAX_WIRE_BYTES = MAX_BODY_BYTES + 16 * 1024;

export interface WireEnvelope {
  statement: ChatWireStatement;
  sigHex: string;
  /** The JSON text the statement's hash covers. */
  body: string;
}

/** Keep only the fields a frame may carry, each shaped as the harness expects. Anything else drops the frame. */
export function parseWireFrame(text: string): WireFrame | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  if (!["start", "reply", "close", "ack"].includes(v.kind as string)) return null;
  if (typeof v.wireId !== "string" || !ID.test(v.wireId)) return null;
  if (!Number.isSafeInteger(v.counter) || (v.counter as number) < 0) return null;
  if (!Number.isSafeInteger(v.leadGeneration) || (v.leadGeneration as number) < 0) return null;
  const f: WireFrame = { kind: v.kind as WireFrame["kind"], wireId: v.wireId, counter: v.counter as number, leadGeneration: v.leadGeneration as number };
  if (v.target !== undefined) {
    const t = v.target as Record<string, unknown>;
    if (!t || typeof t.author !== "string" || typeof t.slug !== "string" || typeof t.targetUser !== "string") return null;
    if (!NAME.test(t.author) || !NAME.test(t.slug) || !NAME.test(t.targetUser)) return null;
    f.target = { author: t.author, slug: t.slug, targetUser: t.targetUser };
  }
  if (v.claimedSender !== undefined) {
    const s = v.claimedSender as Record<string, unknown>;
    if (!s || typeof s.author !== "string" || typeof s.slug !== "string" || !NAME.test(s.author) || !NAME.test(s.slug)) return null;
    f.claimedSender = { author: s.author, slug: s.slug };
  }
  if (v.submittedAt !== undefined) {
    if (!Number.isSafeInteger(v.submittedAt) || (v.submittedAt as number) < 0) return null;
    f.submittedAt = v.submittedAt as number;
  }
  if (v.body !== undefined) {
    if (typeof v.body !== "string" || Buffer.byteLength(v.body) > MAX_BODY_BYTES) return null;
    f.body = v.body;
  }
  if (v.phrase !== undefined) {
    if (typeof v.phrase !== "string" || v.phrase.length > 30) return null;
    f.phrase = v.phrase;
  }
  if (v.proof !== undefined) {
    const p = v.proof as Record<string, unknown>;
    if (!p || typeof p !== "object") return null;
    for (const k of ["nonce", "target", "sourceSession", "perAppId", "accessGrantRef", "signatureHex"] as const) {
      if (typeof p[k] !== "string" || (p[k] as string).length > 512) return null;
    }
    if (p.purpose !== "chat" || !Number.isSafeInteger(p.leadGeneration)) return null;
    f.proof = p as unknown as ChatProof;
  }
  return f;
}

export interface WireSenderOptions {
  self: string;
  /** Signs with the server identity key (the custodian's signAsBox). */
  sign: (msg: Uint8Array) => Uint8Array;
  directory: ChatPeerDirectory;
  fetchImpl?: typeof fetch;
  baseUrl?: (serverDomain: string) => string;
  now?: () => number;
}

/** What the carrier needs to say who it is talking to for a route key. */
export class ChatWireTransport implements ChatTransport {
  /** peer STK hex -> server domain, learnt from our own sends and from authenticated receives. */
  private readonly domains = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: (d: string) => string;

  constructor(private readonly o: WireSenderOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? (() => Date.now());
    this.baseUrl = o.baseUrl ?? ((d) => `https://${d}`);
  }

  noteDomain(peerKey: string, serverDomain: string): void {
    if (this.domains.size >= 4096) this.domains.delete(this.domains.keys().next().value!);
    this.domains.set(peerKey, serverDomain.toLowerCase());
  }

  async sendToLead(target: { author: string; slug: string; targetUser: string }, frame: WireFrame): Promise<{ peerKey: string }> {
    const lead = await this.o.directory.leadOf(target.targetUser, `${target.author}--${target.slug}`.toLowerCase());
    if (!lead) throw new Error("no lead");
    const peer = await this.o.directory.server(lead);
    if (!peer || peer.username.toLowerCase() === this.o.self.split(".").slice(1).join(".").split(".")[0]?.toLowerCase()) throw new Error("no peer");
    this.noteDomain(peer.pubHex, lead);
    await this.post(lead, "frame", JSON.stringify(frame));
    return { peerKey: peer.pubHex };
  }

  async sendOnRoute(peerKey: string, frame: WireFrame): Promise<void> {
    const domain = this.domains.get(peerKey);
    if (!domain) throw new Error("unknown route");
    await this.post(domain, "frame", JSON.stringify(frame));
  }

  /** Same-account box to box (lease votes use the same signed carriage). */
  async post(to: string, purpose: ChatWirePurpose, body: string, path = "/api/chat/wire"): Promise<Response> {
    const statement: ChatWireStatement = {
      purpose,
      fromServer: this.o.self,
      toServer: to,
      issuedAt: this.now(),
      nonce: randomBytes(16).toString("hex"),
      bodySha256Hex: chatWireBodySha256(new TextEncoder().encode(body)),
    };
    const sigHex = Buffer.from(signChatWire(statement, this.o.sign)).toString("hex");
    const envelope: WireEnvelope = { statement, sigHex, body };
    const r = await this.fetchImpl(`${this.baseUrl(to)}${path}`, { method: "POST", headers: J, body: JSON.stringify(envelope), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`peer answered ${r.status}`);
    return r;
  }
}

export interface WireReceiverOptions {
  self: string;
  directory: ChatPeerDirectory;
  transport: ChatWireTransport;
  /** Hand an authenticated frame to the harness. */
  deliver: (frame: WireFrame, peerKey: string) => Promise<void>;
  now?: () => number;
  /** Frames a single sending box may send per minute. */
  perPeerPerMinute?: number;
}

/** `POST /api/chat/wire` */
export function buildWireReceiver(o: WireReceiverOptions) {
  const now = o.now ?? (() => Date.now());
  const seen = new Map<string, number>();
  const buckets = new Map<string, { start: number; n: number }>();
  const cap = o.perPeerPerMinute ?? 240;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path.split("?")[0] !== "/api/chat/wire") return null;
    if (req.method !== "POST") return { status: 405, headers: J, body: JSON.stringify({ error: "method not allowed" }) };
    const env = await authenticatePeer(req, "frame", o.self, o.directory, now, seen);
    if (!env.ok) return { status: env.status, headers: J, body: JSON.stringify({ error: "refused" }) };
    const t = now();
    const b = buckets.get(env.peer.pubHex) ?? { start: t, n: 0 };
    if (t - b.start > 60_000) { b.start = t; b.n = 0; }
    b.n++;
    if (buckets.size >= 2048) buckets.delete(buckets.keys().next().value!);
    buckets.set(env.peer.pubHex, b);
    if (b.n > cap) return { status: 429, headers: J, body: JSON.stringify({ error: "slow down" }) };
    o.transport.noteDomain(env.peer.pubHex, env.statement.fromServer);
    const frame = parseWireFrame(env.body);
    if (frame) await o.deliver(frame, env.peer.pubHex).catch(() => {});
    // Every authenticated frame gets this answer, whatever became of it.
    return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
  };
}

export type PeerAuth =
  | { ok: true; peer: { pubHex: string; username: string }; statement: ChatWireStatement; body: string }
  | { ok: false; status: 400 | 401 | 413 };

/** Shared by the frame receiver and the lease voter: addressed to me, fresh, unique, and signed by the sender's registered key. */
export async function authenticatePeer(
  req: HttpRequest,
  purpose: ChatWirePurpose,
  self: string,
  directory: ChatPeerDirectory,
  now: () => number,
  seen: Map<string, number>,
): Promise<PeerAuth> {
  if (req.body.length > MAX_WIRE_BYTES) return { ok: false, status: 413 };
  let env: WireEnvelope;
  try {
    env = JSON.parse(req.body.toString("utf8")) as WireEnvelope;
  } catch {
    return { ok: false, status: 400 };
  }
  const s = env?.statement;
  if (!s || typeof env.body !== "string" || typeof env.sigHex !== "string" || !/^[0-9a-f]{128}$/.test(env.sigHex) || s.purpose !== purpose) return { ok: false, status: 400 };
  const t = now();
  const bodyBytes = new TextEncoder().encode(env.body);
  try {
    if (!chatWireFresh(s, self, bodyBytes, t)) return { ok: false, status: 401 };
  } catch {
    return { ok: false, status: 400 };
  }
  for (const [k, at] of seen) if (t - at > 300_000) seen.delete(k);
  const key = createHash("sha256").update(`${s.fromServer}|${s.nonce}`).digest("hex");
  if (seen.has(key)) return { ok: false, status: 401 };
  const peer = await directory.server(s.fromServer);
  if (!peer) return { ok: false, status: 401 };
  if (!verifyChatWire(s, Buffer.from(env.sigHex, "hex"), Buffer.from(peer.pubHex, "hex"))) return { ok: false, status: 401 };
  if (seen.size >= 8192) seen.delete(seen.keys().next().value!);
  seen.set(key, t);
  return { ok: true, peer, statement: s, body: env.body };
}
