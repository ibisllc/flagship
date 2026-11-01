/**
 * The phone's bare `<account>.<apex>` route on this relay (plan H3; decisions in
 * docs/architecture-v2/issuance-and-lease-records.md §4 "Phone routing", wire protocol in phone-route.md).
 *
 * A phone opens `/phone-tunnel` (phoneTunnel.ts), asks to begin, gets a session nonce and the ledger's next
 * generation, and signs a `route-claim/v1` for exactly those. The claim is checked here, the phone's key must be an
 * admin-root-granted admin device of the account (eligibility read from `.com`, re-verified here), and `.com`'s
 * ledger commits the generation by compare-and-set. Only then does the bare name route, and only to that session,
 * only while its lease is confirmed. Everything else closes: the bare name never falls back to a box.
 */
import { randomBytes } from "node:crypto";
import {
  checkRouteClaim,
  phoneHostname,
  phoneRouteEligibility,
  PHONE_ROUTE_CHALLENGE_TTL_MS,
  PHONE_ROUTE_CONFIRMED_MS,
  PHONE_ROUTE_ELIGIBILITY_RECHECK_MS,
  PHONE_ROUTE_HANDOVER_STREAM_MS,
  PHONE_ROUTE_LEASE_MS,
  PHONE_ROUTE_RENEW_MS,
  emptyPhoneRouteEntry,
  ledgerAcquire,
  ledgerRelease,
  ledgerRenew,
  liveEntry,
  type AdminGrantView,
  type LedgerResult,
  type PhoneRouteEntry,
  type PhoneRouteHolder,
  type RouteClaim,
} from "@flagship/protocol";
import type { RegisteredTunnel } from "./registry.js";

// ── the ledger (`.com`'s; an in-memory one for one relay and tests) ──────

export type LedgerOp =
  | { op: "acquire"; hostname: string; generation: number; holder: PhoneRouteHolder }
  | { op: "renew"; hostname: string; generation: number; sessionId: string }
  | { op: "release"; hostname: string; generation: number; sessionId: string };

/** Null from any call: `.com` could not be asked. */
export interface PhoneRouteLedgerClient {
  read(hostname: string): Promise<PhoneRouteEntry | null>;
  apply(op: LedgerOp): Promise<LedgerResult | null>;
}

/** The ledger kept in memory; `onAcquired` stands in for the feed's push to every relay. */
export class MemoryPhoneRouteLedger implements PhoneRouteLedgerClient {
  private readonly entries = new Map<string, PhoneRouteEntry>();
  private readonly listeners: Array<(hostname: string, generation: number) => void> = [];
  reachable = true;

  constructor(private readonly now: () => number = () => Date.now()) {}

  onAcquired(fn: (hostname: string, generation: number) => void): void {
    this.listeners.push(fn);
  }

  async read(hostname: string): Promise<PhoneRouteEntry | null> {
    if (!this.reachable) return null;
    return liveEntry(this.entries.get(hostname) ?? emptyPhoneRouteEntry(), this.now());
  }

  async apply(op: LedgerOp): Promise<LedgerResult | null> {
    if (!this.reachable) return null;
    const r = applyLedgerOp(this.entries.get(op.hostname) ?? emptyPhoneRouteEntry(), op, this.now());
    if (r.ok) this.entries.set(op.hostname, r.entry);
    if (r.ok && op.op === "acquire") for (const l of this.listeners) l(op.hostname, op.generation);
    return r;
  }
}

export function applyLedgerOp(e: PhoneRouteEntry, op: LedgerOp, now: number): LedgerResult {
  if (op.op === "acquire") return ledgerAcquire(e, op.generation, op.holder, now);
  if (op.op === "renew") return ledgerRenew(e, op.generation, op.sessionId, now);
  return ledgerRelease(e, op.generation, op.sessionId);
}

function parseEntry(v: unknown): PhoneRouteEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.generation !== "number" || !Number.isSafeInteger(o.generation) || typeof o.leaseUntil !== "number") return null;
  const h = o.holder as Record<string, unknown> | null;
  const holder =
    h && typeof h.relayId === "string" && typeof h.sessionId === "string" && typeof h.phoneRoutePub === "string"
      ? { relayId: h.relayId, sessionId: h.sessionId, phoneRoutePub: h.phoneRoutePub }
      : null;
  return { generation: o.generation, holder, leaseUntil: o.leaseUntil };
}

/** `.com`'s ledger (`/api/internal/phone-route/ledger`, the services control secret). */
export function comPhoneRouteLedger(opts: { comBaseUrl: string; secret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): PhoneRouteLedgerClient {
  const base = opts.comBaseUrl.replace(/\/+$/, "");
  const call = async (init: RequestInit, query = ""): Promise<Record<string, unknown> | null> => {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${base}/api/internal/phone-route/ledger${query}`, {
        ...init,
        headers: { authorization: `Bearer ${opts.secret}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    async read(hostname) {
      const b = await call({ method: "GET" }, `?hostname=${encodeURIComponent(hostname)}`);
      return b ? parseEntry(b.entry) : null;
    },
    async apply(op) {
      const b = await call({ method: "POST", body: JSON.stringify(op) });
      const entry = b ? parseEntry(b.entry) : null;
      if (!b || !entry) return null;
      if (b.ok === true) return { ok: true, entry, superseded: (b.superseded as PhoneRouteHolder | null) ?? null };
      const code = b.code;
      if (code !== "stale-generation" && code !== "not-holder" && code !== "expired" && code !== "malformed") return null;
      return { ok: false, code, entry };
    },
  };
}

// ── eligibility ──────────────────────────────────────────────────────────

export interface PhoneEligibilityRecord {
  adminRootPub: string | null;
  grants: AdminGrantView[];
}

/** Null: `.com` could not be asked. */
export type PhoneEligibilityFetch = (account: string) => Promise<PhoneEligibilityRecord | null>;

const HEX = /^[0-9a-f]*$/;

export function parsePhoneEligibility(body: unknown): PhoneEligibilityRecord | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  const adminRootPub = typeof o.adminRootPub === "string" && /^[0-9a-f]{64}$/.test(o.adminRootPub) ? o.adminRootPub : null;
  const grants: AdminGrantView[] = [];
  for (const raw of Array.isArray(o.grants) ? o.grants : []) {
    const g = raw as Record<string, unknown>;
    if (
      typeof g.grantId !== "string" || typeof g.username !== "string" || typeof g.deviceId !== "string" ||
      typeof g.devicePubHex !== "string" || !/^[0-9a-f]{64}$/.test(g.devicePubHex) || !Array.isArray(g.scopes) ||
      typeof g.issuedAt !== "number" || typeof g.expiresAt !== "number" || typeof g.signatureHex !== "string" || !HEX.test(g.signatureHex)
    ) continue;
    grants.push({
      grant: {
        grantId: g.grantId,
        username: g.username,
        deviceId: g.deviceId,
        devicePubKey: new Uint8Array(Buffer.from(g.devicePubHex, "hex")),
        scopes: g.scopes.filter((s): s is string => typeof s === "string") as AdminGrantView["grant"]["scopes"],
        issuedAt: g.issuedAt,
        expiresAt: g.expiresAt,
      },
      signatureHex: g.signatureHex,
      signerRoot: g.signerRoot === "admin-root" ? "admin-root" : "membership",
      revokedAt: typeof g.revokedAt === "number" ? g.revokedAt : null,
    });
  }
  return { adminRootPub, grants };
}

/** `.com`'s eligibility read (`/api/internal/phone-route/:u/eligibility`, the services control secret). */
export function comPhoneEligibility(opts: { comBaseUrl: string; secret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): PhoneEligibilityFetch {
  const base = opts.comBaseUrl.replace(/\/+$/, "");
  return async (account) => {
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${base}/api/internal/phone-route/${encodeURIComponent(account)}/eligibility`, {
        headers: { authorization: `Bearer ${opts.secret}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
      if (res.status === 404) return { adminRootPub: null, grants: [] };
      if (!res.ok) return null;
      return parsePhoneEligibility(await res.json());
    } catch {
      return null;
    }
  };
}

// ── sessions ─────────────────────────────────────────────────────────────

/** What phoneTunnel.ts gives each session. */
export interface PhoneSessionHandle {
  /** A JSON control message to the phone. */
  send(msg: Record<string, unknown>): void;
  /** The stream side the SNI router pipes visitors into. */
  readonly tunnel: RegisteredTunnel;
  streamCount(): number;
  /** End every open visitor stream. */
  closeStreams(): void;
  close(code: number, reason: string): void;
}

export type PhoneRouteRefusal =
  | "malformed"
  | "busy"
  | "no-challenge"
  | "unavailable"
  | "not-eligible"
  | "stale-generation"
  | "not-holder"
  | "expired"
  | import("@flagship/protocol").RouteClaimRefusal;

export type PhoneRouteLoss = "superseded" | "expired" | "revoked" | "contact" | "released";

const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class PhoneSession {
  readonly id = randomBytes(16).toString("hex");
  offer: { account: string; hostname: string; nonce: string; generation: number; expiresAt: number } | null = null;
  held: { account: string; hostname: string; generation: number; phoneRoutePub: string; confirmedAt: number } | null = null;
  /** When it lost the route it held (it may keep finishing its open streams until the handover deadline). */
  lostAt: number | null = null;
  eligibleUntil = 0;
  closed = false;
  timers: unknown[] = [];

  constructor(readonly handle: PhoneSessionHandle) {}
}

export interface PhoneRoutesOptions {
  relayId: string;
  apex: string;
  ledger: PhoneRouteLedgerClient;
  eligibility: PhoneEligibilityFetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  setRepeat?: (fn: () => void, ms: number) => unknown;
  clearRepeat?: (t: unknown) => void;
  renewMs?: number;
  confirmedMs?: number;
  recheckMs?: number;
  handoverStreamMs?: number;
  /** Visitor streams one phone may have open at once. */
  maxStreams?: number;
  log?: (m: string) => void;
}

export interface PhoneRoutesStats {
  sessions: number;
  holding: number;
  refused: Record<string, number>;
  lost: Record<string, number>;
}

/** The phone sessions on this relay and which one (if any) the bare name of each account routes to. */
export class PhoneRoutes {
  private readonly sessions = new Set<PhoneSession>();
  private readonly holders = new Map<string, PhoneSession>();
  private readonly refused: Record<string, number> = {};
  private readonly lost: Record<string, number> = {};
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly setRepeat: (fn: () => void, ms: number) => unknown;
  private readonly clearRepeat: (t: unknown) => void;
  private readonly log: (m: string) => void;
  readonly apex: string;

  constructor(private readonly opts: PhoneRoutesOptions) {
    this.apex = opts.apex.toLowerCase();
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.setRepeat = opts.setRepeat ?? ((fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearRepeat = opts.clearRepeat ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
    this.log = opts.log ?? (() => {});
  }

  get relayId(): string {
    return this.opts.relayId;
  }

  attach(handle: PhoneSessionHandle): PhoneSession {
    const s = new PhoneSession(handle);
    this.sessions.add(s);
    return s;
  }

  /** The phone tunnel closed: give the route up (best effort) and forget the session. */
  detach(s: PhoneSession): void {
    if (s.closed) return;
    s.closed = true;
    this.clearTimers(s);
    this.sessions.delete(s);
    if (s.held && this.holders.get(s.held.hostname) === s) {
      this.holders.delete(s.held.hostname);
      void this.opts.ledger.apply({ op: "release", hostname: s.held.hostname, generation: s.held.generation, sessionId: s.id });
    }
  }

  /**
   * The SNI router's question for a bare name: the local session that holds it, if its lease is confirmed and it is
   * still eligible. Undefined closes the visitor.
   */
  tunnelFor(hostname: string): RegisteredTunnel | undefined {
    const s = this.holders.get(hostname.toLowerCase());
    if (!s || s.closed || !s.held || s.lostAt !== null) return undefined;
    const now = this.now();
    if (now - s.held.confirmedAt >= (this.opts.confirmedMs ?? PHONE_ROUTE_CONFIRMED_MS)) return undefined;
    if (s.eligibleUntil <= now) return undefined;
    if (s.handle.streamCount() >= (this.opts.maxStreams ?? 64)) return undefined;
    return s.handle.tunnel;
  }

  /** Step 1: the phone names its account; it gets a nonce for this session and the next generation. */
  async begin(s: PhoneSession, account: unknown): Promise<void> {
    if (typeof account !== "string" || !ACCOUNT.test(account)) return this.refuse(s, "malformed");
    const hostname = phoneHostname(account, this.apex);
    const entry = await this.opts.ledger.read(hostname);
    if (s.closed) return;
    if (!entry) return this.refuse(s, "unavailable");
    const now = this.now();
    s.offer = {
      account,
      hostname,
      nonce: randomBytes(16).toString("hex"),
      generation: entry.generation + 1,
      expiresAt: now + PHONE_ROUTE_CHALLENGE_TTL_MS,
    };
    s.handle.send({ type: "challenge", account, hostname, generation: s.offer.generation, sessionNonce: s.offer.nonce, serverTime: now, expiresAt: s.offer.expiresAt });
  }

  /** Step 2: the signed claim. Checked, eligibility verified, then committed in the ledger. */
  async claim(s: PhoneSession, claim: unknown, signature: unknown): Promise<void> {
    const offer = s.offer;
    // Single use, whatever the outcome.
    s.offer = null;
    const now = this.now();
    if (!offer || offer.expiresAt <= now) return this.refuse(s, "no-challenge");
    if (typeof claim !== "object" || claim === null || typeof signature !== "string") return this.refuse(s, "malformed");
    const c = claim as RouteClaim;
    const checked = checkRouteClaim({ claim: c, signature, apex: this.apex, account: offer.account, sessionNonce: offer.nonce, generation: offer.generation, now });
    if (!checked.ok) return this.refuse(s, checked.code);
    const elig = await this.eligible(offer.account, c.phoneRoutePub);
    if (s.closed) return;
    if (elig === null) return this.refuse(s, "unavailable");
    if (!elig.ok) return this.refuse(s, "not-eligible");
    const r = await this.opts.ledger.apply({
      op: "acquire",
      hostname: offer.hostname,
      generation: offer.generation,
      holder: { relayId: this.opts.relayId, sessionId: s.id, phoneRoutePub: c.phoneRoutePub },
    });
    if (s.closed) {
      if (r?.ok) void this.opts.ledger.apply({ op: "release", hostname: offer.hostname, generation: offer.generation, sessionId: s.id });
      return;
    }
    if (!r) return this.refuse(s, "unavailable");
    if (!r.ok) return this.refuse(s, r.code === "malformed" ? "malformed" : r.code === "stale-generation" ? "stale-generation" : r.code);
    const prev = this.holders.get(offer.hostname);
    if (prev && prev !== s) this.lose(prev, "superseded");
    // A session that already held the route (an earlier generation) holds it again under the new one.
    this.clearTimers(s);
    s.held = { account: offer.account, hostname: offer.hostname, generation: offer.generation, phoneRoutePub: c.phoneRoutePub, confirmedAt: now };
    s.lostAt = null;
    s.eligibleUntil = elig.expiresAt;
    this.holders.set(offer.hostname, s);
    s.timers.push({ repeat: this.setRepeat(() => void this.renew(s), this.opts.renewMs ?? PHONE_ROUTE_RENEW_MS) });
    s.timers.push({ repeat: this.setRepeat(() => void this.recheck(s), this.opts.recheckMs ?? PHONE_ROUTE_ELIGIBILITY_RECHECK_MS) });
    s.timers.push({ once: this.setTimer(() => void this.recheck(s), Math.max(0, Math.min(elig.expiresAt - now, 2 ** 31 - 1))) });
    this.log(`[phone-route] ${offer.hostname}: held by session ${s.id.slice(0, 8)} at generation ${offer.generation}`);
    s.handle.send({ type: "granted", hostname: offer.hostname, generation: offer.generation, leaseMs: PHONE_ROUTE_LEASE_MS });
  }

  /** The phone leaves the foreground: it gives the route up; its tunnel closes next. */
  async release(s: PhoneSession): Promise<void> {
    const h = s.held;
    if (!h || this.holders.get(h.hostname) !== s) return;
    this.lose(s, "released");
    await this.opts.ledger.apply({ op: "release", hostname: h.hostname, generation: h.generation, sessionId: s.id });
  }

  /** Renew every held route now (the timer's work; tests call it directly). */
  async renewAll(): Promise<void> {
    await Promise.all([...this.holders.values()].map((s) => this.renew(s)));
  }

  async renew(s: PhoneSession): Promise<void> {
    const h = s.held;
    if (!h || s.closed || this.holders.get(h.hostname) !== s) return;
    const r = await this.opts.ledger.apply({ op: "renew", hostname: h.hostname, generation: h.generation, sessionId: s.id });
    if (s.closed || this.holders.get(h.hostname) !== s || s.held !== h) return;
    const now = this.now();
    if (r?.ok) {
      h.confirmedAt = now;
      return;
    }
    if (r) return this.lose(s, r.code === "expired" ? "expired" : "superseded");
    // `.com` unreachable: routing already stopped at the confirmed window; past the lease the route is gone.
    if (now - h.confirmedAt >= PHONE_ROUTE_LEASE_MS) this.lose(s, "contact");
  }

  /** The feed says the ledger committed `generation` for `hostname` (on any relay). */
  pushed(hostname: string, generation: number): void {
    const s = this.holders.get(hostname.toLowerCase());
    if (s?.held && s.held.generation < generation) this.lose(s, "superseded");
  }

  /** The feed says a device or admin grant of `username` changed: re-check every route of the account now. */
  eligibilityChanged(username: string): Promise<void> {
    const u = username.toLowerCase();
    return Promise.all([...this.holders.values()].filter((s) => s.held?.account === u).map((s) => this.recheck(s))).then(() => undefined);
  }

  /** The feed came back: anything pushed while it was away was missed, so confirm every held route now. */
  async resync(): Promise<void> {
    await this.renewAll();
    await Promise.all([...this.holders.values()].map((s) => this.recheck(s)));
  }

  async recheck(s: PhoneSession): Promise<void> {
    const h = s.held;
    if (!h || s.closed) return;
    const elig = await this.eligible(h.account, h.phoneRoutePub);
    if (s.closed || s.held !== h) return;
    if (elig === null) return;
    if (elig.ok) {
      s.eligibleUntil = elig.expiresAt;
      return;
    }
    this.revoke(s);
  }

  stats(): PhoneRoutesStats {
    return { sessions: this.sessions.size, holding: this.holders.size, refused: { ...this.refused }, lost: { ...this.lost } };
  }

  private async eligible(account: string, phoneRoutePub: string): Promise<{ ok: true; expiresAt: number } | { ok: false } | null> {
    const rec = await this.opts.eligibility(account);
    if (!rec) return null;
    return phoneRouteEligibility(phoneRoutePub, account, rec.adminRootPub, rec.grants, this.now());
  }

  /** No longer eligible: give up the route, end its streams within 5 s, close its tunnel. */
  private revoke(s: PhoneSession): void {
    const h = s.held;
    this.lose(s, "revoked");
    s.handle.closeStreams();
    if (h) void this.opts.ledger.apply({ op: "release", hostname: h.hostname, generation: h.generation, sessionId: s.id });
    s.handle.close(4403, "not-eligible");
  }

  private lose(s: PhoneSession, reason: PhoneRouteLoss): void {
    const h = s.held;
    if (!h || s.lostAt !== null) return;
    s.lostAt = this.now();
    if (this.holders.get(h.hostname) === s) this.holders.delete(h.hostname);
    this.clearTimers(s);
    this.lost[reason] = (this.lost[reason] ?? 0) + 1;
    this.log(`[phone-route] ${h.hostname}: session ${s.id.slice(0, 8)} lost the route (${reason})`);
    s.handle.send({ type: "lost", hostname: h.hostname, generation: h.generation, reason });
    // Streams it already has stay until they end, at most the handover deadline.
    s.timers.push({ once: this.setTimer(() => s.handle.closeStreams(), this.opts.handoverStreamMs ?? PHONE_ROUTE_HANDOVER_STREAM_MS) });
  }

  private refuse(s: PhoneSession, code: PhoneRouteRefusal): void {
    this.refused[code] = (this.refused[code] ?? 0) + 1;
    if (!s.closed) s.handle.send({ type: "refused", code });
  }

  private clearTimers(s: PhoneSession): void {
    for (const t of s.timers as Array<{ repeat?: unknown; once?: unknown }>) {
      if (t.repeat !== undefined) this.clearRepeat(t.repeat);
      if (t.once !== undefined) this.clearTimer(t.once);
    }
    s.timers = [];
  }
}
