// voi.ci pages (docs/voici-and-messages.md §2, §3, §5): the signed index of content-addressed pieces, piece
// schemas and caps, anti-rollback, the piece-upload signature, the one-namespace key, post chunking and the
// two-admin-device merge. Browser twin of packages/protocol/src/voiciPage.ts, byte for byte (shared vectors in
// packages/protocol/test-vectors/voici/). Import it through lib/voiciProtocol.js.
//
//   flagship/voici-page/v1|<username>|<pageId>|<seq>|<issuedAt>|<acceptsMessages 0|1>|<inboxEpoch>|<inboxPub>
//     |<ownerSignPub>|<pieces>|<signerKind admin-root|irk>|<signerPub>
//   flagship/voici-piece-upload/v1|<u>|<pageId>|<sha256>|<size>|<issuedAt>
//
// Exported API: TAG_VOICI_PAGE, TAG_VOICI_PIECE_UPLOAD, VOICI_* caps, VOICI_THEMES, isVoiciJpeg,
// voiciJpegHasMetadata, parseVoiciProfile, parseVoiciProfilePiece, parseVoiciPost, parseVoiciChunkPiece,
// voiciCardRole, canonicalVoiciPageIndex, signVoiciPageIndex, parseVoiciPageIndex, checkVoiciPageIndex,
// checkVoiciPublish, voiciPieceRefsOk, canonicalVoiciPieceUpload, signVoiciPieceUpload, verifyVoiciPieceUpload,
// chunkVoiciPosts, mergeVoiciPage.

import { canonicalJson, ed25519PublicKey, ed25519SignHex, ed25519VerifyHex, hex, isLowerHex } from "./voiciCore.js";
import { checkVoiciLinkUrl, checkVoiciText, VOICI_LINK_SITES } from "./voiciText.js";

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
export const VOICI_INDEX_SKEW_MS = 10 * 60_000;
export const VOICI_THEMES = ["classic", "ink", "sea"];

const enc = (s) => new TextEncoder().encode(s);
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const PAGE_ID = /^[0-9a-f]{32}$/;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SITE_IDS = new Set(VOICI_LINK_SITES.map((s) => s.id));
function exactKeys(r, keys) {
  const ks = Object.keys(r);
  return ks.length === keys.length && keys.every((k) => k in r);
}

export function isVoiciJpeg(b) {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** True when a JPEG carries an APP1 (EXIF/XMP) or APP2 (ICC) segment before its scan. */
export function voiciJpegHasMetadata(b) {
  if (!isVoiciJpeg(b)) return false;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) return false;
    if (m === 0xe1 || m === 0xe2) return true;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return false;
}

function parseJsonPiece(bytes, max) {
  if (bytes.length > max) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const v = JSON.parse(text);
    return isObj(v) && canonicalJson(v) === text ? v : null;
  } catch {
    return null;
  }
}

export function parseVoiciProfile(v) {
  if (!isObj(v) || !exactKeys(v, ["v", "displayName", "bio", "avatar", "theme", "links"]) || v.v !== 1) return null;
  if (checkVoiciText("displayName", v.displayName) || checkVoiciText("bio", v.bio)) return null;
  if (v.avatar !== null && !isLowerHex(v.avatar, 32)) return null;
  if (!VOICI_THEMES.includes(v.theme)) return null;
  if (!Array.isArray(v.links) || v.links.length > VOICI_PROFILE_MAX_LINKS) return null;
  const links = [];
  let mail = 0;
  for (const l of v.links) {
    if (!isObj(l) || !exactKeys(l, ["url", "label", "site"])) return null;
    if (checkVoiciLinkUrl(l.url, true) || checkVoiciText("linkLabel", l.label)) return null;
    if (l.url.startsWith("mailto:") && ++mail > 1) return null;
    if (l.site !== null && !(typeof l.site === "string" && SITE_IDS.has(l.site))) return null;
    links.push({ url: l.url, label: l.label, site: l.site });
  }
  return { v: 1, displayName: v.displayName, bio: v.bio, avatar: v.avatar, theme: v.theme, links };
}

/** A profile piece's bytes: size, canonical JSON, schema. */
export function parseVoiciProfilePiece(bytes) {
  const v = parseJsonPiece(bytes, VOICI_PROFILE_MAX_BYTES);
  return v ? parseVoiciProfile(v) : null;
}

function parseCard(v) {
  if (!isObj(v) || !exactKeys(v, ["title", "site", "description", "image"])) return null;
  if (checkVoiciText("cardTitle", v.title) || checkVoiciText("cardSite", v.site) || checkVoiciText("cardDescription", v.description)) return null;
  if (v.image !== null && !isLowerHex(v.image, 32)) return null;
  return { title: v.title, site: v.site, description: v.description, image: v.image };
}

export function parseVoiciPost(v) {
  if (!isObj(v) || !exactKeys(v, ["id", "createdAt", "editedAt", "text", "links"])) return null;
  if (!isLowerHex(v.id, 16) || !isTime(v.createdAt) || (v.editedAt !== null && !isTime(v.editedAt))) return null;
  if (checkVoiciText("postText", v.text)) return null;
  if (!Array.isArray(v.links) || v.links.length > VOICI_POST_MAX_LINKS) return null;
  const links = [];
  for (const l of v.links) {
    if (!isObj(l) || !exactKeys(l, ["url", "card"]) || checkVoiciLinkUrl(l.url)) return null;
    const card = l.card === null ? null : parseCard(l.card);
    if (l.card !== null && !card) return null;
    links.push({ url: l.url, card });
  }
  return { id: v.id, createdAt: v.createdAt, editedAt: v.editedAt, text: v.text, links };
}

/** A chunk piece's bytes; `n` is the chunk number its role names. Post ids must be unique in the chunk. */
export function parseVoiciChunkPiece(bytes, n) {
  const v = parseJsonPiece(bytes, VOICI_CHUNK_MAX_BYTES);
  if (!v || !exactKeys(v, ["v", "chunk", "posts"]) || v.v !== 1 || v.chunk !== n || !Array.isArray(v.posts) || v.posts.length > VOICI_CHUNK_MAX_POSTS) return null;
  const posts = [];
  const ids = new Set();
  for (const p of v.posts) {
    const q = parseVoiciPost(p);
    if (!q || ids.has(q.id)) return null;
    ids.add(q.id);
    posts.push(q);
  }
  return { v: 1, chunk: n, posts };
}

export function voiciCardRole(sha256) {
  return `card-${sha256.slice(0, 16)}`;
}

// ── the index ─────────────────────────────────────────────────────────────

const ROLE = /^(profile|avatar|chunk-(0|[1-9][0-9]{0,5})|card-[0-9a-f]{16})$/;
const pieceKey = (p) => `${p.role}:${p.sha256}:${p.size}`;

function piecesProblem(pieces) {
  if (!Array.isArray(pieces) || pieces.length > VOICI_INDEX_MAX_PIECES) return "pieces";
  const roles = new Set();
  let chunks = 0;
  for (const p of pieces) {
    if (!isObj(p) || !exactKeys(p, ["role", "sha256", "size"])) return "piece shape";
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
  const keys = pieces.map(pieceKey);
  for (let i = 1; i < keys.length; i++) if (!(keys[i - 1] < keys[i])) return "pieces not sorted";
  return null;
}

export function canonicalVoiciPageIndex(b) {
  const bad = (f) => new Error(`${TAG_VOICI_PAGE}: bad ${f}`);
  if (typeof b.username !== "string" || !USERNAME.test(b.username)) throw bad("username");
  if (!PAGE_ID.test(b.pageId)) throw bad("pageId");
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
      b.pieces.map(pieceKey).join(","),
      b.signerKind,
      b.signerPub,
    ].join("|"),
  );
}

/** Sorts the pieces, then signs with the sensitive key's seed (whose public key becomes `signerPub`). */
export function signVoiciPageIndex(body, signerSeed) {
  const pieces = [...body.pieces].map((p) => ({ role: p.role, sha256: p.sha256, size: p.size }));
  pieces.sort((a, b) => {
    const x = pieceKey(a);
    const y = pieceKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const full = { ...body, pieces, signerPub: hex(ed25519PublicKey(signerSeed)) };
  return { kind: "VoiciPage", version: 1, ...full, signature: ed25519SignHex(canonicalVoiciPageIndex(full), signerSeed) };
}

const INDEX_KEYS = ["kind", "version", "username", "pageId", "seq", "issuedAt", "acceptsMessages", "inboxEpoch", "inboxPub", "ownerSignPub", "pieces", "signerKind", "signerPub", "signature"];

/** Strict shape of an untrusted index (JSON text ≤ 300 KiB or a parsed value); no signature check. */
export function parseVoiciPageIndex(input) {
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
  try {
    canonicalVoiciPageIndex(v);
  } catch {
    return null;
  }
  return {
    kind: "VoiciPage",
    version: 1,
    username: v.username,
    pageId: v.pageId,
    seq: v.seq,
    issuedAt: v.issuedAt,
    acceptsMessages: v.acceptsMessages,
    inboxEpoch: v.inboxEpoch,
    inboxPub: v.inboxPub,
    ownerSignPub: v.ownerSignPub,
    pieces: v.pieces.map((p) => ({ role: p.role, sha256: p.sha256, size: p.size })),
    signerKind: v.signerKind,
    signerPub: v.signerPub,
    signature: v.signature,
  };
}

/**
 * A reader's check: o = {username, sensitiveKind, sensitivePub, highestSeenSeq?, pageId?}.
 * {ok:true, index} | {ok:false, code: malformed|wrong-username|not-sensitive-key|bad-signature|wrong-page|rolled-back}.
 */
export function checkVoiciPageIndex(input, o) {
  const idx = parseVoiciPageIndex(input);
  if (!idx) return { ok: false, code: "malformed" };
  if (idx.username !== o.username) return { ok: false, code: "wrong-username" };
  if (idx.signerKind !== o.sensitiveKind || idx.signerPub !== o.sensitivePub) return { ok: false, code: "not-sensitive-key" };
  if (!ed25519VerifyHex(idx.signature, canonicalVoiciPageIndex(idx), idx.signerPub)) return { ok: false, code: "bad-signature" };
  if (o.pageId !== undefined && idx.pageId !== o.pageId) return { ok: false, code: "wrong-page" };
  if (o.highestSeenSeq !== undefined && idx.seq < o.highestSeenSeq) return { ok: false, code: "rolled-back" };
  return { ok: true, index: idx };
}

/** `.com`'s publish check: o = {username, sensitiveKind, sensitivePub, storedSeq, storedPageId, now}. */
export function checkVoiciPublish(input, o) {
  const r = checkVoiciPageIndex(input, { username: o.username, sensitiveKind: o.sensitiveKind, sensitivePub: o.sensitivePub });
  if (!r.ok) return r;
  if (Math.abs(r.index.issuedAt - o.now) > VOICI_INDEX_SKEW_MS) return { ok: false, code: "stale" };
  if (r.index.seq !== o.storedSeq + 1) return { ok: false, code: "seq-conflict" };
  if (o.storedPageId !== null && r.index.pageId !== o.storedPageId) return { ok: false, code: "wrong-page" };
  return r;
}

/** The pieces the content names are exactly the pieces the index lists. */
export function voiciPieceRefsOk(index, profile, chunks) {
  const byRole = new Map(index.pieces.map((p) => [p.role, p.sha256]));
  if ((profile.avatar ?? null) !== (byRole.get("avatar") ?? null)) return false;
  const nChunks = index.pieces.filter((p) => p.role.startsWith("chunk-")).length;
  if (chunks.length !== nChunks || chunks.some((c, i) => c.chunk !== i)) return false;
  const cards = new Set();
  for (const c of chunks) for (const p of c.posts) for (const l of p.links) if (l.card?.image) cards.add(l.card.image);
  const listed = index.pieces.filter((p) => p.role.startsWith("card-"));
  return listed.length === cards.size && listed.every((p) => cards.has(p.sha256));
}

// ── piece upload ──────────────────────────────────────────────────────────

export function canonicalVoiciPieceUpload(u) {
  if (!USERNAME.test(u.username) || !PAGE_ID.test(u.pageId) || !isLowerHex(u.sha256, 32) || !isTime(u.size) || u.size < 1 || !isTime(u.issuedAt)) {
    throw new Error(`${TAG_VOICI_PIECE_UPLOAD}: bad field`);
  }
  return enc([TAG_VOICI_PIECE_UPLOAD, u.username, u.pageId, u.sha256, String(u.size), String(u.issuedAt)].join("|"));
}

// ── the owner's removal (§3.3) ─────────────────────────────────────────────

export const TAG_VOICI_PAGE_REMOVE = "flagship/voici-page-remove/v1";

/** flagship/voici-page-remove/v1|<username>|<pageId>|<seq>|<issuedAt> (packages/protocol/src/voiciPageRemove.ts). */
export function canonicalVoiciPageRemove(f) {
  if (typeof f.username !== "string" || !USERNAME.test(f.username)) throw new Error(`${TAG_VOICI_PAGE_REMOVE}: bad username`);
  if (typeof f.pageId !== "string" || !PAGE_ID.test(f.pageId)) throw new Error(`${TAG_VOICI_PAGE_REMOVE}: bad pageId`);
  if (!isTime(f.seq) || f.seq < 1 || !isTime(f.issuedAt)) throw new Error(`${TAG_VOICI_PAGE_REMOVE}: bad seq/issuedAt`);
  return enc([TAG_VOICI_PAGE_REMOVE, f.username, f.pageId, String(f.seq), String(f.issuedAt)].join("|"));
}

/** The envelope `.com` takes at POST /api/voici/pages/<u>/remove, signed with the sensitive key's seed. */
export function signVoiciPageRemove(f, signerSeed) {
  const body = { username: f.username, pageId: f.pageId, seq: f.seq, issuedAt: f.issuedAt };
  return {
    kind: "VoiciPageRemove",
    version: 1,
    ...body,
    signerKind: f.signerKind,
    signerPub: hex(ed25519PublicKey(signerSeed)),
    signature: ed25519SignHex(canonicalVoiciPageRemove(body), signerSeed),
  };
}

export function signVoiciPieceUpload(u, signerSeed) {
  return ed25519SignHex(canonicalVoiciPieceUpload(u), signerSeed);
}

export function verifyVoiciPieceUpload(u, signature, signerPub) {
  try {
    return ed25519VerifyHex(signature, canonicalVoiciPieceUpload(u), signerPub);
  } catch {
    return false;
  }
}

// ── chunking and the merge (§5.3) ─────────────────────────────────────────

const byCreation = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const stamp = (p) => p.editedAt ?? p.createdAt;

/** Posts (any order) into fresh chunks of at most 20, creation order. */
export function chunkVoiciPosts(posts) {
  const sorted = [...posts].sort(byCreation);
  const out = [];
  for (let i = 0; i < sorted.length; i += VOICI_CHUNK_MAX_POSTS) out.push(sorted.slice(i, i + VOICI_CHUNK_MAX_POSTS));
  return out;
}

/**
 * Applies pending draft ops to a published state {profile, acceptsMessages, chunks, issuedAt}, ops in (at, opId)
 * order (see voiciPage.ts for the rules). Pure; the input is not changed.
 */
export function mergeVoiciPage(published, ops) {
  const chunks = published.chunks.map((c) => [...c]);
  let profile = published.profile;
  let profileAt = published.issuedAt;
  let accepts = published.acceptsMessages;
  let acceptsAt = published.issuedAt;
  const find = (id) => {
    for (let c = 0; c < chunks.length; c++) {
      const i = chunks[c].findIndex((p) => p.id === id);
      if (i >= 0) return [c, i];
    }
    return null;
  };
  const sorted = [...ops].sort((a, b) => a.at - b.at || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0));
  for (const op of sorted) {
    if ((op.op === "post-add" || op.op === "post-edit") && op.post) {
      const at = find(op.post.id);
      if (at) {
        const cur = chunks[at[0]][at[1]];
        if (stamp(op.post) > stamp(cur)) {
          chunks[at[0]][at[1]] = op.post;
          chunks[at[0]].sort(byCreation);
        }
      } else if (op.op === "post-add") {
        if (chunks.length === 0 || chunks[chunks.length - 1].length >= VOICI_CHUNK_MAX_POSTS) chunks.push([]);
        chunks[chunks.length - 1].push(op.post);
        chunks[chunks.length - 1].sort(byCreation);
      }
    } else if (op.op === "post-delete" && op.postId) {
      const at = find(op.postId);
      if (at) chunks[at[0]].splice(at[1], 1);
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
