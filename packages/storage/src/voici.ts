/**
 * voi.ci pages and Messages (docs/voici-and-messages.md, migration 0123): the last accepted page index, uploaded
 * pieces, the sealed mailbox, the owner's block orders, signed-out browser keys, draft ops and the sealed Messages
 * state blob. `.com` stores no pseudonym ↔ account mapping here.
 */
import type { D1Database, D1PreparedStatement } from "./d1.js";

export interface VoiciPageRecord {
  username: string;
  pageId: string;
  seq: number;
  issuedAt: number;
  acceptsMessages: 0 | 1;
  inboxEpoch: number;
  ownerSignPub: string;
  indexJson: string;
  publishedAt: number;
  takenDownAt: number | null;
  takedownReason: string | null;
}

export interface VoiciPieceRecord {
  pageId: string;
  sha256: string;
  username: string;
  size: number;
  jpeg: boolean;
  uploadedAt: number;
  unreferencedAt: number | null;
  /** The role this JSON piece was parsed and accepted as, with the image hashes it names. */
  role: string | null;
  imageRefs: string[] | null;
}

export type VoiciMessageKind = "voici-message" | "voici-reply";

export interface VoiciMessageRecord {
  id: number;
  pageId: string;
  conv: string;
  msgId: string;
  kind: VoiciMessageKind;
  fromPub: string;
  /** The browser key a voici-message was signed with; null for a reply. */
  delegatePub: string | null;
  sentAt: number;
  envelope: string;
  size: number;
  direct: boolean;
  pushed: boolean;
  storedAt: number;
  fetchedAt: number | null;
}

export interface VoiciConvStats {
  messages: number;
  replies: number;
  messagesLastHour: number;
  messagesLastDay: number;
  lastPushedAt: number | null;
}

export interface VoiciBlockRecord {
  pageId: string;
  pseudonymPub: string;
  op: "block" | "unblock";
  issuedAt: number;
  signature: string;
}

export interface VoiciRevokedDelegate {
  delegatePub: string;
  pageId: string;
  principalPub: string;
  expiresAt: number;
  revokedAt: number;
}

export interface VoiciDraftRecord {
  username: string;
  opId: string;
  devicePub: string;
  envelope: string;
  size: number;
  createdAt: number;
}

/** A visitor's opt-in reply alert (migration 0125): one browser's Web Push subscription for one conversation. */
export interface VoiciAlertRecord {
  conv: string;
  /** SHA-256 hex of the endpoint URL. */
  endpointHash: string;
  pageId: string;
  /** `{endpoint, keys:{p256dh, auth}}` JSON, the providerToken shape pushBridge's Web Push sender reads. */
  subscription: string;
  /** The browser key that turned it on; signing that key out removes the row. */
  delegatePub: string;
  createdAt: number;
  /** The authorising delegation's expiry: the row is neither used nor kept after it. */
  expiresAt: number;
  lastPushedAt: number | null;
}

export interface MessagesStateRecord {
  username: string;
  version: number;
  blob: string;
  updatedAt: number;
}

export interface VoiciStorage {
  getPage(username: string): Promise<VoiciPageRecord | null>;
  getPageById(pageId: string): Promise<VoiciPageRecord | null>;
  /** Compare-and-set on `seq`: inserts when `expectedSeq` is 0 and no row exists, else updates the row at that seq.
   *  The takedown fields are never changed here. */
  publishPage(rec: Omit<VoiciPageRecord, "takenDownAt" | "takedownReason">, expectedSeq: number): Promise<boolean>;
  /** `at` null restores. False when the account has no page. */
  setTakedown(username: string, at: number | null, reason: string | null): Promise<boolean>;

  /** Idempotent; returns the stored row (the first upload's). */
  putPiece(rec: Omit<VoiciPieceRecord, "role" | "imageRefs">): Promise<VoiciPieceRecord>;
  getPieces(pageId: string, sha256s: readonly string[]): Promise<VoiciPieceRecord[]>;
  listPagePieces(pageId: string): Promise<VoiciPieceRecord[]>;
  /** `referenced` lose their unreferenced mark; `unreferenced` get `at` (unless already marked). */
  markPieces(pageId: string, referenced: readonly string[], unreferenced: readonly string[], at: number): Promise<void>;
  /** Marks every piece of the page unreferenced at `at` (takedown, account deletion). */
  unreferenceAllPieces(pageId: string, at: number): Promise<number>;
  setPieceParse(pageId: string, sha256: string, role: string, imageRefs: readonly string[]): Promise<void>;
  uploadedBytesSince(username: string, since: number): Promise<number>;
  listUnreferencedBefore(before: number, limit: number): Promise<VoiciPieceRecord[]>;
  /** Deletes up to `limit` pieces still unreferenced since before `before` (oldest first) and returns them, so their
   *  R2 objects go only after the row (a publish never finds a row whose object is gone). */
  deleteUnreferencedBefore(before: number, limit: number): Promise<{ pageId: string; sha256: string }[]>;
  /** The cron's pass in one round trip: `deleteUnreferencedBefore`, `deleteMessagesBefore`, `deleteDraftsBefore` and
   *  `deleteExpiredRevoked` with the same limit. */
  collect(o: { piecesBefore: number; messagesBefore: number; draftsBefore: number; now: number; limit: number }): Promise<{
    pieces: { pageId: string; sha256: string }[];
    messages: number;
    drafts: number;
    revoked: number;
    /** Reply alerts past their delegation's expiry, or whose conversation has no mail left. */
    alerts: number;
  }>;

  /** False when (conv, msgId) is already stored. */
  insertMessage(rec: Omit<VoiciMessageRecord, "id" | "fetchedAt">): Promise<{ ok: true; id: number } | { ok: false }>;
  getMessage(conv: string, msgId: string): Promise<VoiciMessageRecord | null>;
  convStats(conv: string, hourAgo: number, dayAgo: number): Promise<VoiciConvStats>;
  /** Messages of a page with id > sinceId, oldest first. */
  listInbox(pageId: string, sinceId: number, limit: number): Promise<VoiciMessageRecord[]>;
  /** Marks the page's voici-messages in (afterId, throughId] fetched. */
  markFetched(pageId: string, afterId: number, throughId: number, at: number): Promise<number>;
  listThread(conv: string, sinceId: number, limit: number): Promise<VoiciMessageRecord[]>;
  /** The highest id of a voici-message in the conversation an owner device fetched, 0 when none. */
  deliveredThrough(conv: string): Promise<number>;
  deleteMessagesBefore(before: number, limit: number): Promise<number>;
  /** The page a pseudonym's browser key wrote to, from a stored message, if any. */
  delegatePage(fromPub: string, delegatePub: string): Promise<string | null>;

  /** Newest issuedAt wins; false when a newer or equal order is stored. */
  setBlock(rec: VoiciBlockRecord, at: number): Promise<boolean>;
  getBlock(pageId: string, pseudonymPub: string): Promise<VoiciBlockRecord | null>;
  listBlocked(pageId: string): Promise<string[]>;

  revokeDelegate(rec: VoiciRevokedDelegate): Promise<void>;
  isRevoked(delegatePub: string, now: number): Promise<boolean>;
  listRevoked(pageId: string, now: number): Promise<string[]>;
  deleteExpiredRevoked(now: number, limit: number): Promise<number>;

  /** False when the op is already stored. */
  putDraft(rec: VoiciDraftRecord): Promise<boolean>;
  listDrafts(username: string): Promise<VoiciDraftRecord[]>;
  countDrafts(username: string): Promise<number>;
  consumeDrafts(username: string, opIds: readonly string[]): Promise<number>;
  deleteDraftsBefore(before: number, limit: number): Promise<number>;

  getState(username: string): Promise<MessagesStateRecord | null>;
  /** Compare-and-set: `version` must be the stored version + 1 (1 when none). */
  putState(username: string, version: number, blob: string, at: number): Promise<boolean>;

  /** Upserts the alert for (conv, endpointHash) (its push mark kept), then keeps only the conversation's newest
   *  `maxPerConv` rows. */
  putAlert(rec: Omit<VoiciAlertRecord, "lastPushedAt">, maxPerConv: number): Promise<void>;
  /** Claims a push for the conversation: when no row of it was pushed after `notAfter`, marks every unexpired row
   *  pushed at `now` and returns them; else returns none (at most one push per conversation per interval, also under
   *  concurrent replies). */
  claimAlertPush(conv: string, now: number, notAfter: number): Promise<{ endpointHash: string; subscription: string }[]>;
  listAlerts(conv: string): Promise<VoiciAlertRecord[]>;
  deleteAlert(conv: string, endpointHash: string): Promise<boolean>;
  deleteAlertsForPage(pageId: string): Promise<number>;
  deleteAlertsForDelegate(delegatePub: string): Promise<number>;

  /** Account deletion (§10.3): the page, its mailbox, reply alerts, blocks, revocations, drafts and the state blob go; its pieces
   *  are left for the cron to delete (unreferenced at 0). Returns the page id, if there was a page. */
  deleteAccount(username: string): Promise<string | null>;
}

// ── D1 ──────────────────────────────────────────────────────────────────────

interface PageRow {
  username: string;
  page_id: string;
  seq: number;
  issued_at: number;
  accepts_messages: number;
  inbox_epoch: number;
  owner_sign_pub: string;
  index_json: string;
  published_at: number;
  taken_down_at: number | null;
  takedown_reason: string | null;
}

interface PieceRow {
  page_id: string;
  sha256: string;
  username: string;
  size: number;
  jpeg: number;
  uploaded_at: number;
  unreferenced_at: number | null;
  role: string | null;
  image_refs: string | null;
}

interface MessageRow {
  id: number;
  page_id: string;
  conv: string;
  msg_id: string;
  kind: string;
  from_pub: string;
  delegate_pub: string | null;
  sent_at: number;
  envelope: string;
  size: number;
  direct: number;
  pushed: number;
  stored_at: number;
  fetched_at: number | null;
}

const pageFromRow = (r: PageRow): VoiciPageRecord => ({
  username: r.username,
  pageId: r.page_id,
  seq: r.seq,
  issuedAt: r.issued_at,
  acceptsMessages: r.accepts_messages ? 1 : 0,
  inboxEpoch: r.inbox_epoch,
  ownerSignPub: r.owner_sign_pub,
  indexJson: r.index_json,
  publishedAt: r.published_at,
  takenDownAt: r.taken_down_at ?? null,
  takedownReason: r.takedown_reason ?? null,
});

const pieceFromRow = (r: PieceRow): VoiciPieceRecord => ({
  pageId: r.page_id,
  sha256: r.sha256,
  username: r.username,
  size: r.size,
  jpeg: r.jpeg === 1,
  uploadedAt: r.uploaded_at,
  unreferencedAt: r.unreferenced_at ?? null,
  role: r.role ?? null,
  imageRefs: r.image_refs === null || r.image_refs === undefined ? null : r.image_refs === "" ? [] : r.image_refs.split(","),
});

const messageFromRow = (r: MessageRow): VoiciMessageRecord => ({
  id: r.id,
  pageId: r.page_id,
  conv: r.conv,
  msgId: r.msg_id,
  kind: r.kind as VoiciMessageKind,
  fromPub: r.from_pub,
  delegatePub: r.delegate_pub ?? null,
  sentAt: r.sent_at,
  envelope: r.envelope,
  size: r.size,
  direct: r.direct === 1,
  pushed: r.pushed === 1,
  storedAt: r.stored_at,
  fetchedAt: r.fetched_at ?? null,
});

/** D1 binds at most 100 parameters a statement. */
const PARAM_CHUNK = 90;
function chunks<T>(xs: readonly T[], n = PARAM_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
const placeholders = (n: number, from = 2) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");
const isConflict = (e: unknown) => /UNIQUE|PRIMARY KEY|constraint/i.test(String((e as Error)?.message ?? e));

const PAGE_COLS =
  "username, page_id, seq, issued_at, accepts_messages, inbox_epoch, owner_sign_pub, index_json, published_at, taken_down_at, takedown_reason";
const PIECE_COLS = "page_id, sha256, username, size, jpeg, uploaded_at, unreferenced_at, role, image_refs";
const MSG_COLS = "id, page_id, conv, msg_id, kind, from_pub, delegate_pub, sent_at, envelope, size, direct, pushed, stored_at, fetched_at";

export class D1VoiciStorage implements VoiciStorage {
  constructor(private readonly db: D1Database) {}

  async getPage(username: string) {
    const r = await this.db.prepare(`SELECT ${PAGE_COLS} FROM voici_pages WHERE username = ?1`).bind(username).first<PageRow>();
    return r ? pageFromRow(r) : null;
  }

  async getPageById(pageId: string) {
    const r = await this.db.prepare(`SELECT ${PAGE_COLS} FROM voici_pages WHERE page_id = ?1`).bind(pageId).first<PageRow>();
    return r ? pageFromRow(r) : null;
  }

  async publishPage(rec: Omit<VoiciPageRecord, "takenDownAt" | "takedownReason">, expectedSeq: number) {
    const vals = [rec.username, rec.pageId, rec.seq, rec.issuedAt, rec.acceptsMessages, rec.inboxEpoch, rec.ownerSignPub, rec.indexJson, rec.publishedAt];
    if (expectedSeq === 0) {
      try {
        const res = await this.db
          .prepare(
            "INSERT INTO voici_pages (username, page_id, seq, issued_at, accepts_messages, inbox_epoch, owner_sign_pub, index_json, published_at) " +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
          )
          .bind(...vals)
          .run();
        return (res.meta.changes ?? 0) === 1;
      } catch (e) {
        if (isConflict(e)) return false;
        throw e;
      }
    }
    const res = await this.db
      .prepare(
        "UPDATE voici_pages SET seq = ?3, issued_at = ?4, accepts_messages = ?5, inbox_epoch = ?6, owner_sign_pub = ?7, " +
          "index_json = ?8, published_at = ?9 WHERE username = ?1 AND page_id = ?2 AND seq = ?10",
      )
      .bind(...vals, expectedSeq)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async setTakedown(username: string, at: number | null, reason: string | null) {
    const res = await this.db
      .prepare("UPDATE voici_pages SET taken_down_at = ?2, takedown_reason = ?3 WHERE username = ?1")
      .bind(username, at, at === null ? null : reason)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async putPiece(rec: Omit<VoiciPieceRecord, "role" | "imageRefs">) {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO voici_pieces (page_id, sha256, username, size, jpeg, uploaded_at, unreferenced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(rec.pageId, rec.sha256, rec.username, rec.size, rec.jpeg ? 1 : 0, rec.uploadedAt, rec.unreferencedAt)
      .run();
    const r = await this.db
      .prepare(`SELECT ${PIECE_COLS} FROM voici_pieces WHERE page_id = ?1 AND sha256 = ?2`)
      .bind(rec.pageId, rec.sha256)
      .first<PieceRow>();
    return pieceFromRow(r!);
  }

  async getPieces(pageId: string, sha256s: readonly string[]) {
    if (sha256s.length === 0) return [];
    const stmts = chunks([...new Set(sha256s)]).map((c) =>
      this.db.prepare(`SELECT ${PIECE_COLS} FROM voici_pieces WHERE page_id = ?1 AND sha256 IN (${placeholders(c.length)})`).bind(pageId, ...c),
    );
    const results = stmts.length === 1 ? [await stmts[0]!.all<PieceRow>()] : await this.db.batch(stmts);
    return results.flatMap((r) => ((r.results ?? []) as PieceRow[]).map(pieceFromRow));
  }

  async listPagePieces(pageId: string) {
    const rs = await this.db.prepare(`SELECT ${PIECE_COLS} FROM voici_pieces WHERE page_id = ?1 ORDER BY sha256`).bind(pageId).all<PieceRow>();
    return (rs.results ?? []).map(pieceFromRow);
  }

  async markPieces(pageId: string, referenced: readonly string[], unreferenced: readonly string[], at: number) {
    const stmts: D1PreparedStatement[] = [
      ...chunks(referenced).map((c) =>
        this.db.prepare(`UPDATE voici_pieces SET unreferenced_at = NULL WHERE page_id = ?1 AND sha256 IN (${placeholders(c.length)})`).bind(pageId, ...c),
      ),
      ...chunks(unreferenced, PARAM_CHUNK - 1).map((c) =>
        this.db
          .prepare(
            `UPDATE voici_pieces SET unreferenced_at = ?2 WHERE page_id = ?1 AND unreferenced_at IS NULL AND sha256 IN (${placeholders(c.length, 3)})`,
          )
          .bind(pageId, at, ...c),
      ),
    ];
    if (stmts.length > 0) await this.db.batch(stmts);
  }

  async unreferenceAllPieces(pageId: string, at: number) {
    const res = await this.db.prepare("UPDATE voici_pieces SET unreferenced_at = ?2 WHERE page_id = ?1").bind(pageId, at).run();
    return res.meta.changes ?? 0;
  }

  async setPieceParse(pageId: string, sha256: string, role: string, imageRefs: readonly string[]) {
    await this.db
      .prepare("UPDATE voici_pieces SET role = ?3, image_refs = ?4 WHERE page_id = ?1 AND sha256 = ?2")
      .bind(pageId, sha256, role, imageRefs.join(","))
      .run();
  }

  async uploadedBytesSince(username: string, since: number) {
    const r = await this.db
      .prepare("SELECT COALESCE(SUM(size), 0) AS n FROM voici_pieces WHERE username = ?1 AND uploaded_at >= ?2")
      .bind(username, since)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async listUnreferencedBefore(before: number, limit: number) {
    const rs = await this.db
      .prepare(`SELECT ${PIECE_COLS} FROM voici_pieces WHERE unreferenced_at IS NOT NULL AND unreferenced_at < ?1 ORDER BY unreferenced_at LIMIT ?2`)
      .bind(before, limit)
      .all<PieceRow>();
    return (rs.results ?? []).map(pieceFromRow);
  }

  private deleteUnreferencedStmt(before: number, limit: number) {
    return this.db
      .prepare(
        "DELETE FROM voici_pieces WHERE rowid IN (SELECT rowid FROM voici_pieces WHERE unreferenced_at IS NOT NULL AND unreferenced_at < ?1 " +
          "ORDER BY unreferenced_at LIMIT ?2) RETURNING page_id, sha256",
      )
      .bind(before, limit);
  }

  async deleteUnreferencedBefore(before: number, limit: number) {
    const rs = await this.deleteUnreferencedStmt(before, limit).all<{ page_id: string; sha256: string }>();
    return (rs.results ?? []).map((r) => ({ pageId: r.page_id, sha256: r.sha256 }));
  }

  async collect(o: { piecesBefore: number; messagesBefore: number; draftsBefore: number; now: number; limit: number }) {
    const [p, m, d, r, a] = await this.db.batch([
      this.deleteUnreferencedStmt(o.piecesBefore, o.limit),
      this.db
        .prepare("DELETE FROM voici_messages WHERE id IN (SELECT id FROM voici_messages WHERE stored_at < ?1 ORDER BY stored_at LIMIT ?2)")
        .bind(o.messagesBefore, o.limit),
      this.db
        .prepare("DELETE FROM voici_drafts WHERE rowid IN (SELECT rowid FROM voici_drafts WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)")
        .bind(o.draftsBefore, o.limit),
      this.db
        .prepare("DELETE FROM voici_revoked_delegates WHERE delegate_pub IN (SELECT delegate_pub FROM voici_revoked_delegates WHERE expires_at <= ?1 LIMIT ?2)")
        .bind(o.now, o.limit),
      this.db
        .prepare(
          "DELETE FROM voici_alerts WHERE rowid IN (SELECT a.rowid FROM voici_alerts a WHERE a.expires_at <= ?1 " +
            "OR NOT EXISTS (SELECT 1 FROM voici_messages m WHERE m.conv = a.conv) LIMIT ?2)",
        )
        .bind(o.now, o.limit),
    ]);
    return {
      pieces: ((p?.results ?? []) as { page_id: string; sha256: string }[]).map((x) => ({ pageId: x.page_id, sha256: x.sha256 })),
      messages: m?.meta.changes ?? 0,
      drafts: d?.meta.changes ?? 0,
      revoked: r?.meta.changes ?? 0,
      alerts: a?.meta.changes ?? 0,
    };
  }

  async insertMessage(rec: Omit<VoiciMessageRecord, "id" | "fetchedAt">) {
    try {
      const r = await this.db
        .prepare(
          "INSERT INTO voici_messages (page_id, conv, msg_id, kind, from_pub, delegate_pub, sent_at, envelope, size, direct, pushed, stored_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id",
        )
        .bind(rec.pageId, rec.conv, rec.msgId, rec.kind, rec.fromPub, rec.delegatePub, rec.sentAt, rec.envelope, rec.size, rec.direct ? 1 : 0, rec.pushed ? 1 : 0, rec.storedAt)
        .first<{ id: number }>();
      return r ? { ok: true as const, id: r.id } : { ok: false as const };
    } catch (e) {
      if (isConflict(e)) return { ok: false as const };
      throw e;
    }
  }

  async getMessage(conv: string, msgId: string) {
    const r = await this.db.prepare(`SELECT ${MSG_COLS} FROM voici_messages WHERE conv = ?1 AND msg_id = ?2`).bind(conv, msgId).first<MessageRow>();
    return r ? messageFromRow(r) : null;
  }

  async convStats(conv: string, hourAgo: number, dayAgo: number) {
    const r = await this.db
      .prepare(
        "SELECT COALESCE(SUM(kind = 'voici-message'), 0) AS m, COALESCE(SUM(kind = 'voici-reply'), 0) AS r, " +
          "COALESCE(SUM(kind = 'voici-message' AND stored_at > ?2), 0) AS h, COALESCE(SUM(kind = 'voici-message' AND stored_at > ?3), 0) AS d, " +
          "MAX(CASE WHEN pushed = 1 THEN stored_at END) AS p FROM voici_messages WHERE conv = ?1",
      )
      .bind(conv, hourAgo, dayAgo)
      .first<{ m: number; r: number; h: number; d: number; p: number | null }>();
    return {
      messages: r?.m ?? 0,
      replies: r?.r ?? 0,
      messagesLastHour: r?.h ?? 0,
      messagesLastDay: r?.d ?? 0,
      lastPushedAt: r?.p ?? null,
    };
  }

  async listInbox(pageId: string, sinceId: number, limit: number) {
    const rs = await this.db
      .prepare(`SELECT ${MSG_COLS} FROM voici_messages WHERE page_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`)
      .bind(pageId, sinceId, limit)
      .all<MessageRow>();
    return (rs.results ?? []).map(messageFromRow);
  }

  async markFetched(pageId: string, afterId: number, throughId: number, at: number) {
    const res = await this.db
      .prepare(
        "UPDATE voici_messages SET fetched_at = ?4 WHERE page_id = ?1 AND id > ?2 AND id <= ?3 AND kind = 'voici-message' AND fetched_at IS NULL",
      )
      .bind(pageId, afterId, throughId, at)
      .run();
    return res.meta.changes ?? 0;
  }

  async listThread(conv: string, sinceId: number, limit: number) {
    const rs = await this.db
      .prepare(`SELECT ${MSG_COLS} FROM voici_messages WHERE conv = ?1 AND id > ?2 ORDER BY id LIMIT ?3`)
      .bind(conv, sinceId, limit)
      .all<MessageRow>();
    return (rs.results ?? []).map(messageFromRow);
  }

  async deliveredThrough(conv: string) {
    const r = await this.db
      .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM voici_messages WHERE conv = ?1 AND kind = 'voici-message' AND fetched_at IS NOT NULL")
      .bind(conv)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async deleteMessagesBefore(before: number, limit: number) {
    const res = await this.db
      .prepare("DELETE FROM voici_messages WHERE id IN (SELECT id FROM voici_messages WHERE stored_at < ?1 ORDER BY stored_at LIMIT ?2)")
      .bind(before, limit)
      .run();
    return res.meta.changes ?? 0;
  }

  async delegatePage(fromPub: string, delegatePub: string) {
    const r = await this.db
      .prepare("SELECT page_id FROM voici_messages WHERE delegate_pub = ?2 AND from_pub = ?1 LIMIT 1")
      .bind(fromPub, delegatePub)
      .first<{ page_id: string }>();
    return r?.page_id ?? null;
  }

  async setBlock(rec: VoiciBlockRecord, at: number) {
    const res = await this.db
      .prepare(
        "INSERT INTO voici_blocks (page_id, pseudonym_pub, op, issued_at, signature, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
          "ON CONFLICT (page_id, pseudonym_pub) DO UPDATE SET op = excluded.op, issued_at = excluded.issued_at, signature = excluded.signature, " +
          "updated_at = excluded.updated_at WHERE excluded.issued_at > voici_blocks.issued_at",
      )
      .bind(rec.pageId, rec.pseudonymPub, rec.op, rec.issuedAt, rec.signature, at)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async getBlock(pageId: string, pseudonymPub: string) {
    const r = await this.db
      .prepare("SELECT page_id, pseudonym_pub, op, issued_at, signature FROM voici_blocks WHERE page_id = ?1 AND pseudonym_pub = ?2")
      .bind(pageId, pseudonymPub)
      .first<{ page_id: string; pseudonym_pub: string; op: string; issued_at: number; signature: string }>();
    return r ? { pageId: r.page_id, pseudonymPub: r.pseudonym_pub, op: r.op as "block" | "unblock", issuedAt: r.issued_at, signature: r.signature } : null;
  }

  async listBlocked(pageId: string) {
    const rs = await this.db
      .prepare("SELECT pseudonym_pub FROM voici_blocks WHERE page_id = ?1 AND op = 'block' ORDER BY pseudonym_pub")
      .bind(pageId)
      .all<{ pseudonym_pub: string }>();
    return (rs.results ?? []).map((r) => r.pseudonym_pub);
  }

  async revokeDelegate(rec: VoiciRevokedDelegate) {
    await this.db
      .prepare("INSERT OR IGNORE INTO voici_revoked_delegates (delegate_pub, page_id, principal_pub, expires_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(rec.delegatePub, rec.pageId, rec.principalPub, rec.expiresAt, rec.revokedAt)
      .run();
  }

  async isRevoked(delegatePub: string, now: number) {
    const r = await this.db
      .prepare("SELECT 1 AS x FROM voici_revoked_delegates WHERE delegate_pub = ?1 AND expires_at > ?2")
      .bind(delegatePub, now)
      .first<{ x: number }>();
    return !!r;
  }

  async listRevoked(pageId: string, now: number) {
    const rs = await this.db
      .prepare("SELECT delegate_pub FROM voici_revoked_delegates WHERE page_id = ?1 AND expires_at > ?2 ORDER BY delegate_pub")
      .bind(pageId, now)
      .all<{ delegate_pub: string }>();
    return (rs.results ?? []).map((r) => r.delegate_pub);
  }

  async deleteExpiredRevoked(now: number, limit: number) {
    const res = await this.db
      .prepare("DELETE FROM voici_revoked_delegates WHERE delegate_pub IN (SELECT delegate_pub FROM voici_revoked_delegates WHERE expires_at <= ?1 LIMIT ?2)")
      .bind(now, limit)
      .run();
    return res.meta.changes ?? 0;
  }

  async putDraft(rec: VoiciDraftRecord) {
    const res = await this.db
      .prepare("INSERT OR IGNORE INTO voici_drafts (username, op_id, device_pub, envelope, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(rec.username, rec.opId, rec.devicePub, rec.envelope, rec.size, rec.createdAt)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async listDrafts(username: string) {
    const rs = await this.db
      .prepare("SELECT username, op_id, device_pub, envelope, size, created_at FROM voici_drafts WHERE username = ?1 ORDER BY created_at, op_id")
      .bind(username)
      .all<{ username: string; op_id: string; device_pub: string; envelope: string; size: number; created_at: number }>();
    return (rs.results ?? []).map((r) => ({
      username: r.username,
      opId: r.op_id,
      devicePub: r.device_pub,
      envelope: r.envelope,
      size: r.size,
      createdAt: r.created_at,
    }));
  }

  async countDrafts(username: string) {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM voici_drafts WHERE username = ?1").bind(username).first<{ n: number }>();
    return r?.n ?? 0;
  }

  async consumeDrafts(username: string, opIds: readonly string[]) {
    if (opIds.length === 0) return 0;
    const out = await this.db.batch(
      chunks(opIds).map((c) => this.db.prepare(`DELETE FROM voici_drafts WHERE username = ?1 AND op_id IN (${placeholders(c.length)})`).bind(username, ...c)),
    );
    return out.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }

  async deleteDraftsBefore(before: number, limit: number) {
    const res = await this.db
      .prepare(
        "DELETE FROM voici_drafts WHERE rowid IN (SELECT rowid FROM voici_drafts WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)",
      )
      .bind(before, limit)
      .run();
    return res.meta.changes ?? 0;
  }

  async getState(username: string) {
    const r = await this.db
      .prepare("SELECT username, version, blob, updated_at FROM messages_state WHERE username = ?1")
      .bind(username)
      .first<{ username: string; version: number; blob: string; updated_at: number }>();
    return r ? { username: r.username, version: r.version, blob: r.blob, updatedAt: r.updated_at } : null;
  }

  async putState(username: string, version: number, blob: string, at: number) {
    if (version === 1) {
      const res = await this.db
        .prepare("INSERT OR IGNORE INTO messages_state (username, version, blob, updated_at) VALUES (?1, 1, ?2, ?3)")
        .bind(username, blob, at)
        .run();
      return (res.meta.changes ?? 0) === 1;
    }
    const res = await this.db
      .prepare("UPDATE messages_state SET version = ?2, blob = ?3, updated_at = ?4 WHERE username = ?1 AND version = ?5")
      .bind(username, version, blob, at, version - 1)
      .run();
    return (res.meta.changes ?? 0) === 1;
  }

  async putAlert(rec: Omit<VoiciAlertRecord, "lastPushedAt">, maxPerConv: number) {
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO voici_alerts (conv, endpoint_hash, page_id, subscription, delegate_pub, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
            "ON CONFLICT (conv, endpoint_hash) DO UPDATE SET page_id = excluded.page_id, subscription = excluded.subscription, " +
            "delegate_pub = excluded.delegate_pub, created_at = excluded.created_at, expires_at = excluded.expires_at",
        )
        .bind(rec.conv, rec.endpointHash, rec.pageId, rec.subscription, rec.delegatePub, rec.createdAt, rec.expiresAt),
      this.db
        .prepare(
          "DELETE FROM voici_alerts WHERE conv = ?1 AND rowid NOT IN (SELECT rowid FROM voici_alerts WHERE conv = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        )
        .bind(rec.conv, maxPerConv),
    ]);
  }

  async claimAlertPush(conv: string, now: number, notAfter: number) {
    // The scalar subquery is not correlated, so SQLite evaluates it once, before any row of this UPDATE changes.
    const rs = await this.db
      .prepare(
        "UPDATE voici_alerts SET last_pushed_at = ?2 WHERE conv = ?1 AND expires_at > ?2 " +
          "AND (SELECT COUNT(*) FROM voici_alerts WHERE conv = ?1 AND last_pushed_at > ?3) = 0 RETURNING endpoint_hash, subscription",
      )
      .bind(conv, now, notAfter)
      .all<{ endpoint_hash: string; subscription: string }>();
    return (rs.results ?? []).map((r) => ({ endpointHash: r.endpoint_hash, subscription: r.subscription }));
  }

  async listAlerts(conv: string) {
    const rs = await this.db
      .prepare(
        "SELECT conv, endpoint_hash, page_id, subscription, delegate_pub, created_at, expires_at, last_pushed_at FROM voici_alerts WHERE conv = ?1 ORDER BY created_at, rowid",
      )
      .bind(conv)
      .all<{
        conv: string;
        endpoint_hash: string;
        page_id: string;
        subscription: string;
        delegate_pub: string;
        created_at: number;
        expires_at: number;
        last_pushed_at: number | null;
      }>();
    return (rs.results ?? []).map((r) => ({
      conv: r.conv,
      endpointHash: r.endpoint_hash,
      pageId: r.page_id,
      subscription: r.subscription,
      delegatePub: r.delegate_pub,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastPushedAt: r.last_pushed_at ?? null,
    }));
  }

  async deleteAlert(conv: string, endpointHash: string) {
    const res = await this.db.prepare("DELETE FROM voici_alerts WHERE conv = ?1 AND endpoint_hash = ?2").bind(conv, endpointHash).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async deleteAlertsForPage(pageId: string) {
    const res = await this.db.prepare("DELETE FROM voici_alerts WHERE page_id = ?1").bind(pageId).run();
    return res.meta.changes ?? 0;
  }

  async deleteAlertsForDelegate(delegatePub: string) {
    const res = await this.db.prepare("DELETE FROM voici_alerts WHERE delegate_pub = ?1").bind(delegatePub).run();
    return res.meta.changes ?? 0;
  }

  async deleteAccount(username: string) {
    const page = await this.getPage(username);
    const stmts: D1PreparedStatement[] = [
      this.db.prepare("DELETE FROM voici_drafts WHERE username = ?1").bind(username),
      this.db.prepare("DELETE FROM messages_state WHERE username = ?1").bind(username),
    ];
    if (page) {
      stmts.push(
        this.db.prepare("DELETE FROM voici_messages WHERE page_id = ?1").bind(page.pageId),
        this.db.prepare("DELETE FROM voici_alerts WHERE page_id = ?1").bind(page.pageId),
        this.db.prepare("DELETE FROM voici_blocks WHERE page_id = ?1").bind(page.pageId),
        this.db.prepare("DELETE FROM voici_revoked_delegates WHERE page_id = ?1").bind(page.pageId),
        this.db.prepare("UPDATE voici_pieces SET unreferenced_at = 0 WHERE page_id = ?1").bind(page.pageId),
        this.db.prepare("DELETE FROM voici_pages WHERE username = ?1").bind(username),
      );
    }
    await this.db.batch(stmts);
    return page?.pageId ?? null;
  }
}

// ── in memory ───────────────────────────────────────────────────────────────

export class InMemoryVoiciStorage implements VoiciStorage {
  private pages = new Map<string, VoiciPageRecord>();
  private pieces = new Map<string, VoiciPieceRecord>();
  private messages: VoiciMessageRecord[] = [];
  private nextId = 1;
  private blocks = new Map<string, VoiciBlockRecord>();
  private revoked = new Map<string, VoiciRevokedDelegate>();
  private drafts = new Map<string, VoiciDraftRecord>();
  private states = new Map<string, MessagesStateRecord>();
  private alerts: VoiciAlertRecord[] = [];

  private static pk(a: string, b: string) {
    return `${a}|${b}`;
  }

  async getPage(username: string) {
    const p = this.pages.get(username);
    return p ? { ...p } : null;
  }

  async getPageById(pageId: string) {
    const p = [...this.pages.values()].find((x) => x.pageId === pageId);
    return p ? { ...p } : null;
  }

  async publishPage(rec: Omit<VoiciPageRecord, "takenDownAt" | "takedownReason">, expectedSeq: number) {
    const cur = this.pages.get(rec.username);
    if (expectedSeq === 0) {
      if (cur || [...this.pages.values()].some((p) => p.pageId === rec.pageId)) return false;
      this.pages.set(rec.username, { ...rec, takenDownAt: null, takedownReason: null });
      return true;
    }
    if (!cur || cur.seq !== expectedSeq || cur.pageId !== rec.pageId) return false;
    this.pages.set(rec.username, { ...rec, takenDownAt: cur.takenDownAt, takedownReason: cur.takedownReason });
    return true;
  }

  async setTakedown(username: string, at: number | null, reason: string | null) {
    const cur = this.pages.get(username);
    if (!cur) return false;
    cur.takenDownAt = at;
    cur.takedownReason = at === null ? null : reason;
    return true;
  }

  async putPiece(rec: Omit<VoiciPieceRecord, "role" | "imageRefs">) {
    const k = InMemoryVoiciStorage.pk(rec.pageId, rec.sha256);
    if (!this.pieces.has(k)) this.pieces.set(k, { ...rec, role: null, imageRefs: null });
    const p = this.pieces.get(k)!;
    return { ...p, imageRefs: p.imageRefs ? [...p.imageRefs] : null };
  }

  async getPieces(pageId: string, sha256s: readonly string[]) {
    return [...new Set(sha256s)]
      .map((h) => this.pieces.get(InMemoryVoiciStorage.pk(pageId, h)))
      .filter((p): p is VoiciPieceRecord => !!p)
      .map((p) => ({ ...p, imageRefs: p.imageRefs ? [...p.imageRefs] : null }));
  }

  async listPagePieces(pageId: string) {
    return [...this.pieces.values()]
      .filter((p) => p.pageId === pageId)
      .sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1))
      .map((p) => ({ ...p, imageRefs: p.imageRefs ? [...p.imageRefs] : null }));
  }

  async markPieces(pageId: string, referenced: readonly string[], unreferenced: readonly string[], at: number) {
    for (const h of referenced) {
      const p = this.pieces.get(InMemoryVoiciStorage.pk(pageId, h));
      if (p) p.unreferencedAt = null;
    }
    for (const h of unreferenced) {
      const p = this.pieces.get(InMemoryVoiciStorage.pk(pageId, h));
      if (p && p.unreferencedAt === null) p.unreferencedAt = at;
    }
  }

  async unreferenceAllPieces(pageId: string, at: number) {
    let n = 0;
    for (const p of this.pieces.values()) {
      if (p.pageId === pageId) {
        p.unreferencedAt = at;
        n++;
      }
    }
    return n;
  }

  async setPieceParse(pageId: string, sha256: string, role: string, imageRefs: readonly string[]) {
    const p = this.pieces.get(InMemoryVoiciStorage.pk(pageId, sha256));
    if (p) {
      p.role = role;
      p.imageRefs = [...imageRefs];
    }
  }

  async uploadedBytesSince(username: string, since: number) {
    let n = 0;
    for (const p of this.pieces.values()) if (p.username === username && p.uploadedAt >= since) n += p.size;
    return n;
  }

  async listUnreferencedBefore(before: number, limit: number) {
    return [...this.pieces.values()]
      .filter((p) => p.unreferencedAt !== null && p.unreferencedAt < before)
      .sort((a, b) => a.unreferencedAt! - b.unreferencedAt!)
      .slice(0, limit)
      .map((p) => ({ ...p, imageRefs: p.imageRefs ? [...p.imageRefs] : null }));
  }

  async collect(o: { piecesBefore: number; messagesBefore: number; draftsBefore: number; now: number; limit: number }) {
    return {
      pieces: await this.deleteUnreferencedBefore(o.piecesBefore, o.limit),
      messages: await this.deleteMessagesBefore(o.messagesBefore, o.limit),
      drafts: await this.deleteDraftsBefore(o.draftsBefore, o.limit),
      revoked: await this.deleteExpiredRevoked(o.now, o.limit),
      alerts: this.collectAlerts(o.now, o.limit),
    };
  }

  async deleteUnreferencedBefore(before: number, limit: number) {
    const doomed = await this.listUnreferencedBefore(before, limit);
    for (const p of doomed) this.pieces.delete(InMemoryVoiciStorage.pk(p.pageId, p.sha256));
    return doomed.map((p) => ({ pageId: p.pageId, sha256: p.sha256 }));
  }

  async insertMessage(rec: Omit<VoiciMessageRecord, "id" | "fetchedAt">) {
    if (this.messages.some((m) => m.conv === rec.conv && m.msgId === rec.msgId)) return { ok: false as const };
    const id = this.nextId++;
    this.messages.push({ ...rec, id, fetchedAt: null });
    return { ok: true as const, id };
  }

  async getMessage(conv: string, msgId: string) {
    const m = this.messages.find((x) => x.conv === conv && x.msgId === msgId);
    return m ? { ...m } : null;
  }

  async convStats(conv: string, hourAgo: number, dayAgo: number) {
    const ms = this.messages.filter((m) => m.conv === conv);
    const msgs = ms.filter((m) => m.kind === "voici-message");
    const pushed = ms.filter((m) => m.pushed).map((m) => m.storedAt);
    return {
      messages: msgs.length,
      replies: ms.length - msgs.length,
      messagesLastHour: msgs.filter((m) => m.storedAt > hourAgo).length,
      messagesLastDay: msgs.filter((m) => m.storedAt > dayAgo).length,
      lastPushedAt: pushed.length ? Math.max(...pushed) : null,
    };
  }

  async listInbox(pageId: string, sinceId: number, limit: number) {
    return this.messages.filter((m) => m.pageId === pageId && m.id > sinceId).slice(0, limit).map((m) => ({ ...m }));
  }

  async markFetched(pageId: string, afterId: number, throughId: number, at: number) {
    let n = 0;
    for (const m of this.messages) {
      if (m.pageId === pageId && m.id > afterId && m.id <= throughId && m.kind === "voici-message" && m.fetchedAt === null) {
        m.fetchedAt = at;
        n++;
      }
    }
    return n;
  }

  async listThread(conv: string, sinceId: number, limit: number) {
    return this.messages.filter((m) => m.conv === conv && m.id > sinceId).slice(0, limit).map((m) => ({ ...m }));
  }

  async deliveredThrough(conv: string) {
    return this.messages
      .filter((m) => m.conv === conv && m.kind === "voici-message" && m.fetchedAt !== null)
      .reduce((n, m) => Math.max(n, m.id), 0);
  }

  async deleteMessagesBefore(before: number, limit: number) {
    const doomed = new Set(
      this.messages
        .filter((m) => m.storedAt < before)
        .sort((a, b) => a.storedAt - b.storedAt)
        .slice(0, limit)
        .map((m) => m.id),
    );
    this.messages = this.messages.filter((m) => !doomed.has(m.id));
    return doomed.size;
  }

  async delegatePage(fromPub: string, delegatePub: string) {
    return this.messages.find((m) => m.fromPub === fromPub && m.delegatePub === delegatePub)?.pageId ?? null;
  }

  async setBlock(rec: VoiciBlockRecord, _at: number) {
    const k = InMemoryVoiciStorage.pk(rec.pageId, rec.pseudonymPub);
    const cur = this.blocks.get(k);
    if (cur && cur.issuedAt >= rec.issuedAt) return false;
    this.blocks.set(k, { ...rec });
    return true;
  }

  async getBlock(pageId: string, pseudonymPub: string) {
    const b = this.blocks.get(InMemoryVoiciStorage.pk(pageId, pseudonymPub));
    return b ? { ...b } : null;
  }

  async listBlocked(pageId: string) {
    return [...this.blocks.values()]
      .filter((b) => b.pageId === pageId && b.op === "block")
      .map((b) => b.pseudonymPub)
      .sort();
  }

  async revokeDelegate(rec: VoiciRevokedDelegate) {
    if (!this.revoked.has(rec.delegatePub)) this.revoked.set(rec.delegatePub, { ...rec });
  }

  async isRevoked(delegatePub: string, now: number) {
    const r = this.revoked.get(delegatePub);
    return !!r && r.expiresAt > now;
  }

  async listRevoked(pageId: string, now: number) {
    return [...this.revoked.values()]
      .filter((r) => r.pageId === pageId && r.expiresAt > now)
      .map((r) => r.delegatePub)
      .sort();
  }

  async deleteExpiredRevoked(now: number, limit: number) {
    let n = 0;
    for (const [k, r] of this.revoked) {
      if (n >= limit) break;
      if (r.expiresAt <= now) {
        this.revoked.delete(k);
        n++;
      }
    }
    return n;
  }

  async putDraft(rec: VoiciDraftRecord) {
    const k = InMemoryVoiciStorage.pk(rec.username, rec.opId);
    if (this.drafts.has(k)) return false;
    this.drafts.set(k, { ...rec });
    return true;
  }

  async listDrafts(username: string) {
    return [...this.drafts.values()]
      .filter((d) => d.username === username)
      .sort((a, b) => a.createdAt - b.createdAt || (a.opId < b.opId ? -1 : 1))
      .map((d) => ({ ...d }));
  }

  async countDrafts(username: string) {
    return [...this.drafts.values()].filter((d) => d.username === username).length;
  }

  async consumeDrafts(username: string, opIds: readonly string[]) {
    let n = 0;
    for (const id of new Set(opIds)) if (this.drafts.delete(InMemoryVoiciStorage.pk(username, id))) n++;
    return n;
  }

  async deleteDraftsBefore(before: number, limit: number) {
    const doomed = [...this.drafts.entries()]
      .filter(([, d]) => d.createdAt < before)
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, limit);
    for (const [k] of doomed) this.drafts.delete(k);
    return doomed.length;
  }

  async getState(username: string) {
    const s = this.states.get(username);
    return s ? { ...s } : null;
  }

  async putState(username: string, version: number, blob: string, at: number) {
    const cur = this.states.get(username);
    if ((cur?.version ?? 0) + 1 !== version) return false;
    this.states.set(username, { username, version, blob, updatedAt: at });
    return true;
  }

  private collectAlerts(now: number, limit: number) {
    const live = new Set(this.messages.map((m) => m.conv));
    const doomed = new Set(this.alerts.filter((a) => a.expiresAt <= now || !live.has(a.conv)).slice(0, limit));
    this.alerts = this.alerts.filter((a) => !doomed.has(a));
    return doomed.size;
  }

  async putAlert(rec: Omit<VoiciAlertRecord, "lastPushedAt">, maxPerConv: number) {
    const cur = this.alerts.find((a) => a.conv === rec.conv && a.endpointHash === rec.endpointHash);
    if (cur) Object.assign(cur, rec);
    else this.alerts.push({ ...rec, lastPushedAt: null });
    const mine = this.alerts
      .map((a, i) => ({ a, i }))
      .filter((x) => x.a.conv === rec.conv)
      .sort((x, y) => y.a.createdAt - x.a.createdAt || y.i - x.i);
    const drop = new Set(mine.slice(Math.max(0, maxPerConv)).map((x) => x.a));
    this.alerts = this.alerts.filter((a) => !drop.has(a));
  }

  async claimAlertPush(conv: string, now: number, notAfter: number) {
    const rows = this.alerts.filter((a) => a.conv === conv);
    if (rows.some((a) => a.lastPushedAt !== null && a.lastPushedAt > notAfter)) return [];
    const live = rows.filter((a) => a.expiresAt > now);
    for (const a of live) a.lastPushedAt = now;
    return live.map((a) => ({ endpointHash: a.endpointHash, subscription: a.subscription }));
  }

  async listAlerts(conv: string) {
    return this.alerts
      .map((a, i) => ({ a, i }))
      .filter((x) => x.a.conv === conv)
      .sort((x, y) => x.a.createdAt - y.a.createdAt || x.i - y.i)
      .map((x) => ({ ...x.a }));
  }

  async deleteAlert(conv: string, endpointHash: string) {
    const n = this.alerts.length;
    this.alerts = this.alerts.filter((a) => !(a.conv === conv && a.endpointHash === endpointHash));
    return this.alerts.length < n;
  }

  async deleteAlertsForPage(pageId: string) {
    const n = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.pageId !== pageId);
    return n - this.alerts.length;
  }

  async deleteAlertsForDelegate(delegatePub: string) {
    const n = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.delegatePub !== delegatePub);
    return n - this.alerts.length;
  }

  async deleteAccount(username: string) {
    for (const [k, d] of this.drafts) if (d.username === username) this.drafts.delete(k);
    this.states.delete(username);
    const page = this.pages.get(username);
    if (!page) return null;
    this.messages = this.messages.filter((m) => m.pageId !== page.pageId);
    await this.deleteAlertsForPage(page.pageId);
    for (const [k, b] of this.blocks) if (b.pageId === page.pageId) this.blocks.delete(k);
    for (const [k, r] of this.revoked) if (r.pageId === page.pageId) this.revoked.delete(k);
    await this.unreferenceAllPieces(page.pageId, 0);
    this.pages.delete(username);
    return page.pageId;
  }
}
