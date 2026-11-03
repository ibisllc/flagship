/**
 * voi.ci pages (docs/voici-and-messages.md §2, §3, §5): the signed index of content-addressed pieces, the piece
 * schemas and caps, anti-rollback, the piece-upload signature, the one-namespace key, post chunking and the
 * two-admin-device merge. Shared vectors: packages/protocol/test-vectors/voici/.
 *
 *   flagship/voici-page/v1|<username>|<pageId>|<seq>|<issuedAt>|<acceptsMessages 0|1>|<inboxEpoch>|<inboxPub>
 *     |<ownerSignPub>|<pieces>|<signerKind admin-root|irk>|<signerPub>
 *   pieces = "<role>:<sha256>:<size>" sorted (code-unit order), joined by ","; role "profile", "avatar",
 *            "chunk-<n>" (n decimal, 0-based, contiguous) or "card-<first 16 hex of its sha256>".
 *   flagship/voici-piece-upload/v1|<u>|<pageId>|<sha256>|<size>|<issuedAt>
 * Both are Ed25519 by the account's sensitive key (admin root; the IRK only when the account pins none).
 * Envelope: {kind:"VoiciPage", version:1, username, pageId, seq, issuedAt, acceptsMessages, inboxEpoch, inboxPub,
 * ownerSignPub, pieces:[{role, sha256, size}], signerKind, signerPub, signature}; acceptsMessages is 0 or 1.
 *
 * Pieces are canonical JSON (webEnvelope.ts `canonicalJson`) or JPEG:
 *   profile  {v:1, displayName, bio, avatar:<sha256>|null, theme, links:[{url, label, site:<id>|null}]}  ≤ 16 KiB
 *   chunk    {v:1, chunk:<n>, posts:[{id, createdAt, editedAt|null, text, links:[{url, card|null}]}]}    ≤ 256 KiB
 *   card     {title, site, description, image:<sha256>|null}
 *   images   JPEG (FF D8 FF), avatar ≤ 150 KiB, card image ≤ 40 KiB.
 *
 * Exported API: TAG_VOICI_PAGE, TAG_VOICI_PIECE_UPLOAD, VOICI_* caps, VOICI_THEMES, VoiciTheme, VoiciProfile,
 * VoiciProfileLink, VoiciPost, VoiciPostLink, VoiciCard, VoiciChunk, VoiciPieceRef, VoiciPageIndexBody,
 * VoiciPageIndex, VoiciSignerKind, isVoiciJpeg, voiciJpegHasMetadata, parseVoiciProfile,
 * parseVoiciProfilePiece, parseVoiciPost, parseVoiciChunkPiece, voiciCardRole, canonicalVoiciPageIndex,
 * signVoiciPageIndex, parseVoiciPageIndex, VoiciPageRefusal, checkVoiciPageIndex, checkVoiciPublish,
 * voiciPieceRefsOk, canonicalVoiciPieceUpload, signVoiciPieceUpload, verifyVoiciPieceUpload, VoiciPageState,
 * chunkVoiciPosts, mergeVoiciPage.
 */
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";
import type { VoiciDraftOp } from "./voiciMessages.js";
import { checkVoiciLinkUrl, checkVoiciText, VOICI_LINK_SITES } from "./voiciText.js";
import { canonicalJson, ed25519VerifyHex, isLowerHex } from "./webEnvelope.js";

export const TAG_VOICI_PAGE = "flagship/voici-page/v1";
export const TAG_VOICI_PIECE_UPLOAD = "flagship/voici-piece-upload/v1";

export const VOICI_PROFILE_MAX_BYTES = 16 * 1024;
export const VOICI_CHUNK_MAX_BYTES = 256 * 1024;
export const VOICI_CHUNK_MAX_POSTS = 20;
export const VOICI_AVATAR_MAX_BYTES = 150 * 1024;
export const VOICI_CARD_IMAGE_MAX_BYTES = 40 * 1024;
export const VOICI_INDEX_MAX_BYTES = 300 * 1024;
export const VOICI_INDEX_MAX_PIECES = 2000;
export const VOICI_PROFILE_MAX_LINKS = 12;
export const VOICI_POST_MAX_LINKS = 3;
/** issuedAt must be within this of `.com`'s clock at upload / publish. */
export const VOICI_INDEX_SKEW_MS = 10 * 60_000;
export const VOICI_THEMES = ["classic", "ink", "sea"] as const;
export type VoiciTheme = (typeof VOICI_THEMES)[number];
export type VoiciSignerKind = "admin-root" | "irk";

export interface VoiciProfileLink {
  url: string;
  label: string;
  site: string | null;
}
export interface VoiciProfile {
  v: 1;
  displayName: string;
  bio: string;
  avatar: string | null;
  theme: VoiciTheme;
  links: VoiciProfileLink[];
}
export interface VoiciCard {
  title: string;
  site: string;
  description: string;
  image: string | null;
}
export interface VoiciPostLink {
  url: string;
  card: VoiciCard | null;
}
export interface VoiciPost {
  id: string;
  createdAt: number;
  editedAt: number | null;
  text: string;
  links: VoiciPostLink[];
}
export interface VoiciChunk {
  v: 1;
  chunk: number;
  posts: VoiciPost[];
}
export interface VoiciPieceRef {
  role: string;
  sha256: string;
  size: number;
}

const enc = (s: string): Bytes => new TextEncoder().encode(s);
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SITE_IDS = new Set(VOICI_LINK_SITES.map((s) => s.id));
function exactKeys(r: Record<string, unknown>, keys: string[]): boolean {
  const ks = Object.keys(r);
  return ks.length === keys.length && keys.every((k) => k in r);
}

export function isVoiciJpeg(b: Bytes): boolean {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** True when a JPEG carries an APP1 (EXIF/XMP) or APP2 (ICC) segment before its scan: the re-encode must drop both. */
export function voiciJpegHasMetadata(b: Bytes): boolean {
  if (!isVoiciJpeg(b)) return false;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1]!;
    if (m === 0xda || m === 0xd9) return false;
    if (m === 0xe1 || m === 0xe2) return true;
    i += 2 + ((b[i + 2]! << 8) | b[i + 3]!);
  }
  return false;
}

function parseJsonPiece(bytes: Bytes, max: number): Record<string, unknown> | null {
  if (bytes.length > max) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const v = JSON.parse(text);
    return isObj(v) && canonicalJson(v) === text ? v : null;
  } catch {
    return null;
  }
}

export function parseVoiciProfile(v: unknown): VoiciProfile | null {
  if (!isObj(v) || !exactKeys(v, ["v", "displayName", "bio", "avatar", "theme", "links"]) || v.v !== 1) return null;
  if (checkVoiciText("displayName", v.displayName) || checkVoiciText("bio", v.bio)) return null;
  if (v.avatar !== null && !isLowerHex(v.avatar, 32)) return null;
  if (!VOICI_THEMES.includes(v.theme as VoiciTheme)) return null;
  if (!Array.isArray(v.links) || v.links.length > VOICI_PROFILE_MAX_LINKS) return null;
  const links: VoiciProfileLink[] = [];
  let mail = 0;
  for (const l of v.links) {
    if (!isObj(l) || !exactKeys(l, ["url", "label", "site"])) return null;
    if (checkVoiciLinkUrl(l.url, true) || checkVoiciText("linkLabel", l.label)) return null;
    if ((l.url as string).startsWith("mailto:") && ++mail > 1) return null;
    if (l.site !== null && !(typeof l.site === "string" && SITE_IDS.has(l.site))) return null;
    links.push({ url: l.url as string, label: l.label as string, site: l.site as string | null });
  }
  return { v: 1, displayName: v.displayName as string, bio: v.bio as string, avatar: v.avatar as string | null, theme: v.theme as VoiciTheme, links };
}

/** A profile piece's bytes: size, canonical JSON, schema. */
export function parseVoiciProfilePiece(bytes: Bytes): VoiciProfile | null {
  const v = parseJsonPiece(bytes, VOICI_PROFILE_MAX_BYTES);
  return v ? parseVoiciProfile(v) : null;
}

function parseCard(v: unknown): VoiciCard | null {
  if (!isObj(v) || !exactKeys(v, ["title", "site", "description", "image"])) return null;
  if (checkVoiciText("cardTitle", v.title) || checkVoiciText("cardSite", v.site) || checkVoiciText("cardDescription", v.description)) return null;
  if (v.image !== null && !isLowerHex(v.image, 32)) return null;
  return { title: v.title as string, site: v.site as string, description: v.description as string, image: v.image as string | null };
}

export function parseVoiciPost(v: unknown): VoiciPost | null {
  if (!isObj(v) || !exactKeys(v, ["id", "createdAt", "editedAt", "text", "links"])) return null;
  if (!isLowerHex(v.id, 16) || !isTime(v.createdAt) || (v.editedAt !== null && !isTime(v.editedAt))) return null;
  if (checkVoiciText("postText", v.text)) return null;
  if (!Array.isArray(v.links) || v.links.length > VOICI_POST_MAX_LINKS) return null;
  const links: VoiciPostLink[] = [];
  for (const l of v.links) {
    if (!isObj(l) || !exactKeys(l, ["url", "card"]) || checkVoiciLinkUrl(l.url)) return null;
    const card = l.card === null ? null : parseCard(l.card);
    if (l.card !== null && !card) return null;
    links.push({ url: l.url as string, card });
  }
  return { id: v.id, createdAt: v.createdAt, editedAt: v.editedAt as number | null, text: v.text as string, links };
}

/** A chunk piece's bytes; `n` is the chunk number its role names. Post ids must be unique in the chunk. */
export function parseVoiciChunkPiece(bytes: Bytes, n: number): VoiciChunk | null {
  const v = parseJsonPiece(bytes, VOICI_CHUNK_MAX_BYTES);
  if (!v || !exactKeys(v, ["v", "chunk", "posts"]) || v.v !== 1 || v.chunk !== n || !Array.isArray(v.posts) || v.posts.length > VOICI_CHUNK_MAX_POSTS) return null;
  const posts: VoiciPost[] = [];
  const ids = new Set<string>();
  for (const p of v.posts) {
    const q = parseVoiciPost(p);
    if (!q || ids.has(q.id)) return null;
    ids.add(q.id);
    posts.push(q);
  }
  return { v: 1, chunk: n, posts };
}

export function voiciCardRole(sha256: string): string {
  return `card-${sha256.slice(0, 16)}`;
}

// ── the index ──────────────────────────────────────────────────────────────

export interface VoiciPageIndexBody {
  username: string;
  pageId: string;
  seq: number;
  issuedAt: number;
  acceptsMessages: 0 | 1;
  inboxEpoch: number;
  inboxPub: string;
  ownerSignPub: string;
  pieces: VoiciPieceRef[];
  signerKind: VoiciSignerKind;
  signerPub: string;
}

export interface VoiciPageIndex extends VoiciPageIndexBody {
  kind: "VoiciPage";
  version: 1;
  signature: string;
}

const ROLE = /^(profile|avatar|chunk-(0|[1-9][0-9]{0,5})|card-[0-9a-f]{16})$/;

function piecesProblem(pieces: VoiciPieceRef[]): string | null {
  if (!Array.isArray(pieces) || pieces.length > VOICI_INDEX_MAX_PIECES) return "pieces";
  const roles = new Set<string>();
  let chunks = 0;
  for (const p of pieces) {
    if (!isObj(p) || !exactKeys(p as unknown as Record<string, unknown>, ["role", "sha256", "size"])) return "piece shape";
    if (typeof p.role !== "string" || !ROLE.test(p.role) || !isLowerHex(p.sha256, 32) || !isTime(p.size) || p.size < 1) return "piece field";
    if (roles.has(p.role)) return "duplicate role";
    roles.add(p.role);
    if (p.role.startsWith("card-") && p.role !== voiciCardRole(p.sha256)) return "card role";
    if (p.role.startsWith("chunk-")) chunks++;
    const cap = p.role === "profile" ? VOICI_PROFILE_MAX_BYTES : p.role === "avatar" ? VOICI_AVATAR_MAX_BYTES : p.role.startsWith("card-") ? VOICI_CARD_IMAGE_MAX_BYTES : VOICI_CHUNK_MAX_BYTES;
    if (p.size > cap) return "piece size";
  }
  if (!roles.has("profile")) return "no profile";
  for (let i = 0; i < chunks; i++) if (!roles.has(`chunk-${i}`)) return "chunks not contiguous";
  const keys = pieces.map((p) => `${p.role}:${p.sha256}:${p.size}`);
  for (let i = 1; i < keys.length; i++) if (!(keys[i - 1]! < keys[i]!)) return "pieces not sorted";
  return null;
}

export function canonicalVoiciPageIndex(b: VoiciPageIndexBody): Bytes {
  const bad = (f: string) => new Error(`${TAG_VOICI_PAGE}: bad ${f}`);
  if (typeof b.username !== "string" || !USERNAME.test(b.username)) throw bad("username");
  if (typeof b.pageId !== "string" || !PAGE_ID.test(b.pageId)) throw bad("pageId");
  if (!isTime(b.seq) || b.seq < 1 || !isTime(b.issuedAt)) throw bad("seq/issuedAt");
  if (b.acceptsMessages !== 0 && b.acceptsMessages !== 1) throw bad("acceptsMessages");
  if (!isTime(b.inboxEpoch) || b.inboxEpoch < 1) throw bad("inboxEpoch");
  if (!isLowerHex(b.inboxPub, 1216) || !isLowerHex(b.ownerSignPub, 32)) throw bad("keys");
  const pp = piecesProblem(b.pieces);
  if (pp) throw bad(pp);
  if (b.signerKind !== "admin-root" && b.signerKind !== "irk") throw bad("signerKind");
  if (!isLowerHex(b.signerPub, 32)) throw bad("signerPub");
  return enc(
    [
      TAG_VOICI_PAGE,
      b.username,
      b.pageId,
      String(b.seq),
      String(b.issuedAt),
      String(b.acceptsMessages),
      String(b.inboxEpoch),
      b.inboxPub,
      b.ownerSignPub,
      b.pieces.map((p) => `${p.role}:${p.sha256}:${p.size}`).join(","),
      b.signerKind,
      b.signerPub,
    ].join("|"),
  );
}

/** Sorts the pieces, then signs with the sensitive key's seed (whose public key must be `signerPub`). */
export function signVoiciPageIndex(body: Omit<VoiciPageIndexBody, "signerPub">, signerSeed: Bytes): VoiciPageIndex {
  const pieces = [...body.pieces].map((p) => ({ role: p.role, sha256: p.sha256, size: p.size }));
  pieces.sort((a, b) => {
    const x = `${a.role}:${a.sha256}:${a.size}`;
    const y = `${b.role}:${b.sha256}:${b.size}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const full: VoiciPageIndexBody = { ...body, pieces, signerPub: hex(ed.getPublicKey(signerSeed)) };
  return { kind: "VoiciPage", version: 1, ...full, signature: hex(ed.sign(canonicalVoiciPageIndex(full), signerSeed)) };
}

const INDEX_KEYS = ["kind", "version", "username", "pageId", "seq", "issuedAt", "acceptsMessages", "inboxEpoch", "inboxPub", "ownerSignPub", "pieces", "signerKind", "signerPub", "signature"];

/** Strict shape of an untrusted index (JSON text ≤ 300 KiB or a parsed value); no signature check. */
export function parseVoiciPageIndex(input: unknown): VoiciPageIndex | null {
  let v = input;
  if (typeof input === "string") {
    if (enc(input).length > VOICI_INDEX_MAX_BYTES) return null;
    try {
      v = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isObj(v) || !exactKeys(v, INDEX_KEYS) || v.kind !== "VoiciPage" || v.version !== 1 || !isLowerHex(v.signature, 64)) return null;
  const r = v as unknown as VoiciPageIndex;
  try {
    canonicalVoiciPageIndex(r);
  } catch {
    return null;
  }
  return {
    kind: "VoiciPage",
    version: 1,
    username: r.username,
    pageId: r.pageId,
    seq: r.seq,
    issuedAt: r.issuedAt,
    acceptsMessages: r.acceptsMessages,
    inboxEpoch: r.inboxEpoch,
    inboxPub: r.inboxPub,
    ownerSignPub: r.ownerSignPub,
    pieces: r.pieces.map((p) => ({ role: p.role, sha256: p.sha256, size: p.size })),
    signerKind: r.signerKind,
    signerPub: r.signerPub,
    signature: r.signature,
  };
}

export type VoiciPageRefusal = "malformed" | "wrong-username" | "not-sensitive-key" | "bad-signature" | "rolled-back" | "stale" | "seq-conflict" | "wrong-page";

/**
 * A reader's check (voi.ci, the apps): shape, the username asked for, `signerPub` = the account's current sensitive
 * key (`sensitivePub`, with its kind: admin root, or the IRK when the account pins none), the signature, and
 * anti-rollback: `seq` must not be lower than `highestSeenSeq` for this pageId (§2.9).
 */
export function checkVoiciPageIndex(
  input: unknown,
  o: { username: string; sensitiveKind: VoiciSignerKind; sensitivePub: string; highestSeenSeq?: number; pageId?: string },
): { ok: true; index: VoiciPageIndex } | { ok: false; code: VoiciPageRefusal } {
  const idx = parseVoiciPageIndex(input);
  if (!idx) return { ok: false, code: "malformed" };
  if (idx.username !== o.username) return { ok: false, code: "wrong-username" };
  if (idx.signerKind !== o.sensitiveKind || idx.signerPub !== o.sensitivePub) return { ok: false, code: "not-sensitive-key" };
  if (!ed25519VerifyHex(idx.signature, canonicalVoiciPageIndex(idx), idx.signerPub)) return { ok: false, code: "bad-signature" };
  if (o.pageId !== undefined && idx.pageId !== o.pageId) return { ok: false, code: "wrong-page" };
  if (o.highestSeenSeq !== undefined && idx.seq < o.highestSeenSeq) return { ok: false, code: "rolled-back" };
  return { ok: true, index: idx };
}

/**
 * `.com`'s publish check (§3) after the reader's: `issuedAt` within 10 minutes of `now`, `seq` = stored + 1 (stored 0
 * when none), and the pageId unchanged from the stored index. Piece presence and parsing are `.com`'s (storage).
 */
export function checkVoiciPublish(
  input: unknown,
  o: { username: string; sensitiveKind: VoiciSignerKind; sensitivePub: string; storedSeq: number; storedPageId: string | null; now: number },
): { ok: true; index: VoiciPageIndex } | { ok: false; code: VoiciPageRefusal } {
  const r = checkVoiciPageIndex(input, { username: o.username, sensitiveKind: o.sensitiveKind, sensitivePub: o.sensitivePub });
  if (!r.ok) return r;
  if (Math.abs(r.index.issuedAt - o.now) > VOICI_INDEX_SKEW_MS) return { ok: false, code: "stale" };
  if (r.index.seq !== o.storedSeq + 1) return { ok: false, code: "seq-conflict" };
  if (o.storedPageId !== null && r.index.pageId !== o.storedPageId) return { ok: false, code: "wrong-page" };
  return r;
}

/**
 * The pieces the content names are the pieces the index lists: profile.avatar ↔ the avatar role (or neither), every
 * card image ↔ a card role with that hash, and chunk count ↔ chunk roles. No unreferenced image roles.
 */
export function voiciPieceRefsOk(index: VoiciPageIndexBody, profile: VoiciProfile, chunks: VoiciChunk[]): boolean {
  const byRole = new Map(index.pieces.map((p) => [p.role, p.sha256]));
  if ((profile.avatar ?? null) !== (byRole.get("avatar") ?? null)) return false;
  const nChunks = index.pieces.filter((p) => p.role.startsWith("chunk-")).length;
  if (chunks.length !== nChunks || chunks.some((c, i) => c.chunk !== i)) return false;
  const cards = new Set<string>();
  for (const c of chunks) for (const p of c.posts) for (const l of p.links) if (l.card?.image) cards.add(l.card.image);
  const listed = index.pieces.filter((p) => p.role.startsWith("card-"));
  return listed.length === cards.size && listed.every((p) => cards.has(p.sha256));
}

// ── piece upload ───────────────────────────────────────────────────────────

export interface VoiciPieceUpload {
  username: string;
  pageId: string;
  sha256: string;
  size: number;
  issuedAt: number;
}

export function canonicalVoiciPieceUpload(u: VoiciPieceUpload): Bytes {
  if (typeof u.username !== "string" || typeof u.pageId !== "string" || !USERNAME.test(u.username) || !PAGE_ID.test(u.pageId) || !isLowerHex(u.sha256, 32) || !isTime(u.size) || u.size < 1 || !isTime(u.issuedAt)) {
    throw new Error(`${TAG_VOICI_PIECE_UPLOAD}: bad field`);
  }
  return enc([TAG_VOICI_PIECE_UPLOAD, u.username, u.pageId, u.sha256, String(u.size), String(u.issuedAt)].join("|"));
}

export function signVoiciPieceUpload(u: VoiciPieceUpload, signerSeed: Bytes): string {
  return hex(ed.sign(canonicalVoiciPieceUpload(u), signerSeed));
}

export function verifyVoiciPieceUpload(u: VoiciPieceUpload, signature: string, signerPub: string): boolean {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciPieceUpload(u), signerPub);
  } catch {
    return false;
  }
}

// ── chunking and the merge (§5.3) ──────────────────────────────────────────

export interface VoiciPageState {
  profile: VoiciProfile;
  acceptsMessages: 0 | 1;
  /** Chunk n holds posts in creation order; chunk 0 the oldest. */
  chunks: VoiciPost[][];
  /** The published index's issuedAt (0 for a page never published): the time published profile fields carry. */
  issuedAt: number;
}

const byCreation = (a: VoiciPost, b: VoiciPost) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const stamp = (p: VoiciPost) => p.editedAt ?? p.createdAt;

/** Posts (any order) into fresh chunks of at most 20, creation order: for a first publish. */
export function chunkVoiciPosts(posts: VoiciPost[]): VoiciPost[][] {
  const sorted = [...posts].sort(byCreation);
  const out: VoiciPost[][] = [];
  for (let i = 0; i < sorted.length; i += VOICI_CHUNK_MAX_POSTS) out.push(sorted.slice(i, i + VOICI_CHUNK_MAX_POSTS));
  return out;
}

/**
 * Applies pending draft ops to a published state, the loser's side of a seq conflict (and every admin publish):
 * ops in (at, opId) order. post-add of a new id appends to the last chunk (a new chunk when it holds 20); of an
 * existing id, the newer (editedAt ?? createdAt) wins. post-edit replaces only a newer version of a post still
 * present (a delete beats an edit). post-delete removes it (its chunk stays, maybe empty). profile and
 * accept-messages win when op.at > the state's time (published issuedAt, then the last applied op). Each touched
 * chunk is kept in creation order. Pure; the input is not changed.
 */
export function mergeVoiciPage(published: VoiciPageState, ops: readonly VoiciDraftOp[]): VoiciPageState {
  const chunks = published.chunks.map((c) => [...c]);
  let profile = published.profile;
  let profileAt = published.issuedAt;
  let accepts = published.acceptsMessages;
  let acceptsAt = published.issuedAt;
  const find = (id: string): [number, number] | null => {
    for (let c = 0; c < chunks.length; c++) {
      const i = chunks[c]!.findIndex((p) => p.id === id);
      if (i >= 0) return [c, i];
    }
    return null;
  };
  const sorted = [...ops].sort((a, b) => a.at - b.at || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0));
  for (const op of sorted) {
    if ((op.op === "post-add" || op.op === "post-edit") && op.post) {
      const at = find(op.post.id);
      if (at) {
        const cur = chunks[at[0]]![at[1]]!;
        if (stamp(op.post) > stamp(cur)) {
          chunks[at[0]]![at[1]] = op.post;
          chunks[at[0]]!.sort(byCreation);
        }
      } else if (op.op === "post-add") {
        if (chunks.length === 0 || chunks[chunks.length - 1]!.length >= VOICI_CHUNK_MAX_POSTS) chunks.push([]);
        chunks[chunks.length - 1]!.push(op.post);
        chunks[chunks.length - 1]!.sort(byCreation);
      }
    } else if (op.op === "post-delete" && op.postId) {
      const at = find(op.postId);
      if (at) chunks[at[0]]!.splice(at[1], 1);
    } else if (op.op === "profile" && op.profile && op.at > profileAt) {
      profile = op.profile;
      profileAt = op.at;
    } else if (op.op === "accept-messages" && op.accepts !== undefined && op.at > acceptsAt) {
      accepts = op.accepts;
      acceptsAt = op.at;
    }
  }
  return { profile, acceptsMessages: accepts, chunks, issuedAt: published.issuedAt };
}
