/**
 * Direct access on `.com` (docs/direct-access-and-domains.md §6 step 3, migration 0133): the owner's signed
 * direct-access order per box with the box's newest address update inside it, and the direct-name registry. `.com`
 * verifies every signature before storing; these stores only keep the newest of each.
 */
import type { D1Database } from "./d1.js";

export interface DirectAccessRecord {
  serverDomain: string;
  username: string;
  orderJson: string;
  signatureHex: string;
  pqSignatureJson?: string | null;
  orderSha256: string;
  enabled: boolean;
  issuedAt: number;
  updateJson?: string | null;
  updateSignatureHex?: string | null;
  updateIssuedAt?: number | null;
  updatedAt: number;
}

export type DirectNameKindValue = "derived" | "vanity";
export type DirectPublishState = "pending" | "published" | "empty";

export interface DirectNameRecord {
  /** The label under the direct apex. */
  name: string;
  username: string;
  kind: DirectNameKindValue;
  serverDomain: string;
  enabled: boolean;
  orderJson: string;
  signatureHex: string;
  pqSignatureJson?: string | null;
  issuedAt: number;
  suspendedAt?: number | null;
  suspendedReason?: string | null;
  /** JSON `[{type, content}]`: what the zone holds now. */
  publishedJson: string;
  publishState: DirectPublishState;
  publishReason?: string | null;
  publishError?: string | null;
  publishedAt?: number | null;
  probeAt?: number | null;
  probeJson?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type PutResult = { ok: true } | { ok: false; reason: "stale" | "taken" };

export interface DirectAccessStorage {
  getOrder(serverDomain: string): Promise<DirectAccessRecord | null>;
  listOrdersForUser(username: string): Promise<DirectAccessRecord[]>;
  /** Stores the order unless the box already holds one at least as new; clears the address update. */
  putOrderIfNewer(rec: Omit<DirectAccessRecord, "updateJson" | "updateSignatureHex" | "updateIssuedAt">): Promise<PutResult>;
  /** Stores the update only while `orderSha256` is still the box's order and the update is newer than the one held. */
  putUpdateIfNewer(serverDomain: string, orderSha256: string, u: { updateJson: string; updateSignatureHex: string; updateIssuedAt: number; updatedAt: number }): Promise<PutResult>;

  getName(name: string): Promise<DirectNameRecord | null>;
  listNamesForUser(username: string): Promise<DirectNameRecord[]>;
  listNamesForServer(serverDomain: string): Promise<DirectNameRecord[]>;
  /**
   * Names whose zone records need reconciling, oldest change first: those marked pending, then (when `staleBefore`
   * is given) those not looked at since then, so a change nobody announced (an admin-root rotation) is found too.
   */
  listPending(limit: number, staleBefore?: number): Promise<DirectNameRecord[]>;
  /**
   * Stores the owner's newer order for a name: refused as `taken` when another account holds it, `stale` when the
   * held order is at least as new. Marks the name for reconciling.
   */
  putNameIfNewer(rec: Pick<DirectNameRecord, "name" | "username" | "kind" | "serverDomain" | "enabled" | "orderJson" | "signatureHex" | "pqSignatureJson" | "issuedAt"> & { now: number }): Promise<PutResult>;
  /** Marks names for reconciling (after an order, an address update or a change to their box). */
  markPending(names: string[], now: number): Promise<void>;
  /** Records what the zone holds after a reconcile; skipped when the row changed since `seenUpdatedAt`. */
  setPublished(name: string, seenUpdatedAt: number, r: { publishedJson: string; state: DirectPublishState; reason: string | null; error: string | null; now: number }): Promise<boolean>;
  setProbe(name: string, probeJson: string, now: number): Promise<void>;
  suspend(name: string, reason: string | null, now: number): Promise<boolean>;
  /** Drops a row whose records are gone (the account or the name was released). */
  delete(name: string): Promise<boolean>;
}

interface OrderRow {
  server_domain: string;
  username: string;
  order_json: string;
  signature_hex: string;
  pq_signature_json: string | null;
  order_sha256: string;
  enabled: number;
  issued_at: number;
  update_json: string | null;
  update_signature_hex: string | null;
  update_issued_at: number | null;
  updated_at: number;
}

interface NameRow {
  name: string;
  username: string;
  kind: DirectNameKindValue;
  server_domain: string;
  enabled: number;
  order_json: string;
  signature_hex: string;
  pq_signature_json: string | null;
  issued_at: number;
  suspended_at: number | null;
  suspended_reason: string | null;
  published_json: string;
  publish_state: DirectPublishState;
  publish_reason: string | null;
  publish_error: string | null;
  published_at: number | null;
  probe_at: number | null;
  probe_json: string | null;
  created_at: number;
  updated_at: number;
}

const orderOf = (r: OrderRow): DirectAccessRecord => ({
  serverDomain: r.server_domain,
  username: r.username,
  orderJson: r.order_json,
  signatureHex: r.signature_hex,
  pqSignatureJson: r.pq_signature_json,
  orderSha256: r.order_sha256,
  enabled: r.enabled === 1,
  issuedAt: r.issued_at,
  updateJson: r.update_json,
  updateSignatureHex: r.update_signature_hex,
  updateIssuedAt: r.update_issued_at,
  updatedAt: r.updated_at,
});

const nameOf = (r: NameRow): DirectNameRecord => ({
  name: r.name,
  username: r.username,
  kind: r.kind,
  serverDomain: r.server_domain,
  enabled: r.enabled === 1,
  orderJson: r.order_json,
  signatureHex: r.signature_hex,
  pqSignatureJson: r.pq_signature_json,
  issuedAt: r.issued_at,
  suspendedAt: r.suspended_at,
  suspendedReason: r.suspended_reason,
  publishedJson: r.published_json,
  publishState: r.publish_state,
  publishReason: r.publish_reason,
  publishError: r.publish_error,
  publishedAt: r.published_at,
  probeAt: r.probe_at,
  probeJson: r.probe_json,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class D1DirectAccessStorage implements DirectAccessStorage {
  constructor(private readonly db: D1Database) {}

  async getOrder(serverDomain: string) {
    const r = await this.db.prepare("SELECT * FROM direct_access_orders WHERE server_domain = ?1").bind(serverDomain.toLowerCase()).first<OrderRow>();
    return r ? orderOf(r) : null;
  }

  async listOrdersForUser(username: string) {
    const r = await this.db
      .prepare("SELECT * FROM direct_access_orders WHERE username = ?1 ORDER BY server_domain")
      .bind(username.toLowerCase())
      .all<OrderRow>();
    return (r.results ?? []).map(orderOf);
  }

  async putOrderIfNewer(rec: Omit<DirectAccessRecord, "updateJson" | "updateSignatureHex" | "updateIssuedAt">): Promise<PutResult> {
    const r = await this.db
      .prepare(
        `INSERT INTO direct_access_orders (server_domain, username, order_json, signature_hex, pq_signature_json, order_sha256, enabled, issued_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(server_domain) DO UPDATE SET
           username = excluded.username, order_json = excluded.order_json, signature_hex = excluded.signature_hex,
           pq_signature_json = excluded.pq_signature_json, order_sha256 = excluded.order_sha256, enabled = excluded.enabled,
           issued_at = excluded.issued_at, update_json = NULL, update_signature_hex = NULL, update_issued_at = NULL,
           updated_at = excluded.updated_at
         WHERE excluded.issued_at > direct_access_orders.issued_at OR excluded.username <> direct_access_orders.username`,
      )
      .bind(
        rec.serverDomain.toLowerCase(),
        rec.username.toLowerCase(),
        rec.orderJson,
        rec.signatureHex,
        rec.pqSignatureJson ?? null,
        rec.orderSha256,
        rec.enabled ? 1 : 0,
        rec.issuedAt,
        rec.updatedAt,
      )
      .run();
    return (r.meta?.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: "stale" };
  }

  async putUpdateIfNewer(serverDomain: string, orderSha256: string, u: { updateJson: string; updateSignatureHex: string; updateIssuedAt: number; updatedAt: number }): Promise<PutResult> {
    const r = await this.db
      .prepare(
        `UPDATE direct_access_orders SET update_json = ?1, update_signature_hex = ?2, update_issued_at = ?3, updated_at = ?4
         WHERE server_domain = ?5 AND order_sha256 = ?6 AND enabled = 1 AND (update_issued_at IS NULL OR update_issued_at < ?3)`,
      )
      .bind(u.updateJson, u.updateSignatureHex, u.updateIssuedAt, u.updatedAt, serverDomain.toLowerCase(), orderSha256)
      .run();
    return (r.meta?.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: "stale" };
  }

  async getName(name: string) {
    const r = await this.db.prepare("SELECT * FROM direct_names WHERE name = ?1").bind(name.toLowerCase()).first<NameRow>();
    return r ? nameOf(r) : null;
  }

  async listNamesForUser(username: string) {
    const r = await this.db.prepare("SELECT * FROM direct_names WHERE username = ?1 ORDER BY name").bind(username.toLowerCase()).all<NameRow>();
    return (r.results ?? []).map(nameOf);
  }

  async listNamesForServer(serverDomain: string) {
    const r = await this.db
      .prepare("SELECT * FROM direct_names WHERE server_domain = ?1 ORDER BY name")
      .bind(serverDomain.toLowerCase())
      .all<NameRow>();
    return (r.results ?? []).map(nameOf);
  }

  async listPending(limit: number, staleBefore?: number) {
    const r = await this.db
      .prepare(
        "SELECT * FROM direct_names WHERE publish_state = 'pending' OR updated_at < ?2 " +
          "ORDER BY CASE WHEN publish_state = 'pending' THEN 0 ELSE 1 END, updated_at, name LIMIT ?1",
      )
      .bind(limit, staleBefore ?? 0)
      .all<NameRow>();
    return (r.results ?? []).map(nameOf);
  }

  async putNameIfNewer(rec: Parameters<DirectAccessStorage["putNameIfNewer"]>[0]): Promise<PutResult> {
    const name = rec.name.toLowerCase();
    const user = rec.username.toLowerCase();
    const r = await this.db
      .prepare(
        `INSERT INTO direct_names (name, username, kind, server_domain, enabled, order_json, signature_hex, pq_signature_json, issued_at,
           publish_state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10)
         ON CONFLICT(name) DO UPDATE SET
           server_domain = excluded.server_domain, enabled = excluded.enabled, order_json = excluded.order_json,
           signature_hex = excluded.signature_hex, pq_signature_json = excluded.pq_signature_json, issued_at = excluded.issued_at,
           publish_state = 'pending', updated_at = excluded.updated_at
         WHERE direct_names.username = excluded.username AND excluded.issued_at > direct_names.issued_at`,
      )
      .bind(name, user, rec.kind, rec.serverDomain.toLowerCase(), rec.enabled ? 1 : 0, rec.orderJson, rec.signatureHex, rec.pqSignatureJson ?? null, rec.issuedAt, rec.now)
      .run();
    if ((r.meta?.changes ?? 0) > 0) return { ok: true };
    const held = await this.getName(name);
    return { ok: false, reason: held && held.username !== user ? "taken" : "stale" };
  }

  async markPending(names: string[], now: number) {
    if (names.length === 0) return;
    await this.db.batch(
      names.map((n) => this.db.prepare("UPDATE direct_names SET publish_state = 'pending', updated_at = ?1 WHERE name = ?2").bind(now, n.toLowerCase())),
    );
  }

  async setPublished(name: string, seenUpdatedAt: number, r: { publishedJson: string; state: DirectPublishState; reason: string | null; error: string | null; now: number }) {
    const res = await this.db
      .prepare(
        `UPDATE direct_names SET published_json = ?1, publish_state = ?2, publish_reason = ?3, publish_error = ?4,
           published_at = ?5, updated_at = CASE WHEN ?2 = 'pending' THEN updated_at ELSE ?5 END
         WHERE name = ?6 AND updated_at = ?7`,
      )
      .bind(r.publishedJson, r.state, r.reason, r.error, r.now, name.toLowerCase(), seenUpdatedAt)
      .run();
    if ((res.meta?.changes ?? 0) > 0) return true;
    // The row changed while the zone was written: keep what the zone holds, leave it pending for the next pass.
    await this.db.prepare("UPDATE direct_names SET published_json = ?1 WHERE name = ?2").bind(r.publishedJson, name.toLowerCase()).run();
    return false;
  }

  async setProbe(name: string, probeJson: string, now: number) {
    await this.db.prepare("UPDATE direct_names SET probe_json = ?1, probe_at = ?2 WHERE name = ?3").bind(probeJson, now, name.toLowerCase()).run();
  }

  async suspend(name: string, reason: string | null, now: number) {
    const r = await this.db
      .prepare(
        reason === null
          ? "UPDATE direct_names SET suspended_at = NULL, suspended_reason = NULL, publish_state = 'pending', updated_at = ?2 WHERE name = ?1"
          : "UPDATE direct_names SET suspended_at = ?2, suspended_reason = ?3, publish_state = 'pending', updated_at = ?2 WHERE name = ?1",
      )
      .bind(...(reason === null ? [name.toLowerCase(), now] : [name.toLowerCase(), now, reason]))
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async delete(name: string) {
    const r = await this.db.prepare("DELETE FROM direct_names WHERE name = ?1").bind(name.toLowerCase()).run();
    return (r.meta?.changes ?? 0) > 0;
  }
}

export class InMemoryDirectAccessStorage implements DirectAccessStorage {
  private orders = new Map<string, DirectAccessRecord>();
  private names = new Map<string, DirectNameRecord>();

  async getOrder(serverDomain: string) {
    const r = this.orders.get(serverDomain.toLowerCase());
    return r ? { ...r } : null;
  }

  async listOrdersForUser(username: string) {
    return [...this.orders.values()].filter((r) => r.username === username.toLowerCase()).map((r) => ({ ...r }));
  }

  async putOrderIfNewer(rec: Omit<DirectAccessRecord, "updateJson" | "updateSignatureHex" | "updateIssuedAt">): Promise<PutResult> {
    const key = rec.serverDomain.toLowerCase();
    const held = this.orders.get(key);
    const user = rec.username.toLowerCase();
    if (held && rec.issuedAt <= held.issuedAt && held.username === user) return { ok: false, reason: "stale" };
    this.orders.set(key, { ...rec, serverDomain: key, username: user, updateJson: null, updateSignatureHex: null, updateIssuedAt: null });
    return { ok: true };
  }

  async putUpdateIfNewer(serverDomain: string, orderSha256: string, u: { updateJson: string; updateSignatureHex: string; updateIssuedAt: number; updatedAt: number }): Promise<PutResult> {
    const held = this.orders.get(serverDomain.toLowerCase());
    if (!held || held.orderSha256 !== orderSha256 || !held.enabled || (held.updateIssuedAt != null && held.updateIssuedAt >= u.updateIssuedAt)) {
      return { ok: false, reason: "stale" };
    }
    Object.assign(held, u);
    return { ok: true };
  }

  async getName(name: string) {
    const r = this.names.get(name.toLowerCase());
    return r ? { ...r } : null;
  }

  async listNamesForUser(username: string) {
    return [...this.names.values()].filter((r) => r.username === username.toLowerCase()).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r }));
  }

  async listNamesForServer(serverDomain: string) {
    return [...this.names.values()].filter((r) => r.serverDomain === serverDomain.toLowerCase()).map((r) => ({ ...r }));
  }

  async listPending(limit: number, staleBefore?: number) {
    const rank = (r: DirectNameRecord) => (r.publishState === "pending" ? 0 : 1);
    return [...this.names.values()]
      .filter((r) => r.publishState === "pending" || r.updatedAt < (staleBefore ?? 0))
      .sort((a, b) => rank(a) - rank(b) || a.updatedAt - b.updatedAt || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async putNameIfNewer(rec: Parameters<DirectAccessStorage["putNameIfNewer"]>[0]): Promise<PutResult> {
    const key = rec.name.toLowerCase();
    const user = rec.username.toLowerCase();
    const held = this.names.get(key);
    if (held && held.username !== user) return { ok: false, reason: "taken" };
    if (held && rec.issuedAt <= held.issuedAt) return { ok: false, reason: "stale" };
    const { now, ...fields } = rec;
    this.names.set(key, {
      ...(held ?? { publishedJson: "[]", createdAt: now, suspendedAt: null, suspendedReason: null }),
      ...fields,
      name: key,
      username: user,
      serverDomain: rec.serverDomain.toLowerCase(),
      kind: held?.kind ?? rec.kind,
      publishState: "pending",
      updatedAt: now,
    } as DirectNameRecord);
    return { ok: true };
  }

  async markPending(names: string[], now: number) {
    for (const n of names) {
      const r = this.names.get(n.toLowerCase());
      if (r) Object.assign(r, { publishState: "pending", updatedAt: now });
    }
  }

  async setPublished(name: string, seenUpdatedAt: number, r: { publishedJson: string; state: DirectPublishState; reason: string | null; error: string | null; now: number }) {
    const row = this.names.get(name.toLowerCase());
    if (!row) return false;
    if (row.updatedAt !== seenUpdatedAt) {
      row.publishedJson = r.publishedJson;
      return false;
    }
    Object.assign(row, {
      publishedJson: r.publishedJson,
      publishState: r.state,
      publishReason: r.reason,
      publishError: r.error,
      publishedAt: r.now,
      updatedAt: r.state === "pending" ? row.updatedAt : r.now,
    });
    return true;
  }

  async setProbe(name: string, probeJson: string, now: number) {
    const row = this.names.get(name.toLowerCase());
    if (row) Object.assign(row, { probeJson, probeAt: now });
  }

  async suspend(name: string, reason: string | null, now: number) {
    const row = this.names.get(name.toLowerCase());
    if (!row) return false;
    Object.assign(row, { suspendedAt: reason === null ? null : now, suspendedReason: reason, publishState: "pending", updatedAt: now });
    return true;
  }

  async delete(name: string) {
    return this.names.delete(name.toLowerCase());
  }
}
