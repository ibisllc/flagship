/**
 * Architecture v2 milestone 4 (docs/architecture-v2/pq-suites.md §13): the PQ-authenticated
 * channel on the box.
 *
 *   POST /api/pq-session/hello    { hello }               → { handshake, accept }
 *   POST /api/pq-session/finish   { handshake, finish }   → { session, expiresAt }
 *   POST /api/pq-session/call     { session, record }     → { record }
 *
 * A record carries one inner HTTP request; the box runs it through its own handler chain, marked
 * as having arrived over the channel (`channelOf`), and seals the answer under the request's
 * number. Phones (role `device`, keys from the device book) and the account's other servers
 * (role `box-stk`, keys pinned per sibling) may open a session; the box answers with its STK's
 * hybrid key through keyd.
 *
 * While the installation's strict profile is in force, `pqStrictGuard` refuses a request that
 * carries a paired-session token or goes box to box (`/api/access-sync/`) unless it came over the
 * channel, so a forged WebPKI certificate or a classical-only peer reaches nothing private. A
 * browser session passes only when the owner said browsers may still reach the server.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PqSessionError,
  acceptPqSession,
  completePqSession,
  decodeInnerRequest,
  decodeInnerResponse,
  encodeInner,
  finishPqSession,
  startPqSession,
  verifyPqKeyBinding,
  type PqSessionChannel,
  type PqSessionIdentity,
  type PqSessionInitiatorLookup,
  type PqSessionInitiatorRole,
  type PqSessionResponderPending,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";
import { extractPairedSessionToken } from "./pairedSessionStore.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const MAX_PENDING = 256;
const MAX_SESSIONS = 2048;
const PENDING_MS = 60_000;
const MAX_INNER_RESPONSE = 16 * 1024 * 1024 - 64 * 1024;
const DROP_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "keep-alive"]);

export interface ChannelPeer {
  role: PqSessionInitiatorRole;
  subject: string;
  keyIdHex: string;
  sessionIdHex: string;
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

const refuse = (status: number, code: string, error: string): HttpResponse => json(status, { error, code });

export interface PqChannelServerOptions {
  /** This box's verified STK binding and its hybrid signer (keyd), or null before it is bound. */
  self: () => PqSessionIdentity | null;
  lookup: PqSessionInitiatorLookup;
  /** The box's own handler chain. */
  dispatch: (req: HttpRequest) => Promise<HttpResponse>;
  now?: () => number;
  log?: (m: string) => void;
}

export class PqChannelServer {
  private readonly pending = new Map<string, PqSessionResponderPending>();
  private readonly sessions = new Map<string, PqSessionChannel>();
  private readonly via = new WeakMap<HttpRequest, ChannelPeer>();
  private readonly now: () => number;

  constructor(private readonly opts: PqChannelServerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The peer a request came from over the channel, or null when it came any other way. */
  channelOf(req: HttpRequest): ChannelPeer | null {
    return this.via.get(req) ?? null;
  }

  /** Forget every session (the box's key or policy changed). */
  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    this.pending.clear();
  }

  async handle(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;
    if (!path.startsWith("/api/pq-session/")) return null;
    if (req.method !== "POST") return refuse(405, "method", "use POST");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("shape");
    } catch {
      return refuse(400, "session-malformed", "the body is not a JSON object");
    }
    try {
      if (path === "/api/pq-session/hello") return await this.hello(body);
      if (path === "/api/pq-session/finish") return this.finish(body);
      if (path === "/api/pq-session/call") return await this.call(body);
    } catch (e) {
      if (e instanceof PqSessionError) {
        const status = e.code === "unknown-initiator" || e.code === "responder-mismatch" ? 403 : e.code === "session-expired" ? 410 : 400;
        return refuse(status, e.code, `the quantum-safe session was refused (${e.code})`);
      }
      throw e;
    }
    return refuse(404, "not-found", "no such session endpoint");
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, p] of this.pending) if (now - p.createdAt > PENDING_MS || !p.prk) this.pending.delete(k);
    for (const [k, s] of this.sessions) if (s.expired(now)) this.sessions.delete(k);
  }

  private async hello(body: Record<string, unknown>): Promise<HttpResponse> {
    const self = this.opts.self();
    if (!self) return refuse(503, "not-ready", "this server has no bound PQ key yet");
    this.sweep();
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const { accept, pending } = await acceptPqSession({ hello: body.hello, identity: self, lookupInitiator: this.opts.lookup, now: this.now() });
    const handshake = randomBytes(16).toString("hex");
    this.pending.set(handshake, pending);
    return json(200, { handshake, accept });
  }

  private finish(body: Record<string, unknown>): HttpResponse {
    const id = typeof body.handshake === "string" ? body.handshake : "";
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p) return refuse(410, "session-expired", "that handshake is unknown or already used");
    const ch = completePqSession(p, body.finish, this.now());
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(ch.sessionIdHex, ch);
    this.opts.log?.(`[pq-session] ${ch.peer.role} ${ch.peerSubject.slice(0, 24)} opened a session`);
    return json(200, { session: ch.sessionIdHex });
  }

  private async call(body: Record<string, unknown>): Promise<HttpResponse> {
    const ch = typeof body.session === "string" ? this.sessions.get(body.session) : undefined;
    if (!ch) return refuse(410, "session-expired", "open a new quantum-safe session");
    if (typeof body.record !== "string") return refuse(400, "session-malformed", "no record");
    const { seq, plaintext } = ch.openRequest(Buffer.from(body.record, "base64"), this.now());
    const inner = decodeInnerRequest(plaintext);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(inner.headers)) if (!DROP_HEADERS.has(k) && !k.startsWith("x-flagship-pq")) headers[k] = v;
    const req: HttpRequest = { method: inner.method, path: inner.path, headers, body: Buffer.from(inner.body, "base64") };
    this.via.set(req, { role: ch.peer.role as PqSessionInitiatorRole, subject: ch.peerSubject, keyIdHex: ch.peer.keyIdHex, sessionIdHex: ch.sessionIdHex });
    const res = await this.opts.dispatch(req);
    const out = await innerBody(res);
    const answer = out.length > MAX_INNER_RESPONSE
      ? { status: 413, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "the answer is too large for one quantum-safe record", code: "record-too-large" })).toString("base64") }
      : { status: res.status, headers: res.headers ?? {}, body: out.toString("base64") };
    return json(200, { record: Buffer.from(ch.sealResponse(seq, encodeInner(answer))).toString("base64") });
  }
}

async function innerBody(res: HttpResponse): Promise<Buffer> {
  if (!res.stream) return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
  if (res.stream.length > MAX_INNER_RESPONSE) return Buffer.alloc(MAX_INNER_RESPONSE + 1);
  const parts: Buffer[] = [];
  for await (const c of res.stream.open() as AsyncIterable<Buffer | string>) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(parts);
}

/**
 * Strict scopes take private requests over the channel only. `browsersAllowed` is the owner's
 * answer, recorded in the signed change to strict ("browser-without-pq-authentication").
 */
export function pqStrictGuard(opts: {
  strict: () => boolean;
  browsersAllowed: () => boolean;
  channelOf: (req: HttpRequest) => ChannelPeer | null;
}): (req: HttpRequest) => Promise<HttpResponse | null> {
  return async (req) => {
    if (!opts.strict()) return null;
    const path = req.path.split("?")[0]!;
    if (path.startsWith("/api/pq-session/")) return null;
    const peer = opts.channelOf(req);
    if (path.startsWith("/api/access-sync/")) {
      return peer?.role === "box-stk" ? null : refuse(403, "pq-channel-required", "This server only accepts quantum-safe connections from the account's other servers.");
    }
    if (!extractPairedSessionToken(req)) return null;
    if (peer?.role === "device") return null;
    if (!peer && opts.browsersAllowed()) return null;
    return refuse(403, "pq-channel-required", "This server only accepts quantum-safe connections. Use the Flagship app on your phone.");
  };
}

/**
 * The account's other servers' PQ keys, pinned on first sight: `.com` serves each server's
 * `box-stk` binding, which must verify under the STK `/pods` names, and the first ML-DSA key per
 * STK wins (a later one is a key change and is refused), so `.com` cannot swap it.
 */
export class SiblingPqPins {
  private pins = new Map<string, { stk: string; mldsa: string; issuedAt: number }>();
  private verified = new Map<string, VerifiedPqKeyBinding>();

  constructor(
    private readonly opts: {
      path: string;
      fetchBinding: (domain: string) => Promise<unknown>;
      now?: () => number;
      log?: (m: string) => void;
    },
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.opts.path, "utf8")) as Record<string, { stk: string; mldsa: string; issuedAt: number }>;
      for (const [d, p] of Object.entries(raw)) if (p && typeof p.stk === "string" && typeof p.mldsa === "string") this.pins.set(d, p);
    } catch {
      /* nothing pinned yet */
    }
  }

  /** The sibling's verified binding under `stkHex`, fetching and pinning it the first time. */
  async bindingFor(domain: string, stkHex: string): Promise<VerifiedPqKeyBinding | null> {
    const d = domain.toLowerCase();
    const stk = stkHex.toLowerCase();
    const cached = this.verified.get(d);
    if (cached && cached.ed25519PubHex === stk) return cached;
    const pin = this.pins.get(d);
    if (pin && pin.stk !== stk) return null;
    let wire: unknown;
    try {
      wire = await this.opts.fetchBinding(d);
    } catch {
      return null;
    }
    try {
      const b = verifyPqKeyBinding(wire, {
        role: "box-stk",
        subjectId: d,
        ed25519PubHex: stk,
        mldsaPubHex: pin?.mldsa ?? null,
        now: (this.opts.now ?? Date.now)(),
        ...(pin ? { minIssuedAt: pin.issuedAt } : {}),
      });
      this.verified.set(d, b);
      if (!pin) {
        this.pins.set(d, { stk, mldsa: b.mldsaPubHex, issuedAt: b.issuedAt });
        await writeFileDurable(this.opts.path, JSON.stringify(Object.fromEntries(this.pins)));
      }
      return b;
    } catch (e) {
      this.opts.log?.(`[pq-session] ${d}: its PQ binding does not verify (${(e as { code?: string }).code ?? "error"})`);
      return null;
    }
  }

  /** For the session lookup: a sibling whose binding this box already verified. */
  known(subject: string, keyIdHex: string): VerifiedPqKeyBinding | null {
    const b = this.verified.get(subject.toLowerCase());
    return b && b.keyIdHex === keyIdHex ? b : null;
  }
}

/**
 * A fetch that carries each request over a PQ session to the target box (box to box). The
 * session is opened once per host and reopened when the box forgets it.
 */
export function pqSessionFetch(opts: {
  identity: () => PqSessionIdentity | null;
  /** The target box's verified STK binding, or null (then the request is refused, never sent in the clear). */
  responder: (host: string) => Promise<VerifiedPqKeyBinding | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): typeof fetch {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const open = new Map<string, { ch: PqSessionChannel; id: string }>();

  async function connect(origin: string, host: string): Promise<{ ch: PqSessionChannel; id: string }> {
    const identity = opts.identity();
    const responder = await opts.responder(host);
    if (!identity || !responder) throw new PqSessionError("unknown-initiator");
    const st = startPqSession({ responder: host, responderBinding: responder, initiatorRole: "box-stk", identity, now: now() });
    const h = await f(`${origin}/api/pq-session/hello`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: st.hello }) });
    if (!h.ok) throw new PqSessionError("unknown-initiator");
    const hb = (await h.json()) as { handshake: string; accept: unknown };
    const { finish, session } = await finishPqSession(st, hb.accept, now());
    const fr = await f(`${origin}/api/pq-session/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handshake: hb.handshake, finish }) });
    if (!fr.ok) throw new PqSessionError("confirm-failed");
    const fb = (await fr.json()) as { session: string };
    if (fb.session !== session.sessionIdHex) throw new PqSessionError("confirm-failed");
    const s = { ch: session, id: fb.session };
    open.set(host, s);
    return s;
  }

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const host = url.hostname.toLowerCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const raw = init?.body === undefined || init.body === null ? Buffer.alloc(0) : Buffer.from(typeof init.body === "string" ? init.body : new Uint8Array(await new Response(init.body).arrayBuffer()));
    const inner = encodeInner({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname + url.search, headers, body: raw.toString("base64") });
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = open.get(host) ?? (await connect(url.origin, host));
      const { seq, record } = s.ch.sealRequest(inner, now());
      const r = await f(`${url.origin}/api/pq-session/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: s.id, record: Buffer.from(record).toString("base64") }) });
      if (r.status === 410) {
        open.delete(host);
        continue;
      }
      if (!r.ok) return r;
      const body = (await r.json()) as { record: string };
      const ans = decodeInnerResponse(s.ch.openResponse(seq, Buffer.from(body.record, "base64")));
      return new Response(ans.status === 204 || ans.status === 304 ? null : Buffer.from(ans.body, "base64"), { status: ans.status, headers: ans.headers });
    }
    throw new PqSessionError("session-expired");
  }) as typeof fetch;
}
