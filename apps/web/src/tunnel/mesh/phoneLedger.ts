/**
 * The phone's bare name across the mesh (relay-mesh.md §8). Each account's phone ledger lives on the first reachable
 * `full` relay in the rendezvous ranking of the directory (`phoneLedgerRanking`); the existing ledger rules
 * (`ledgerAcquire`, `ledgerRenew`, `ledgerRelease`, `liveEntry`) run there unchanged, in memory. The phone keeps its
 * tunnel on whatever relay P it landed on; P talks to the ledger relay L over the bridge (or to itself), announces the
 * L-signed phone route grant to every peer, and withdraws it when the phone leaves. Nothing about it reaches `.com`.
 *
 * Eligibility no longer comes from `.com`: the phone presents its own admin grant chain in `begin`, checked against
 * the log's admin root for the account and its `device-grant-revoke` entries.
 */
import { randomBytes } from "node:crypto";
import {
  accountHash,
  emptyPhoneRouteEntry,
  liveEntry,
  PHONE_ROUTE_GRANT_TTL_MS,
  phoneHostname,
  signRelayMeshRecord,
  type LedgerResult,
  type PhoneItem,
  type PhoneRouteEntry,
  type PhoneRouteGrant,
  type RelayLogState,
} from "@flagship/protocol";
import { applyLedgerOp, parsePhoneEligibility, type LedgerOp, type PhoneEligibilityRecord, type PhoneRouteLedgerClient } from "../phoneRoute.js";
import type { BridgePeer } from "./bridge.js";

// ── L: the ledger relay ───────────────────────────────────────────────────

export interface PhoneLedgerHostOptions {
  selfRelayId: string;
  servicesApex: string;
  sign: (msg: Uint8Array) => Uint8Array;
  now?: () => number;
  /** The highest generation in any phone item seen for the hostname (a new L starts above it). */
  maxSeenGeneration: (hostname: string) => number;
  /** A holder released or its lease lapsed: tell every relay (`phone-vacant`). */
  onVacant: (hostname: string, generation: number) => void;
}

export interface GrantedResult {
  result: LedgerResult;
  grant?: PhoneRouteGrant;
  grantSignature?: string;
}

export class PhoneLedgerHost {
  private readonly entries = new Map<string, PhoneRouteEntry>();
  private readonly now: () => number;
  ops = 0;

  constructor(private readonly opts: PhoneLedgerHostOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  private entry(hostname: string): PhoneRouteEntry {
    const had = this.entries.get(hostname);
    if (had) return liveEntry(had, this.now());
    return { ...emptyPhoneRouteEntry(), generation: this.opts.maxSeenGeneration(hostname) };
  }

  /** `phone-begin`: the next generation to offer, and whether the route is vacant. */
  begin(account: string): { hostname: string; generation: number; vacant: boolean; holderGeneration?: number } | null {
    let hostname: string;
    try {
      hostname = phoneHostname(account, this.opts.servicesApex);
    } catch {
      return null;
    }
    const e = this.entry(hostname);
    return { hostname, generation: e.generation + 1, vacant: e.holder === null, ...(e.holder ? { holderGeneration: e.generation } : {}) };
  }

  read(hostname: string): PhoneRouteEntry {
    return this.entry(hostname);
  }

  /** Apply one op for the relay `from` (a claim may only name `from` as its holder). */
  apply(op: LedgerOp, from: string): GrantedResult {
    this.ops++;
    const before = this.entry(op.hostname);
    if (op.op === "acquire" && op.holder.relayId !== from) return { result: { ok: false, code: "malformed", entry: before } };
    if (op.op !== "acquire" && before.holder && before.holder.relayId !== from) return { result: { ok: false, code: "not-holder", entry: before } };
    const now = this.now();
    const r = applyLedgerOp(before, op, now);
    if (!r.ok) {
      // The holder's lease lapsed under it: the route is vacant now (told once, on the failed renew).
      if (op.op === "renew" && r.code === "expired") this.opts.onVacant(op.hostname, before.generation);
      return { result: r };
    }
    this.entries.set(op.hostname, r.entry);
    if (op.op === "release") {
      this.opts.onVacant(op.hostname, op.generation);
      return { result: r };
    }
    const h = r.entry.holder!;
    const grant: PhoneRouteGrant = {
      hostname: op.hostname,
      phoneRoutePub: h.phoneRoutePub,
      generation: r.entry.generation,
      holderRelayId: h.relayId,
      ledgerRelayId: this.opts.selfRelayId,
      issuedAt: now,
      notAfter: now + PHONE_ROUTE_GRANT_TTL_MS,
    };
    return { result: r, grant, grantSignature: signRelayMeshRecord("phone-route-grant", grant, this.opts.sign) };
  }

  /** Lapsed leases become vacancies (the sweep timer). */
  sweep(): void {
    const now = this.now();
    for (const [host, e] of this.entries) {
      if (e.holder && e.leaseUntil <= now) {
        this.entries.set(host, liveEntry(e, now));
        this.opts.onVacant(host, e.generation);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }
}

// ── P: the holder's client of L ───────────────────────────────────────────

export type LedgerTarget = { local: PhoneLedgerHost } | { peer: BridgePeer } | null;

export interface MeshPhoneLedgerClientOptions {
  selfRelayId: string;
  /** L for the hostname's account: this relay, a live bridge, or none reachable. */
  ledgerFor: (hostname: string) => LedgerTarget;
  /** A grant came back: announce it as a phone item (and keep it in the store). */
  announce: (item: PhoneItem) => void;
  /** The phone left (or lost) the route: withdraw this relay's items for the hostname. */
  withdraw: (hostname: string, upToIssuedAt: number) => void;
  timeoutMs?: number;
}

export class MeshPhoneLedgerClient implements PhoneRouteLedgerClient {
  private readonly waiting = new Map<string, { resolve: (m: Record<string, unknown> | null) => void; timer: ReturnType<typeof setTimeout> }>();
  /** hostname → the newest grant this relay announced. */
  private readonly announced = new Map<string, number>();

  constructor(private readonly opts: MeshPhoneLedgerClientOptions) {}

  async read(hostname: string): Promise<PhoneRouteEntry | null> {
    const t = this.opts.ledgerFor(hostname);
    if (!t) return null;
    const account = hostname.split(".")[0]!;
    if ("local" in t) return t.local.read(hostname);
    const m = await this.ask(t.peer, { type: "phone-begin", account });
    if (!m || typeof m.generation !== "number" || !Number.isSafeInteger(m.generation) || m.generation < 1) return null;
    const vacant = m.vacant === true;
    return { generation: m.generation - 1, holder: vacant ? null : { relayId: "", sessionId: "", phoneRoutePub: "" }, leaseUntil: 0 };
  }

  async apply(op: LedgerOp): Promise<LedgerResult | null> {
    const t = this.opts.ledgerFor(op.hostname);
    if (!t) return null;
    let res: GrantedResult | null;
    if ("local" in t) res = t.local.apply(op, this.opts.selfRelayId);
    else res = parseGranted(await this.ask(t.peer, toWire(op)), op);
    if (!res) return null;
    if (res.result.ok && res.grant && res.grantSignature && op.op !== "release") {
      this.announced.set(op.hostname, res.grant.issuedAt);
      this.opts.announce({ kind: "phone", grant: res.grant, signature: res.grantSignature });
    } else if (op.op === "release" || (op.op === "renew" && !res.result.ok)) {
      const upTo = this.announced.get(op.hostname);
      if (upTo !== undefined) {
        this.announced.delete(op.hostname);
        this.opts.withdraw(op.hostname, upTo);
      }
    }
    return res.result;
  }

  /** A `phone-begun` / `phone-claimed` from a ledger relay. */
  onReply(msg: Record<string, unknown>): void {
    const qid = typeof msg.qid === "string" ? msg.qid : "";
    const w = this.waiting.get(qid);
    if (!w) return;
    this.waiting.delete(qid);
    clearTimeout(w.timer);
    w.resolve(msg);
  }

  private ask(peer: BridgePeer, msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const qid = randomBytes(8).toString("hex");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(qid);
        resolve(null);
      }, this.opts.timeoutMs ?? 5_000);
      timer.unref?.();
      this.waiting.set(qid, { resolve, timer });
      peer.send({ ...msg, qid });
    });
  }
}

function toWire(op: LedgerOp): Record<string, unknown> {
  if (op.op === "acquire") return { type: "phone-claim", hostname: op.hostname, generation: op.generation, holder: op.holder };
  return { type: op.op === "renew" ? "phone-renew" : "phone-release", hostname: op.hostname, generation: op.generation, sessionId: op.sessionId };
}

const CODES = new Set(["route-held", "stale-generation", "not-holder", "expired", "malformed"]);

function parseGranted(m: Record<string, unknown> | null, op: LedgerOp): GrantedResult | null {
  if (!m) return null;
  const generation = typeof m.generation === "number" && Number.isSafeInteger(m.generation) ? m.generation : op.generation;
  const entry: PhoneRouteEntry = { generation, holder: null, leaseUntil: 0 };
  if (m.ok === true) {
    const grant = m.grant as PhoneRouteGrant | undefined;
    const sig = typeof m.grantSignature === "string" ? m.grantSignature : undefined;
    return { result: { ok: true, entry }, ...(grant && sig ? { grant, grantSignature: sig } : {}) };
  }
  if (typeof m.code !== "string" || !CODES.has(m.code)) return null;
  return { result: { ok: false, code: m.code as Exclude<LedgerResult, { ok: true }>["code"], entry } };
}

/** L's answer to a P request over the bridge. */
export function answerLedgerRequest(host: PhoneLedgerHost, from: BridgePeer, msg: Record<string, unknown>): void {
  const qid = msg.qid;
  if (typeof qid !== "string" || qid.length > 64) return;
  if (msg.type === "phone-begin") {
    const b = typeof msg.account === "string" ? host.begin(msg.account) : null;
    if (!b) return from.send({ type: "phone-claimed", qid, ok: false, code: "malformed" });
    return from.send({ type: "phone-begun", qid, generation: b.generation, vacant: b.vacant, ...(b.holderGeneration !== undefined ? { holderGeneration: b.holderGeneration } : {}) });
  }
  const op = fromWire(msg);
  if (!op) return from.send({ type: "phone-claimed", qid, ok: false, code: "malformed" });
  const r = host.apply(op, from.relayId);
  from.send({
    type: "phone-claimed",
    qid,
    ok: r.result.ok,
    generation: r.result.entry.generation,
    ...(r.result.ok ? {} : { code: r.result.code }),
    ...(r.grant ? { grant: r.grant, grantSignature: r.grantSignature } : {}),
  });
}

function fromWire(m: Record<string, unknown>): LedgerOp | null {
  if (typeof m.hostname !== "string" || typeof m.generation !== "number" || !Number.isSafeInteger(m.generation)) return null;
  if (m.type === "phone-claim") {
    const h = m.holder as Record<string, unknown> | null;
    if (!h || typeof h.relayId !== "string" || typeof h.sessionId !== "string" || typeof h.phoneRoutePub !== "string") return null;
    return { op: "acquire", hostname: m.hostname, generation: m.generation, holder: { relayId: h.relayId, sessionId: h.sessionId, phoneRoutePub: h.phoneRoutePub } };
  }
  if (typeof m.sessionId !== "string") return null;
  if (m.type === "phone-renew") return { op: "renew", hostname: m.hostname, generation: m.generation, sessionId: m.sessionId };
  if (m.type === "phone-release") return { op: "release", hostname: m.hostname, generation: m.generation, sessionId: m.sessionId };
  return null;
}

// ── eligibility from the phone's own grants (§8.2) ────────────────────────

/**
 * The phone presents its admin grant chain in `begin` (`grants: [{grant, signatureHex, signerRoot}]`); it is checked
 * against the log's admin root for the account, with every grant id the log revoked marked revoked.
 */
export function meshPhoneEligibility(log: () => RelayLogState, now: () => number = () => Date.now()) {
  return async (account: string, presented?: unknown): Promise<PhoneEligibilityRecord | null> => {
    let h: string;
    try {
      h = accountHash(account);
    } catch {
      return { adminRootPub: null, grants: [] };
    }
    const state = log();
    const adminRootPub = state.authorities.get(h)?.adminRootPub ?? null;
    const raw = Array.isArray(presented) ? presented.slice(0, 8) : [];
    const wire = raw.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const g = (o.grant ?? {}) as Record<string, unknown>;
      return { ...g, signatureHex: o.signatureHex, signerRoot: o.signerRoot, revokedAt: typeof g.grantId === "string" && state.revokedGrants.has(g.grantId) ? now() : null };
    });
    return parsePhoneEligibility({ adminRootPub, grants: wire });
  };
}
