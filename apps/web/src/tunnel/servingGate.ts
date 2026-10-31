/**
 * The relay half of the serving authority (docs/architecture-v2/serving-wiring.md §2): per connected box, the
 * decision `servingDecision` gives from `.com`'s records, the box's HELLO and the pushed revocation log, kept current
 * on HELLO, on a `changed` frame and at the decision's `until`; and the fail-closed rule when the feed from `.com`
 * goes quiet. Every rule lives in `@flagship/protocol`; this file only gathers the inputs and acts on the answer.
 */
import {
  boxRevoked,
  emptyRevocationState,
  servingDecision,
  type RenewalKeyDelegation,
  type RevocationState,
  type ServingReason,
  type ServingInput,
  type ServingLease,
  type ServingPolicy,
  type SignedServingRecord,
} from "@flagship/protocol";
import type { ServingView } from "./registry.js";

type LeaseInput = ServingInput["leases"][number];

/** `.com`'s answer to `GET /api/internal/serving/:u/:boxPub`, parsed. */
export interface ComServingRecord {
  /** The account's sensitive-order key (admin root, else IRK), hex. */
  adminKey: string | null;
  regGen: number;
  policy: SignedServingRecord<ServingPolicy> | null;
  /** Leases joined with the delegation that signed them, when one did. */
  leases: LeaseInput[];
}

/** Null: `.com` could not be asked, or does not know the box. */
export type ServingRecordFetch = (username: string, boxPub: string) => Promise<ComServingRecord | null>;

const HEX64 = /^[0-9a-f]{64}$/;

/** A `{record, signature}` pair (also accepted under `altKey`, the name the POST bodies use). */
export function parseSignedRecord<T>(raw: unknown, altKey?: string): SignedServingRecord<T> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const record = o.record ?? (altKey ? o[altKey] : undefined);
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  if (typeof o.signature !== "string") return null;
  return { record: record as T, signature: o.signature };
}

export function parseComServingRecord(body: unknown): ComServingRecord | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.regGen !== "number" || !Number.isSafeInteger(o.regGen) || o.regGen < 1) return null;
  const adminKey = typeof o.adminKey === "string" && HEX64.test(o.adminKey) ? o.adminKey : null;
  const policy = parseSignedRecord<ServingPolicy>(o.policy, "policy");
  const delegations: SignedServingRecord<RenewalKeyDelegation>[] = [];
  for (const d of Array.isArray(o.delegations) ? o.delegations : []) {
    const p = parseSignedRecord<RenewalKeyDelegation>(d, "delegation");
    if (p) delegations.push(p);
  }
  const leases: LeaseInput[] = [];
  for (const raw of Array.isArray(o.leases) ? o.leases : []) {
    const l = parseSignedRecord<ServingLease>(raw, "lease");
    if (!l) continue;
    const r = raw as Record<string, unknown>;
    const inline = parseSignedRecord<RenewalKeyDelegation>(r.delegation, "delegation");
    const pub = typeof r.delegationPub === "string" ? r.delegationPub : inline?.record.renewalPub;
    if (inline) {
      leases.push({ ...l, delegation: inline });
    } else if (pub) {
      const d = delegations.find((x) => x.record.renewalPub === pub);
      leases.push(d ? { ...l, delegation: d } : l);
    } else {
      // No hint which key signed it: offer it under the admin key and under each delegation; one must verify.
      leases.push(l);
      for (const d of delegations) leases.push({ ...l, delegation: d });
    }
  }
  return { adminKey, regGen: o.regGen, policy, leases };
}

/** Reads `.com`'s internal serving record with the services control secret. */
export function comServingFetcher(opts: {
  comBaseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ServingRecordFetch {
  const base = opts.comBaseUrl.replace(/\/+$/, "");
  return async (username, boxPub) => {
    try {
      const res = await (opts.fetchImpl ?? fetch)(
        `${base}/api/internal/serving/${encodeURIComponent(username)}/${encodeURIComponent(boxPub)}`,
        {
          headers: { authorization: `Bearer ${opts.secret}` },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        },
      );
      if (!res.ok) return null;
      return parseComServingRecord(await res.json());
    } catch {
      return null;
    }
  };
}

/** What the box said about itself in its HELLO. */
export interface ServingHello {
  username: string;
  /** The box's identity key (the HELLO's verified podPubKey), hex. */
  boxPub: string;
  podCanonical: string;
  /** `servingAdminKey`: the admin key the box pinned. Null when the box sent none. */
  adminKey: string | null;
  /** `servingPolicy`: the box's stored signed policy. */
  policy: SignedServingRecord<ServingPolicy> | null;
}

/** How the gate acts on one tunnel. */
export interface ServingTunnelHandle {
  /** The box may not keep its tunnel (revoked, admin keys differ, or contact with `.com` lost). */
  closeTunnel(code: number, reason: string): void;
  /** Its app routes just stopped: end every open visitor stream that is not its control name. */
  closeAppStreams(): void;
  /** Its app routes stopped or came back: the allocator hands its slots on or takes free ones back. */
  onAppsChanged(apps: boolean): void;
}

/** `unavailable`: `.com`'s record for the box could not be read, so no decision could be made (apps stay off). */
export type ServingGateReason = ServingReason | "unavailable";

export type GateDecision =
  | { control: true; apps: true; until: number | null }
  | { control: boolean; apps: false; reason: ServingGateReason };

export interface ServingGateOptions {
  fetchRecord: ServingRecordFetch;
  /** The per-account authority lookup's admin key (admin root, else IRK); used when `.com`'s record names none. */
  adminKeyLookup?: (username: string) => Promise<string | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** No frame from `.com` for this long: refuse new tunnels. Default 60 s. */
  refuseNewAfterMs?: number;
  /** No frame for this long: close every tunnel until contact returns. Default 10 min. */
  closeAllAfterMs?: number;
  /** A box whose record could not be read is asked again after this long. Default 30 s. */
  retryMs?: number;
}

const MAX_TIMER_MS = 2 ** 31 - 1;
const REFRESH_CONCURRENCY = 8;

export class ServingBox {
  decision: GateDecision = { control: true, apps: false, reason: "unavailable" };
  com: ComServingRecord | null = null;
  timer: unknown = null;
  fetchGen = 0;
  closed = false;

  constructor(
    readonly gate: ServingGate,
    public hello: ServingHello,
    readonly handle: ServingTunnelHandle,
  ) {}

  view(): ServingView {
    return { control: this.decision.control, apps: this.decision.apps };
  }

  /** A HELLO refresh on the same tunnel: re-read `.com` and decide again. */
  update(hello: ServingHello): Promise<GateDecision> {
    this.hello = hello;
    return this.gate.refresh(this);
  }

  detach(): void {
    this.gate.detach(this);
  }
}

export interface ServingGateStats {
  boxes: number;
  serving: number;
  appsStopped: number;
  /** Boxes the revocation log has ended. */
  revoked: number;
  /** Tunnels refused or closed because the decision denied control. */
  refusedTunnels: number;
  contact: "ok" | "refuse-new" | "lost";
  lastContactAgeMs: number;
  feed: { sequence: number; latest: number; lag: number };
}

export class ServingGate {
  private readonly boxes = new Map<string, Set<ServingBox>>();
  private revocationState: RevocationState = emptyRevocationState();
  private lastContact: number;
  private lostClosed = false;
  private latestSequence = 0;
  private refusedTunnels = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  readonly refuseNewAfterMs: number;
  readonly closeAllAfterMs: number;
  private readonly retryMs: number;

  constructor(private readonly opts: ServingGateOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.refuseNewAfterMs = opts.refuseNewAfterMs ?? 60_000;
    this.closeAllAfterMs = opts.closeAllAfterMs ?? 10 * 60_000;
    this.retryMs = opts.retryMs ?? 30_000;
    // A relay that just started gets the same grace to reach `.com` as one that just lost it.
    this.lastContact = this.now();
  }

  /** Check the contact thresholds every `checkMs`. */
  start(checkMs = 5_000): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), checkMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const set of this.boxes.values()) for (const b of set) this.clearBoxTimer(b);
  }

  // ── contact with `.com` ────────────────────────────────────────────────

  noteContact(): void {
    this.lastContact = this.now();
    this.lostClosed = false;
  }

  contact(): "ok" | "refuse-new" | "lost" {
    const quiet = this.now() - this.lastContact;
    if (quiet >= this.closeAllAfterMs) return "lost";
    if (quiet >= this.refuseNewAfterMs) return "refuse-new";
    return "ok";
  }

  acceptingNewTunnels(): boolean {
    return this.contact() === "ok";
  }

  /** Close every tunnel once contact has been gone for `closeAllAfterMs`; they come back when it returns. */
  tick(): void {
    if (this.contact() !== "lost" || this.lostClosed) return;
    this.lostClosed = true;
    for (const set of [...this.boxes.values()]) {
      for (const b of [...set]) b.handle.closeTunnel(1013, "serving-feed-lost");
    }
  }

  // ── the revocation log ─────────────────────────────────────────────────

  get revocations(): RevocationState {
    return this.revocationState;
  }

  /** The feed applied entries (with `applyRevocationEntries`): every box of an account it touched decides again. */
  adoptRevocations(next: RevocationState): void {
    const prev = this.revocationState;
    this.revocationState = next;
    const accounts = new Set<string>();
    for (const [key, gen] of next.boxes) if (prev.boxes.get(key) !== gen) accounts.add(key.split("|")[0]!);
    const newKeys = [...next.renewalKeys].filter((k) => !prev.renewalKeys.has(k));
    for (const set of this.boxes.values()) {
      for (const b of set) {
        if (accounts.has(b.hello.username) || (newKeys.length > 0 && this.leaseUsesAny(b, newKeys))) this.redecide(b);
      }
    }
  }

  noteLatestSequence(seq: number): void {
    if (seq > this.latestSequence) this.latestSequence = seq;
  }

  private leaseUsesAny(b: ServingBox, keys: string[]): boolean {
    return (b.com?.leases ?? []).some((l) => l.delegation && keys.includes(l.delegation.record.renewalPub));
  }

  // ── boxes ──────────────────────────────────────────────────────────────

  /** A HELLO passed authentication: read `.com`'s record and decide. The caller refuses the tunnel when `control` is false. */
  async attach(hello: ServingHello, handle: ServingTunnelHandle): Promise<ServingBox> {
    const b = new ServingBox(this, hello, handle);
    const key = boxKey(hello.username, hello.boxPub);
    let set = this.boxes.get(key);
    if (!set) this.boxes.set(key, (set = new Set()));
    set.add(b);
    await this.refresh(b, { initial: true });
    return b;
  }

  detach(b: ServingBox): void {
    b.closed = true;
    this.clearBoxTimer(b);
    const key = boxKey(b.hello.username, b.hello.boxPub);
    const set = this.boxes.get(key);
    set?.delete(b);
    if (set && set.size === 0) this.boxes.delete(key);
  }

  /** `.com` says this box's policy, leases or delegations changed. */
  async changed(username: string, boxPub: string): Promise<void> {
    const set = this.boxes.get(boxKey(username.toLowerCase(), boxPub.toLowerCase()));
    if (!set) return;
    await Promise.all([...set].map((b) => this.refresh(b)));
  }

  /** Re-read every box (after the feed reconnects: `changed` frames sent while it was away were missed). */
  async refreshAll(): Promise<void> {
    const all = [...this.boxes.values()].flatMap((s) => [...s]);
    let i = 0;
    const worker = async () => {
      while (i < all.length) {
        const b = all[i++]!;
        if (!b.closed) await this.refresh(b);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, all.length) }, worker));
  }

  async refresh(b: ServingBox, o: { initial?: boolean } = {}): Promise<GateDecision> {
    const gen = ++b.fetchGen;
    const rec = await this.opts.fetchRecord(b.hello.username, b.hello.boxPub);
    let comKey: string | null = rec?.adminKey ?? null;
    if (rec && !comKey && this.opts.adminKeyLookup) comKey = await this.opts.adminKeyLookup(b.hello.username).catch(() => null);
    if (b.closed || gen !== b.fetchGen) return b.decision;
    // A record read is not contact: only the feed carries revocations.
    if (rec) b.com = comKey === rec.adminKey ? rec : { ...rec, adminKey: comKey };
    this.redecide(b, { initial: o.initial === true, failed: !rec });
    return b.decision;
  }

  /** Decide from what is held, act on a change, and arm the timer for the next one. */
  redecide(b: ServingBox, o: { initial?: boolean; failed?: boolean } = {}): void {
    if (b.closed) return;
    const prev = b.decision;
    const next = this.decide(b);
    b.decision = next;
    this.clearBoxTimer(b);
    if (!next.control) {
      this.refusedTunnels += 1;
      if (!o.initial) b.handle.closeTunnel(1008, next.apps === false ? next.reason : "refused");
      return;
    }
    if (!o.initial && prev.apps !== next.apps) {
      if (!next.apps) b.handle.closeAppStreams();
      b.handle.onAppsChanged(next.apps);
    }
    if (next.apps && next.until !== null) {
      this.armBoxTimer(b, next.until - this.now(), () => this.redecide(b));
    } else if (!b.com || o.failed) {
      this.armBoxTimer(b, this.retryMs, () => void this.refresh(b));
    }
  }

  private decide(b: ServingBox): GateDecision {
    const rec = b.com;
    if (!rec || !rec.adminKey) return { control: true, apps: false, reason: "unavailable" };
    const { username, boxPub } = b.hello;
    if (!b.hello.adminKey) {
      // An older box that pins nothing keeps its control name (recovery stays possible) but serves no app.
      if (boxRevoked(this.revocationState, username, boxPub, rec.regGen)) return { control: false, apps: false, reason: "revoked" };
      return { control: true, apps: false, reason: "admin-keys-differ" };
    }
    const d = servingDecision({
      account: username,
      box: boxPub,
      regGen: rec.regGen,
      adminKeyFromCom: rec.adminKey,
      adminKeyFromBox: b.hello.adminKey,
      policies: [rec.policy, b.hello.policy].filter((p): p is SignedServingRecord<ServingPolicy> => p !== null),
      leases: rec.leases,
      revocations: this.revocationState,
      now: this.now(),
    });
    return d.apps ? { control: true, apps: true, until: d.until } : { control: d.control, apps: false, reason: d.reason };
  }

  private armBoxTimer(b: ServingBox, ms: number, fn: () => void): void {
    const delay = Math.max(0, ms);
    b.timer = this.setTimer(delay > MAX_TIMER_MS ? () => this.armBoxTimer(b, delay - MAX_TIMER_MS, fn) : fn, Math.min(delay, MAX_TIMER_MS));
  }

  private clearBoxTimer(b: ServingBox): void {
    if (b.timer !== null) this.clearTimer(b.timer);
    b.timer = null;
  }

  stats(): ServingGateStats {
    let boxes = 0;
    let serving = 0;
    let appsStopped = 0;
    for (const set of this.boxes.values()) {
      for (const b of set) {
        boxes += 1;
        if (b.decision.apps) serving += 1;
        else if (b.decision.control) appsStopped += 1;
      }
    }
    const sequence = this.revocationState.sequence;
    const latest = Math.max(this.latestSequence, sequence);
    return {
      boxes,
      serving,
      appsStopped,
      revoked: this.revocationState.boxes.size,
      refusedTunnels: this.refusedTunnels,
      contact: this.contact(),
      lastContactAgeMs: this.now() - this.lastContact,
      feed: { sequence, latest, lag: latest - sequence },
    };
  }
}

function boxKey(username: string, boxPub: string): string {
  return `${username}|${boxPub}`;
}
