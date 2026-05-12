/**
 * Inheritance handlers (#77).
 *
 *   POST /api/inheritance
 *     Body: { declaration, signature_hex }
 *     `declaration` is an InheritanceDeclaration the user signed with
 *     their IRK. .com verifies the signature against the registered
 *     username → IRK row, then upserts the declaration onto the user's
 *     encrypted-blob record. The blob bytes themselves are opaque AES
 *     ciphertext driven by maintainers/protocol's EncryptedBlobAdapter
 *     — .com only sees the plaintext declaration AT verify time, never
 *     stores it in cleartext.
 *
 *   POST /api/inheritance/takeover
 *     (not implemented — heir-side, requires K-of-N heir signatures +
 *      starts a 7-day notice period; left as a follow-up. The current
 *      ticket asks for the declaration storage + the scheduled-job
 *      function that decides whether takeover is allowed.)
 *
 *   GET /api/inheritance/eligible-for-takeover
 *     Returns the set of usernames whose declaration is eligible for
 *     takeover (i.e. last-signed-at + triggerAfterInactiveDays < now).
 *     This is the scheduled-job's input feed; the function is
 *     deliberately exported as a pure helper so a future cron / worker
 *     timer can call it without re-implementing the decision.
 *
 * Security model:
 *   - Default state is OFF. No row exists until the user explicitly
 *     opts in via POST.
 *   - The user can revoke the declaration at any time by POSTing a new
 *     one with an empty heir list (storage layer collapses it to
 *     "declared off").
 *   - Every successful POST writes a `lastSignedAt` timestamp on the
 *     username row so subsequent signatures reset the inactive timer.
 */

import {
  ed,
  verifyInheritanceDeclaration,
  type InheritanceDeclaration,
} from "@flagship/protocol";
import type { UsernameStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponse,
} from "./types.js";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_HEIRS = 12;
const DEFAULT_TRIGGER_DAYS = 365;
const NOTICE_PERIOD_MS = 7 * 24 * 60 * 60_000;

export interface StoredInheritanceDeclaration {
  username: string;
  heirIrkPubHex: string[];
  threshold: number;
  heirSetVersion: number;
  triggerAfterInactiveDays: number;
  issuedAt: number;
  signatureHex: string;
  /** When the row was last updated. */
  updatedAt: number;
  /** When the user last signed anything; the takeover gate checks this. */
  lastSignedAt: number;
}

/**
 * Pluggable storage. Production wires this to a D1 row keyed on
 * username; the in-memory implementation below is sufficient for tests.
 *
 * `recordSigningActivity` is called by every other endpoint that
 * processes an IRK-signed envelope (re-pair, etc.) so the inactive
 * timer reflects real signing activity. The cross-worker dependency
 * is stubbed in this commit: the call sites in rePair / username-claim
 * / etc. don't yet invoke it — wiring them in is a follow-up that
 * touches a wide surface area and shouldn't gate this commit.
 */
export interface InheritanceStorage {
  put(rec: StoredInheritanceDeclaration): Promise<void>;
  get(username: string): Promise<StoredInheritanceDeclaration | undefined>;
  list(): Promise<StoredInheritanceDeclaration[]>;
  recordSigningActivity(username: string, atMs: number): Promise<void>;
}

export class InMemoryInheritanceStorage implements InheritanceStorage {
  private readonly rows = new Map<string, StoredInheritanceDeclaration>();
  async put(rec: StoredInheritanceDeclaration): Promise<void> {
    this.rows.set(rec.username.toLowerCase(), { ...rec, heirIrkPubHex: [...rec.heirIrkPubHex] });
  }
  async get(username: string): Promise<StoredInheritanceDeclaration | undefined> {
    const r = this.rows.get(username.toLowerCase());
    return r ? { ...r, heirIrkPubHex: [...r.heirIrkPubHex] } : undefined;
  }
  async list(): Promise<StoredInheritanceDeclaration[]> {
    return [...this.rows.values()].map((r) => ({ ...r, heirIrkPubHex: [...r.heirIrkPubHex] }));
  }
  async recordSigningActivity(username: string, atMs: number): Promise<void> {
    const key = username.toLowerCase();
    const r = this.rows.get(key);
    if (!r) return;
    r.lastSignedAt = atMs;
    this.rows.set(key, r);
  }
}

export interface InheritanceDeps {
  storage: InheritanceStorage;
  usernames: UsernameStorage;
  now?: () => number;
  maxAgeMs?: number;
  /** Override the notice window (7 days default) for tests. */
  noticePeriodMs?: number;
}

interface PostBody {
  declaration?: {
    username?: unknown;
    heirIrkPub?: unknown;
    threshold?: unknown;
    heirSetVersion?: unknown;
    triggerAfterInactiveDays?: unknown;
    issuedAt?: unknown;
  };
  signature_hex?: unknown;
}

/**
 * POST /api/inheritance — upsert the declaration.
 */
export async function handlePutInheritanceDeclaration(
  deps: InheritanceDeps,
  body: PostBody | undefined,
): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;
  const d = body?.declaration ?? {};

  if (typeof d.username !== "string" || d.username.length === 0) {
    return malformed("username required");
  }
  if (!Array.isArray(d.heirIrkPub)) {
    return malformed("heirIrkPub must be an array of hex pubkeys");
  }
  if (d.heirIrkPub.length > MAX_HEIRS) {
    return malformed(`heirIrkPub exceeds limit of ${MAX_HEIRS}`);
  }
  for (const h of d.heirIrkPub) {
    if (typeof h !== "string" || !HEX64.test(h)) {
      return malformed("heirIrkPub entries must be 32-byte hex");
    }
  }
  if (
    typeof d.threshold !== "number" ||
    !Number.isInteger(d.threshold) ||
    d.threshold < 1 ||
    (d.heirIrkPub.length > 0 && d.threshold > d.heirIrkPub.length)
  ) {
    return malformed("threshold must be 1..N where N = heirIrkPub.length");
  }
  if (typeof d.heirSetVersion !== "number" || !Number.isInteger(d.heirSetVersion) || d.heirSetVersion < 1) {
    return malformed("heirSetVersion must be a positive integer");
  }
  const triggerDays =
    typeof d.triggerAfterInactiveDays === "number" &&
    Number.isFinite(d.triggerAfterInactiveDays) &&
    d.triggerAfterInactiveDays >= 1
      ? d.triggerAfterInactiveDays
      : DEFAULT_TRIGGER_DAYS;
  if (typeof d.issuedAt !== "number") return malformed("issuedAt must be a number");
  if (Math.abs(now - d.issuedAt) > maxAgeMs) return forbidden("stale request");
  if (typeof body?.signature_hex !== "string" || !HEX128.test(body.signature_hex)) {
    return malformed("signature_hex must be 64-byte hex");
  }

  const userRec = await deps.usernames.get(d.username);
  if (!userRec) return notFound("unknown username");

  const heirBytes = (d.heirIrkPub as string[]).map((h) => hexToBytes(h));
  const claim: InheritanceDeclaration = {
    username: d.username,
    heirIrkPub: heirBytes,
    threshold: d.threshold,
    heirSetVersion: d.heirSetVersion,
    triggerAfterInactiveDays: triggerDays,
    issuedAt: d.issuedAt,
  };
  const sig = hexToBytes(body.signature_hex);
  const irkPub = hexToBytes(userRec.irkPubHex);
  if (!verifyInheritanceDeclaration(claim, sig, irkPub)) {
    return forbidden("signature did not verify against the registered IRK");
  }

  // Versions must roll forward; a replay of an older declaration must
  // not overwrite a newer one (otherwise an attacker who captured the
  // user's first declaration could re-publish it after the user added
  // a new heir and undo the addition).
  const existing = await deps.storage.get(d.username);
  if (existing && existing.heirSetVersion >= d.heirSetVersion) {
    return conflict("a newer heirSetVersion is already on record");
  }

  const stored: StoredInheritanceDeclaration = {
    username: d.username,
    heirIrkPubHex: (d.heirIrkPub as string[]).map((h) => h.toLowerCase()),
    threshold: d.threshold,
    heirSetVersion: d.heirSetVersion,
    triggerAfterInactiveDays: triggerDays,
    issuedAt: d.issuedAt,
    signatureHex: body.signature_hex.toLowerCase(),
    updatedAt: now,
    // The POST IS a fresh signing — reset the inactive timer.
    lastSignedAt: now,
  };
  await deps.storage.put(stored);
  return ok({ ok: true, heirSetVersion: d.heirSetVersion, updatedAt: now });
}

/**
 * GET /api/inheritance/:username — read a stored declaration. Public
 * read (no signature gate); declarations include only pubkey
 * fingerprints and not any names / contact info, so disclosure is fine.
 */
export async function handleGetInheritanceDeclaration(
  deps: InheritanceDeps,
  username: string,
): Promise<HandlerResponse> {
  const rec = await deps.storage.get(username);
  if (!rec) return notFound("no inheritance declaration");
  return ok({
    username: rec.username,
    heirIrkPub: rec.heirIrkPubHex,
    threshold: rec.threshold,
    heirSetVersion: rec.heirSetVersion,
    triggerAfterInactiveDays: rec.triggerAfterInactiveDays,
    issuedAt: rec.issuedAt,
    signature_hex: rec.signatureHex,
    updatedAt: rec.updatedAt,
    lastSignedAt: rec.lastSignedAt,
  });
}

export interface TakeoverEligibility {
  username: string;
  heirIrkPub: string[];
  threshold: number;
  /** When the user last signed anything we observed. */
  lastSignedAt: number;
  /** When the takeover request becomes valid (lastSignedAt + triggerAfterInactiveDays). */
  eligibleAt: number;
  /** When a successful takeover request would bind (eligibleAt + 7d notice). */
  bindsAt: number;
}

/**
 * Scheduled-job entry point. Walks every declaration and reports the
 * subset that is currently eligible for takeover.
 *
 * Not wired to a real cron yet — the v1-alpha decision is to surface
 * the function and the on-disk state; turning it into a periodic
 * Worker timer is a deploy-time decision documented in
 * docs/policy/inheritance.md.
 */
export async function eligibleForTakeover(
  deps: InheritanceDeps,
): Promise<TakeoverEligibility[]> {
  const now = (deps.now ?? (() => Date.now()))();
  const noticeMs = deps.noticePeriodMs ?? NOTICE_PERIOD_MS;
  const rows = await deps.storage.list();
  const out: TakeoverEligibility[] = [];
  for (const r of rows) {
    if (r.heirIrkPubHex.length === 0) continue; // "off" state
    const inactiveMs = r.triggerAfterInactiveDays * 24 * 60 * 60_000;
    const eligibleAt = r.lastSignedAt + inactiveMs;
    if (now < eligibleAt) continue;
    out.push({
      username: r.username,
      heirIrkPub: [...r.heirIrkPubHex],
      threshold: r.threshold,
      lastSignedAt: r.lastSignedAt,
      eligibleAt,
      bindsAt: eligibleAt + noticeMs,
    });
  }
  return out;
}

/**
 * Helper for the scheduled job (or a future heir UI). Returns the
 * canonical 7-day notice end the heir must wait past before the
 * takeover may bind.
 */
export function takeoverNoticeWindowEnd(
  declaration: StoredInheritanceDeclaration,
  noticePeriodMs = NOTICE_PERIOD_MS,
): number {
  const inactiveMs = declaration.triggerAfterInactiveDays * 24 * 60 * 60_000;
  return declaration.lastSignedAt + inactiveMs + noticePeriodMs;
}

// Re-export so the Worker route can import a single symbol.
export { NOTICE_PERIOD_MS };
