import type { D1Database } from "./d1.js";

/**
 * voi.ci calls on `.com` (docs/voici-calls.md §6; migration 0146): the per-(page, day) ring counter, the one live call
 * per account, iOS VoIP push tokens, the owner's signed call-allow orders and missed calls (sealed to the inbox key).
 * No call log: an answered call leaves nothing here once it ends.
 */
export interface VoiciVoipToken {
  username: string;
  deviceId: string;
  devicePub: string;
  token: string;
  registeredAt: number;
}

export interface VoiciCallAllowRecord {
  pageId: string;
  conv: string;
  op: "allow" | "disallow";
  issuedAt: number;
  signature: string;
}

/** A device's bound call-only key (flagship/voici-call-key/v1; migration 0147). */
export interface VoiciCallKeyRecord {
  username: string;
  deviceId: string;
  callKeyPub: string;
  createdAt: number;
  /** Ed25519 by the page's ownerSignPub over the binding. */
  signature: string;
  registeredAt: number;
}

/** A caller's ring-back channel (flagship/voici-ring-back/v1; migration 0149); `username` when the caller's app attached it. */
export interface VoiciRingBackRecord {
  pageId: string;
  conv: string;
  username: string | null;
  issuedAt: number;
  expiresAt: number;
}

/** The owner's ring still ringing (flagship/voici-ring/v1; migration 0149). */
export interface VoiciRingRecord {
  pageId: string;
  conv: string;
  ringId: string;
  hint: string;
  media: string;
  issuedAt: number;
  expiresAt: number;
}

export interface VoiciMissedCallRecord {
  id: number;
  pageId: string;
  conv: string;
  callId: string;
  sealed: string;
  storedAt: number;
}

export interface VoiciCallStorage {
  /** Adds one ring to (page, day) unless it is already at `max`; false when full. */
  countRing(pageId: string, day: string, max: number): Promise<boolean>;
  /** Takes the account's one live call slot; false while another live call holds it (expiresAt > now). */
  claimLiveCall(username: string, callId: string, now: number, expiresAt: number): Promise<boolean>;
  extendLiveCall(username: string, callId: string, expiresAt: number): Promise<void>;
  releaseLiveCall(username: string, callId: string): Promise<void>;
  putVoipToken(rec: VoiciVoipToken): Promise<void>;
  deleteVoipToken(username: string, deviceId: string): Promise<void>;
  listVoipTokens(username: string): Promise<VoiciVoipToken[]>;
  /** Newest issuedAt wins; false when an order at least as new is stored. */
  setCallAllow(rec: VoiciCallAllowRecord, at: number): Promise<boolean>;
  getCallAllow(pageId: string, conv: string): Promise<VoiciCallAllowRecord | null>;
  putMissedCall(rec: Omit<VoiciMissedCallRecord, "id">): Promise<boolean>;
  listMissedCalls(pageId: string, sinceId: number, limit: number): Promise<VoiciMissedCallRecord[]>;
  /** Retention (180 days, as the mailbox) and the counters older than two days. */
  collectCalls(o: { missedBefore: number; countsBeforeDay: string; now: number; limit: number }): Promise<number>;
  deleteCallsForPage(pageId: string): Promise<void>;
  /** Binds a call key for (username, deviceId), replacing that device's previous one; false when the key was revoked. */
  putCallKey(rec: VoiciCallKeyRecord): Promise<boolean>;
  getCallKey(username: string, deviceId: string): Promise<VoiciCallKeyRecord | null>;
  /** Records the revocation and drops the binding when it still names this key. */
  revokeCallKey(rec: { username: string; deviceId: string; callKeyPub: string; revokedAt: number; signature: string }): Promise<void>;
  isCallKeyRevoked(callKeyPub: string): Promise<boolean>;
  /** Drops a device's call-key binding (its device grant was revoked: docs/voici-calls.md, 2026-11-15 second round). */
  deleteCallKeyForDevice(username: string, deviceId: string): Promise<void>;
  deleteCallsForAccount(username: string): Promise<void>;
  /** Newest issuedAt wins; false when a newer order is stored. */
  putRingBack(rec: VoiciRingBackRecord): Promise<boolean>;
  getRingBack(pageId: string, conv: string, now: number): Promise<VoiciRingBackRecord | null>;
  /** "Stop call-backs": the channel and any ring in progress go. */
  deleteRingBack(pageId: string, conv: string): Promise<void>;
  putRing(rec: VoiciRingRecord): Promise<void>;
  getRing(pageId: string, conv: string, now: number): Promise<VoiciRingRecord | null>;
  /** Spends a proof-of-work challenge once; false when it was spent already. */
  spendPow(challengeHash: string, expiresAt: number): Promise<boolean>;
  blockAnon(pageId: string, conv: string, expiresAt: number): Promise<void>;
  /** Delete = forget: the conversation's ring-back channel, ring, call allow and missed calls go at once. */
  deleteConversationCalls(pageId: string, conv: string): Promise<void>;
  /** Rows still held for one conversation in the call tables (tests: a deleted conversation leaves none). */
  conversationCallRowCount(pageId: string, conv: string): Promise<number>;
  isAnonBlocked(pageId: string, conv: string, now: number): Promise<boolean>;
}

type MissedRow = { id: number; page_id: string; conv: string; call_id: string; sealed: string; stored_at: number };
const missedFromRow = (r: MissedRow): VoiciMissedCallRecord => ({ id: r.id, pageId: r.page_id, conv: r.conv, callId: r.call_id, sealed: r.sealed, storedAt: r.stored_at });

export class D1VoiciCallStorage implements VoiciCallStorage {
  constructor(private readonly db: D1Database) {}

  async countRing(pageId: string, day: string, max: number) {
    const r = await this.db
      .prepare(
        "INSERT INTO voici_call_counts (page_id, day, rings) VALUES (?1, ?2, 1) " +
          "ON CONFLICT (page_id, day) DO UPDATE SET rings = rings + 1 WHERE voici_call_counts.rings < ?3",
      )
      .bind(pageId, day, max)
      .run();
    return (r.meta.changes ?? 0) === 1;
  }

  async claimLiveCall(username: string, callId: string, now: number, expiresAt: number) {
    const r = await this.db
      .prepare(
        "INSERT INTO voici_live_calls (username, call_id, started_at, expires_at) VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT (username) DO UPDATE SET call_id = ?2, started_at = ?3, expires_at = ?4 WHERE voici_live_calls.expires_at <= ?3",
      )
      .bind(username, callId, now, expiresAt)
      .run();
    return (r.meta.changes ?? 0) === 1;
  }

  async extendLiveCall(username: string, callId: string, expiresAt: number) {
    await this.db.prepare("UPDATE voici_live_calls SET expires_at = ?3 WHERE username = ?1 AND call_id = ?2").bind(username, callId, expiresAt).run();
  }

  async releaseLiveCall(username: string, callId: string) {
    await this.db.prepare("DELETE FROM voici_live_calls WHERE username = ?1 AND call_id = ?2").bind(username, callId).run();
  }

  async putVoipToken(rec: VoiciVoipToken) {
    await this.db
      .prepare(
        "INSERT INTO voici_voip_tokens (username, device_id, device_pub, token, registered_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT (username, device_id) DO UPDATE SET device_pub = ?3, token = ?4, registered_at = ?5",
      )
      .bind(rec.username, rec.deviceId, rec.devicePub, rec.token, rec.registeredAt)
      .run();
  }

  async deleteVoipToken(username: string, deviceId: string) {
    await this.db.prepare("DELETE FROM voici_voip_tokens WHERE username = ?1 AND device_id = ?2").bind(username, deviceId).run();
  }

  async listVoipTokens(username: string) {
    const r = await this.db
      .prepare("SELECT username, device_id, device_pub, token, registered_at FROM voici_voip_tokens WHERE username = ?1")
      .bind(username)
      .all<{ username: string; device_id: string; device_pub: string; token: string; registered_at: number }>();
    return (r.results ?? []).map((x) => ({ username: x.username, deviceId: x.device_id, devicePub: x.device_pub, token: x.token, registeredAt: x.registered_at }));
  }

  async setCallAllow(rec: VoiciCallAllowRecord, at: number) {
    const r = await this.db
      .prepare(
        "INSERT INTO voici_call_allows (page_id, conv, op, issued_at, signature, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
          "ON CONFLICT (page_id, conv) DO UPDATE SET op = ?3, issued_at = ?4, signature = ?5, updated_at = ?6 WHERE voici_call_allows.issued_at < ?4",
      )
      .bind(rec.pageId, rec.conv, rec.op, rec.issuedAt, rec.signature, at)
      .run();
    return (r.meta.changes ?? 0) === 1;
  }

  async getCallAllow(pageId: string, conv: string) {
    const r = await this.db
      .prepare("SELECT page_id, conv, op, issued_at, signature FROM voici_call_allows WHERE page_id = ?1 AND conv = ?2")
      .bind(pageId, conv)
      .first<{ page_id: string; conv: string; op: "allow" | "disallow"; issued_at: number; signature: string }>();
    return r ? { pageId: r.page_id, conv: r.conv, op: r.op, issuedAt: r.issued_at, signature: r.signature } : null;
  }

  async putMissedCall(rec: Omit<VoiciMissedCallRecord, "id">) {
    try {
      const r = await this.db
        .prepare("INSERT INTO voici_missed_calls (page_id, conv, call_id, sealed, stored_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(rec.pageId, rec.conv, rec.callId, rec.sealed, rec.storedAt)
        .run();
      return (r.meta.changes ?? 0) === 1;
    } catch {
      return false;
    }
  }

  async listMissedCalls(pageId: string, sinceId: number, limit: number) {
    const r = await this.db
      .prepare("SELECT id, page_id, conv, call_id, sealed, stored_at FROM voici_missed_calls WHERE page_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3")
      .bind(pageId, sinceId, limit)
      .all<MissedRow>();
    return (r.results ?? []).map(missedFromRow);
  }

  async collectCalls(o: { missedBefore: number; countsBeforeDay: string; now: number; limit: number }) {
    const a = await this.db
      .prepare("DELETE FROM voici_missed_calls WHERE id IN (SELECT id FROM voici_missed_calls WHERE stored_at < ?1 LIMIT ?2)")
      .bind(o.missedBefore, o.limit)
      .run();
    const b = await this.db.prepare("DELETE FROM voici_call_counts WHERE day < ?1").bind(o.countsBeforeDay).run();
    const c = await this.db.prepare("DELETE FROM voici_live_calls WHERE expires_at < ?1").bind(o.now).run();
    let more = 0;
    for (const t of ["voici_ring_backs", "voici_rings", "voici_pow_spent", "voici_anon_blocks"]) {
      more += (await this.db.prepare(`DELETE FROM ${t} WHERE expires_at < ?1`).bind(o.now).run()).meta.changes ?? 0;
    }
    return (a.meta.changes ?? 0) + (b.meta.changes ?? 0) + (c.meta.changes ?? 0) + more;
  }

  async deleteCallsForPage(pageId: string) {
    await this.db.prepare("DELETE FROM voici_missed_calls WHERE page_id = ?1").bind(pageId).run();
    await this.db.prepare("DELETE FROM voici_call_allows WHERE page_id = ?1").bind(pageId).run();
    await this.db.prepare("DELETE FROM voici_call_counts WHERE page_id = ?1").bind(pageId).run();
    for (const t of ["voici_ring_backs", "voici_rings", "voici_anon_blocks"]) await this.db.prepare(`DELETE FROM ${t} WHERE page_id = ?1`).bind(pageId).run();
  }

  async deleteCallsForAccount(username: string) {
    await this.db.prepare("DELETE FROM voici_voip_tokens WHERE username = ?1").bind(username).run();
    await this.db.prepare("DELETE FROM voici_live_calls WHERE username = ?1").bind(username).run();
    await this.db.prepare("DELETE FROM voici_call_keys WHERE username = ?1").bind(username).run();
    await this.db.prepare("DELETE FROM voici_ring_backs WHERE username = ?1").bind(username).run();
  }

  async putCallKey(rec: VoiciCallKeyRecord) {
    if (await this.isCallKeyRevoked(rec.callKeyPub)) return false;
    await this.db
      .prepare(
        "INSERT INTO voici_call_keys (username, device_id, call_key_pub, created_at, signature, registered_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
          "ON CONFLICT (username, device_id) DO UPDATE SET call_key_pub = ?3, created_at = ?4, signature = ?5, registered_at = ?6",
      )
      .bind(rec.username, rec.deviceId, rec.callKeyPub, rec.createdAt, rec.signature, rec.registeredAt)
      .run();
    return true;
  }

  async getCallKey(username: string, deviceId: string) {
    const r = await this.db
      .prepare("SELECT username, device_id, call_key_pub, created_at, signature, registered_at FROM voici_call_keys WHERE username = ?1 AND device_id = ?2")
      .bind(username, deviceId)
      .first<{ username: string; device_id: string; call_key_pub: string; created_at: number; signature: string; registered_at: number }>();
    return r ? { username: r.username, deviceId: r.device_id, callKeyPub: r.call_key_pub, createdAt: r.created_at, signature: r.signature, registeredAt: r.registered_at } : null;
  }

  async revokeCallKey(rec: { username: string; deviceId: string; callKeyPub: string; revokedAt: number; signature: string }) {
    await this.db
      .prepare("INSERT OR IGNORE INTO voici_call_key_revocations (call_key_pub, username, device_id, revoked_at, signature) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(rec.callKeyPub, rec.username, rec.deviceId, rec.revokedAt, rec.signature)
      .run();
    await this.db.prepare("DELETE FROM voici_call_keys WHERE username = ?1 AND device_id = ?2 AND call_key_pub = ?3").bind(rec.username, rec.deviceId, rec.callKeyPub).run();
  }

  async deleteCallKeyForDevice(username: string, deviceId: string) {
    await this.db.prepare("DELETE FROM voici_call_keys WHERE username = ?1 AND device_id = ?2").bind(username, deviceId).run();
  }

  async putRingBack(rec: VoiciRingBackRecord) {
    const r = await this.db
      .prepare(
        "INSERT INTO voici_ring_backs (page_id, conv, username, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT (page_id, conv) DO UPDATE SET username = COALESCE(?3, voici_ring_backs.username), issued_at = ?4, expires_at = ?5 WHERE voici_ring_backs.issued_at < ?4",
      )
      .bind(rec.pageId, rec.conv, rec.username, rec.issuedAt, rec.expiresAt)
      .run();
    return (r.meta.changes ?? 0) === 1;
  }

  async getRingBack(pageId: string, conv: string, now: number) {
    const r = await this.db
      .prepare("SELECT page_id, conv, username, issued_at, expires_at FROM voici_ring_backs WHERE page_id = ?1 AND conv = ?2 AND expires_at > ?3")
      .bind(pageId, conv, now)
      .first<{ page_id: string; conv: string; username: string | null; issued_at: number; expires_at: number }>();
    return r ? { pageId: r.page_id, conv: r.conv, username: r.username ?? null, issuedAt: r.issued_at, expiresAt: r.expires_at } : null;
  }

  async deleteRingBack(pageId: string, conv: string) {
    await this.db.prepare("DELETE FROM voici_ring_backs WHERE page_id = ?1 AND conv = ?2").bind(pageId, conv).run();
    await this.db.prepare("DELETE FROM voici_rings WHERE page_id = ?1 AND conv = ?2").bind(pageId, conv).run();
  }

  async putRing(rec: VoiciRingRecord) {
    await this.db
      .prepare(
        "INSERT INTO voici_rings (page_id, conv, ring_id, hint, media, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
          "ON CONFLICT (page_id, conv) DO UPDATE SET ring_id = ?3, hint = ?4, media = ?5, issued_at = ?6, expires_at = ?7",
      )
      .bind(rec.pageId, rec.conv, rec.ringId, rec.hint, rec.media, rec.issuedAt, rec.expiresAt)
      .run();
  }

  async getRing(pageId: string, conv: string, now: number) {
    const r = await this.db
      .prepare("SELECT page_id, conv, ring_id, hint, media, issued_at, expires_at FROM voici_rings WHERE page_id = ?1 AND conv = ?2 AND expires_at > ?3")
      .bind(pageId, conv, now)
      .first<{ page_id: string; conv: string; ring_id: string; hint: string; media: string; issued_at: number; expires_at: number }>();
    return r ? { pageId: r.page_id, conv: r.conv, ringId: r.ring_id, hint: r.hint, media: r.media, issuedAt: r.issued_at, expiresAt: r.expires_at } : null;
  }

  async deleteConversationCalls(pageId: string, conv: string) {
    for (const t of ["voici_ring_backs", "voici_rings", "voici_call_allows", "voici_missed_calls"]) {
      await this.db.prepare(`DELETE FROM ${t} WHERE page_id = ?1 AND conv = ?2`).bind(pageId, conv).run();
    }
  }

  async conversationCallRowCount(pageId: string, conv: string) {
    let n = 0;
    for (const t of ["voici_ring_backs", "voici_rings", "voici_call_allows", "voici_missed_calls", "voici_anon_blocks"]) {
      n += (await this.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE page_id = ?1 AND conv = ?2`).bind(pageId, conv).first<{ n: number }>())?.n ?? 0;
    }
    return n;
  }

  async spendPow(challengeHash: string, expiresAt: number) {
    const r = await this.db.prepare("INSERT OR IGNORE INTO voici_pow_spent (challenge_hash, expires_at) VALUES (?1, ?2)").bind(challengeHash, expiresAt).run();
    return (r.meta.changes ?? 0) === 1;
  }

  async blockAnon(pageId: string, conv: string, expiresAt: number) {
    await this.db
      .prepare("INSERT INTO voici_anon_blocks (page_id, conv, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT (page_id, conv) DO UPDATE SET expires_at = ?3")
      .bind(pageId, conv, expiresAt)
      .run();
  }

  async isAnonBlocked(pageId: string, conv: string, now: number) {
    const r = await this.db.prepare("SELECT 1 AS x FROM voici_anon_blocks WHERE page_id = ?1 AND conv = ?2 AND expires_at > ?3").bind(pageId, conv, now).first<{ x: number }>();
    return !!r;
  }

  async isCallKeyRevoked(callKeyPub: string) {
    const r = await this.db.prepare("SELECT 1 AS x FROM voici_call_key_revocations WHERE call_key_pub = ?1").bind(callKeyPub).first<{ x: number }>();
    return !!r;
  }
}

export class InMemoryVoiciCallStorage implements VoiciCallStorage {
  counts = new Map<string, number>();
  live = new Map<string, { callId: string; expiresAt: number }>();
  voip = new Map<string, VoiciVoipToken>();
  allows = new Map<string, VoiciCallAllowRecord>();
  missed: VoiciMissedCallRecord[] = [];
  callKeys = new Map<string, VoiciCallKeyRecord>();
  revokedCallKeys = new Set<string>();
  ringBacks = new Map<string, VoiciRingBackRecord>();
  rings = new Map<string, VoiciRingRecord>();
  powSpent = new Map<string, number>();
  anonBlocks = new Map<string, number>();
  private nextId = 1;

  async countRing(pageId: string, day: string, max: number) {
    const k = `${pageId}|${day}`;
    const n = this.counts.get(k) ?? 0;
    if (n >= max) return false;
    this.counts.set(k, n + 1);
    return true;
  }
  async claimLiveCall(username: string, callId: string, now: number, expiresAt: number) {
    const cur = this.live.get(username);
    if (cur && cur.expiresAt > now) return false;
    this.live.set(username, { callId, expiresAt });
    return true;
  }
  async extendLiveCall(username: string, callId: string, expiresAt: number) {
    const cur = this.live.get(username);
    if (cur?.callId === callId) cur.expiresAt = expiresAt;
  }
  async releaseLiveCall(username: string, callId: string) {
    if (this.live.get(username)?.callId === callId) this.live.delete(username);
  }
  async putVoipToken(rec: VoiciVoipToken) {
    this.voip.set(`${rec.username}|${rec.deviceId}`, { ...rec });
  }
  async deleteVoipToken(username: string, deviceId: string) {
    this.voip.delete(`${username}|${deviceId}`);
  }
  async listVoipTokens(username: string) {
    return [...this.voip.values()].filter((t) => t.username === username);
  }
  async setCallAllow(rec: VoiciCallAllowRecord) {
    const k = `${rec.pageId}|${rec.conv}`;
    const cur = this.allows.get(k);
    if (cur && cur.issuedAt >= rec.issuedAt) return false;
    this.allows.set(k, { ...rec });
    return true;
  }
  async getCallAllow(pageId: string, conv: string) {
    return this.allows.get(`${pageId}|${conv}`) ?? null;
  }
  async putMissedCall(rec: Omit<VoiciMissedCallRecord, "id">) {
    if (this.missed.some((m) => m.callId === rec.callId)) return false;
    this.missed.push({ ...rec, id: this.nextId++ });
    return true;
  }
  async listMissedCalls(pageId: string, sinceId: number, limit: number) {
    return this.missed.filter((m) => m.pageId === pageId && m.id > sinceId).slice(0, limit);
  }
  async collectCalls(o: { missedBefore: number; countsBeforeDay: string; now: number }) {
    const before = this.missed.length;
    this.missed = this.missed.filter((m) => m.storedAt >= o.missedBefore);
    let n = before - this.missed.length;
    for (const k of [...this.counts.keys()]) if (k.split("|")[1]! < o.countsBeforeDay) (this.counts.delete(k), n++);
    for (const [u, l] of [...this.live]) if (l.expiresAt < o.now) (this.live.delete(u), n++);
    return n;
  }
  async deleteCallsForPage(pageId: string) {
    this.missed = this.missed.filter((m) => m.pageId !== pageId);
    for (const k of [...this.allows.keys()]) if (k.startsWith(`${pageId}|`)) this.allows.delete(k);
    for (const k of [...this.counts.keys()]) if (k.startsWith(`${pageId}|`)) this.counts.delete(k);
    for (const m of [this.ringBacks, this.rings, this.anonBlocks]) for (const k of [...m.keys()]) if (k.startsWith(`${pageId}|`)) m.delete(k);
  }
  async deleteCallsForAccount(username: string) {
    for (const k of [...this.voip.keys()]) if (k.startsWith(`${username}|`)) this.voip.delete(k);
    for (const k of [...this.callKeys.keys()]) if (k.startsWith(`${username}|`)) this.callKeys.delete(k);
    for (const [k, r] of [...this.ringBacks]) if (r.username === username) this.ringBacks.delete(k);
    this.live.delete(username);
  }
  async putCallKey(rec: VoiciCallKeyRecord) {
    if (this.revokedCallKeys.has(rec.callKeyPub)) return false;
    this.callKeys.set(`${rec.username}|${rec.deviceId}`, { ...rec });
    return true;
  }
  async getCallKey(username: string, deviceId: string) {
    return this.callKeys.get(`${username}|${deviceId}`) ?? null;
  }
  async revokeCallKey(rec: { username: string; deviceId: string; callKeyPub: string }) {
    this.revokedCallKeys.add(rec.callKeyPub);
    const k = `${rec.username}|${rec.deviceId}`;
    if (this.callKeys.get(k)?.callKeyPub === rec.callKeyPub) this.callKeys.delete(k);
  }
  async deleteCallKeyForDevice(username: string, deviceId: string) {
    this.callKeys.delete(`${username}|${deviceId}`);
  }
  async putRingBack(rec: VoiciRingBackRecord) {
    const k = `${rec.pageId}|${rec.conv}`;
    const cur = this.ringBacks.get(k);
    if (cur && cur.issuedAt >= rec.issuedAt) return false;
    this.ringBacks.set(k, { ...rec, username: rec.username ?? cur?.username ?? null });
    return true;
  }
  async getRingBack(pageId: string, conv: string, now: number) {
    const r = this.ringBacks.get(`${pageId}|${conv}`);
    return r && r.expiresAt > now ? { ...r } : null;
  }
  async deleteRingBack(pageId: string, conv: string) {
    this.ringBacks.delete(`${pageId}|${conv}`);
    this.rings.delete(`${pageId}|${conv}`);
  }
  async putRing(rec: VoiciRingRecord) {
    this.rings.set(`${rec.pageId}|${rec.conv}`, { ...rec });
  }
  async getRing(pageId: string, conv: string, now: number) {
    const r = this.rings.get(`${pageId}|${conv}`);
    return r && r.expiresAt > now ? { ...r } : null;
  }
  async deleteConversationCalls(pageId: string, conv: string) {
    const k = `${pageId}|${conv}`;
    this.ringBacks.delete(k);
    this.rings.delete(k);
    this.allows.delete(k);
    this.missed = this.missed.filter((m) => !(m.pageId === pageId && m.conv === conv));
  }
  async conversationCallRowCount(pageId: string, conv: string) {
    const k = `${pageId}|${conv}`;
    return [this.ringBacks, this.rings, this.allows, this.anonBlocks].filter((m) => m.has(k)).length + this.missed.filter((m) => m.pageId === pageId && m.conv === conv).length;
  }
  async spendPow(challengeHash: string, expiresAt: number) {
    if (this.powSpent.has(challengeHash)) return false;
    this.powSpent.set(challengeHash, expiresAt);
    return true;
  }
  async blockAnon(pageId: string, conv: string, expiresAt: number) {
    this.anonBlocks.set(`${pageId}|${conv}`, expiresAt);
  }
  async isAnonBlocked(pageId: string, conv: string, now: number) {
    return (this.anonBlocks.get(`${pageId}|${conv}`) ?? 0) > now;
  }

  async isCallKeyRevoked(callKeyPub: string) {
    return this.revokedCallKeys.has(callKeyPub);
  }
}
