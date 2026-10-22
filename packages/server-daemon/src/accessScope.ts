/**
 * Separate access lists per server, a Pro option (docs/service-access-gating.md,
 * "Separate lists per server (Pro)"; feat/marketplace only).
 *
 * On main an app's access list is one list shared by every server of the
 * account that runs it (accessSync.ts). An admin can sign
 * `flagship/app-list-scope/v1` to give an app a separate list on each server
 * (`server`) or to go back to one (`account`). This module holds the latest
 * order per app, checks the account's plan, and says which scope each app is
 * in right now:
 *
 *   - `server` is honoured only while the box holds a CA-signed plan
 *     attestation saying the account is Pro (PlanCheck below). A box that gets
 *     the order from another server before it has seen Pro keeps it pending
 *     (one list) until it does.
 *   - When the box verifies that Pro has ended (a CA-signed attestation that
 *     says free), every app with separate lists goes back to one list: the
 *     order is marked ended, and only a new order turns it on again.
 *   - When the plan can't be checked (no attestation, an expired one, a lapsed
 *     CA lease, `.com` unreachable), nothing changes: the box neither turns a
 *     pending order on nor ends one.
 *
 * Each app's "epoch" names the order it follows and how; two servers exchange
 * list entries only while their epochs match, so a server's separate copy
 * never leaks into another's list across a switch.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isProTier,
  parseAppListScopeOrder,
  parsePlanAttestation,
  verifyCaSignedPlanAttestation,
  type AppListScopeOrder,
  type CaTrustChain,
  type PlanAttestation,
} from "@flagship/protocol";
import type { AccessScope } from "./accessSync.js";

/** What the box knows about the account's plan. */
export type ProState = "pro" | "free" | "unknown";

export interface PlanCheckOptions {
  /** Where the newest verified attestation is kept (so a restart works offline). */
  path: string;
  /** The account that owns this box. */
  username: string;
  /** The box's CA trust chain (the same one every CA artifact goes through). */
  chain: () => CaTrustChain | null;
  /** `GET /api/users/<u>/plan-attestation` (the box's read token); null on any failure. */
  fetchAttestation: () => Promise<unknown | null>;
  /** Override the baked maintainer pin (tests). */
  pinnedMandateHash?: string;
  now?: () => number;
  log?: (m: string) => void;
}

/**
 * The account's plan as the box can prove it: the newest CA-signed attestation
 * it verified, read again every few hours.
 */
export class PlanCheck {
  private held: PlanAttestation | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: ((s: ProState) => void)[] = [];
  private last: ProState = "unknown";
  private lastRefreshAt = 0;

  constructor(private readonly opts: PlanCheckOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private accept(v: unknown): PlanAttestation | null {
    const a = parsePlanAttestation(v);
    if (!a || a.username !== this.opts.username.toLowerCase()) return null;
    const ok = this.opts.pinnedMandateHash !== undefined
      ? verifyCaSignedPlanAttestation(a, this.opts.chain(), this.now(), this.opts.pinnedMandateHash)
      : verifyCaSignedPlanAttestation(a, this.opts.chain(), this.now());
    if (!ok.ok) {
      this.opts.log?.(`[plan] attestation refused: ${ok.reason}`);
      return null;
    }
    return a;
  }

  async load(): Promise<void> {
    try {
      this.held = this.accept(JSON.parse(await readFile(this.opts.path, "utf8")));
    } catch {
      this.held = null;
    }
    this.last = this.state();
  }

  /** Fetch and verify a fresh attestation; tells listeners when the state changed. */
  async refresh(): Promise<ProState> {
    this.lastRefreshAt = this.now();
    const got = await this.opts.fetchAttestation().catch(() => null);
    const a = got ? this.accept(got) : null;
    if (a && (!this.held || a.issuedAt > this.held.issuedAt)) {
      this.held = a;
      await this.persist(a);
    }
    return this.emit();
  }

  /** A refresh at most every `minMs` (another server says the plan changed). */
  async refreshSoon(minMs = 5 * 60_000): Promise<ProState> {
    if (this.now() - this.lastRefreshAt < minMs) return this.state();
    return this.refresh();
  }

  /**
   * `pro` while the held attestation is in date, says Pro and its paid period
   * hasn't ended; `free` while it is in date and says free; otherwise unknown
   * (no attestation, an expired one, or a paid period that ended and no newer
   * word from `.com` yet).
   */
  state(): ProState {
    const a = this.held;
    const now = this.now();
    if (!a || now < a.issuedAt || now >= a.expiresAt) return "unknown";
    if (!isProTier(a.tier)) return "free";
    return a.paidUntil === 0 || a.paidUntil > now ? "pro" : "unknown";
  }

  onChange(cb: (s: ProState) => void): void {
    this.listeners.push(cb);
  }

  /** Re-read the state (the clock moves too) and tell listeners when it changed. */
  emit(): ProState {
    const s = this.state();
    if (s !== this.last) {
      this.last = s;
      for (const l of this.listeners) {
        try {
          l(s);
        } catch {
          /* a listener must not break the check */
        }
      }
    }
    return s;
  }

  start(everyMs = 3 * 3_600_000): void {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => void this.refresh().catch(() => {}), everyMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async persist(a: PlanAttestation): Promise<void> {
    try {
      await mkdir(dirname(this.opts.path), { recursive: true });
      const tmp = `${this.opts.path}.tmp`;
      await writeFile(tmp, JSON.stringify(a), { mode: 0o600 });
      await rename(tmp, this.opts.path);
    } catch (e) {
      this.opts.log?.(`[plan] could not keep the attestation: ${String((e as Error)?.message ?? e)}`);
    }
  }
}

/** One app's latest scope order, as this box holds it. */
export interface ScopeRecord {
  order: AppListScopeOrder;
  signature: string;
  /** A `server` order this box honoured (it saw Pro while holding it). */
  honoured?: boolean;
  /** When this box saw Pro end while holding a `server` order (back to one list). */
  endedAt?: number;
}

export type ScopeAdoptResult = "applied" | "stale" | "refused" | "needs-pro";

export interface AccessScopesOptions {
  /** `<dataDir>/data/flagship-access/access-scope.json` */
  path: string;
  plan: Pick<PlanCheck, "state">;
  /** The admin-only key check (the same one every admin access order uses). */
  verify: (order: AppListScopeOrder, signatureHex: string) => boolean;
  now?: () => number;
  log?: (m: string) => void;
}

/** Called when an app's epoch changes; `to` is the scope it is in now. */
export type ScopeTransition = (serviceRef: string, change: { fromEpoch: string; toEpoch: string; to: AccessScope; resets: boolean }) => Promise<void>;

export class AccessScopes {
  private byApp = new Map<string, ScopeRecord>();
  private transition: ScopeTransition | null = null;
  /** Apps switching lists right now: nothing crosses for them until the switch is done. */
  private switching = new Map<string, number>();

  constructor(private readonly opts: AccessScopesOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** What the sync does when an app's epoch changes (set once it exists). */
  onTransition(t: ScopeTransition): void {
    this.transition = t;
  }

  async load(): Promise<void> {
    this.byApp.clear();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(this.opts.path, "utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const [ref, v] of Object.entries(raw ?? {})) {
      const r = v as Partial<ScopeRecord> | null;
      const order = parseAppListScopeOrder(r?.order);
      if (!order || order.serviceRef !== ref || typeof r?.signature !== "string") continue;
      // Re-checked at load: a tampered file can't turn a list separate.
      if (!this.opts.verify(order, r.signature)) continue;
      this.byApp.set(ref, {
        order,
        signature: r.signature.toLowerCase(),
        ...(r.honoured === true ? { honoured: true } : {}),
        ...(typeof r.endedAt === "number" ? { endedAt: r.endedAt } : {}),
      });
    }
  }

  record(serviceRef: string): ScopeRecord | null {
    const r = this.byApp.get(serviceRef);
    return r ? { ...r, order: { ...r.order } } : null;
  }

  /** The order to hand to other servers (null when the app never had one). */
  shareable(serviceRef: string): { order: AppListScopeOrder; signature: string } | null {
    const r = this.byApp.get(serviceRef);
    return r ? { order: { ...r.order }, signature: r.signature } : null;
  }

  /** The scope the app is in right now. */
  scope(serviceRef: string): AccessScope {
    const r = this.byApp.get(serviceRef);
    return r && r.order.scope === "server" && r.honoured && r.endedAt === undefined ? "server" : "account";
  }

  /** `<issuedAt>:<account|server|pending|ended>`: servers exchange list entries only within one epoch. */
  epoch(serviceRef: string): string {
    const r = this.byApp.get(serviceRef);
    if (!r) return "0:account";
    if (r.order.scope === "account") return `${r.order.issuedAt}:account`;
    if (r.endedAt !== undefined) return `${r.order.issuedAt}:ended`;
    return `${r.order.issuedAt}:${r.honoured ? "server" : "pending"}`;
  }

  /** Whether an app is switching lists (its new epoch shows, its list isn't ready yet). */
  busy(serviceRef: string): boolean {
    return (this.switching.get(serviceRef) ?? 0) > 0;
  }

  private hold(ref: string): void {
    this.switching.set(ref, (this.switching.get(ref) ?? 0) + 1);
  }

  private release(ref: string): void {
    const n = (this.switching.get(ref) ?? 1) - 1;
    if (n <= 0) this.switching.delete(ref);
    else this.switching.set(ref, n);
  }

  /** The apps that keep a separate list on each server right now. */
  separateApps(): string[] {
    return [...this.byApp.keys()].filter((ref) => this.scope(ref) === "server");
  }

  /**
   * Take a signed scope order. `direct` is an admin's own post to this box: a
   * `server` order is then refused unless the box sees Pro. One handed over by
   * another server is kept, and honoured as soon as the box sees Pro.
   */
  async adopt(order: AppListScopeOrder, signatureHex: string, opts: { direct: boolean }): Promise<ScopeAdoptResult> {
    const parsed = parseAppListScopeOrder(order);
    if (!parsed || !/^[0-9a-f]{128}$/i.test(signatureHex) || !this.opts.verify(parsed, signatureHex)) return "refused";
    const prev = this.byApp.get(parsed.serviceRef);
    if (prev && parsed.issuedAt <= prev.order.issuedAt) return "stale";
    const plan = this.opts.plan.state();
    if (parsed.scope === "server" && opts.direct && plan !== "pro") return "needs-pro";
    const fromEpoch = this.epoch(parsed.serviceRef);
    const rec: ScopeRecord = { order: parsed, signature: signatureHex.toLowerCase() };
    if (parsed.scope === "server") {
      if (plan === "pro") rec.honoured = true;
      else if (plan === "free") rec.endedAt = this.now();
    }
    // Held before the new epoch shows, so nothing crosses until the list is ready.
    this.hold(parsed.serviceRef);
    this.byApp.set(parsed.serviceRef, rec);
    try {
      await this.persist();
      await this.changed(parsed.serviceRef, fromEpoch);
    } finally {
      this.release(parsed.serviceRef);
    }
    return "applied";
  }

  /**
   * The plan changed: honour pending `server` orders on Pro; on free, end every
   * `server` order (back to one list). Returns the apps that had a separate
   * list on each server and now have one list.
   */
  async planChanged(state: ProState): Promise<string[]> {
    if (state === "unknown") return [];
    const merged: string[] = [];
    const changed: [string, string][] = [];
    for (const [ref, r] of this.byApp) {
      if (r.order.scope !== "server" || r.endedAt !== undefined) continue;
      const fromEpoch = this.epoch(ref);
      if (state === "pro" && !r.honoured) {
        this.hold(ref);
        r.honoured = true;
        changed.push([ref, fromEpoch]);
      } else if (state === "free") {
        this.hold(ref);
        if (r.honoured) merged.push(ref);
        r.endedAt = this.now();
        changed.push([ref, fromEpoch]);
      }
    }
    if (changed.length === 0) return [];
    try {
      await this.persist();
      for (const [ref, fromEpoch] of changed) await this.changed(ref, fromEpoch);
    } finally {
      for (const [ref] of changed) this.release(ref);
    }
    return merged;
  }

  /** Uninstall: a reinstall under the same id starts with one list. */
  async forget(serviceRef: string): Promise<void> {
    if (this.byApp.delete(serviceRef)) await this.persist();
  }

  private async changed(ref: string, fromEpoch: string): Promise<void> {
    const toEpoch = this.epoch(ref);
    if (toEpoch === fromEpoch || !this.transition) return;
    const to = this.scope(ref);
    // Going back to one list (an `account` order, or Pro ending) takes the
    // lead server's list; a pending order or a separate list keeps this one.
    const kind = toEpoch.slice(toEpoch.indexOf(":") + 1);
    const resets = kind === "account" || kind === "ended";
    try {
      await this.transition(ref, { fromEpoch, toEpoch, to, resets });
    } catch (e) {
      this.opts.log?.(`[access-scope] ${ref}: switching lists failed: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private writing: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    this.writing = this.writing
      .then(async () => {
        const out: Record<string, ScopeRecord> = {};
        for (const [ref, r] of this.byApp) out[ref] = r;
        await mkdir(dirname(this.opts.path), { recursive: true });
        const tmp = `${this.opts.path}.tmp`;
        await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
        await rename(tmp, this.opts.path);
      })
      .catch(() => {});
    return this.writing;
  }
}
