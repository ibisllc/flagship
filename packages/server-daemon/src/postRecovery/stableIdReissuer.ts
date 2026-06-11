/**
 * Per-app stable-id re-issuance walk-through (J.4).
 *
 * Runs on the daemon after .com confirms a J.3 re-pair has swapped the
 * user's IRK pubkey. Every installed app keeps a `members` table keyed
 * on the user's IRK pubkey (the canonical membership identity); when the
 * IRK rotates, every row that referenced the OLD IRK must be rewritten
 * to the NEW IRK so the user — and only the user — still has their own
 * memberships. The stable-id (derived from `(SWK, serviceId, irkPub)`) also
 * shifts as a side-effect; apps that have keyed user data on the stable
 * id will see those rows re-anchor to the new id after the rewrite.
 *
 * Three design choices worth flagging:
 *
 *   1. The OLD IRK pubkey is WIPED from app data — not soft-deleted.
 *      Leaving it around would let an attacker who later compromised a
 *      different surface enumerate the user's history pre-rotation.
 *      The undo journal (#72) keeps the *minimum* needed to reverse
 *      the rewrite for 7 days; nothing else.
 *
 *   2. Journal entries are themselves encrypted with a key derived from
 *      the daemon's SWK + a per-recovery salt, so a daemon-disk snapshot
 *      taken DURING the 7-day window doesn't leak the old-IRK→new-IRK
 *      mapping. The webapp's reattach progress view reads the journal
 *      via a paired-session-gated BFF endpoint that decrypts on demand.
 *
 *   3. Per-app summaries are emitted to the alert inbox so the webapp's
 *      reattach-progress screen can poll a single JSON endpoint instead
 *      of fanning out per-app. The summary intentionally only carries
 *      counts + the app's display name, never any member IRK hex.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ServicePlatform } from "../servicePlatform.js";
import type { AppMembership } from "../membership.js";

export type ReissuerStatus = "pending" | "running" | "complete" | "failed";

export interface AppReissuanceSummary {
  serviceId: string;
  slug: string;
  /** Rows rewritten OLD→NEW. */
  rewrittenCount: number;
  /** Rows that didn't reference the old IRK; left alone. */
  unchangedCount: number;
  /** Set when the per-app walk threw. */
  error: string | null;
  /** Unix-ms; when this app's walk completed. */
  completedAt: number;
}

export interface ReissuanceReport {
  startedAt: number;
  completedAt: number | null;
  status: ReissuerStatus;
  /** Salt used to derive the journal key from SWK; hex. */
  journalSaltHex: string;
  /** SHA-256(oldIrkPub) | SHA-256(newIrkPub), hex prefixes (12 chars each), surfaced for UI only. */
  oldIrkPrefix: string;
  newIrkPrefix: string;
  /** Apps walked + their results. */
  apps: AppReissuanceSummary[];
  /** Sum of rewrittenCount across apps. */
  totalRewritten: number;
  /** Apps with at least one rewrite. */
  reattachedCount: number;
  /** Apps the walk visited that had no matching rows. */
  unchangedCount: number;
  /** Earliest moment the user can undo the rewrite. */
  undoWindowExpiresAt: number;
}

export interface JournalEntry {
  /** App composite id `<creator>-<slug>`. */
  serviceId: string;
  /** Hex of the OLD IRK pubkey (32 bytes). */
  oldIrkPubHex: string;
  /** Hex of the NEW IRK pubkey (32 bytes). */
  newIrkPubHex: string;
  /** Role the membership row carried; preserved so undo restores intent. */
  role: string;
  /** When the row was originally added (preserved across rewrite). */
  addedAt: number;
  /** When the rewrite happened. */
  rewrittenAt: number;
}

export interface EncryptedJournalRow {
  /** App composite id, kept plaintext for the index. */
  serviceId: string;
  /** AES-GCM IV (12 bytes), hex. */
  ivHex: string;
  /** AES-GCM ciphertext, hex. */
  ciphertextHex: string;
  /** AES-GCM auth tag (16 bytes), hex. */
  tagHex: string;
  rewrittenAt: number;
}

/**
 * Storage interface for the encrypted undo journal. The production
 * implementation will be a JSONL file on the daemon's persistent
 * volume; in-memory below is sufficient for tests + the worker's
 * cross-process dependency on the file is stubbed for now.
 */
export interface JournalStore {
  append(row: EncryptedJournalRow): Promise<void>;
  listAll(): Promise<EncryptedJournalRow[]>;
  deleteOlderThan(cutoffMs: number): Promise<number>;
}

export class InMemoryJournalStore implements JournalStore {
  private readonly rows: EncryptedJournalRow[] = [];
  async append(row: EncryptedJournalRow): Promise<void> {
    this.rows.push({ ...row });
  }
  async listAll(): Promise<EncryptedJournalRow[]> {
    return this.rows.map((r) => ({ ...r }));
  }
  async deleteOlderThan(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.rewrittenAt < cutoffMs) {
        this.rows.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }
}

export interface ReissuerDeps {
  servicePlatform: ServicePlatform;
  /** Daemon SWK; used to derive the journal encryption key. */
  swk: Uint8Array;
  journal: JournalStore;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  /** 7-day undo window per design. Overridable for tests. */
  undoWindowMs?: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;
const TAG = new TextEncoder().encode("flagship/post-recovery-journal/v1");

/**
 * The single entry point. Walk every installed app, rewrite each
 * `app_users` row whose `irk_pubkey === oldIrkPub` to `newIrkPub`,
 * journal the change, and return a JSON-safe report.
 */
export async function reissueStableIds(args: {
  deps: ReissuerDeps;
  oldIrkPubHex: string;
  newIrkPubHex: string;
}): Promise<ReissuanceReport> {
  const { deps } = args;
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomBytes ?? ((n) => new Uint8Array(randomBytes(n)));
  const undoWindowMs = deps.undoWindowMs ?? SEVEN_DAYS_MS;

  const oldHex = args.oldIrkPubHex.toLowerCase();
  const newHex = args.newIrkPubHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(oldHex)) {
    throw new Error("oldIrkPubHex must be 32-byte hex");
  }
  if (!/^[0-9a-f]{64}$/.test(newHex)) {
    throw new Error("newIrkPubHex must be 32-byte hex");
  }
  if (oldHex === newHex) {
    throw new Error("oldIrkPubHex equals newIrkPubHex — nothing to reissue");
  }

  const journalSalt = rand(16);
  const journalKey = deriveJournalKey(deps.swk, journalSalt);
  const startedAt = now();
  const apps = deps.servicePlatform.list();

  const summaries: AppReissuanceSummary[] = [];
  let totalRewritten = 0;
  let reattachedCount = 0;
  let unchangedAppCount = 0;

  for (const installed of apps) {
    const summary = await walkSingleApp({
      serviceId: installed.serviceId,
      slug: installed.slug,
      membership: installed.membership,
      oldHex,
      newHex,
      journalKey,
      journal: deps.journal,
      rand,
      now,
    });
    summaries.push(summary);
    totalRewritten += summary.rewrittenCount;
    if (summary.rewrittenCount > 0) reattachedCount++;
    else if (!summary.error) unchangedAppCount++;
  }

  const completedAt = now();
  return {
    startedAt,
    completedAt,
    status: summaries.some((s) => s.error) ? "failed" : "complete",
    journalSaltHex: bytesToHex(journalSalt),
    oldIrkPrefix: sha256Hex(hexToBytes(oldHex)).slice(0, 12),
    newIrkPrefix: sha256Hex(hexToBytes(newHex)).slice(0, 12),
    apps: summaries,
    totalRewritten,
    reattachedCount,
    unchangedCount: unchangedAppCount,
    undoWindowExpiresAt: completedAt + undoWindowMs,
  };
}

async function walkSingleApp(args: {
  serviceId: string;
  slug: string;
  membership: AppMembership;
  oldHex: string;
  newHex: string;
  journalKey: Uint8Array;
  journal: JournalStore;
  rand: (n: number) => Uint8Array;
  now: () => number;
}): Promise<AppReissuanceSummary> {
  try {
    const members = args.membership.members.list();
    let rewritten = 0;
    let unchanged = 0;
    for (const m of members) {
      if (m.irkPubHex.toLowerCase() === args.oldHex) {
        const oldBytes = hexToBytes(args.oldHex);
        const newBytes = hexToBytes(args.newHex);
        args.membership.members.internalAdd(newBytes, m.role);
        // Wipe — the design says the OLD pubkey leaves no trace in app
        // data. The journal entry (encrypted under the SWK-derived key)
        // is the only place the mapping is retained, and only for the
        // undo window.
        args.membership.members.internalRemoveByHex(args.oldHex);
        const entry: JournalEntry = {
          serviceId: args.serviceId,
          oldIrkPubHex: args.oldHex,
          newIrkPubHex: args.newHex,
          role: m.role,
          addedAt: m.addedAt,
          rewrittenAt: args.now(),
        };
        const encrypted = encryptJournalEntry(args.journalKey, args.rand, entry);
        await args.journal.append(encrypted);
        rewritten++;
      } else {
        unchanged++;
      }
    }
    return {
      serviceId: args.serviceId,
      slug: args.slug,
      rewrittenCount: rewritten,
      unchangedCount: unchanged,
      error: null,
      completedAt: args.now(),
    };
  } catch (e) {
    return {
      serviceId: args.serviceId,
      slug: args.slug,
      rewrittenCount: 0,
      unchangedCount: 0,
      error: (e as Error).message,
      completedAt: args.now(),
    };
  }
}

/**
 * Surface the journal as decrypted entries (for the webapp's undo
 * summary). The webapp is paired-session-gated upstream; this helper
 * doesn't re-authorize.
 */
export async function readJournalDecrypted(
  deps: ReissuerDeps,
  journalSaltHex: string,
): Promise<JournalEntry[]> {
  const salt = hexToBytes(journalSaltHex);
  const key = deriveJournalKey(deps.swk, salt);
  const rows = await deps.journal.listAll();
  const out: JournalEntry[] = [];
  for (const r of rows) {
    try {
      const dec = decryptJournalEntry(key, r);
      out.push(dec);
    } catch {
      // skip rows we can't decrypt — different salt / corrupted disk
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Crypto helpers — AES-GCM with a per-recovery salt-derived key.
// ──────────────────────────────────────────────────────────────────────

function deriveJournalKey(swk: Uint8Array, salt: Uint8Array): Uint8Array {
  const h = createHash("sha256");
  h.update(TAG);
  h.update(swk);
  h.update(salt);
  return new Uint8Array(h.digest());
}

function encryptJournalEntry(
  key: Uint8Array,
  rand: (n: number) => Uint8Array,
  entry: JournalEntry,
): EncryptedJournalRow {
  const iv = rand(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(entry));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    serviceId: entry.serviceId,
    ivHex: bytesToHex(iv),
    ciphertextHex: ct.toString("hex"),
    tagHex: tag.toString("hex"),
    rewrittenAt: entry.rewrittenAt,
  };
}

function decryptJournalEntry(key: Uint8Array, row: EncryptedJournalRow): JournalEntry {
  const iv = hexToBytes(row.ivHex);
  const ct = Buffer.from(row.ciphertextHex, "hex");
  const tag = Buffer.from(row.tagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as JournalEntry;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}
