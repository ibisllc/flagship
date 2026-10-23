/**
 * The carrier between harnesses of different owners (SECURITY-HARDENING-PLAN.md 17.5-17.6).
 *
 * A frame is addressed to an app, never to a server: it goes to the app's canonical name on the
 * target owner's account (`<label>.<user>.<apex>`, the label from `deriveUrlFragment`: `slug` for
 * the author's own account, `slug--author` elsewhere), and the relay hands it to whichever of that
 * owner's boxes holds the name. Which box that is stays the owner's own business (their server
 * order decides it); nobody, `.com` included, is asked.
 *
 * Outbound: the JSON frame is hashed and sent under a statement the sending box signs with its
 * server key (`flagship/chat-wire/v1`), naming the app host it is for. Inbound (an app gate on that
 * app's own host): the statement must name this app's canonical host on this account, be recent,
 * name the body that arrived and not have been seen before; the sender's registered key comes from
 * `.com`'s public server registry. Only then is the frame handed to the harness, keyed by the
 * sending ACCOUNT, since any of that owner's boxes may hold their app's name. Every authenticated
 * frame is answered the same way, so a sender learns nothing about listeners, approvals or apps.
 */
import { createHash, randomBytes } from "node:crypto";
import { chatWireBodySha256, chatWireFresh, composeServiceId, deriveUrlFragment, signChatWire, verifyChatWire, type ChatWirePurpose, type ChatWireStatement } from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { ChatProof } from "./admission.js";
import type { ChatTransport, WireFrame } from "./harness.js";
import type { ChatPeerDirectory } from "./peerDirectory.js";
import { MAX_BODY_BYTES, type AppIdentity } from "./types.js";

const J = { "content-type": "application/json" } as const;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const ID = /^[A-Za-z0-9_-]{16,80}$/;
/** A frame is a message body plus a small envelope. */
export const MAX_WIRE_BYTES = MAX_BODY_BYTES + 16 * 1024;
/** Served by the box on every app's own host, ahead of the app. */
export const CHAT_WIRE_PATH = "/__flagship/chat/wire";

/** The app's canonical, leader-routed name on `user`'s account. */
export function chatAppHost(app: AppIdentity, user: string, apex: string): string {
  return `${deriveUrlFragment(composeServiceId(app.author, app.slug), user)}.${user}.${apex}`.toLowerCase();
}

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
  /** This server's FQDN: the statement's `fromServer`, which the receiver looks up. */
  self: string;
  /** The account this box belongs to; frames to it never leave the box. */
  account: string;
  apex: string;
  /** Signs with the server identity key (the custodian's signAsBox). */
  sign: (msg: Uint8Array) => Uint8Array;
  fetchImpl?: typeof fetch;
  baseUrl?: (host: string) => string;
  now?: () => number;
}

export class ChatWireTransport implements ChatTransport {
  /** `<peer account>|<wireId>` -> the peer app's host, from our own starts and authenticated incoming ones. */
  private readonly routes = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: (h: string) => string;

  constructor(private readonly o: WireSenderOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? (() => Date.now());
    this.baseUrl = o.baseUrl ?? ((h) => `https://${h}`);
  }

  get apex(): string {
    return this.o.apex;
  }

  /** Where replies on `wireId` go. A route once set is never moved by a later frame. */
  noteRoute(peerKey: string, wireId: string, host: string): void {
    const k = `${peerKey}|${wireId}`;
    if (this.routes.has(k)) return;
    if (this.routes.size >= 4096) this.routes.delete(this.routes.keys().next().value!);
    this.routes.set(k, host.toLowerCase());
  }

  async sendToLead(target: { author: string; slug: string; targetUser: string }, frame: WireFrame): Promise<{ peerKey: string }> {
    const peerKey = target.targetUser.toLowerCase();
    if (peerKey === this.o.account.toLowerCase()) throw new Error("own account");
    const host = chatAppHost(target, peerKey, this.o.apex);
    this.noteRoute(peerKey, frame.wireId, host);
    await this.post(host, "frame", JSON.stringify(frame));
    return { peerKey };
  }

  async sendOnRoute(peerKey: string, frame: WireFrame): Promise<void> {
    const host = this.routes.get(`${peerKey}|${frame.wireId}`);
    if (!host) throw new Error("unknown route");
    await this.post(host, "frame", JSON.stringify(frame));
  }

  async post(to: string, purpose: ChatWirePurpose, body: string): Promise<Response> {
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
    const r = await this.fetchImpl(`${this.baseUrl(to)}${CHAT_WIRE_PATH}`, { method: "POST", headers: J, body: JSON.stringify(envelope), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`peer answered ${r.status}`);
    return r;
  }
}

export interface WireReceiverOptions {
  account: string;
  directory: ChatPeerDirectory;
  transport: ChatWireTransport;
  /** The app an SNI-selected service id names, or null. */
  appOf: (serviceRef: string) => AppIdentity | null;
  /** Hand an authenticated frame to the harness, with the app whose host it arrived on. */
  deliver: (frame: WireFrame, peerKey: string, via: AppIdentity) => Promise<void>;
  now?: () => number;
  /** Frames a single sending account may send per minute. */
  perPeerPerMinute?: number;
}

/** `POST /__flagship/chat/wire` on an app's own host: an app gate, ahead of the app and its access rules. */
export function buildWireReceiver(o: WireReceiverOptions) {
  const now = o.now ?? (() => Date.now());
  const seen = new Map<string, number>();
  const buckets = new Map<string, { start: number; n: number }>();
  const cap = o.perPeerPerMinute ?? 240;
  const account = o.account.toLowerCase();

  return async function handle(req: HttpRequest, appServiceRef: string | null): Promise<HttpResponse | null> {
    if (req.path.split("?")[0] !== CHAT_WIRE_PATH) return null;
    const app = appServiceRef ? o.appOf(appServiceRef) : null;
    if (!app) return { status: 404, headers: J, body: JSON.stringify({ error: "not found" }) };
    if (req.method !== "POST") return { status: 405, headers: J, body: JSON.stringify({ error: "method not allowed" }) };
    const env = await authenticatePeer(req, "frame", chatAppHost(app, account, o.transport.apex), o.directory, now, seen);
    if (!env.ok) return { status: env.status, headers: J, body: JSON.stringify({ error: "refused" }) };
    const peerKey = env.peer.username.toLowerCase();
    // Messages among one owner's own deployments never cross the wire.
    if (peerKey === account) return { status: 401, headers: J, body: JSON.stringify({ error: "refused" }) };
    const t = now();
    const b = buckets.get(peerKey) ?? { start: t, n: 0 };
    if (t - b.start > 60_000) { b.start = t; b.n = 0; }
    b.n++;
    if (buckets.size >= 2048) buckets.delete(buckets.keys().next().value!);
    buckets.set(peerKey, b);
    if (b.n > cap) return { status: 429, headers: J, body: JSON.stringify({ error: "slow down" }) };
    const frame = parseWireFrame(env.body);
    if (frame) {
      if (frame.kind === "start" && frame.claimedSender) o.transport.noteRoute(peerKey, frame.wireId, chatAppHost(frame.claimedSender, peerKey, o.transport.apex));
      await o.deliver(frame, peerKey, app).catch(() => {});
    }
    // Every authenticated frame gets this answer, whatever became of it.
    return { status: 200, headers: J, body: JSON.stringify({ ok: true }) };
  };
}

export type PeerAuth =
  | { ok: true; peer: { pubHex: string; username: string }; statement: ChatWireStatement; body: string }
  | { ok: false; status: 400 | 401 | 413 };

/** Addressed to `expectedTo`, fresh, unique, and signed by the sending server's registered key. */
export async function authenticatePeer(
  req: HttpRequest,
  purpose: ChatWirePurpose,
  expectedTo: string,
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
    if (!chatWireFresh(s, expectedTo, bodyBytes, t)) return { ok: false, status: 401 };
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
