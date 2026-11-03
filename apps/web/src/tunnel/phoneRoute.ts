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
  PHONE_ROUTE_STANDBY_POLL_MS,
  checkRouteRelease,
  PHONE_ROUTE_LEASE_MS,
  PHONE_ROUTE_RENEW_MS,
  PHONE_BEGIN_BURST,
  PHONE_BEGIN_PER_MINUTE,
  PHONE_ELIGIBILITY_CACHE_MS,
  PHONE_LEDGER_READ_CACHE_MS,
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
  type RouteRelease,
} from "@flagship/protocol";
import type { RegisteredTunnel } from "./registry.js";

// ── the ledger (`.com`'s; an in-memory one for one relay and tests) ──────

export type LedgerOp =
  | { op: "acquire"; hostname: string; generation: number; holder: PhoneRouteHolder; claim?: RouteClaim; claimSignature?: string }
  | { op: "renew"; hostname: string; generation: number; sessionId: string }
  | { op: "release"; hostname: string; generation: number; sessionId: string };

/** Null from any call: `.com` could not be asked. */
export interface PhoneRouteLedgerClient {
  read(hostname: string): Promise<PhoneRouteEntry | null>;
  apply(op: LedgerOp): Promise<LedgerResult | null>;
}

/** The ledger kept in memory; `onChange` stands in for the feed's push to every relay (acquired or vacated). */
export class MemoryPhoneRouteLedger implements PhoneRouteLedgerClient {
  private readonly entries = new Map<string, PhoneRouteEntry>();
  private readonly listeners: Array<(hostname: string, generation: number, vacant: boolean) => void> = [];
  reachable = true;

  constructor(private readonly now: () => number = () => Date.now()) {}

  onChange(fn: (hostname: string, generation: number, vacant: boolean) => void): void {
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
    if (r.ok && op.op !== "renew") for (const l of this.listeners) l(op.hostname, op.generation, op.op === "release");
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
      const wire = op.op === "acquire" ? { op: op.op, hostname: op.hostname, generation: op.generation, holder: op.holder } : op;
      const b = await call({ method: "POST", body: JSON.stringify(wire) });
      const entry = b ? parseEntry(b.entry) : null;
      if (!b || !entry) return null;
      if (b.ok === true) return { ok: true, entry };
      const code = b.code;
      if (code !== "route-held" && code !== "stale-generation" && code !== "not-holder" && code !== "expired" && code !== "malformed") return null;
      return { ok: false, code, entry };
    },
  };
}

// ── eligibility ──────────────────────────────────────────────────────────

export interface PhoneEligibilityRecord {
  adminRootPub: string | null;
  grants: AdminGrantView[];
}

/**
 * Null: `.com` could not be asked. `presented` is the grant chain the phone sent in `begin` (relay mesh, relay-mesh.md
 * §8.2: a mesh relay checks the phone's own grants against the log instead of asking `.com`); `.com`'s fetch ignores it.
 */
export type PhoneEligibilityFetch = ((account: string, presented?: unknown) => Promise<PhoneEligibilityRecord | null>) & {
  /** Drop any cached answer (a revocation push names the account, or none: every account). */
  forget?: (account?: string) => void;
};

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

/**
 * `.com`'s eligibility read (`/api/internal/phone-route/:u/eligibility`, the services control secret). A successful
 * answer is reused for `PHONE_ELIGIBILITY_CACHE_MS` per account (security review 2026-11-02, M4: one D1 read per grant
 * on `.com` for every `begin`); a revocation push forgets it.
 */
export function comPhoneEligibility(opts: { comBaseUrl: string; secret: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number; cacheMs?: number }): PhoneEligibilityFetch {
  const base = opts.comBaseUrl.replace(/\/+$/, "");
  const now = opts.now ?? (() => Date.now());
  const cacheMs = opts.cacheMs ?? PHONE_ELIGIBILITY_CACHE_MS;
  const cache = new Map<string, { at: number; rec: PhoneEligibilityRecord }>();
  const fetchOne = async (account: string): Promise<PhoneEligibilityRecord | null> => {
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
  const read = async (account: string): Promise<PhoneEligibilityRecord | null> => {
    const t = now();
    const hit = cache.get(account);
    if (hit && t - hit.at < cacheMs) return hit.rec;
    const rec = await fetchOne(account);
    if (rec) {
      if (cache.size >= 10_000) for (const [k, v] of cache) if (t - v.at >= cacheMs) cache.delete(k);
      if (cache.size < 10_000) cache.set(account, { at: t, rec });
    }
    return rec;
  };
  return Object.assign(read, { forget: (account?: string) => (account === undefined ? cache.clear() : void cache.delete(account.toLowerCase())) });
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
  | "holding"
  | "no-challenge"
  | "unavailable"
  | "not-eligible"
  | "route-held"
  | "stale-generation"
  | "not-holder"
  | "expired"
  | import("@flagship/protocol").RouteClaimRefusal;

export type PhoneRouteLoss = "expired" | "revoked" | "contact" | "released";

const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface Held {
  account: string;
  hostname: string;
  generation: number;
  phoneRoutePub: string;
  sessionNonce: string;
  confirmedAt: number;
}

export class PhoneSession {
  readonly id = randomBytes(16).toString("hex");
  offer: { account: string; hostname: string; nonce: string; generation: number; expiresAt: number } | null = null;
  /** The client address the tunnel came from (per-address `begin` budget). */
  address = "";
  held: Held | null = null;
  /** Refused while another phone held the route: told when it becomes vacant. */
  standby: string | null = null;
  /** The admin grant chain the phone presented in `begin` (mesh relays check eligibility from it). */
  presented: unknown = undefined;
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
  standbyPollMs?: number;
  /** Visitor streams one phone may have open at once. */
  maxStreams?: number;
  /**
   * Mesh (relay-mesh.md §4.6): false while the relay is not fresh; a `begin` is then refused `unavailable` and the
   * tunnel closed 1013 "try-again". Absent: always accepting.
   */
  accepting?: () => boolean;
  log?: (m: string) => void;
}

export interface PhoneRoutesStats {
  sessions: number;
  holding: number;
  standby: number;
  refused: Record<string, number>;
  lost: Record<string, number>;
}

/**
 * The phone sessions on this relay and which one (if any) the bare name of each account routes to. The relay only
 * obeys the ledger (owner, 2026-11-01): a claim succeeds only while the route is vacant; a live holder keeps it while
 * its tunnel and lease live; refused phones wait as standbys and are told when it becomes vacant.
 */
export class PhoneRoutes {
  private readonly sessions = new Set<PhoneSession>();
  private readonly holders = new Map<string, PhoneSession>();
  private readonly standbys = new Map<string, { sessions: Set<PhoneSession>; poll: unknown; notified: number }>();
  private readonly refused: Record<string, number> = {};
  private readonly lost: Record<string, number> = {};
  /** Per client address `begin` budget (security review 2026-11-02, M4). */
  private readonly beginBudget = new Map<string, { tokens: number; at: number }>();
  /** hostname → a ledger read reused for `PHONE_LEDGER_READ_CACHE_MS`. */
  private readonly readCache = new Map<string, { at: number; entry: PhoneRouteEntry }>();
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

  attach(handle: PhoneSessionHandle, address = ""): PhoneSession {
    const s = new PhoneSession(handle);
    s.address = address;
    this.sessions.add(s);
    return s;
  }

  /** The phone tunnel closed (the app left the foreground): the route is vacant at once, its streams went with it. */
  detach(s: PhoneSession): void {
    if (s.closed) return;
    s.closed = true;
    this.clearTimers(s);
    this.sessions.delete(s);
    this.leaveStandby(s);
    const h = s.held;
    if (h && this.holders.get(h.hostname) === s) {
      this.holders.delete(h.hostname);
      void this.opts.ledger.apply({ op: "release", hostname: h.hostname, generation: h.generation, sessionId: s.id });
      this.notifyVacant(h.hostname, h.generation);
    }
  }

  /**
   * The SNI router's question for a bare name: the local session that holds it, if its lease is confirmed and it is
   * still eligible. Undefined closes the visitor.
   */
  tunnelFor(hostname: string): RegisteredTunnel | undefined {
    const s = this.holders.get(hostname.toLowerCase());
    if (!s || s.closed || !s.held) return undefined;
    const now = this.now();
    if (now - s.held.confirmedAt >= (this.opts.confirmedMs ?? PHONE_ROUTE_CONFIRMED_MS)) return undefined;
    if (s.eligibleUntil <= now) return undefined;
    if (s.handle.streamCount() >= (this.opts.maxStreams ?? 64)) return undefined;
    return s.handle.tunnel;
  }

  /** Step 1: the phone names its account; it gets a nonce for this session and the next generation. */
  async begin(s: PhoneSession, account: unknown, grants?: unknown): Promise<void> {
    if (typeof account !== "string" || !ACCOUNT.test(account)) return this.refuse(s, "malformed");
    if (this.opts.accepting && !this.opts.accepting()) {
      this.refuse(s, "unavailable");
      s.handle.close(1013, "try-again");
      return;
    }
    if (grants !== undefined) s.presented = grants;
    if (s.held && this.holders.get(s.held.hostname) === s) return this.refuse(s, "holding", { generation: s.held.generation });
    if (!this.takeBegin(s.address)) return this.refuse(s, "busy");
    // Only an account with an eligible admin device (in the phone's own chain on a mesh relay) gets a challenge: the
    // ledger is not asked and no generation is revealed before that (security review 2026-11-02).
    const any = await this.anyEligible(account, s.presented);
    if (s.closed) return;
    if (any === null) return this.refuse(s, "unavailable");
    if (!any) return this.refuse(s, "not-eligible");
    const hostname = phoneHostname(account, this.apex);
    const entry = await this.readLedger(hostname);
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

  /** Step 2: the signed claim. Checked, eligibility verified, then committed in the ledger only if the route is vacant. */
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
    const elig = await this.eligible(offer.account, c.phoneRoutePub, s.presented);
    if (s.closed) return;
    if (elig === null) return this.refuse(s, "unavailable");
    if (!elig.ok) return this.refuse(s, "not-eligible");
    this.readCache.delete(offer.hostname);
    const r = await this.opts.ledger.apply({
      op: "acquire",
      hostname: offer.hostname,
      generation: offer.generation,
      holder: { relayId: this.opts.relayId, sessionId: s.id, phoneRoutePub: c.phoneRoutePub },
      claim: c,
      claimSignature: signature,
    });
    this.readCache.delete(offer.hostname);
    if (s.closed) {
      if (r?.ok) void this.opts.ledger.apply({ op: "release", hostname: offer.hostname, generation: offer.generation, sessionId: s.id });
      return;
    }
    if (!r) return this.refuse(s, "unavailable");
    if (!r.ok) {
      // An eligible phone refused because the route is taken (or was just taken) waits as a standby.
      if (r.code === "route-held" || r.code === "stale-generation") this.enterStandby(s, offer.hostname);
      return this.refuse(s, r.code === "stale-generation" ? "route-held" : r.code, { generation: r.entry.generation });
    }
    this.leaveStandby(s);
    this.clearTimers(s);
    s.held = { account: offer.account, hostname: offer.hostname, generation: offer.generation, phoneRoutePub: c.phoneRoutePub, sessionNonce: offer.nonce, confirmedAt: now };
    s.eligibleUntil = elig.expiresAt;
    this.holders.set(offer.hostname, s);
    s.timers.push({ repeat: this.setRepeat(() => void this.renew(s), this.opts.renewMs ?? PHONE_ROUTE_RENEW_MS) });
    s.timers.push({ repeat: this.setRepeat(() => void this.recheck(s), this.opts.recheckMs ?? PHONE_ROUTE_ELIGIBILITY_RECHECK_MS) });
    s.timers.push({ once: this.setTimer(() => void this.recheck(s), Math.max(0, Math.min(elig.expiresAt - now, 2 ** 31 - 1))) });
    this.log(`[phone-route] ${offer.hostname}: held by session ${s.id.slice(0, 8)} at generation ${offer.generation}`);
    s.handle.send({ type: "granted", hostname: offer.hostname, generation: offer.generation, leaseMs: PHONE_ROUTE_LEASE_MS });
  }

  /** The holder gives the route up (signed, bound to the claim it holds); its tunnel may stay open as a standby. */
  async release(s: PhoneSession, release: unknown, signature: unknown): Promise<void> {
    const h = s.held;
    if (!h || this.holders.get(h.hostname) !== s) return this.refuse(s, "not-holder");
    if (typeof release !== "object" || release === null || typeof signature !== "string") return this.refuse(s, "malformed");
    const checked = checkRouteRelease({ release: release as RouteRelease, signature, held: h, now: this.now() });
    if (!checked.ok) return this.refuse(s, checked.code);
    this.lose(s, "released");
    const r = await this.opts.ledger.apply({ op: "release", hostname: h.hostname, generation: h.generation, sessionId: s.id });
    if (!s.closed) s.handle.send({ type: "released", hostname: h.hostname, generation: h.generation, confirmed: r?.ok === true });
    this.notifyVacant(h.hostname, h.generation);
    // Its tunnel stays open, so it waits as a standby too, but only for a later vacancy (not the one it just made).
    if (!s.closed) this.enterStandby(s, h.hostname, h.generation + 1);
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
    if (r) return this.lose(s, "expired");
    // `.com` unreachable: routing already stopped at the confirmed window; past the lease the route is gone.
    if (now - h.confirmedAt >= PHONE_ROUTE_LEASE_MS) this.lose(s, "contact");
  }

  /** The feed: the ledger committed `generation` for `hostname` (a new holder) or it became vacant. */
  pushed(hostname: string, generation: number, vacant: boolean): void {
    const host = hostname.toLowerCase();
    this.readCache.delete(host);
    if (vacant) return this.notifyVacant(host, generation);
    // A newer holder elsewhere means this one's lease had lapsed: it is not the holder any more.
    const s = this.holders.get(host);
    if (s?.held && s.held.generation < generation) this.lose(s, "expired");
  }

  /** Close every phone tunnel (mesh: contact lost past the close-all deadline, §4.6). */
  closeAll(code: number, reason: string): void {
    for (const s of [...this.sessions]) s.handle.close(code, reason);
  }

  /** The relay log revoked a device grant (mesh: the log names no account): re-check every held route now. */
  recheckAll(): Promise<void> {
    this.opts.eligibility.forget?.();
    return Promise.all([...this.holders.values()].map((s) => this.recheck(s))).then(() => undefined);
  }

  /** The feed says a device or admin grant of `username` changed: re-check every route of the account now. */
  eligibilityChanged(username: string): Promise<void> {
    const u = username.toLowerCase();
    this.opts.eligibility.forget?.(u);
    return Promise.all([...this.holders.values()].filter((s) => s.held?.account === u).map((s) => this.recheck(s))).then(() => undefined);
  }

  /** The feed came back: anything pushed while it was away was missed, so confirm every held route and standby now. */
  async resync(): Promise<void> {
    await this.renewAll();
    await Promise.all([...this.holders.values()].map((s) => this.recheck(s)));
    await Promise.all([...this.standbys.keys()].map((h) => this.pollStandby(h)));
  }

  async recheck(s: PhoneSession): Promise<void> {
    const h = s.held;
    if (!h || s.closed) return;
    const elig = await this.eligible(h.account, h.phoneRoutePub, s.presented);
    if (s.closed || s.held !== h) return;
    if (elig === null) return;
    if (elig.ok) {
      s.eligibleUntil = elig.expiresAt;
      return;
    }
    this.revoke(s);
  }

  /** A standby relay's own look at the ledger (the bound when a vacancy push is lost). */
  async pollStandby(hostname: string): Promise<void> {
    const st = this.standbys.get(hostname);
    if (!st) return;
    const e = await this.opts.ledger.read(hostname);
    if (e && e.holder === null && st.notified < e.generation + 1) this.notifyVacant(hostname, e.generation);
  }

  stats(): PhoneRoutesStats {
    let standby = 0;
    for (const st of this.standbys.values()) standby += st.sessions.size;
    return { sessions: this.sessions.size, holding: this.holders.size, standby, refused: { ...this.refused }, lost: { ...this.lost } };
  }

  private enterStandby(s: PhoneSession, hostname: string, notifiedFloor = 0): void {
    this.leaveStandby(s);
    s.standby = hostname;
    let st = this.standbys.get(hostname);
    if (!st) {
      st = { sessions: new Set(), poll: this.setRepeat(() => void this.pollStandby(hostname), this.opts.standbyPollMs ?? PHONE_ROUTE_STANDBY_POLL_MS), notified: 0 };
      this.standbys.set(hostname, st);
    }
    st.notified = Math.max(st.notified, notifiedFloor);
    st.sessions.add(s);
  }

  private leaveStandby(s: PhoneSession): void {
    const host = s.standby;
    if (!host) return;
    s.standby = null;
    const st = this.standbys.get(host);
    if (!st) return;
    st.sessions.delete(s);
    if (st.sessions.size === 0) {
      this.clearRepeat(st.poll);
      this.standbys.delete(host);
    }
  }

  /** Tell every standby of `hostname` on this relay that it is free: the first valid claim wins in the ledger. */
  private notifyVacant(hostname: string, generation: number): void {
    this.readCache.delete(hostname);
    const st = this.standbys.get(hostname);
    if (!st) return;
    st.notified = Math.max(st.notified, generation + 1);
    for (const s of st.sessions) if (!s.closed) s.handle.send({ type: "route-vacant", hostname, generation });
  }

  /** Does the account have any key that may claim (a pre-check before a challenge)? Null: eligibility unavailable. */
  private async anyEligible(account: string, presented: unknown): Promise<boolean | null> {
    const rec = await this.opts.eligibility(account, presented);
    if (!rec) return null;
    const now = this.now();
    return rec.grants.some((g) => g.revokedAt == null && phoneRouteEligibility(Buffer.from(g.grant.devicePubKey).toString("hex"), account, rec.adminRootPub, rec.grants, now).ok);
  }

  private takeBegin(address: string): boolean {
    const now = this.now();
    const b = this.beginBudget.get(address) ?? { tokens: PHONE_BEGIN_BURST, at: now };
    b.tokens = Math.min(PHONE_BEGIN_BURST, b.tokens + ((now - b.at) * PHONE_BEGIN_PER_MINUTE) / 60_000);
    b.at = now;
    if (this.beginBudget.size >= 100_000 && !this.beginBudget.has(address)) {
      for (const [k, v] of this.beginBudget) if (v.tokens + ((now - v.at) * PHONE_BEGIN_PER_MINUTE) / 60_000 >= PHONE_BEGIN_BURST) this.beginBudget.delete(k);
      if (this.beginBudget.size >= 100_000) return false;
    }
    this.beginBudget.set(address, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private async readLedger(hostname: string): Promise<PhoneRouteEntry | null> {
    const now = this.now();
    const hit = this.readCache.get(hostname);
    if (hit && now - hit.at < PHONE_LEDGER_READ_CACHE_MS) return hit.entry;
    const entry = await this.opts.ledger.read(hostname);
    if (entry) {
      if (this.readCache.size >= 10_000) for (const [k, v] of this.readCache) if (now - v.at >= PHONE_LEDGER_READ_CACHE_MS) this.readCache.delete(k);
      if (this.readCache.size < 10_000) this.readCache.set(hostname, { at: now, entry });
    }
    return entry;
  }

  private async eligible(account: string, phoneRoutePub: string, presented: unknown): Promise<{ ok: true; expiresAt: number } | { ok: false } | null> {
    const rec = await this.opts.eligibility(account, presented);
    if (!rec) return null;
    return phoneRouteEligibility(phoneRoutePub, account, rec.adminRootPub, rec.grants, this.now());
  }

  /** No longer eligible: give up the route, end its streams within 5 s, close its tunnel. */
  private revoke(s: PhoneSession): void {
    const h = s.held;
    this.lose(s, "revoked");
    if (h) {
      void this.opts.ledger.apply({ op: "release", hostname: h.hostname, generation: h.generation, sessionId: s.id });
      this.notifyVacant(h.hostname, h.generation);
    }
    s.handle.close(4403, "not-eligible");
  }

  /** The route is gone from this session: no new visitors, and its streams end with it (no drain). */
  private lose(s: PhoneSession, reason: PhoneRouteLoss): void {
    const h = s.held;
    if (!h) return;
    s.held = null;
    if (this.holders.get(h.hostname) === s) this.holders.delete(h.hostname);
    this.clearTimers(s);
    this.lost[reason] = (this.lost[reason] ?? 0) + 1;
    this.log(`[phone-route] ${h.hostname}: session ${s.id.slice(0, 8)} lost the route (${reason})`);
    s.handle.closeStreams();
    if (!s.closed) s.handle.send({ type: "lost", hostname: h.hostname, generation: h.generation, reason });
  }

  private refuse(s: PhoneSession, code: PhoneRouteRefusal, extra: Record<string, unknown> = {}): void {
    this.refused[code] = (this.refused[code] ?? 0) + 1;
    if (!s.closed) s.handle.send({ type: "refused", code, ...extra });
  }

  private clearTimers(s: PhoneSession): void {
    for (const t of s.timers as Array<{ repeat?: unknown; once?: unknown }>) {
      if (t.repeat !== undefined) this.clearRepeat(t.repeat);
      if (t.once !== undefined) this.clearTimer(t.once);
    }
    s.timers = [];
  }
}
