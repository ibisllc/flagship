/**
 * Enterprise org accounts (migration 0141, docs/enterprise-accounts.md §6, §11): org rows, the
 * signed org objects `.com` relays (verified before storing; readers verify again) and the org's
 * audit hash chain.
 */
import { ORG_LOG_GENESIS as PROTOCOL_LOG_GENESIS, orgLogEntryHash as protocolLogEntryHash } from "@flagship/protocol";
import type { D1Database } from "./d1.js";

export interface OrgRecord {
  orgId: string;
  name: string;
  genesisHash: string;
  planTier: string;
  /** null = no seat limit. */
  seatLimit: number | null;
  /** null = not on a paid term (a trial or an invoice not yet tracked here). */
  paidUntil: number | null;
  createdAt: number;
  /** The trial's end (migration 0156); null = the row predates 0156, `.com` derives it from `createdAt`. */
  trialEndsAt?: number | null;
  /** Seats the org's vouchers pay for (0 or null: none yet). */
  paidSeats?: number | null;
}

export interface OrgPlanUpdate {
  planTier: string;
  seatLimit: number | null;
  paidUntil: number | null;
  paidSeats?: number;
  trialEndsAt?: number;
}

/** `authority` keys by version (zero-padded), the others by their object's id or digest. */
export type OrgObjectKind =
  | "authority"
  | "invite"
  | "accept"
  | "grant"
  | "revoke"
  | "freeze"
  | "overturn"
  | "veto"
  | "ceremony"
  /** A server code (the org's AuthCode), keyed by serial; `usedAt` is set in the body once a box registered with it. */
  | "server-code"
  /** A registered org server, keyed by its domain. */
  | "server"
  /** One version of a key-ring key, keyed `<kind>|<scope>|<version zero-padded>`. */
  | "key-ring"
  /** A seat's X-Wing key statement, keyed by seat id (newest wins). */
  | "seat-kem"
  /** A box's X-Wing key statement, keyed by server domain (newest wins). */
  | "box-kem"
  /** A box's own signed Activity log head, keyed by server domain (newest wins). */
  | "box-log-head"
  /** Every box log head the org log names, keyed `<domain>|<seq zero-padded>|<head hash>` (the audit export carries all). */
  | "box-log-head-seen"
  /** Every server registration the org log names, keyed `<domain>|<STK hex>` (a re-registered server keeps its earlier ones). */
  | "server-registration"
  /** A sealed directory entry (docs/org-directory.md §2), keyed by its opaque entry id (newest wins). */
  | "directory"
  /** A directory connector's authority record, keyed by connector id (newest wins). */
  | "connector"
  /** A connector's proposal, keyed by proposal id; `decided` is set in the body once an admin acted on it. */
  | "proposal"
  /** A member's sealed slice of the directory, keyed by seat id (newest wins). */
  | "directory-slice";

export interface OrgObject {
  kind: OrgObjectKind;
  key: string;
  bodyJson: string;
  issuedAt: number;
  storedAt: number;
}

export interface OrgLogEntry {
  seq: number;
  prevHash: string;
  entryHash: string;
  kind: string;
  refSha256: string;
  at: number;
}

export interface OrgStorage {
  /** False when the id or the name is taken. */
  createOrg(rec: OrgRecord): Promise<boolean>;
  getOrg(orgId: string): Promise<OrgRecord | null>;
  getOrgByName(name: string): Promise<OrgRecord | null>;
  setPlan(orgId: string, plan: OrgPlanUpdate): Promise<void>;
  /** setPlan only while the stored paid end is still `expectPaidUntil` (null = none): false when another spend won. */
  setPlanIf(orgId: string, plan: OrgPlanUpdate, expectPaidUntil: number | null): Promise<boolean>;
  /** Inserts; when `replace` is false an existing key is left alone and false is returned. */
  putObject(orgId: string, obj: OrgObject, replace?: boolean): Promise<boolean>;
  /**
   * Inserts a proposal (`decision` null) only while the org holds fewer than `maxOpen` undecided ones: the insert
   * holds the limit itself (security report F4, §6). False when the key exists, "full" at the limit.
   */
  putOpenProposal(orgId: string, obj: OrgObject, maxOpen: number): Promise<boolean | "full">;
  /**
   * Inserts a seat's grant or invite only while seat `seatId` is live or the org's live seats (seats with an
   * unexpired grant at `now` and no revoke) number fewer than `seatLimit`, counted by the insert itself. A null
   * limit is none. False when the key exists, "full" at the limit.
   */
  putSeatObject(orgId: string, obj: OrgObject, seatId: string, seatLimit: number | null, now: number): Promise<boolean | "full">;
  getObject(orgId: string, kind: OrgObjectKind, key: string): Promise<OrgObject | null>;
  listObjects(orgId: string, kind: OrgObjectKind): Promise<OrgObject[]>;
  deleteObject(orgId: string, kind: OrgObjectKind, key: string): Promise<void>;
  /** Appends to the org's hash chain and returns the new entry. */
  appendLog(orgId: string, kind: string, refSha256: string, at: number): Promise<OrgLogEntry>;
  listLog(orgId: string, afterSeq?: number): Promise<OrgLogEntry[]>;
  /** The org that issued server code `serial` (any org), or null: the install timeline accepts an org server's serial. */
  findServerCodeOrg(serial: string): Promise<string | null>;
}

export const ORG_LOG_GENESIS = PROTOCOL_LOG_GENESIS;

/** `sha256("flagship/org-log/v1|<orgId>|<seq>|<prevHash>|<kind>|<refSha256>|<at>")`; the audit export verifies the same hash. */
export const orgLogEntryHash = protocolLogEntryHash;

const byIssued = (a: OrgObject, b: OrgObject) => a.issuedAt - b.issuedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export class InMemoryOrgStorage implements OrgStorage {
  private readonly orgs = new Map<string, OrgRecord>();
  private readonly objects = new Map<string, Map<string, OrgObject>>();
  private readonly logs = new Map<string, OrgLogEntry[]>();

  async createOrg(rec: OrgRecord) {
    if (this.orgs.has(rec.orgId) || [...this.orgs.values()].some((o) => o.name === rec.name)) return false;
    this.orgs.set(rec.orgId, { ...rec });
    return true;
  }
  async getOrg(orgId: string) {
    const o = this.orgs.get(orgId);
    return o ? { ...o } : null;
  }
  async getOrgByName(name: string) {
    const o = [...this.orgs.values()].find((x) => x.name === name);
    return o ? { ...o } : null;
  }
  async setPlan(orgId: string, plan: OrgPlanUpdate) {
    const o = this.orgs.get(orgId);
    if (o) this.orgs.set(orgId, { ...o, ...plan });
  }
  async setPlanIf(orgId: string, plan: OrgPlanUpdate, expectPaidUntil: number | null) {
    const o = this.orgs.get(orgId);
    if (!o || (o.paidUntil ?? null) !== expectPaidUntil) return false;
    this.orgs.set(orgId, { ...o, ...plan });
    return true;
  }
  private bucket(orgId: string, kind: OrgObjectKind) {
    const k = `${orgId}|${kind}`;
    let m = this.objects.get(k);
    if (!m) this.objects.set(k, (m = new Map()));
    return m;
  }
  async putObject(orgId: string, obj: OrgObject, replace = false) {
    const m = this.bucket(orgId, obj.kind);
    if (m.has(obj.key) && !replace) return false;
    m.set(obj.key, { ...obj });
    return true;
  }
  async putOpenProposal(orgId: string, obj: OrgObject, maxOpen: number) {
    const m = this.bucket(orgId, obj.kind);
    if (m.has(obj.key)) return false;
    const open = [...m.values()].filter((o) => (JSON.parse(o.bodyJson) as { decision?: unknown }).decision == null).length;
    if (open >= maxOpen) return "full" as const;
    m.set(obj.key, { ...obj });
    return true;
  }
  async putSeatObject(orgId: string, obj: OrgObject, seatId: string, seatLimit: number | null, now: number) {
    const m = this.bucket(orgId, obj.kind);
    if (m.has(obj.key)) return false;
    if (seatLimit !== null) {
      const revoked = new Set(this.bucket(orgId, "revoke").keys());
      const live = new Set<string>();
      for (const o of this.bucket(orgId, "grant").values()) {
        const g = (JSON.parse(o.bodyJson) as { grant?: { seatId?: string; expiresAt?: number } }).grant;
        if (g?.seatId && (g.expiresAt ?? 0) > now && !revoked.has(g.seatId)) live.add(g.seatId);
      }
      if (!live.has(seatId) && live.size >= seatLimit) return "full" as const;
    }
    m.set(obj.key, { ...obj });
    return true;
  }
  async getObject(orgId: string, kind: OrgObjectKind, key: string) {
    const o = this.bucket(orgId, kind).get(key);
    return o ? { ...o } : null;
  }
  async listObjects(orgId: string, kind: OrgObjectKind) {
    return [...this.bucket(orgId, kind).values()].map((o) => ({ ...o })).sort(byIssued);
  }
  async findServerCodeOrg(serial: string) {
    for (const [k, m] of this.objects) {
      const [orgId, kind] = k.split("|");
      if (kind === "server-code" && m.has(serial)) return orgId!;
    }
    return null;
  }
  async deleteObject(orgId: string, kind: OrgObjectKind, key: string) {
    this.bucket(orgId, kind).delete(key);
  }
  async appendLog(orgId: string, kind: string, refSha256: string, at: number) {
    const log = this.logs.get(orgId) ?? [];
    const prev = log[log.length - 1];
    const seq = prev ? prev.seq + 1 : 1;
    const prevHash = prev ? prev.entryHash : ORG_LOG_GENESIS;
    const e: OrgLogEntry = { seq, prevHash, entryHash: orgLogEntryHash(orgId, seq, prevHash, kind, refSha256, at), kind, refSha256, at };
    log.push(e);
    this.logs.set(orgId, log);
    return { ...e };
  }
  async listLog(orgId: string, afterSeq = 0) {
    return (this.logs.get(orgId) ?? []).filter((e) => e.seq > afterSeq).map((e) => ({ ...e }));
  }
}

interface OrgRow {
  org_id: string;
  name: string;
  genesis_hash: string;
  plan_tier: string;
  seat_limit: number | null;
  paid_until: number | null;
  created_at: number;
  trial_ends_at?: number | null;
  paid_seats?: number | null;
}
interface ObjRow {
  kind: string;
  object_key: string;
  body_json: string;
  issued_at: number;
  stored_at: number;
}
interface LogRow {
  seq: number;
  prev_hash: string;
  entry_hash: string;
  kind: string;
  ref_sha256: string;
  at: number;
}

const orgOf = (r: OrgRow | null): OrgRecord | null =>
  r
    ? {
        orgId: r.org_id,
        name: r.name,
        genesisHash: r.genesis_hash,
        planTier: r.plan_tier,
        seatLimit: r.seat_limit,
        paidUntil: r.paid_until,
        createdAt: r.created_at,
        trialEndsAt: r.trial_ends_at ?? null,
        paidSeats: r.paid_seats ?? null,
      }
    : null;
const ORG_SELECT = `SELECT o.*, t.trial_ends_at AS trial_ends_at, t.paid_seats AS paid_seats FROM orgs o LEFT JOIN org_plan_terms t ON t.org_id = o.org_id`;
const objOf = (r: ObjRow): OrgObject => ({ kind: r.kind as OrgObjectKind, key: r.object_key, bodyJson: r.body_json, issuedAt: r.issued_at, storedAt: r.stored_at });
const logOf = (r: LogRow): OrgLogEntry => ({ seq: r.seq, prevHash: r.prev_hash, entryHash: r.entry_hash, kind: r.kind, refSha256: r.ref_sha256, at: r.at });

export class D1OrgStorage implements OrgStorage {
  constructor(private readonly db: D1Database) {}

  async createOrg(rec: OrgRecord) {
    const r = await this.db
      .prepare(
        `INSERT INTO orgs (org_id, name, genesis_hash, plan_tier, seat_limit, paid_until, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING`,
      )
      .bind(rec.orgId, rec.name, rec.genesisHash, rec.planTier, rec.seatLimit, rec.paidUntil, rec.createdAt)
      .run();
    const created = (r.meta.changes ?? 0) > 0;
    if (created && typeof rec.trialEndsAt === "number") {
      await this.db
        .prepare(`INSERT INTO org_plan_terms (org_id, trial_ends_at, paid_seats, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING`)
        .bind(rec.orgId, rec.trialEndsAt, rec.paidSeats ?? 0, rec.createdAt)
        .run();
    }
    return created;
  }
  async getOrg(orgId: string) {
    return orgOf(await this.db.prepare(`${ORG_SELECT} WHERE o.org_id = ?1`).bind(orgId).first<OrgRow>());
  }
  async getOrgByName(name: string) {
    return orgOf(await this.db.prepare(`${ORG_SELECT} WHERE o.name = ?1`).bind(name).first<OrgRow>());
  }
  private termsStatement(orgId: string, plan: OrgPlanUpdate) {
    if (plan.paidSeats === undefined && plan.trialEndsAt === undefined) return null;
    return this.db
      .prepare(
        `INSERT INTO org_plan_terms (org_id, trial_ends_at, paid_seats, updated_at)
         VALUES (?1, COALESCE(?2, (SELECT created_at FROM orgs WHERE org_id = ?1)), COALESCE(?3, 0), ?4)
         ON CONFLICT(org_id) DO UPDATE SET trial_ends_at = COALESCE(?2, trial_ends_at), paid_seats = COALESCE(?3, paid_seats), updated_at = ?4`,
      )
      .bind(orgId, plan.trialEndsAt ?? null, plan.paidSeats ?? null, Date.now());
  }
  async setPlan(orgId: string, plan: OrgPlanUpdate) {
    await this.db
      .prepare(`UPDATE orgs SET plan_tier = ?2, seat_limit = ?3, paid_until = ?4 WHERE org_id = ?1`)
      .bind(orgId, plan.planTier, plan.seatLimit, plan.paidUntil)
      .run();
    const t = this.termsStatement(orgId, plan);
    if (t) await t.run();
  }
  async setPlanIf(orgId: string, plan: OrgPlanUpdate, expectPaidUntil: number | null) {
    const r = await this.db
      .prepare(`UPDATE orgs SET plan_tier = ?2, seat_limit = ?3, paid_until = ?4 WHERE org_id = ?1 AND IFNULL(paid_until, -1) = ?5`)
      .bind(orgId, plan.planTier, plan.seatLimit, plan.paidUntil, expectPaidUntil ?? -1)
      .run();
    if ((r.meta.changes ?? 0) === 0) return false;
    const t = this.termsStatement(orgId, plan);
    if (t) await t.run();
    return true;
  }
  async putObject(orgId: string, obj: OrgObject, replace = false) {
    const sql = replace
      ? `INSERT INTO org_objects (org_id, kind, object_key, body_json, issued_at, stored_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(org_id, kind, object_key) DO UPDATE SET body_json = excluded.body_json, issued_at = excluded.issued_at, stored_at = excluded.stored_at`
      : `INSERT INTO org_objects (org_id, kind, object_key, body_json, issued_at, stored_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`;
    const r = await this.db.prepare(sql).bind(orgId, obj.kind, obj.key, obj.bodyJson, obj.issuedAt, obj.storedAt).run();
    return (r.meta.changes ?? 0) > 0;
  }
  async putOpenProposal(orgId: string, obj: OrgObject, maxOpen: number) {
    const r = await this.db
      .prepare(
        `INSERT INTO org_objects (org_id, kind, object_key, body_json, issued_at, stored_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE (SELECT COUNT(*) FROM org_objects WHERE org_id = ?1 AND kind = ?2 AND json_extract(body_json, '$.decision') IS NULL) < ?7
         ON CONFLICT DO NOTHING`,
      )
      .bind(orgId, obj.kind, obj.key, obj.bodyJson, obj.issuedAt, obj.storedAt, maxOpen)
      .run();
    if ((r.meta.changes ?? 0) > 0) return true;
    return (await this.getObject(orgId, obj.kind, obj.key)) ? false : ("full" as const);
  }
  async putSeatObject(orgId: string, obj: OrgObject, seatId: string, seatLimit: number | null, now: number) {
    const liveGrant = `kind = 'grant' AND json_extract(body_json, '$.grant.expiresAt') > ?9
      AND json_extract(body_json, '$.grant.seatId') NOT IN (SELECT object_key FROM org_objects WHERE org_id = ?1 AND kind = 'revoke')`;
    const r = await this.db
      .prepare(
        `INSERT INTO org_objects (org_id, kind, object_key, body_json, issued_at, stored_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE ?8 IS NULL
             OR EXISTS (SELECT 1 FROM org_objects WHERE org_id = ?1 AND ${liveGrant} AND json_extract(body_json, '$.grant.seatId') = ?7)
             OR (SELECT COUNT(DISTINCT json_extract(body_json, '$.grant.seatId')) FROM org_objects WHERE org_id = ?1 AND ${liveGrant}) < ?8
         ON CONFLICT DO NOTHING`,
      )
      .bind(orgId, obj.kind, obj.key, obj.bodyJson, obj.issuedAt, obj.storedAt, seatId, seatLimit, now)
      .run();
    if ((r.meta.changes ?? 0) > 0) return true;
    return (await this.getObject(orgId, obj.kind, obj.key)) ? false : ("full" as const);
  }
  async getObject(orgId: string, kind: OrgObjectKind, key: string) {
    const r = await this.db
      .prepare(`SELECT kind, object_key, body_json, issued_at, stored_at FROM org_objects WHERE org_id = ?1 AND kind = ?2 AND object_key = ?3`)
      .bind(orgId, kind, key)
      .first<ObjRow>();
    return r ? objOf(r) : null;
  }
  async listObjects(orgId: string, kind: OrgObjectKind) {
    const r = await this.db
      .prepare(`SELECT kind, object_key, body_json, issued_at, stored_at FROM org_objects WHERE org_id = ?1 AND kind = ?2 ORDER BY issued_at, object_key`)
      .bind(orgId, kind)
      .all<ObjRow>();
    return r.results.map(objOf);
  }
  async findServerCodeOrg(serial: string) {
    const r = await this.db
      .prepare(`SELECT org_id FROM org_objects WHERE kind = 'server-code' AND object_key = ?1 LIMIT 1`)
      .bind(serial)
      .first<{ org_id: string }>();
    return r?.org_id ?? null;
  }
  async deleteObject(orgId: string, kind: OrgObjectKind, key: string) {
    await this.db.prepare(`DELETE FROM org_objects WHERE org_id = ?1 AND kind = ?2 AND object_key = ?3`).bind(orgId, kind, key).run();
  }
  async appendLog(orgId: string, kind: string, refSha256: string, at: number) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const prev = await this.db
        .prepare(`SELECT seq, prev_hash, entry_hash, kind, ref_sha256, at FROM org_log WHERE org_id = ?1 ORDER BY seq DESC LIMIT 1`)
        .bind(orgId)
        .first<LogRow>();
      const seq = prev ? prev.seq + 1 : 1;
      const prevHash = prev ? prev.entry_hash : ORG_LOG_GENESIS;
      const entryHash = orgLogEntryHash(orgId, seq, prevHash, kind, refSha256, at);
      const r = await this.db
        .prepare(`INSERT INTO org_log (org_id, seq, prev_hash, entry_hash, kind, ref_sha256, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING`)
        .bind(orgId, seq, prevHash, entryHash, kind, refSha256, at)
        .run();
      if ((r.meta.changes ?? 0) > 0) return { seq, prevHash, entryHash, kind, refSha256, at };
    }
    throw new Error("org log: too many concurrent appends");
  }
  async listLog(orgId: string, afterSeq = 0) {
    const r = await this.db
      .prepare(`SELECT seq, prev_hash, entry_hash, kind, ref_sha256, at FROM org_log WHERE org_id = ?1 AND seq > ?2 ORDER BY seq LIMIT 1000`)
      .bind(orgId, afterSeq)
      .all<LogRow>();
    return r.results.map(logOf);
  }
}
