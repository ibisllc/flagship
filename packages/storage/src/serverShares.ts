/**
 * Share this server (docs/share-a-server.md, migrations 0087 and 0097).
 * `.com` keeps an opaque share id, a hash of the link's bearer token, and
 * ciphertext; the second account's boot copy (sealed to its per-share key);
 * its "Shared with me" inbox (sealed entries under an inbox key unrelated to
 * its account); and the push tokens of its devices that asked to be woken for
 * the server's start-up, which live and die with the boot copy.
 */
import type { D1Database } from "./d1.js";

export type ServerShareEndKind = "revoke" | "leave";

export interface ServerShareRecord {
  shareId: string;
  ownerUsername: string;
  serverDomain: string;
  tokenHash: string;
  offerHex: string;
  ownerHex: string;
  acceptHex: string | null;
  acceptedAt: number | null;
  endKind: ServerShareEndKind | null;
  /** The signed revoke or leave, as JSON `{revoke|leave, signature}`. */
  endJson: string | null;
  endedAt: number | null;
  createdAt: number;
  expiresAt: number;
}

export interface ServerShareEnd {
  shareId: string;
  kind: ServerShareEndKind;
  endJson: string;
  endedAt: number;
}

export interface ServerShareUnlockRecord {
  shareId: string;
  serverDomain: string;
  memberPubHex: string;
  sealedKeyHex: string;
  depositJson: string;
  signatureHex: string;
  issuedAt: number;
}

export type SharePushPlatform = "apns" | "fcm" | "webpush";

export interface ServerSharePushRecord {
  shareId: string;
  serverDomain: string;
  memberPubHex: string;
  tokenSha256: string;
  platform: SharePushPlatform;
  providerToken: string;
  registeredAt: number;
}

export interface ShareInboxRecord {
  inboxId: string;
  entryId: string;
  ctHex: string;
  createdAt: number;
}

export type ShareAcceptResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "ended" | "expired" | "already-accepted" };

export interface ServerShareStorage {
  /** `{ok:false}` when the id or the token hash is already taken. */
  create(rec: Omit<ServerShareRecord, "acceptHex" | "acceptedAt" | "endKind" | "endJson" | "endedAt">): Promise<{ ok: boolean }>;
  get(shareId: string): Promise<ServerShareRecord | null>;
  listForOwner(username: string): Promise<ServerShareRecord[]>;
  /** First acceptance wins. */
  accept(shareId: string, acceptHex: string, now: number): Promise<ShareAcceptResult>;
  /** Ends the share and drops its boot copy. False when unknown or already ended. */
  end(shareId: string, kind: ServerShareEndKind, endJson: string, now: number): Promise<boolean>;
  /** Ended shares of one server, ended at or after `since`, oldest first. */
  endsForServer(serverDomain: string, since: number, limit: number): Promise<ServerShareEnd[]>;
  putUnlock(rec: ServerShareUnlockRecord): Promise<void>;
  getUnlock(shareId: string): Promise<ServerShareUnlockRecord | null>;
  /** The boot copy whose key is `memberPubHex` on `serverDomain`, for a share still running. */
  unlockForMember(serverDomain: string, memberPubHex: string): Promise<ServerShareUnlockRecord | null>;
  /** Drops the boot copy and, with it, every push token registered for the share. */
  deleteUnlock(shareId: string): Promise<boolean>;
  /** False when the share already holds `cap` tokens (and this one is new). */
  putPush(rec: ServerSharePushRecord, cap: number): Promise<boolean>;
  deletePush(shareId: string, tokenSha256: string): Promise<boolean>;
  /** Tokens to wake for this server: shares still running whose boot copy names the same key. */
  pushTargetsForServer(serverDomain: string): Promise<ServerSharePushRecord[]>;
  /** False when the inbox already holds `cap` entries (and this id is new). */
  inboxPut(rec: ShareInboxRecord, cap: number): Promise<boolean>;
  inboxList(inboxId: string): Promise<ShareInboxRecord[]>;
  inboxDelete(inboxId: string, entryId: string): Promise<boolean>;
}

interface ShareRow {
  share_id: string;
  owner_username: string;
  server_domain: string;
  token_hash: string;
  offer_hex: string;
  owner_hex: string;
  accept_hex: string | null;
  accepted_at: number | null;
  end_kind: string | null;
  end_json: string | null;
  ended_at: number | null;
  created_at: number;
  expires_at: number;
}

interface UnlockRow {
  share_id: string;
  server_domain: string;
  member_pub_hex: string;
  sealed_key_hex: string;
  deposit_json: string;
  signature_hex: string;
  issued_at: number;
}

interface PushRow {
  share_id: string;
  server_domain: string;
  member_pub_hex: string;
  token_sha256: string;
  platform: string;
  provider_token: string;
  registered_at: number;
}

function pushFromRow(r: PushRow): ServerSharePushRecord {
  return {
    shareId: r.share_id,
    serverDomain: r.server_domain,
    memberPubHex: r.member_pub_hex,
    tokenSha256: r.token_sha256,
    platform: r.platform as SharePushPlatform,
    providerToken: r.provider_token,
    registeredAt: r.registered_at,
  };
}

interface InboxRow {
  inbox_id: string;
  entry_id: string;
  ct_hex: string;
  created_at: number;
}

function shareFromRow(r: ShareRow): ServerShareRecord {
  return {
    shareId: r.share_id,
    ownerUsername: r.owner_username,
    serverDomain: r.server_domain,
    tokenHash: r.token_hash,
    offerHex: r.offer_hex,
    ownerHex: r.owner_hex,
    acceptHex: r.accept_hex,
    acceptedAt: r.accepted_at,
    endKind: r.end_kind === "revoke" || r.end_kind === "leave" ? r.end_kind : null,
    endJson: r.end_json,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

function unlockFromRow(r: UnlockRow): ServerShareUnlockRecord {
  return {
    shareId: r.share_id,
    serverDomain: r.server_domain,
    memberPubHex: r.member_pub_hex,
    sealedKeyHex: r.sealed_key_hex,
    depositJson: r.deposit_json,
    signatureHex: r.signature_hex,
    issuedAt: r.issued_at,
  };
}

export class D1ServerShareStorage implements ServerShareStorage {
  constructor(private readonly db: D1Database) {}

  async create(rec: Omit<ServerShareRecord, "acceptHex" | "acceptedAt" | "endKind" | "endJson" | "endedAt">): Promise<{ ok: boolean }> {
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO server_shares
           (share_id, owner_username, server_domain, token_hash, offer_hex, owner_hex, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(rec.shareId, rec.ownerUsername, rec.serverDomain, rec.tokenHash, rec.offerHex, rec.ownerHex, rec.createdAt, rec.expiresAt)
      .run();
    return { ok: (res.meta.changes ?? 0) > 0 };
  }

  async get(shareId: string): Promise<ServerShareRecord | null> {
    const r = await this.db.prepare(`SELECT * FROM server_shares WHERE share_id = ?1`).bind(shareId).first<ShareRow>();
    return r ? shareFromRow(r) : null;
  }

  async listForOwner(username: string): Promise<ServerShareRecord[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM server_shares WHERE owner_username = ?1 ORDER BY created_at DESC LIMIT 500`)
      .bind(username)
      .all<ShareRow>();
    return (rs.results ?? []).map(shareFromRow);
  }

  async accept(shareId: string, acceptHex: string, now: number): Promise<ShareAcceptResult> {
    const res = await this.db
      .prepare(
        `UPDATE server_shares SET accept_hex = ?2, accepted_at = ?3
           WHERE share_id = ?1 AND accept_hex IS NULL AND ended_at IS NULL AND expires_at > ?3`,
      )
      .bind(shareId, acceptHex, now)
      .run();
    if ((res.meta.changes ?? 0) > 0) return { ok: true };
    const cur = await this.get(shareId);
    if (!cur) return { ok: false, reason: "unknown" };
    if (cur.endedAt !== null) return { ok: false, reason: "ended" };
    if (cur.acceptHex !== null) return { ok: false, reason: "already-accepted" };
    return { ok: false, reason: "expired" };
  }

  async end(shareId: string, kind: ServerShareEndKind, endJson: string, now: number): Promise<boolean> {
    const res = await this.db
      .prepare(`UPDATE server_shares SET end_kind = ?2, end_json = ?3, ended_at = ?4 WHERE share_id = ?1 AND ended_at IS NULL`)
      .bind(shareId, kind, endJson, now)
      .run();
    await this.deleteUnlock(shareId);
    return (res.meta.changes ?? 0) > 0;
  }

  async endsForServer(serverDomain: string, since: number, limit: number): Promise<ServerShareEnd[]> {
    const rs = await this.db
      .prepare(
        `SELECT share_id, end_kind, end_json, ended_at FROM server_shares
           WHERE server_domain = ?1 AND ended_at IS NOT NULL AND ended_at >= ?2
           ORDER BY ended_at ASC LIMIT ?3`,
      )
      .bind(serverDomain, since, limit)
      .all<{ share_id: string; end_kind: string; end_json: string; ended_at: number }>();
    return (rs.results ?? [])
      .filter((r) => r.end_kind === "revoke" || r.end_kind === "leave")
      .map((r) => ({ shareId: r.share_id, kind: r.end_kind as ServerShareEndKind, endJson: r.end_json, endedAt: r.ended_at }));
  }

  async putUnlock(rec: ServerShareUnlockRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO server_share_unlocks
           (share_id, server_domain, member_pub_hex, sealed_key_hex, deposit_json, signature_hex, issued_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(share_id) DO UPDATE SET
           server_domain = excluded.server_domain, member_pub_hex = excluded.member_pub_hex,
           sealed_key_hex = excluded.sealed_key_hex, deposit_json = excluded.deposit_json,
           signature_hex = excluded.signature_hex, issued_at = excluded.issued_at`,
      )
      .bind(rec.shareId, rec.serverDomain, rec.memberPubHex, rec.sealedKeyHex, rec.depositJson, rec.signatureHex, rec.issuedAt)
      .run();
  }

  async getUnlock(shareId: string): Promise<ServerShareUnlockRecord | null> {
    const r = await this.db.prepare(`SELECT * FROM server_share_unlocks WHERE share_id = ?1`).bind(shareId).first<UnlockRow>();
    return r ? unlockFromRow(r) : null;
  }

  async unlockForMember(serverDomain: string, memberPubHex: string): Promise<ServerShareUnlockRecord | null> {
    const r = await this.db
      .prepare(
        `SELECT u.* FROM server_share_unlocks u JOIN server_shares s ON s.share_id = u.share_id
           WHERE u.server_domain = ?1 AND u.member_pub_hex = ?2 AND s.ended_at IS NULL
           ORDER BY u.issued_at DESC LIMIT 1`,
      )
      .bind(serverDomain, memberPubHex)
      .first<UnlockRow>();
    return r ? unlockFromRow(r) : null;
  }

  async deleteUnlock(shareId: string): Promise<boolean> {
    const res = await this.db.prepare(`DELETE FROM server_share_unlocks WHERE share_id = ?1`).bind(shareId).run();
    await this.db.prepare(`DELETE FROM server_share_push WHERE share_id = ?1`).bind(shareId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async putPush(rec: ServerSharePushRecord, cap: number): Promise<boolean> {
    const existing = await this.db
      .prepare(`SELECT 1 AS x FROM server_share_push WHERE share_id = ?1 AND token_sha256 = ?2`)
      .bind(rec.shareId, rec.tokenSha256)
      .first<{ x: number }>();
    if (!existing) {
      const n = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM server_share_push WHERE share_id = ?1`)
        .bind(rec.shareId)
        .first<{ n: number }>();
      if ((n?.n ?? 0) >= cap) return false;
    }
    await this.db
      .prepare(
        `INSERT INTO server_share_push
           (share_id, server_domain, member_pub_hex, token_sha256, platform, provider_token, registered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(share_id, token_sha256) DO UPDATE SET
           server_domain = excluded.server_domain, member_pub_hex = excluded.member_pub_hex,
           platform = excluded.platform, provider_token = excluded.provider_token,
           registered_at = excluded.registered_at`,
      )
      .bind(rec.shareId, rec.serverDomain, rec.memberPubHex, rec.tokenSha256, rec.platform, rec.providerToken, rec.registeredAt)
      .run();
    return true;
  }

  async deletePush(shareId: string, tokenSha256: string): Promise<boolean> {
    const res = await this.db
      .prepare(`DELETE FROM server_share_push WHERE share_id = ?1 AND token_sha256 = ?2`)
      .bind(shareId, tokenSha256)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async pushTargetsForServer(serverDomain: string): Promise<ServerSharePushRecord[]> {
    const rs = await this.db
      .prepare(
        `SELECT p.* FROM server_share_push p
           JOIN server_shares s ON s.share_id = p.share_id
           JOIN server_share_unlocks u ON u.share_id = p.share_id AND u.member_pub_hex = p.member_pub_hex
           WHERE p.server_domain = ?1 AND s.ended_at IS NULL
           LIMIT 200`,
      )
      .bind(serverDomain)
      .all<PushRow>();
    return (rs.results ?? []).map(pushFromRow);
  }

  async inboxPut(rec: ShareInboxRecord, cap: number): Promise<boolean> {
    const existing = await this.db
      .prepare(`SELECT 1 AS x FROM share_inbox WHERE inbox_id = ?1 AND entry_id = ?2`)
      .bind(rec.inboxId, rec.entryId)
      .first<{ x: number }>();
    if (!existing) {
      const n = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM share_inbox WHERE inbox_id = ?1`)
        .bind(rec.inboxId)
        .first<{ n: number }>();
      if ((n?.n ?? 0) >= cap) return false;
    }
    await this.db
      .prepare(
        `INSERT INTO share_inbox (inbox_id, entry_id, ct_hex, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(inbox_id, entry_id) DO UPDATE SET ct_hex = excluded.ct_hex`,
      )
      .bind(rec.inboxId, rec.entryId, rec.ctHex, rec.createdAt)
      .run();
    return true;
  }

  async inboxList(inboxId: string): Promise<ShareInboxRecord[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM share_inbox WHERE inbox_id = ?1 ORDER BY created_at ASC, entry_id ASC`)
      .bind(inboxId)
      .all<InboxRow>();
    return (rs.results ?? []).map((r) => ({ inboxId: r.inbox_id, entryId: r.entry_id, ctHex: r.ct_hex, createdAt: r.created_at }));
  }

  async inboxDelete(inboxId: string, entryId: string): Promise<boolean> {
    const res = await this.db.prepare(`DELETE FROM share_inbox WHERE inbox_id = ?1 AND entry_id = ?2`).bind(inboxId, entryId).run();
    return (res.meta.changes ?? 0) > 0;
  }
}

export class InMemoryServerShareStorage implements ServerShareStorage {
  private readonly shares = new Map<string, ServerShareRecord>();
  private readonly unlocks = new Map<string, ServerShareUnlockRecord>();
  private readonly inbox = new Map<string, ShareInboxRecord>();
  private readonly pushes = new Map<string, ServerSharePushRecord>();

  async create(rec: Omit<ServerShareRecord, "acceptHex" | "acceptedAt" | "endKind" | "endJson" | "endedAt">): Promise<{ ok: boolean }> {
    if (this.shares.has(rec.shareId)) return { ok: false };
    for (const s of this.shares.values()) if (s.tokenHash === rec.tokenHash) return { ok: false };
    this.shares.set(rec.shareId, { ...rec, acceptHex: null, acceptedAt: null, endKind: null, endJson: null, endedAt: null });
    return { ok: true };
  }

  async get(shareId: string): Promise<ServerShareRecord | null> {
    const s = this.shares.get(shareId);
    return s ? { ...s } : null;
  }

  async listForOwner(username: string): Promise<ServerShareRecord[]> {
    return [...this.shares.values()]
      .filter((s) => s.ownerUsername === username)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({ ...s }));
  }

  async accept(shareId: string, acceptHex: string, now: number): Promise<ShareAcceptResult> {
    const s = this.shares.get(shareId);
    if (!s) return { ok: false, reason: "unknown" };
    if (s.endedAt !== null) return { ok: false, reason: "ended" };
    if (s.acceptHex !== null) return { ok: false, reason: "already-accepted" };
    if (s.expiresAt <= now) return { ok: false, reason: "expired" };
    s.acceptHex = acceptHex;
    s.acceptedAt = now;
    return { ok: true };
  }

  async end(shareId: string, kind: ServerShareEndKind, endJson: string, now: number): Promise<boolean> {
    const s = this.shares.get(shareId);
    this.unlocks.delete(shareId);
    if (!s || s.endedAt !== null) return false;
    s.endKind = kind;
    s.endJson = endJson;
    s.endedAt = now;
    return true;
  }

  async endsForServer(serverDomain: string, since: number, limit: number): Promise<ServerShareEnd[]> {
    return [...this.shares.values()]
      .filter((s) => s.serverDomain === serverDomain && s.endedAt !== null && s.endedAt >= since && s.endKind && s.endJson)
      .sort((a, b) => a.endedAt! - b.endedAt!)
      .slice(0, limit)
      .map((s) => ({ shareId: s.shareId, kind: s.endKind!, endJson: s.endJson!, endedAt: s.endedAt! }));
  }

  async putUnlock(rec: ServerShareUnlockRecord): Promise<void> {
    this.unlocks.set(rec.shareId, { ...rec });
  }

  async getUnlock(shareId: string): Promise<ServerShareUnlockRecord | null> {
    const u = this.unlocks.get(shareId);
    return u ? { ...u } : null;
  }

  async unlockForMember(serverDomain: string, memberPubHex: string): Promise<ServerShareUnlockRecord | null> {
    let best: ServerShareUnlockRecord | null = null;
    for (const u of this.unlocks.values()) {
      if (u.serverDomain !== serverDomain || u.memberPubHex !== memberPubHex) continue;
      if (this.shares.get(u.shareId)?.endedAt !== null) continue;
      if (!best || u.issuedAt > best.issuedAt) best = u;
    }
    return best ? { ...best } : null;
  }

  async deleteUnlock(shareId: string): Promise<boolean> {
    for (const [k, p] of this.pushes) if (p.shareId === shareId) this.pushes.delete(k);
    return this.unlocks.delete(shareId);
  }

  async putPush(rec: ServerSharePushRecord, cap: number): Promise<boolean> {
    const key = `${rec.shareId}|${rec.tokenSha256}`;
    if (!this.pushes.has(key) && [...this.pushes.values()].filter((p) => p.shareId === rec.shareId).length >= cap) return false;
    this.pushes.set(key, { ...rec });
    return true;
  }

  async deletePush(shareId: string, tokenSha256: string): Promise<boolean> {
    return this.pushes.delete(`${shareId}|${tokenSha256}`);
  }

  async pushTargetsForServer(serverDomain: string): Promise<ServerSharePushRecord[]> {
    return [...this.pushes.values()]
      .filter((p) => {
        if (p.serverDomain !== serverDomain) return false;
        const s = this.shares.get(p.shareId);
        const u = this.unlocks.get(p.shareId);
        return !!s && s.endedAt === null && !!u && u.memberPubHex === p.memberPubHex;
      })
      .map((p) => ({ ...p }));
  }

  async inboxPut(rec: ShareInboxRecord, cap: number): Promise<boolean> {
    const key = `${rec.inboxId}|${rec.entryId}`;
    const prev = this.inbox.get(key);
    if (!prev && [...this.inbox.values()].filter((r) => r.inboxId === rec.inboxId).length >= cap) return false;
    this.inbox.set(key, prev ? { ...prev, ctHex: rec.ctHex } : { ...rec });
    return true;
  }

  async inboxList(inboxId: string): Promise<ShareInboxRecord[]> {
    return [...this.inbox.values()]
      .filter((r) => r.inboxId === inboxId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.entryId < b.entryId ? -1 : 1))
      .map((r) => ({ ...r }));
  }

  async inboxDelete(inboxId: string, entryId: string): Promise<boolean> {
    return this.inbox.delete(`${inboxId}|${entryId}`);
  }
}
