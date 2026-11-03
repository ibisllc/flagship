/**
 * voi.ci pages on `.com` (docs/voici-and-messages.md §2.8, §2.9, §3, §4.1, §5.2):
 *
 *   POST /api/voici/pages/<u>/pieces             sensitive-key signed headers, body = one piece
 *   POST /api/voici/pages/<u>/publish            the index's own signature
 *   GET  /api/voici/pages/<u>                    public
 *   POST /api/accounts/<u>/voici-drafts          device headers + a device-signed voici-draft envelope
 *   GET  /api/accounts/<u>/voici-drafts          read token
 *   POST /api/accounts/<u>/voici-drafts/consume  sensitive key (flagship/voici-drafts-consume/v1)
 *
 * Refusals are `{error: code, code, ...}`; the apps write the sentences. The sensitive key is the account's pinned
 * admin root, else its IRK: the only keys a page index can name (`signerKind`).
 */
import {
  canonicalVoiciPageIndex,
  checkVoiciDraft,
  edVerifyFast,
  checkVoiciPublish,
  isLowerHex,
  isVoiciJpeg,
  parseVoiciChunkPiece,
  parseVoiciPageIndex,
  parseVoiciProfilePiece,
  sha256Hex,
  verifyDeviceCapabilityGrant,
  verifyVoiciDraftsConsume,
  verifyVoiciPieceUpload,
  voiciCardRole,
  VOICI_CHUNK_MAX_BYTES,
  VOICI_DRAFT_MAX_ENVELOPE_BYTES,
  VOICI_DRAFTS_CONSUME_MAX,
  VOICI_INDEX_MAX_BYTES,
  VOICI_INDEX_SKEW_MS,
  type DeviceCapabilityGrant,
  type DeviceScope,
  type VoiciPageIndex,
  type VoiciSignerKind,
} from "@flagship/protocol";
import type { UsernameRecord, UsernameStorage, VoiciPageRecord, VoiciPieceRecord, VoiciStorage } from "@flagship/storage";
import { requireAccountRead, ACCOUNT_KEY_HOLDERS_ONLY, ACCOUNT_READ_HEADERS, type AccountReadTokenDeps } from "./accountReadToken.js";
import { authorizeActiveDevice, type AccountDirectoryDeps, type DirectoryAuthorization } from "./accountDirectory.js";
import { hexToBytes } from "./hex.js";
import type { HandlerResponseWithHeaders } from "./types.js";

const DAY = 86_400_000;
/** Bytes of pieces one account may upload in any 24 hours (§9.4). */
export const VOICI_PIECE_BYTES_PER_DAY = 50 * 1024 * 1024;
/** Draft ops waiting for an admin device, per account. */
export const VOICI_MAX_PENDING_DRAFTS = 200;
/** Draft ops nobody published are dropped after this long. */
export const VOICI_DRAFT_TTL_MS = 30 * DAY;
/** A piece no index has listed for this long is deleted (§2.8). */
export const VOICI_UNREFERENCED_TTL_MS = 30 * DAY;

/** The R2 object keys (§2.8). */
export const voiciIndexKey = (username: string) => `v1/u/${username}.json`;
export const voiciPieceKey = (pageId: string, sha256: string) => `v1/p/${pageId}/${sha256}`;
export const VOICI_INDEX_CACHE = "public, max-age=30";
export const VOICI_PIECE_CACHE = "public, max-age=31536000, immutable";

/** The slice of an R2 bucket (`VOICI`, flagship-voici) the handlers use. */
export interface VoiciBucket {
  put(key: string, value: Uint8Array | string, opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<unknown>;
}

export interface VoiciPagesDeps {
  voici: VoiciStorage;
  usernames: Pick<UsernameStorage, "get">;
  bucket: VoiciBucket;
  /** Chunk B2: an account banned from pages and Messages (§9.3). */
  isAccountBanned?: (username: string) => Promise<boolean>;
  now?: () => number;
}

const nowOf = (d: { now?: () => number }) => (d.now ?? Date.now)();
const NO_STORE = { "cache-control": "private, no-store" };

export function voiciRefusal(status: number, code: string, extra: Record<string, unknown> = {}): HandlerResponseWithHeaders {
  return { status, body: { error: code, code, ...extra }, headers: { ...NO_STORE } };
}
const okNoStore = (body: unknown): HandlerResponseWithHeaders => ({ status: 200, body, headers: { ...NO_STORE } });

/** The account's sensitive key: the pinned admin root, else the IRK. */
export function voiciSensitiveKey(user: Pick<UsernameRecord, "adminRootPubHex" | "irkPubHex">): { kind: VoiciSignerKind; pub: string } {
  return user.adminRootPubHex
    ? { kind: "admin-root", pub: user.adminRootPubHex.toLowerCase() }
    : { kind: "irk", pub: user.irkPubHex.toLowerCase() };
}

const PAGE_ID = /^[0-9a-f]{32}$/;

// ── pieces ──────────────────────────────────────────────────────────────────

/** `x-flagship-page-id`, `-issued-at`, `-signature`; `-sha256`, `-size` and `-signer-pub` are optional cross-checks. */
export interface VoiciPieceUploadHeaders {
  pageId: string | null;
  issuedAt: string | null;
  signature: string | null;
  sha256?: string | null;
  size?: string | null;
  signerPub?: string | null;
}

export async function handleVoiciPieceUpload(
  deps: VoiciPagesDeps,
  username: string,
  h: VoiciPieceUploadHeaders,
  body: Uint8Array,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  if (body.length < 1 || body.length > VOICI_CHUNK_MAX_BYTES) return voiciRefusal(413, "too-large");
  const issuedAt = Number(h.issuedAt);
  if (!h.pageId || !PAGE_ID.test(h.pageId) || !Number.isSafeInteger(issuedAt) || !h.signature || !isLowerHex(h.signature, 64)) {
    return voiciRefusal(400, "malformed");
  }
  const [user, page, banned] = await Promise.all([deps.usernames.get(u), deps.voici.getPage(u), deps.isAccountBanned?.(u) ?? false]);
  if (!user) return voiciRefusal(404, "not-found");
  if (page?.takenDownAt != null) return voiciRefusal(410, "taken-down");
  if (page && page.pageId !== h.pageId) return voiciRefusal(409, "wrong-page");
  if (Math.abs(now - issuedAt) > VOICI_INDEX_SKEW_MS) return voiciRefusal(403, "stale");
  const sha256 = sha256Hex(body);
  if ((h.sha256 && h.sha256 !== sha256) || (h.size && h.size !== String(body.length))) return voiciRefusal(400, "bad-piece");
  const key = voiciSensitiveKey(user);
  if (h.signerPub && h.signerPub.toLowerCase() !== key.pub) return voiciRefusal(403, "not-sensitive-key");
  if (!verifyVoiciPieceUpload({ username: u, pageId: h.pageId, sha256, size: body.length, issuedAt }, h.signature, key.pub)) {
    return voiciRefusal(403, "bad-signature");
  }
  if (banned) return voiciRefusal(403, "banned");
  const [have] = await deps.voici.getPieces(h.pageId, [sha256]);
  if (have) return okNoStore({ ok: true, sha256, size: have.size });
  if ((await deps.voici.uploadedBytesSince(u, now - DAY)) + body.length > VOICI_PIECE_BYTES_PER_DAY) {
    return voiciRefusal(429, "rate-limited", { retryAfterSec: 3600 });
  }
  const jpeg = isVoiciJpeg(body);
  await deps.bucket.put(voiciPieceKey(h.pageId, sha256), body, {
    httpMetadata: { contentType: jpeg ? "image/jpeg" : "application/json", cacheControl: VOICI_PIECE_CACHE },
  });
  await deps.voici.putPiece({ pageId: h.pageId, sha256, username: u, size: body.length, jpeg, uploadedAt: now, unreferencedAt: now });
  return okNoStore({ ok: true, sha256, size: body.length });
}

// ── publish ─────────────────────────────────────────────────────────────────

type PieceCheck = { ok: true; refs: string[]; parsed: boolean } | { ok: false; code: "missing-piece" | "bad-piece" };

async function checkPiece(deps: VoiciPagesDeps, pageId: string, role: string, ref: { sha256: string; size: number }, row: VoiciPieceRecord | undefined): Promise<PieceCheck> {
  if (!row || row.size !== ref.size) return { ok: false, code: "missing-piece" };
  const image = role === "avatar" || role.startsWith("card-");
  if (image) return row.jpeg ? { ok: true, refs: [], parsed: false } : { ok: false, code: "bad-piece" };
  if (row.role === role && row.imageRefs) return { ok: true, refs: row.imageRefs, parsed: false };
  const obj = await deps.bucket.get(voiciPieceKey(pageId, ref.sha256));
  if (!obj) return { ok: false, code: "missing-piece" };
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.length !== ref.size || sha256Hex(bytes) !== ref.sha256) return { ok: false, code: "missing-piece" };
  if (role === "profile") {
    const p = parseVoiciProfilePiece(bytes);
    return p ? { ok: true, refs: p.avatar ? [p.avatar] : [], parsed: true } : { ok: false, code: "bad-piece" };
  }
  const c = parseVoiciChunkPiece(bytes, Number(role.slice("chunk-".length)));
  if (!c) return { ok: false, code: "bad-piece" };
  const refs = new Set<string>();
  for (const post of c.posts) for (const l of post.links) if (l.card?.image) refs.add(l.card.image);
  return { ok: true, refs: [...refs].sort(), parsed: true };
}

/**
 * `voiciPieceRefsOk` over the remembered parses: the profile's avatar is exactly the avatar piece (or neither), and the
 * card images the chunks name are exactly the card pieces.
 */
function refsMatch(index: VoiciPageIndex, refsByRole: Map<string, string[]>): boolean {
  const avatar = index.pieces.find((p) => p.role === "avatar")?.sha256 ?? null;
  if ((refsByRole.get("profile")?.[0] ?? null) !== avatar) return false;
  const named = new Set<string>();
  for (const [role, refs] of refsByRole) if (role.startsWith("chunk-")) for (const r of refs) named.add(r);
  const cards = index.pieces.filter((p) => p.role.startsWith("card-"));
  return cards.length === named.size && cards.every((p) => named.has(p.sha256) && p.role === voiciCardRole(p.sha256));
}

export async function handleVoiciPublish(deps: VoiciPagesDeps, username: string, bodyText: string): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  if (new TextEncoder().encode(bodyText).length > VOICI_INDEX_MAX_BYTES + 64) return voiciRefusal(413, "too-large");
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return voiciRefusal(400, "malformed");
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "index" in raw) raw = (raw as { index: unknown }).index;
  const parsed = parseVoiciPageIndex(raw);
  if (!parsed || parsed.username !== u) return voiciRefusal(400, "malformed");
  const [user, stored, banned] = await Promise.all([deps.usernames.get(u), deps.voici.getPage(u), deps.isAccountBanned?.(u) ?? false]);
  if (!user) return voiciRefusal(404, "not-found");
  if (banned) return voiciRefusal(403, "banned");
  if (stored?.takenDownAt != null) return voiciRefusal(410, "taken-down");
  const key = voiciSensitiveKey(user);
  await edVerifyFast(parsed.signature, canonicalVoiciPageIndex(parsed), parsed.signerPub).catch(() => false);
  const verdict = checkVoiciPublish(parsed, {
    username: u,
    sensitiveKind: key.kind,
    sensitivePub: key.pub,
    storedSeq: stored?.seq ?? 0,
    storedPageId: stored?.pageId ?? null,
    now,
  });
  if (!verdict.ok) {
    if (verdict.code === "seq-conflict") return seqConflict(stored);
    const status = verdict.code === "wrong-page" ? 409 : verdict.code === "malformed" || verdict.code === "wrong-username" ? 400 : 403;
    return voiciRefusal(status, verdict.code === "wrong-username" ? "malformed" : verdict.code);
  }
  const index = verdict.index;
  const rows = new Map((await deps.voici.getPieces(index.pageId, index.pieces.map((p) => p.sha256))).map((r) => [r.sha256, r]));
  const refsByRole = new Map<string, string[]>();
  const checks = await Promise.all(index.pieces.map((p) => checkPiece(deps, index.pageId, p.role, p, rows.get(p.sha256))));
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]!;
    if (!c.ok) return voiciRefusal(c.code === "missing-piece" ? 409 : 400, c.code);
    const role = index.pieces[i]!.role;
    if (role === "profile" || role.startsWith("chunk-")) refsByRole.set(role, c.refs);
  }
  if (!refsMatch(index, refsByRole)) return voiciRefusal(400, "bad-piece");
  const indexJson = JSON.stringify(index);
  const accepted = await deps.voici.publishPage(
    {
      username: u,
      pageId: index.pageId,
      seq: index.seq,
      issuedAt: index.issuedAt,
      acceptsMessages: index.acceptsMessages,
      inboxEpoch: index.inboxEpoch,
      ownerSignPub: index.ownerSignPub,
      indexJson,
      publishedAt: now,
    },
    stored?.seq ?? 0,
  );
  if (!accepted) return seqConflict(await deps.voici.getPage(u));
  const before = stored ? (parseVoiciPageIndex(stored.indexJson)?.pieces.map((p) => p.sha256) ?? []) : [];
  const after = new Set(index.pieces.map((p) => p.sha256));
  await Promise.all([
    deps.bucket.put(voiciIndexKey(u), indexJson, { httpMetadata: { contentType: "application/json", cacheControl: VOICI_INDEX_CACHE } }),
    deps.voici.markPieces(index.pageId, [...after], before.filter((h) => !after.has(h)), now),
    ...index.pieces
      .map((p, i) => ({ p, c: checks[i]! }))
      .filter(({ c }) => c.ok && c.parsed)
      .map(({ p, c }) => deps.voici.setPieceParse(index.pageId, p.sha256, p.role, (c as { refs: string[] }).refs)),
  ]);
  return okNoStore({ ok: true, pageId: index.pageId, seq: index.seq });
}

function seqConflict(stored: VoiciPageRecord | null | undefined): HandlerResponseWithHeaders {
  return voiciRefusal(409, "seq-conflict", { index: stored ? JSON.parse(stored.indexJson) : null });
}

/** `GET /api/voici/pages/<u>/pieces/<sha256>` (the webapp's read; its CSP cannot reach files.voi.ci): a piece the stored
 *  index lists, else null. */
export async function voiciListedPiece(deps: Pick<VoiciPagesDeps, "voici" | "bucket">, username: string, sha256: string) {
  if (!isLowerHex(sha256, 32)) return null;
  const page = await deps.voici.getPage(username.toLowerCase());
  if (!page || page.takenDownAt !== null) return null;
  const ref = parseVoiciPageIndex(page.indexJson)?.pieces.find((p) => p.sha256 === sha256);
  if (!ref) return null;
  const obj = await deps.bucket.get(voiciPieceKey(page.pageId, sha256));
  if (!obj) return null;
  const isImage = ref.role === "avatar" || ref.role.startsWith("card-");
  return { bytes: new Uint8Array(await obj.arrayBuffer()), contentType: isImage ? "image/jpeg" : "application/json" };
}

export async function handleVoiciGetPage(deps: Pick<VoiciPagesDeps, "voici">, username: string): Promise<HandlerResponseWithHeaders> {
  const page = await deps.voici.getPage(username.toLowerCase());
  if (!page) return voiciRefusal(404, "not-found");
  if (page.takenDownAt !== null) return voiciRefusal(410, "taken-down");
  return { status: 200, body: { index: JSON.parse(page.indexJson) }, headers: { "cache-control": "no-cache" } };
}

// voi.ci/<name> is resolved by resolveVoiciPath (voici.ts): one function for links, codes and pages
// (docs/voici-namespace-spec.md), with the names registry as the only collision check.

// ── drafts (§5.2) ───────────────────────────────────────────────────────────

export interface VoiciDraftsDeps {
  voici: VoiciStorage;
  usernames: Pick<UsernameStorage, "get">;
  directory: Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">;
  readTokens: AccountReadTokenDeps;
  /** Content-free `page-drafts` push to the account's admin devices. */
  notifyAdmins?: (username: string) => Promise<unknown>;
  now?: () => number;
}

/** The cred's grant names this device of this account and verifies under the admin root or the IRK. */
export function voiciDraftGrantOk(user: Pick<UsernameRecord, "username" | "adminRootPubHex" | "irkPubHex">, now: number) {
  return (grant: unknown, grantSignature: string, devicePub: string): boolean => {
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) return false;
    const g = grant as Record<string, unknown>;
    if (g.username !== user.username || g.devicePubKey !== devicePub || typeof g.expiresAt !== "number" || g.expiresAt <= now) return false;
    if (typeof g.grantId !== "string" || typeof g.deviceId !== "string" || typeof g.issuedAt !== "number" || !Array.isArray(g.scopes)) return false;
    let parsed: DeviceCapabilityGrant;
    try {
      parsed = {
        grantId: g.grantId,
        username: g.username,
        deviceId: g.deviceId,
        devicePubKey: hexToBytes(devicePub),
        scopes: g.scopes as DeviceScope[],
        issuedAt: g.issuedAt,
        expiresAt: g.expiresAt,
      };
    } catch {
      return false;
    }
    const sig = hexToBytes(grantSignature);
    return [user.adminRootPubHex, user.irkPubHex].some((k) => !!k && verifyDeviceCapabilityGrant(parsed, sig, hexToBytes(k)));
  };
}

export async function handleVoiciDraftDeposit(
  deps: VoiciDraftsDeps,
  username: string,
  auth: DirectoryAuthorization | undefined,
  bodyText: string,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  if (new TextEncoder().encode(bodyText).length > VOICI_DRAFT_MAX_ENVELOPE_BYTES) return voiciRefusal(413, "too-large");
  const caller = await authorizeActiveDevice(deps.directory, auth, { accountId: u, method: "POST", path: `/api/accounts/${u}/voici-drafts` });
  if (!caller) return voiciRefusal(403, "forbidden");
  const user = await deps.usernames.get(u);
  if (!user) return voiciRefusal(404, "not-found");
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return voiciRefusal(400, "malformed");
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "envelope" in raw) raw = (raw as { envelope: unknown }).envelope;
  const r = checkVoiciDraft(raw, { username: u, checkGrant: voiciDraftGrantOk(user, now), freshAt: now });
  if (!r.ok) return voiciRefusal(r.code === "too-large" ? 413 : r.code === "malformed" || r.code === "wrong-kind" || r.code === "wrong-audience" ? 400 : 403, r.code);
  if (r.envelope.from !== caller.signerPubHex) return voiciRefusal(403, "bad-signature");
  if ((await deps.voici.countDrafts(u)) >= VOICI_MAX_PENDING_DRAFTS) return voiciRefusal(429, "rate-limited", { retryAfterSec: 3600 });
  const fresh = await deps.voici.putDraft({
    username: u,
    opId: r.envelope.msgId,
    devicePub: r.envelope.from,
    envelope: JSON.stringify(r.envelope),
    size: bodyText.length,
    createdAt: now,
  });
  if (fresh && deps.notifyAdmins) await deps.notifyAdmins(u);
  return okNoStore({ ok: true, opId: r.envelope.msgId });
}

export async function handleVoiciDraftList(deps: VoiciDraftsDeps, username: string, authorization: string | null): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const read = await requireAccountRead(deps.readTokens, u, authorization, ACCOUNT_KEY_HOLDERS_ONLY);
  if (!read.ok) return read.response;
  const drafts = await deps.voici.listDrafts(u);
  return {
    status: 200,
    body: { drafts: drafts.map((d) => JSON.parse(d.envelope) as unknown) },
    headers: { ...ACCOUNT_READ_HEADERS },
  };
}

/** Body `{opIds, issuedAt, signerPub?, signature}` (or `{consume:{username, opIds, issuedAt}, signature}`). */
export async function handleVoiciDraftConsume(deps: VoiciDraftsDeps, username: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  const b = body as { consume?: { username?: unknown; opIds?: unknown; issuedAt?: unknown }; opIds?: unknown; issuedAt?: unknown; signerPub?: unknown; signature?: unknown } | undefined;
  const c = b?.consume ?? (b ? { username: u, opIds: b.opIds, issuedAt: b.issuedAt } : undefined);
  if (
    !c ||
    c.username !== u ||
    !Array.isArray(c.opIds) ||
    c.opIds.length > VOICI_DRAFTS_CONSUME_MAX ||
    typeof c.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return voiciRefusal(400, "malformed");
  }
  const user = await deps.usernames.get(u);
  if (!user) return voiciRefusal(404, "not-found");
  if (Math.abs(now - c.issuedAt) > VOICI_INDEX_SKEW_MS) return voiciRefusal(403, "stale");
  const consume = { username: u, opIds: c.opIds as string[], issuedAt: c.issuedAt };
  const key = voiciSensitiveKey(user).pub;
  if (typeof b.signerPub === "string" && b.signerPub.toLowerCase() !== key) return voiciRefusal(403, "not-sensitive-key");
  if (!verifyVoiciDraftsConsume(consume, b.signature, key)) return voiciRefusal(403, "bad-signature");
  const removed = await deps.voici.consumeDrafts(u, consume.opIds);
  return okNoStore({ ok: true, removed });
}
