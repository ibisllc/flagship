/**
 * Live apps' access lists (docs/ai-privacy-and-staging.md §3a) and the
 * requests the box records when an app is denied a host no rule matched.
 *
 * Each list is kept WITH the owner signature that authorizes it, sealed under
 * the SWK in `<dataDir>/data/app-access.sealed`, and re-verified at every
 * load: a list whose signature no longer verifies under the box's current
 * sensitive-order authority is dropped (that app is back to everything
 * denied). Two kinds of authority are accepted:
 *   - v2: a `flagship/app-access/v1` grant over the list's SHA-256;
 *   - v1: a `flagship/app-egress/v1` grant (older apps, and approvals from
 *     before access lists), whose hosts become `allow` lines above the
 *     default list. A v1 `app-egress.sealed` file is migrated on first load.
 *
 * Requests are box state, not owner decisions, so they carry no signature;
 * they're sealed too because the hosts an app tries are private. So are
 * drafts ("Suggested lists"): the list with an `allow` line on top for each
 * host the manifest's `network.egress` suggests that the list doesn't
 * decide yet. A draft opens nothing until the owner signs it as a list.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_ACCESS_LIST,
  accessListFromEgressHosts,
  accessListSha256,
  checkAccessTarget,
  decideAccess,
  normalizeAccessList,
  parseAccessList,
  parseAppAccessGrant,
  parseAppEgressGrant,
  type AccessRule,
  type AppAccessGrant,
  type AppEgressGrant,
  type EgressSuggestion,
} from "@flagship/protocol";
import type { SwkOps } from "../keyCustodian.js";

export type AccessRequestSource = "attempt" | "app";

export interface AccessRequest {
  host: string;
  source: AccessRequestSource;
  attempts: number;
  firstSeen: number;
  lastSeen: number;
}

/** A suggested list waiting for the owner (docs/ai-privacy-and-staging.md §3a "Suggested lists"). */
export interface AccessDraft {
  list: string;
  listSha256: string;
  hosts: EgressSuggestion[];
  createdAt: number;
}

export type StoredAccessAuthority =
  | { v: 2; grant: AppAccessGrant; signature: string }
  | { v: 1; grant: AppEgressGrant; signature: string };

export interface AccessAuthorizer {
  v2(grant: AppAccessGrant, sig: Uint8Array): boolean;
  v1(grant: AppEgressGrant, sig: Uint8Array): boolean;
}

interface Entry {
  list: string;
  rules: AccessRule[];
  auth: StoredAccessAuthority;
}

interface PerApp {
  pending: Map<string, AccessRequest>;
  /** host → until (ms): Ignore keeps a host quiet for a while. */
  dismissed: Map<string, number>;
  draft: AccessDraft | null;
  /** Hosts a draft has already suggested: only a host not in here triggers a new draft. */
  suggested: Set<string>;
}

/** The spacing between a drafted rule and its reason, so the comment lines up. */
const DRAFT_WHY_SEP = "   # ";

type Swk = Pick<SwkOps, "sealWithSwk" | "openWithSwk">;

export const PENDING_MAX_PER_APP = 50;
export const DISMISS_QUIET_MS = 7 * 24 * 60 * 60_000;
export const ALERT_PER_HOST_MS = 24 * 60 * 60_000;
export const ALERTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;
/** Repeated lookups of one name (A, AAAA, HTTPS, retries) count once. */
const ATTEMPT_COALESCE_MS = 1000;
const SAVE_DEBOUNCE_MS = 2000;
/** Names that never leave a LAN or a container; not worth asking about. */
const PRIVATE_SUFFIXES = [".local", ".localdomain", ".internal", ".lan", ".home", ".arpa", ".invalid", ".localhost"];

export interface AppAccessStoreOptions {
  /** The v1 `app-egress.sealed` file to migrate from when the v2 file is absent. */
  legacyPath?: string | null;
  now?: () => number;
}

/**
 * The first rule that decides a whole target: an exact host as the gateway
 * would decide it, and `*.x` only by `all` or a `*.` rule covering every
 * subdomain of x (an exact rule decides one name, not the wildcard).
 */
export function coveringRule(rules: readonly AccessRule[], target: string): AccessRule | null {
  if (!target.startsWith("*.")) {
    const d = decideAccess(rules, target);
    return d.rule === null ? null : rules[d.rule - 1]!;
  }
  const sub = target.slice(1);
  for (const r of rules) {
    if (r.target === "all" || r.target === target) return r;
    if (r.target.startsWith("*.") && sub.endsWith(r.target.slice(1))) return r;
  }
  return null;
}

export class AppAccessStore {
  private entries = new Map<string, Entry>();
  private apps = new Map<string, PerApp>();
  private alertedAt = new Map<string, number>();
  private recentAlerts: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  /** `path` null ⇒ memory only (tests). */
  constructor(
    private readonly path: string | null,
    private readonly swk: Swk | null,
    private readonly opts: AppAccessStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Load, keeping only lists that still verify. Returns how many were
   * dropped and how many v1 approvals were migrated.
   */
  async load(auth: AccessAuthorizer, serverDomain: string): Promise<{ dropped: number; migrated: number }> {
    if (!this.path || !this.swk) return { dropped: 0, migrated: 0 };
    const raw = await this.readSealed(this.path);
    if (raw === null) return this.migrateLegacy(auth, serverDomain);
    const parsed = raw as {
      lists?: unknown;
      requests?: Record<string, unknown>;
      dismissed?: Record<string, Record<string, unknown>>;
      drafts?: Record<string, unknown>;
      suggested?: Record<string, unknown>;
      alerts?: { hosts?: Record<string, unknown>; recent?: unknown };
    };
    let dropped = 0;
    this.entries.clear();
    this.apps.clear();
    for (const rawEntry of Array.isArray(parsed.lists) ? parsed.lists : []) {
      const e = rawEntry as { serviceId?: unknown; list?: unknown; auth?: { v?: unknown; grant?: unknown; signature?: unknown } };
      const entry = typeof e.serviceId === "string" ? this.verifyEntry(e.serviceId, e.list, e.auth, auth, serverDomain) : null;
      if (!entry) {
        dropped++;
        continue;
      }
      this.entries.set(e.serviceId as string, entry);
    }
    for (const [id, list] of Object.entries(parsed.requests ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const r of list as Array<Record<string, unknown>>) {
        if (typeof r.host !== "string" || (r.source !== "attempt" && r.source !== "app")) continue;
        if (typeof r.attempts !== "number" || typeof r.firstSeen !== "number" || typeof r.lastSeen !== "number") continue;
        this.app(id).pending.set(r.host, {
          host: r.host,
          source: r.source,
          attempts: r.attempts,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
        });
      }
    }
    for (const [id, hosts] of Object.entries(parsed.dismissed ?? {})) {
      for (const [h, until] of Object.entries(hosts ?? {})) {
        if (typeof until === "number") this.app(id).dismissed.set(h, until);
      }
    }
    for (const [id, d] of Object.entries(parsed.drafts ?? {})) {
      const draft = parseDraft(d);
      if (draft) this.app(id).draft = draft;
    }
    for (const [id, hosts] of Object.entries(parsed.suggested ?? {})) {
      if (!Array.isArray(hosts)) continue;
      for (const h of hosts) if (typeof h === "string") this.app(id).suggested.add(h);
    }
    for (const [k, t] of Object.entries(parsed.alerts?.hosts ?? {})) if (typeof t === "number") this.alertedAt.set(k, t);
    if (Array.isArray(parsed.alerts?.recent)) {
      this.recentAlerts = (parsed.alerts!.recent as unknown[]).filter((t): t is number => typeof t === "number");
    }
    return { dropped, migrated: 0 };
  }

  private async migrateLegacy(auth: AccessAuthorizer, serverDomain: string): Promise<{ dropped: number; migrated: number }> {
    const legacy = this.opts.legacyPath;
    if (!legacy) return { dropped: 0, migrated: 0 };
    const raw = (await this.readSealed(legacy)) as { grants?: unknown } | null;
    if (raw === null) return { dropped: 0, migrated: 0 };
    let dropped = 0;
    let migrated = 0;
    for (const rawGrant of Array.isArray(raw.grants) ? raw.grants : []) {
      const r = rawGrant as { grant?: { serviceId?: unknown }; signature?: unknown };
      const id = typeof r.grant?.serviceId === "string" ? r.grant.serviceId : null;
      const entry = id ? this.verifyEntry(id, undefined, { v: 1, grant: r.grant, signature: r.signature }, auth, serverDomain) : null;
      if (!entry || !id) {
        dropped++;
        continue;
      }
      this.entries.set(id, entry);
      migrated++;
    }
    await this.save();
    await rename(legacy, `${legacy}.migrated`).catch(() => {});
    return { dropped, migrated };
  }

  private async readSealed(path: string): Promise<unknown | null> {
    let hex: string;
    try {
      hex = (await readFile(path, "utf8")).trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const buf = Buffer.from(hex, "hex");
    if (buf.length < 12) throw new Error(`${path} is truncated`);
    const plain = this.swk!.openWithSwk({ nonce: buf.subarray(0, 12), ciphertext: buf.subarray(12) });
    return JSON.parse(Buffer.from(plain).toString("utf8")) as unknown;
  }

  private verifyEntry(
    serviceId: string,
    list: unknown,
    a: { v?: unknown; grant?: unknown; signature?: unknown } | undefined,
    auth: AccessAuthorizer,
    serverDomain: string,
  ): Entry | null {
    if (!a || typeof a.signature !== "string") return null;
    const sig = hexToBytes(a.signature);
    if (!sig || sig.length !== 64) return null;
    if (a.v === 2) {
      const g = parseAppAccessGrant(a.grant);
      if (!g || g.serviceId !== serviceId || g.serverDomain !== serverDomain || typeof list !== "string") return null;
      if (normalizeAccessList(list) !== list || accessListSha256(list) !== g.listSha256) return null;
      const parsed = parseAccessList(list);
      if (parsed.errors.length > 0 || !auth.v2(g, sig)) return null;
      return { list, rules: parsed.rules, auth: { v: 2, grant: g, signature: a.signature } };
    }
    if (a.v === 1) {
      const g = parseAppEgressGrant(a.grant);
      if (!g || g.serviceId !== serviceId || g.serverDomain !== serverDomain || !auth.v1(g, sig)) return null;
      const derived = accessListFromEgressHosts(g.hosts);
      return { list: derived, rules: parseAccessList(derived).rules, auth: { v: 1, grant: g, signature: a.signature } };
    }
    return null;
  }

  /** The list the box enforces (the default list until the owner signs one). */
  list(serviceId: string): string {
    return this.entries.get(serviceId)?.list ?? DEFAULT_ACCESS_LIST;
  }

  rules(serviceId: string): AccessRule[] {
    return this.entries.get(serviceId)?.rules ?? [];
  }

  held(serviceId: string): StoredAccessAuthority | null {
    return this.entries.get(serviceId)?.auth ?? null;
  }

  heldIssuedAt(serviceId: string): number | null {
    return this.entries.get(serviceId)?.auth.grant.issuedAt ?? null;
  }

  /** Apply a verified list. Requests the list now answers go away, and so does a draft. */
  async putSigned(serviceId: string, list: string, auth: StoredAccessAuthority): Promise<void> {
    const rules = parseAccessList(list).rules;
    this.entries.set(serviceId, { list, rules, auth });
    const a = this.apps.get(serviceId);
    if (a) {
      a.draft = null;
      for (const host of [...a.pending.keys()]) if (coveringRule(rules, host)) a.pending.delete(host);
      for (const host of [...a.dismissed.keys()]) if (coveringRule(rules, host)) a.dismissed.delete(host);
    }
    await this.save();
  }

  /**
   * The gateway denied `host` to the app because no rule matched. Returns the
   * request (and whether it is new), or null when the host isn't one to ask
   * about (not a public name, dismissed recently, or the app's list is full).
   */
  recordAttempt(serviceId: string, rawHost: string): { request: AccessRequest; created: boolean } | null {
    const host = askableHost(rawHost);
    if (!host) return null;
    const t = this.now();
    const a = this.app(serviceId);
    if ((a.dismissed.get(host) ?? 0) > t) return null;
    const existing = a.pending.get(host);
    if (existing) {
      if (t - existing.lastSeen >= ATTEMPT_COALESCE_MS || existing.attempts === 0) existing.attempts++;
      existing.lastSeen = t;
      this.saveSoon();
      return { request: { ...existing }, created: false };
    }
    if (!this.makeRoom(a)) return null;
    const request: AccessRequest = { host, source: "attempt", attempts: 1, firstSeen: t, lastSeen: t };
    a.pending.set(host, request);
    this.saveSoon();
    return { request: { ...request }, created: true };
  }

  /**
   * The hosts a manifest suggests (`network.egress`, at install and on each
   * update). When one the box hasn't suggested before is still undecided,
   * it drafts the current list with an `allow <host>   # <why>` line on top
   * for every undecided host, replacing an unanswered draft. Returns the new
   * draft, or null when nothing is new.
   *
   * "Undecided": no rule allows it, and no rule names it to deny it (an
   * explicit `deny <host>` is the owner's answer; a `deny all` is not).
   */
  async draftFromDeclared(serviceId: string, suggestions: readonly EgressSuggestion[]): Promise<AccessDraft | null> {
    const rules = this.rules(serviceId);
    const a = this.app(serviceId);
    const hosts: EgressSuggestion[] = [];
    for (const s of suggestions) {
      const c = checkAccessTarget(s.host);
      if ("error" in c || c.target === "all" || hosts.some((h) => h.host === c.target)) continue;
      const rule = coveringRule(rules, c.target);
      if (rule && (rule.action === "allow" || rule.target !== "all")) continue;
      hosts.push(s.why ? { host: c.target, why: s.why } : { host: c.target });
    }
    if (!hosts.some((h) => !a.suggested.has(h.host))) return null;
    const current = this.list(serviceId);
    const top = hosts.map((h) => `allow ${h.host}${h.why ? `${DRAFT_WHY_SEP}${oneLine(h.why)}` : ""}`).join("\n");
    const list = normalizeAccessList(`${top}\n${current}`);
    const draft: AccessDraft = { list, listSha256: accessListSha256(list), hosts, createdAt: this.now() };
    a.draft = draft;
    for (const h of hosts) a.suggested.add(h.host);
    // Hosts the draft carries no longer wait as separate requests.
    for (const h of hosts) if (a.pending.get(h.host)?.source === "app") a.pending.delete(h.host);
    await this.save();
    return cloneDraft(draft);
  }

  /** The app's unanswered draft, or null. */
  draft(serviceId: string): AccessDraft | null {
    const d = this.apps.get(serviceId)?.draft;
    return d ? cloneDraft(d) : null;
  }

  /** Discard the draft (changes nothing the app can reach). False when there was none. */
  async dismissDraft(serviceId: string): Promise<boolean> {
    const a = this.apps.get(serviceId);
    if (!a?.draft) return false;
    a.draft = null;
    await this.save();
    return true;
  }

  draftServiceIds(): string[] {
    return [...this.apps.entries()].filter(([, a]) => a.draft !== null).map(([id]) => id);
  }

  /** Ignore: forget the request and keep the host quiet for a week. */
  async dismiss(serviceId: string, rawHost: string): Promise<boolean> {
    const c = checkAccessTarget(rawHost.trim());
    if ("error" in c) return false;
    const a = this.app(serviceId);
    a.pending.delete(c.target);
    const t = this.now();
    for (const [h, until] of a.dismissed) if (until <= t) a.dismissed.delete(h);
    if (a.dismissed.size < 500) a.dismissed.set(c.target, t + DISMISS_QUIET_MS);
    await this.save();
    return true;
  }

  /** Newest first. */
  pending(serviceId: string): AccessRequest[] {
    const a = this.apps.get(serviceId);
    if (!a) return [];
    return [...a.pending.values()].map((r) => ({ ...r })).sort((x, y) => y.lastSeen - x.lastSeen);
  }

  pendingServiceIds(): string[] {
    return [...this.apps.entries()].filter(([, a]) => a.pending.size > 0).map(([id]) => id);
  }

  serviceIds(): string[] {
    return [...new Set([...this.entries.keys(), ...this.apps.keys()])];
  }

  /**
   * May the box push an alert for this app and host now? At most one per app
   * and host per day and ALERTS_PER_HOUR per box. Records the alert when yes.
   */
  takeAlert(serviceId: string, host: string): boolean {
    const t = this.now();
    const key = `${serviceId} ${host}`;
    if ((this.alertedAt.get(key) ?? -Infinity) > t - ALERT_PER_HOST_MS) return false;
    this.recentAlerts = this.recentAlerts.filter((x) => x > t - HOUR_MS);
    if (this.recentAlerts.length >= ALERTS_PER_HOUR) return false;
    for (const [k, at] of this.alertedAt) if (at <= t - ALERT_PER_HOST_MS) this.alertedAt.delete(k);
    this.alertedAt.set(key, t);
    this.recentAlerts.push(t);
    this.saveSoon();
    return true;
  }

  /** Uninstall: drop the app's list, requests and alert history. Idempotent. */
  async forget(serviceId: string): Promise<void> {
    const hadList = this.entries.delete(serviceId);
    const hadState = this.apps.delete(serviceId);
    const had = hadList || hadState;
    for (const k of [...this.alertedAt.keys()]) if (k.startsWith(`${serviceId} `)) this.alertedAt.delete(k);
    if (had) await this.save();
  }

  /** Write any debounced changes now. */
  flush(): Promise<void> {
    if (!this.saveTimer) return this.chain;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return this.save();
  }

  private app(serviceId: string): PerApp {
    let a = this.apps.get(serviceId);
    if (!a) {
      a = { pending: new Map(), dismissed: new Map(), draft: null, suggested: new Set() };
      this.apps.set(serviceId, a);
    }
    return a;
  }

  /** Keep the per-app cap: evict the stalest attempt; never evict what the manifest declared. */
  private makeRoom(a: PerApp): boolean {
    if (a.pending.size < PENDING_MAX_PER_APP) return true;
    let oldest: AccessRequest | null = null;
    for (const r of a.pending.values()) {
      if (r.source === "attempt" && (!oldest || r.lastSeen < oldest.lastSeen)) oldest = r;
    }
    if (!oldest) return false;
    a.pending.delete(oldest.host);
    return true;
  }

  private saveSoon(): void {
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private save(): Promise<void> {
    const path = this.path;
    const swk = this.swk;
    if (!path || !swk) return Promise.resolve();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const snapshot = {
      v: 2,
      lists: [...this.entries.entries()].map(([serviceId, e]) => ({
        serviceId,
        ...(e.auth.v === 2 ? { list: e.list } : {}),
        auth: e.auth,
      })),
      requests: Object.fromEntries([...this.apps.entries()].map(([id, a]) => [id, [...a.pending.values()]])),
      dismissed: Object.fromEntries([...this.apps.entries()].map(([id, a]) => [id, Object.fromEntries(a.dismissed)])),
      drafts: Object.fromEntries([...this.apps.entries()].filter(([, a]) => a.draft).map(([id, a]) => [id, a.draft])),
      suggested: Object.fromEntries([...this.apps.entries()].filter(([, a]) => a.suggested.size > 0).map(([id, a]) => [id, [...a.suggested]])),
      alerts: { hosts: Object.fromEntries(this.alertedAt), recent: this.recentAlerts },
    };
    const next = this.chain.then(async () => {
      const blob = swk.sealWithSwk(new TextEncoder().encode(JSON.stringify(snapshot)));
      const hex = Buffer.concat([Buffer.from(blob.nonce), Buffer.from(blob.ciphertext)]).toString("hex");
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, hex, { mode: 0o600 });
      await rename(tmp, path);
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function cloneDraft(d: AccessDraft): AccessDraft {
  return { ...d, hosts: d.hosts.map((h) => ({ ...h })) };
}

function parseDraft(v: unknown): AccessDraft | null {
  if (typeof v !== "object" || v === null) return null;
  const d = v as Record<string, unknown>;
  if (typeof d.list !== "string" || typeof d.createdAt !== "number" || !Array.isArray(d.hosts)) return null;
  const hosts: EgressSuggestion[] = [];
  for (const h of d.hosts as Array<Record<string, unknown>>) {
    if (typeof h?.host !== "string") return null;
    hosts.push(typeof h.why === "string" ? { host: h.host, why: h.why } : { host: h.host });
  }
  return { list: d.list, listSha256: accessListSha256(d.list), hosts, createdAt: d.createdAt };
}

/** A denied name worth asking the owner about: a public host a list could allow. */
export function askableHost(raw: string): string | null {
  const c = checkAccessTarget(raw.trim());
  if ("error" in c || c.target === "all" || c.target.startsWith("*.")) return null;
  if (PRIVATE_SUFFIXES.some((s) => c.target.endsWith(s))) return null;
  return c.target;
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
