/**
 * The one registry of voi.ci paths (docs/voici-namespace-spec.md, migration 0127): every username, custom link name,
 * code and reserved word is a row of `names`, and a partial UNIQUE index on the safety key (status <> 'released')
 * is the only collision check. A claim is one INSERT; a unique violation means "taken or too similar".
 *
 * Kinds and their statuses: username active | held | released; link and code active | retired (never released, so
 * they block for ever, D7); reserved active. `owner` is the account's username (accounts are keyed by it), NULL for
 * reserved words. A held username redirects to its owner's active username while the account lives, and answers 404
 * once the account is gone; a job releases it when `held_until` passes (GRACE, `NAME_HOLD_MS`).
 */
import { voiciNameKey } from "@flagship/protocol";
import type { D1Database, D1PreparedStatement } from "./d1.js";

export type NameKind = "username" | "link" | "code" | "reserved";
export type NameStatus = "active" | "held" | "released" | "retired";

/** GRACE (owner clarification 1): a given-up username is held 30 days, then released to anyone. */
export const NAME_HOLD_MS = 30 * 86_400_000;

export interface NameRecord {
  id: number;
  name: string;
  safetyKey: string;
  kind: NameKind;
  status: NameStatus;
  owner: string | null;
  serviceId: string | null;
  target: string | null;
  expiresAt: number | null;
  heldUntil: number | null;
  lastActiveAt: number | null;
  warned: number;
  reason: string | null;
  createdAt: number;
  statusChangedAt: number;
}

/** The columns a new row sets; the rest default. */
export interface NewName {
  name: string;
  kind: NameKind;
  owner?: string | null;
  serviceId?: string | null;
  target?: string | null;
  expiresAt?: number | null;
  lastActiveAt?: number | null;
  at: number;
}

export interface NameRegistryStorage {
  /** The row (any status but released) whose name is exactly `name`; lookups never fold (pluckyavocet is not plucky-avocet). */
  lookup(name: string, kind?: NameKind): Promise<NameRecord | undefined>;
  /** True when a row that still blocks holds `name`'s safety key: a claim of it would be refused. */
  isTaken(name: string): Promise<boolean>;
  /** The account's active username row. None: the account is gone (or never was). */
  activeUsername(owner: string): Promise<NameRecord | undefined>;
  /** Reserved words from the config file. A word whose key is already blocked is left out and reported. */
  addReserved(words: readonly string[], at: number): Promise<{ added: string[]; conflicts: string[] }>;
  /** The scheduled job: held usernames whose hold ended at or before `now` are released. */
  releaseExpiredHolds(now: number): Promise<number>;
  /**
   * The registry half of a rename (the action itself ships with feat/custom-names): in one transaction insert `to`
   * as the account's active username and hold its current one for `holdMs`. If `to` is taken nothing changes.
   */
  renameUsername(owner: string, to: string, now: number, holdMs?: number): Promise<{ ok: true } | { ok: false; reason: "taken" | "no-account" }>;
}

export function isUniqueViolation(e: unknown): boolean {
  return /unique constraint|constraint failed|SQLITE_CONSTRAINT/i.test(e instanceof Error ? e.message : String(e));
}

// ── D1 ──────────────────────────────────────────────────────────────────────

interface NameRow {
  id: number;
  name: string;
  safety_key: string;
  kind: string;
  status: string;
  owner: string | null;
  service_id: string | null;
  target: string | null;
  expires_at: number | null;
  held_until: number | null;
  last_active_at: number | null;
  warned: number | null;
  reason: string | null;
  created_at: number;
  status_changed_at: number;
}

export const NAME_COLS =
  "id, name, safety_key, kind, status, owner, service_id, target, expires_at, held_until, last_active_at, warned, reason, created_at, status_changed_at";

export function rowToName(r: NameRow): NameRecord {
  return {
    id: r.id,
    name: r.name,
    safetyKey: r.safety_key,
    kind: r.kind as NameKind,
    status: r.status as NameStatus,
    owner: r.owner,
    serviceId: r.service_id,
    target: r.target,
    expiresAt: r.expires_at,
    heldUntil: r.held_until,
    lastActiveAt: r.last_active_at,
    warned: r.warned ?? 0,
    reason: r.reason,
    createdAt: r.created_at,
    statusChangedAt: r.status_changed_at,
  };
}

/** The INSERT that claims a name: it throws a unique violation when the safety key is taken. */
export function claimNameStatement(db: D1Database, n: NewName): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO names (name, safety_key, kind, status, owner, service_id, target, expires_at, last_active_at, warned, created_at, status_changed_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)`,
    )
    .bind(n.name, voiciNameKey(n.name), n.kind, n.owner ?? null, n.serviceId ?? null, n.target ?? null, n.expiresAt ?? null, n.lastActiveAt ?? null, n.at);
}

/** Claims `name` as `owner`'s active username unless that exact row already exists (a re-claim by the account). */
export function claimUsernameStatement(db: D1Database, name: string, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO names (name, safety_key, kind, status, owner, warned, created_at, status_changed_at)
       SELECT ?1, ?2, 'username', 'active', ?1, 0, ?3, ?3
       WHERE NOT EXISTS (SELECT 1 FROM names WHERE kind = 'username' AND name = ?1 AND owner = ?1 AND status = 'active')`,
    )
    .bind(name, voiciNameKey(name), at);
}

/** Account deletion: its usernames are held for GRACE, its links and codes retired for good. */
export function accountGoneStatements(db: D1Database, owner: string, at: number, holdMs = NAME_HOLD_MS): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE names SET status = 'held', held_until = ?2, reason = 'deleted', status_changed_at = ?3 WHERE kind = 'username' AND owner = ?1 AND status = 'active'")
      .bind(owner, at + holdMs, at),
    db
      .prepare("UPDATE names SET status = 'retired', reason = 'deleted', status_changed_at = ?2 WHERE kind IN ('link', 'code') AND owner = ?1 AND status = 'active'")
      .bind(owner, at),
  ];
}

/** An operator teardown of a demo account: its usernames are released at once (no person waits on them). */
export function demoGoneStatements(db: D1Database, owner: string, at: number): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE names SET status = 'released', held_until = NULL, reason = 'demo-cleanup', status_changed_at = ?2 WHERE kind = 'username' AND owner = ?1 AND status IN ('active', 'held')")
      .bind(owner, at),
    db
      .prepare("UPDATE names SET status = 'retired', reason = 'deleted', status_changed_at = ?2 WHERE kind IN ('link', 'code') AND owner = ?1 AND status = 'active'")
      .bind(owner, at),
  ];
}

export class D1NameRegistryStorage implements NameRegistryStorage {
  constructor(private readonly db: D1Database) {}

  async lookup(name: string, kind?: NameKind) {
    const r = await this.db
      .prepare(`SELECT ${NAME_COLS} FROM names WHERE name = ?1 AND status <> 'released' ${kind ? "AND kind = ?2 " : ""}ORDER BY id DESC LIMIT 1`)
      .bind(...(kind ? [name, kind] : [name]))
      .first<NameRow>();
    return r ? rowToName(r) : undefined;
  }

  async isTaken(name: string) {
    const r = await this.db
      .prepare("SELECT 1 AS hit FROM names WHERE safety_key = ?1 AND status <> 'released' LIMIT 1")
      .bind(voiciNameKey(name))
      .first<{ hit: number }>();
    return !!r;
  }

  async activeUsername(owner: string) {
    const r = await this.db
      .prepare(`SELECT ${NAME_COLS} FROM names WHERE kind = 'username' AND owner = ?1 AND status = 'active' ORDER BY id DESC LIMIT 1`)
      .bind(owner.toLowerCase())
      .first<NameRow>();
    return r ? rowToName(r) : undefined;
  }

  async addReserved(words: readonly string[], at: number) {
    const added: string[] = [];
    const conflicts: string[] = [];
    // One read in the usual case (every word already in): only a new word costs a write.
    const have = await this.db.prepare("SELECT name FROM names WHERE kind = 'reserved' AND status = 'active'").all<{ name: string }>();
    const present = new Set((have.results ?? []).map((r) => r.name));
    for (const w of [...new Set(words.map((x) => x.toLowerCase()))]) {
      if (present.has(w)) continue;
      try {
        await claimNameStatement(this.db, { name: w, kind: "reserved", at }).run();
        added.push(w);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        conflicts.push(w);
      }
    }
    return { added, conflicts };
  }

  async releaseExpiredHolds(now: number) {
    const r = await this.db
      .prepare("UPDATE names SET status = 'released', status_changed_at = ?1 WHERE kind = 'username' AND status = 'held' AND held_until <= ?1")
      .bind(now)
      .run();
    return r.meta?.changes ?? 0;
  }

  async renameUsername(owner: string, to: string, now: number, holdMs = NAME_HOLD_MS) {
    const o = owner.toLowerCase();
    const current = await this.activeUsername(o);
    if (!current) return { ok: false as const, reason: "no-account" as const };
    try {
      await this.db.batch([
        this.db
          .prepare("UPDATE names SET status = 'held', held_until = ?2, reason = 'renamed', status_changed_at = ?3 WHERE id = ?1 AND status = 'active'")
          .bind(current.id, now + holdMs, now),
        claimNameStatement(this.db, { name: to.toLowerCase(), kind: "username", owner: o, at: now }),
      ]);
      return { ok: true as const };
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false as const, reason: "taken" as const };
      throw e;
    }
  }
}

// ── in memory ───────────────────────────────────────────────────────────────

/** The same registry in memory: one instance is shared by the username, link and code stores (InMemoryStorage). */
export class InMemoryNameRegistryStorage implements NameRegistryStorage {
  readonly rows: NameRecord[] = [];
  private nextId = 1;

  constructor(reserved: readonly string[] = [], at = 0) {
    for (const w of reserved) this.claim({ name: w.toLowerCase(), kind: "reserved", at });
  }

  private blocking(key: string): NameRecord | undefined {
    return this.rows.find((r) => r.safetyKey === key && r.status !== "released");
  }

  /** The INSERT: refused when the safety key is taken. */
  claim(n: NewName): { ok: true; row: NameRecord } | { ok: false; reason: "taken" } {
    const key = voiciNameKey(n.name);
    if (this.blocking(key)) return { ok: false, reason: "taken" };
    const row: NameRecord = {
      id: this.nextId++,
      name: n.name,
      safetyKey: key,
      kind: n.kind,
      status: "active",
      owner: n.owner ?? null,
      serviceId: n.serviceId ?? null,
      target: n.target ?? null,
      expiresAt: n.expiresAt ?? null,
      heldUntil: null,
      lastActiveAt: n.lastActiveAt ?? null,
      warned: 0,
      reason: null,
      createdAt: n.at,
      statusChangedAt: n.at,
    };
    this.rows.push(row);
    return { ok: true, row };
  }

  live(kind?: NameKind): NameRecord[] {
    return this.rows.filter((r) => r.status !== "released" && (!kind || r.kind === kind));
  }

  accountGone(owner: string, at: number, holdMs = NAME_HOLD_MS): void {
    for (const r of this.rows) {
      if (r.owner !== owner || r.status !== "active") continue;
      if (r.kind === "username") Object.assign(r, { status: "held", heldUntil: at + holdMs, reason: "deleted", statusChangedAt: at });
      else if (r.kind === "link" || r.kind === "code") Object.assign(r, { status: "retired", reason: "deleted", statusChangedAt: at });
    }
  }

  demoGone(owner: string, at: number): void {
    for (const r of this.rows) {
      if (r.owner !== owner) continue;
      if (r.kind === "username" && (r.status === "active" || r.status === "held")) Object.assign(r, { status: "released", heldUntil: null, reason: "demo-cleanup", statusChangedAt: at });
      else if ((r.kind === "link" || r.kind === "code") && r.status === "active") Object.assign(r, { status: "retired", reason: "deleted", statusChangedAt: at });
    }
  }

  async lookup(name: string, kind?: NameKind) {
    const hits = this.live(kind).filter((r) => r.name === name);
    const r = hits[hits.length - 1];
    return r ? { ...r } : undefined;
  }

  async isTaken(name: string) {
    return !!this.blocking(voiciNameKey(name));
  }

  async activeUsername(owner: string) {
    const o = owner.toLowerCase();
    const r = this.rows.filter((x) => x.kind === "username" && x.owner === o && x.status === "active").pop();
    return r ? { ...r } : undefined;
  }

  async addReserved(words: readonly string[], at: number) {
    const added: string[] = [];
    const conflicts: string[] = [];
    for (const raw of words) {
      const w = raw.toLowerCase();
      const held = this.blocking(voiciNameKey(w));
      if (held) {
        if (!(held.kind === "reserved" && held.name === w)) conflicts.push(w);
        continue;
      }
      this.claim({ name: w, kind: "reserved", at });
      added.push(w);
    }
    return { added, conflicts };
  }

  async releaseExpiredHolds(now: number) {
    let n = 0;
    for (const r of this.rows) {
      if (r.kind === "username" && r.status === "held" && r.heldUntil !== null && r.heldUntil <= now) {
        Object.assign(r, { status: "released", statusChangedAt: now });
        n++;
      }
    }
    return n;
  }

  async renameUsername(owner: string, to: string, now: number, holdMs = NAME_HOLD_MS) {
    const o = owner.toLowerCase();
    const current = this.rows.filter((x) => x.kind === "username" && x.owner === o && x.status === "active").pop();
    if (!current) return { ok: false as const, reason: "no-account" as const };
    // One transaction: the new name must be free (the current name, held, still blocks its own look-alikes).
    if (this.blocking(voiciNameKey(to))) return { ok: false as const, reason: "taken" as const };
    Object.assign(current, { status: "held", heldUntil: now + holdMs, reason: "renamed", statusChangedAt: now });
    this.claim({ name: to.toLowerCase(), kind: "username", owner: o, at: now });
    return { ok: true as const };
  }
}
