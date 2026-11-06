// voi.ci pages and Messages, the owner's side, on the webapp (docs/voici-and-messages.md §3, §5, §7.4, §8.3, §9,
// §10). The talking-to-`.com` half: read and verify the published page, publish a new index (admin devices),
// hand a change to the admin device as a sealed draft (other devices), read the inbox, reply, block, report, and keep
// the sealed Messages state blob. The protocol itself is lib/voiciProtocol.js (chunk A); this module adds only the
// HTTP shapes and the keys this browser holds. Every function takes `deps` (fetch, now, session, profile) so the
// unit tests run it without a browser.
//
// Pages and messages never reach a model (§10.4): nothing here is shared with any AI code.

import {
  b64Encode,
  b64Decode,
  canonicalJsonBytes,
  canonicalVoiciPageIndex,
  canonicalVoiciPieceUpload,
  checkVoiciDraft,
  checkVoiciMessage,
  checkVoiciPageIndex,
  checkVoiciReply,
  deriveMessagesStateKey,
  deriveVoiciDraftsKey,
  deriveVoiciInboxKey,
  deriveVoiciOwnerSignKey,
  emptyMessagesState,
  hex,
  hexToBytes,
  isVoiciJpeg,
  mergeMessagesState,
  mergeVoiciPage,
  openMessagesState,
  openVoiciBody,
  openVoiciDraft,
  parseVoiciChunkPiece,
  parseVoiciProfilePiece,
  sealMessagesState,
  sealVoiciBody,
  sealVoiciDraft,
  sha256Hex,
  signVoiciBlock,
  signVoiciMessageReport,
  signWebEnvelopeEd25519,
  parsePhoneLiveAnswer,
  voiciCardRole,
  VOICI_WEB_ORIGIN,
  VOICI_WEB_ORIGIN_GYM,
  PHONE_LIVE_PATH,
  PHONE_DELIVER_PATH,
  PHONE_ENVELOPE_CONTENT_TYPE,
  ed25519VerifyHex,
  ed25519PublicKey,
  ed25519SignHex,
  canonicalVoiciPageRemove,
} from "./voiciProtocol.js";
import { controlApex, controlHost, dataApex } from "./apex.js";
import { accountReadFetch } from "./accountRead.js";
import { canonicalDirectoryRequest } from "./accountMetadata.js";
import { deviceGrantCanonicalBytes } from "./crossDevicePairing.js";
import { getSession } from "./state.js";
import { getActiveProfile } from "./profiles.js";
import { canSignAdminOrders } from "./addServerGate.js";
import { serverTrust } from "./serverTrust.js";
import {
  adminRootPubHex,
  bytesToHex,
  deriveAccountDeviceSeedFromSeed,
  deriveIrkFromSeed,
  signWithAdminRoot,
  signWithIrk,
} from "../keystore.js";

/** Default profile of a page that was never published: the account name as the display name. */
export function defaultVoiciProfile(username) {
  return { v: 1, displayName: String(username).slice(0, 64), bio: "", avatar: null, theme: "classic", links: [] };
}

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const randHex = (n) => hex(rand(n));

/** The origin a delegation names: voi.ci, or gym.voi.ci when this webapp talks to the gym apex. */
export function voiciWebOrigin(host = controlHost()) {
  return /^gym\./.test(host) ? VOICI_WEB_ORIGIN_GYM : VOICI_WEB_ORIGIN;
}

/** The public page address shown to the owner. */
export function voiciPageUrl(username, origin = voiciWebOrigin()) {
  return `${origin}/${username}`;
}

/** An error the views turn into a sentence: `code` is `.com`'s (or ours), `retryAfterSec` when given. */
export class VoiciError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = "VoiciError";
    this.code = code;
    Object.assign(this, extra);
  }
}

async function readError(r) {
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* no body */
  }
  const code = typeof body?.code === "string" ? body.code : r.status === 404 ? "not-found" : r.status === 429 ? "rate-limited" : "failed";
  return new VoiciError(code, { status: r.status, body, retryAfterSec: typeof body?.retryAfterSec === "number" ? body.retryAfterSec : undefined });
}

function ctx(deps = {}) {
  return {
    fetch: deps.fetch ?? ((...a) => globalThis.fetch(...a)),
    readFetch: deps.readFetch ?? accountReadFetch,
    now: deps.now ?? Date.now,
    session: deps.session ?? getSession(),
    profile: deps.profile ?? getActiveProfile(),
    apex: deps.apex ?? controlApex(),
    deviceSeed: deps.deviceSeed ?? null,
  };
}

const usernameOf = (c) => String(c.session?.username ?? "").toLowerCase();
const umkOf = (c) => {
  const umk = c.session?.umk;
  if (!(umk instanceof Uint8Array)) throw new VoiciError("locked");
  return { seed: umk };
};

// ── the account's keys ────────────────────────────────────────────────────

/** `.com`'s public keys for an account (`GET /api/username/<u>`): the sensitive key that signs its page. */
export async function fetchAccountKeys(username, deps = {}) {
  const c = ctx(deps);
  const r = await c.fetch(`${c.apex}/api/username/${encodeURIComponent(username)}`, { cache: "no-store" });
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  const admin = typeof body.adminRootPub === "string" && /^[0-9a-f]{64}$/i.test(body.adminRootPub) ? body.adminRootPub.toLowerCase() : null;
  const irk = String(body.irkPub ?? body.irkPubHex ?? "").toLowerCase();
  return admin ? { kind: "admin-root", pub: admin, adminRootPub: admin, irkPub: irk } : { kind: "irk", pub: irk, adminRootPub: null, irkPub: irk };
}

/** The key this device signs the page with, or null when it can't publish (a device without the admin root). */
export async function ownPageSigner(deps = {}) {
  const c = ctx(deps);
  const canPublish = deps.canPublish ?? canSignAdminOrders;
  if (!canPublish(c.session, c.profile)) return null;
  const seed = c.session?.adminRootSeed;
  if (seed instanceof Uint8Array) {
    return { kind: "admin-root", pub: await adminRootPubHex(seed), sign: async (bytes) => bytesToHex(await signWithAdminRoot(seed, bytes)) };
  }
  const umk = umkOf(c).seed;
  const irk = await deriveIrkFromSeed(umk);
  return { kind: "irk", pub: bytesToHex(irk.publicKey), sign: async (bytes) => bytesToHex(await signWithIrk(umk, bytes)) };
}

/** The owner's inbox (X-Wing) and messages signing (Ed25519) keys for one page and epoch. */
export function ownerKeys(umk, pageId, inboxEpoch) {
  return { inbox: deriveVoiciInboxKey(umk, pageId, inboxEpoch), sign: deriveVoiciOwnerSignKey(umk, pageId, inboxEpoch) };
}

// ── the published page ────────────────────────────────────────────────────

/**
 * The page as published, checked: `{index, profile, acceptsMessages, chunks: [[post]], issuedAt, pieces: Map}` or null
 * when the account never published. The index must carry the account's sensitive key; every piece is checked
 * against its hash and size. `pieces` maps sha256 → bytes for the pieces read (profile, chunks, avatar).
 */
export async function loadPublishedPage(username, deps = {}) {
  const c = ctx(deps);
  const r = await c.fetch(`${c.apex}/api/voici/pages/${encodeURIComponent(username)}`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  return verifyPublishedIndex(username, body?.index, deps);
}

/** Checks a signed index against the account's key, then reads and checks its pieces. */
export async function verifyPublishedIndex(username, rawIndex, deps = {}) {
  const c = ctx(deps);
  const keys = deps.accountKeys ?? (await fetchAccountKeys(username, deps));
  const checked = checkVoiciPageIndex(rawIndex, { username, sensitiveKind: keys.kind, sensitivePub: keys.pub });
  if (!checked.ok) throw new VoiciError("page-unverified", { reason: checked.code });
  const index = checked.index;
  const pieces = new Map();
  const read = async (p) => {
    const bytes = await fetchPiece(username, p, c);
    pieces.set(p.sha256, bytes);
    return bytes;
  };
  const byRole = new Map(index.pieces.map((p) => [p.role, p]));
  const profile = parseVoiciProfilePiece(await read(byRole.get("profile")));
  if (!profile) throw new VoiciError("page-unverified", { reason: "bad-piece" });
  const chunks = [];
  for (let i = 0; byRole.has(`chunk-${i}`); i++) {
    const chunk = parseVoiciChunkPiece(await read(byRole.get(`chunk-${i}`)), i);
    if (!chunk) throw new VoiciError("page-unverified", { reason: "bad-piece" });
    chunks.push(chunk.posts);
  }
  if (byRole.has("avatar")) {
    try {
      await read(byRole.get("avatar"));
    } catch {
      /* the photo is shown when it can be read; the page stays usable without it */
    }
  }
  return { index, profile, acceptsMessages: index.acceptsMessages, chunks, issuedAt: index.issuedAt, pieces };
}

/** F (spec §3): the apps read a piece from `.com` (`GET /api/voici/pages/<u>/pieces/<sha256>`), whose bytes equal
 *  `files.voi.ci`'s; the webapp's CSP reaches only the control apex. Checked against the index's hash and size. */
async function fetchPiece(username, piece, c) {
  if (!piece) throw new VoiciError("page-unverified", { reason: "missing-piece" });
  const r = await c.fetch(`${c.apex}/api/voici/pages/${encodeURIComponent(username)}/pieces/${piece.sha256}`, { cache: "force-cache" });
  if (!r.ok) throw await readError(r);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length !== piece.size || sha256Hex(bytes) !== piece.sha256) throw new VoiciError("page-unverified", { reason: "bad-piece" });
  return bytes;
}

/** Every post of a page model, newest first. */
export function postsNewestFirst(chunks) {
  return chunks.flat().sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

// ── publishing (admin devices, §5.1, §5.3) ────────────────────────────────

const json = (v) => canonicalJsonBytes(v);

/**
 * Builds the pieces and the signed index for `merged` on top of `published` (null for a first publish).
 * images: Map sha256 → bytes for any image not already on the page. Returns {index, uploads: [{role, sha256,
 * size, bytes, contentType}]} with only the pieces `published` doesn't list.
 */
export async function buildVoiciIndex({ username, published, merged, images, signer, umk, now, rotate = false }) {
  const pageId = published?.index.pageId ?? randHex(16);
  const prevEpoch = published?.index.inboxEpoch ?? 1;
  const inboxEpoch = rotate && published ? prevEpoch + 1 : prevEpoch;
  const keys = ownerKeys(umk, pageId, inboxEpoch);
  const listed = new Map((published?.index.pieces ?? []).map((p) => [p.sha256, p]));
  const pieces = [];
  const uploads = [];
  const add = (role, bytes, sha, size, contentType) => {
    pieces.push({ role, sha256: sha, size });
    if (!listed.has(sha) && bytes) uploads.push({ role, sha256: sha, size, bytes, contentType });
  };
  const addJson = (role, value) => {
    const bytes = json(value);
    add(role, bytes, sha256Hex(bytes), bytes.length, "application/json");
  };
  const addImage = (role, sha) => {
    const known = listed.get(sha);
    if (known) return add(role, null, sha, known.size, "image/jpeg");
    const bytes = images?.get(sha);
    if (!bytes || !isVoiciJpeg(bytes)) throw new VoiciError("missing-image");
    add(role, bytes, sha, bytes.length, "image/jpeg");
  };
  addJson("profile", merged.profile);
  if (merged.profile.avatar) addImage("avatar", merged.profile.avatar);
  const cards = new Set();
  merged.chunks.forEach((posts, i) => {
    addJson(`chunk-${i}`, { v: 1, chunk: i, posts });
    for (const p of posts) for (const l of p.links) if (l.card?.image) cards.add(l.card.image);
  });
  for (const sha of [...cards].sort()) addImage(voiciCardRole(sha), sha);
  const body = {
    username,
    pageId,
    seq: (published?.index.seq ?? 0) + 1,
    issuedAt: now,
    acceptsMessages: merged.acceptsMessages ? 1 : 0,
    inboxEpoch,
    inboxPub: hex(keys.inbox.publicKey),
    ownerSignPub: hex(keys.sign.publicKey),
    pieces: sortPieces(pieces),
    signerKind: signer.kind,
    signerPub: signer.pub,
  };
  const signature = await signer.sign(canonicalVoiciPageIndex(body));
  return { index: { kind: "VoiciPage", version: 1, ...body, signature }, uploads };
}

function sortPieces(pieces) {
  const key = (p) => `${p.role}:${p.sha256}:${p.size}`;
  return [...pieces].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The piece-upload signature rides in headers (the iOS client's wire, spec §3 "D:"): `x-flagship-page-id`,
 *  `-sha256`, `-size`, `-issued-at`, `-signer-pub`, `-signature`; the body is the piece's bytes. */
async function uploadPiece(username, pageId, piece, signer, c) {
  const issuedAt = c.now();
  const signature = await signer.sign(canonicalVoiciPieceUpload({ username, pageId, sha256: piece.sha256, size: piece.size, issuedAt }));
  const r = await c.fetch(`${c.apex}/api/voici/pages/${encodeURIComponent(username)}/pieces`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-flagship-page-id": pageId,
      "x-flagship-sha256": piece.sha256,
      "x-flagship-size": String(piece.size),
      "x-flagship-issued-at": String(issuedAt),
      "x-flagship-signer-pub": signer.pub,
      "x-flagship-signature": signature,
    },
    body: piece.bytes,
  });
  if (!r.ok) throw await readError(r);
}

/**
 * Publishes `ops` (draft ops: this device's and other devices') on top of the current page. On a seq conflict it
 * reads the newer page, merges again and retries, at most 3 times (§5.3). Returns the new published model.
 */
export async function publishVoiciPage({ ops = [], images = new Map(), rotate = false }, deps = {}) {
  const c = ctx(deps);
  const username = usernameOf(c);
  const umk = umkOf(c);
  const signer = deps.signer ?? (await ownPageSigner(deps));
  if (!signer) throw new VoiciError("not-admin");
  let published = deps.published !== undefined ? deps.published : await loadPublishedPage(username, deps);
  // A page the owner removed: its content lives on this device (removedSnapshotBase) and the pieces are gone from
  // `.com`, so every piece is uploaded again under the same pageId, one step up the seq ladder.
  if (!published && deps.removed) published = deps.removed;
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = published ?? { profile: defaultVoiciProfile(username), acceptsMessages: 0, chunks: [], issuedAt: 0 };
    const merged = mergeVoiciPage(base, ops);
    const allImages = new Map([...(published?.pieces ?? new Map()), ...images]);
    const { index, uploads } = await buildVoiciIndex({ username, published, merged, images: allImages, signer, umk, now: c.now(), rotate });
    for (const u of uploads) await uploadPiece(username, index.pageId, u, signer, c);
    const r = await c.fetch(`${c.apex}/api/voici/pages/${encodeURIComponent(username)}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    });
    if (r.ok) {
      const pieces = new Map(allImages);
      for (const u of uploads) pieces.set(u.sha256, u.bytes);
      return { index, profile: merged.profile, acceptsMessages: index.acceptsMessages, chunks: merged.chunks, issuedAt: index.issuedAt, pieces };
    }
    const err = await readError(r);
    if (err.code !== "seq-conflict") throw err;
    if (err.body?.removed === true) published = removedLadderBase(err.body, base);
    else published = err.body?.index ? await verifyPublishedIndex(username, err.body.index, deps) : await loadPublishedPage(username, deps);
  }
  throw new VoiciError("publish-conflict");
}

/**
 * A publish base for a removed page: `content` (this device's copy, else the default profile) under the ladder `.com`
 * answered with (its stored pageId and seq, the stored index's inbox epoch) and no listed pieces, so all are uploaded.
 */
export function removedLadderBase(body, content) {
  const epoch = Number.isSafeInteger(body?.index?.inboxEpoch) ? body.index.inboxEpoch : content?.index?.inboxEpoch ?? 1;
  return {
    profile: content.profile,
    acceptsMessages: content.acceptsMessages,
    chunks: content.chunks,
    issuedAt: content.issuedAt ?? 0,
    pieces: content.pieces ?? new Map(),
    index: { pageId: body.pageId, seq: body.seq, inboxEpoch: epoch, pieces: [] },
  };
}

/**
 * The owner takes the page off voi.ci (§3.3): a removal one step up the seq ladder, signed by the sensitive key. A
 * seq conflict (another admin device published meanwhile) retries on the stored seq; a page that is already gone
 * answers `{removed: true}` without a new removal. Returns `{pageId, seq}` of the page as `.com` now holds it.
 */
export async function removeVoiciPage({ published }, deps = {}) {
  const c = ctx(deps);
  const username = usernameOf(c);
  const signer = deps.signer ?? (await ownPageSigner(deps));
  if (!signer) throw new VoiciError("not-admin");
  if (!published?.index) throw new VoiciError("not-found");
  const pageId = published.index.pageId;
  let seq = published.index.seq;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { username, pageId, seq: seq + 1, issuedAt: c.now() };
    const signature = await signer.sign(canonicalVoiciPageRemove(body));
    const r = await c.fetch(`${c.apex}/api/voici/pages/${encodeURIComponent(username)}/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "VoiciPageRemove", version: 1, ...body, signerKind: signer.kind, signerPub: signer.pub, signature }),
    });
    if (r.ok) {
      const ok = await r.json();
      return { pageId: ok.pageId ?? pageId, seq: ok.seq ?? body.seq };
    }
    const err = await readError(r);
    if (err.code === "not-found") return { pageId, seq: null, already: true };
    if (err.code !== "seq-conflict" || !Number.isSafeInteger(err.body?.seq)) throw err;
    if (err.body.removed === true) return { pageId, seq: err.body.seq, already: true };
    seq = err.body.seq;
  }
  throw new VoiciError("publish-conflict");
}

// ── draft ops (§5.2) ──────────────────────────────────────────────────────

/** A new draft op from this device. `field` is the op's payload ({post}, {postId}, {profile}, {accepts}). */
export function makeDraftOp(op, field, { deviceId, now = Date.now(), images } = {}) {
  const out = { v: 1, opId: randHex(16), op, at: now, deviceId: deviceId || "webapp", ...field };
  if (images?.length) out.images = images.map((bytes) => ({ sha256: sha256Hex(bytes), data: b64Encode(bytes) }));
  return out;
}

/** The images a list of ops carries, sha256 → bytes. */
export function opImages(ops) {
  const m = new Map();
  for (const o of ops) for (const im of o.images ?? []) m.set(im.sha256, b64Decode(im.data));
  return m;
}

/** This device's own grant (from `GET /api/users/<u>/device-grants`, read token), for a draft's `cred`. */
async function ownDeviceGrant(c, username, devicePub) {
  const r = await c.readFetch(`${c.apex}/api/users/${encodeURIComponent(username)}/device-grants`, { cache: "no-store" }, { username });
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  const list = Array.isArray(body) ? body : body.grants ?? body.deviceGrants ?? [];
  for (const g of list) {
    const grant = g.grant ?? g;
    const sig = g.grantSignature ?? g.signatureHex ?? grant.signatureHex;
    if (String(grant.devicePubHex ?? "").toLowerCase() === devicePub && typeof sig === "string") {
      const clean = { ...grant };
      delete clean.signatureHex;
      delete clean.signerRoot;
      return { grant: clean, grantSignature: sig.toLowerCase() };
    }
  }
  throw new VoiciError("no-device-grant");
}

async function deviceSeed(c) {
  if (c.deviceSeed instanceof Uint8Array) return c.deviceSeed;
  const p = c.profile;
  if (!/^[0-9a-f]{32}$/.test(p?.deviceId ?? "")) throw new VoiciError("no-device-key");
  return deriveAccountDeviceSeedFromSeed(umkOf(c).seed, p.accountId, p.deviceId);
}

/**
 * Hands one op to the admin device: sealed under the drafts key, signed by this device's account key, delivered
 * straight to the admin phone when it holds its bare name, and always deposited in the `.com` drafts lane so every
 * device of the account shows it grayed (F: the lane is written even after a direct delivery; the admin device's
 * consume clears both).
 */
export async function sendDraftOp(op, deps = {}) {
  const c = ctx(deps);
  const username = usernameOf(c);
  const seed = await deviceSeed(c);
  const devicePub = hex(ed25519PublicKey(seed));
  const cred = deps.grant ?? (await ownDeviceGrant(c, username, devicePub));
  const body = sealVoiciDraft(deriveVoiciDraftsKey(umkOf(c)), username, op);
  const seqKey = `flagship.voici.draftSeq.${username}.${devicePub}`;
  let seq = 1;
  try {
    seq = (Number(localStorage.getItem(seqKey)) || 0) + 1;
    localStorage.setItem(seqKey, String(seq));
  } catch {
    seq = Math.max(1, Math.floor(c.now() / 1000));
  }
  const envelope = signWebEnvelopeEd25519(
    { v: 1, kind: "voici-draft", audience: username, conv: "", from: devicePub, msgId: op.opId, seq, sentAt: c.now(), bodyB64: b64Encode(body), cred },
    seed,
  );
  const direct = await deliverDirect(username, envelope, c).catch(() => false);
  const r = await c.fetch(`${c.apex}/api/accounts/${encodeURIComponent(username)}/voici-drafts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await deviceHeaders(c, "POST", `/api/accounts/${username}/voici-drafts`)) },
    body: JSON.stringify({ envelope }),
  });
  if (!r.ok) throw await readError(r);
  return { envelope, direct };
}

/** The phone endpoint's live ping (2 s), then one deliver; true when it answered with an ack. */
async function deliverDirect(username, envelope, c) {
  const base = `https://${username}.${dataApex()}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2000);
  let live;
  try {
    const r = await c.fetch(`${base}${PHONE_LIVE_PATH}`, { signal: ac.signal, cache: "no-store" });
    live = r.ok ? parsePhoneLiveAnswer(await r.json()) : null;
  } finally {
    clearTimeout(t);
  }
  if (!live || live.account !== username) return false;
  const r = await c.fetch(`${base}${PHONE_DELIVER_PATH}`, { method: "POST", headers: { "content-type": PHONE_ENVELOPE_CONTENT_TYPE }, body: JSON.stringify(envelope) });
  if (!r.ok) return false;
  const ack = await r.json().catch(() => null);
  return !!(ack?.ack ?? ack)?.signature;
}

/** The account-directory request headers (as `/profile`) for `method` and `path` under `/api/accounts/`. */
export async function deviceHeaders(c, method, path) {
  const p = c.profile;
  const seed = await deviceSeed(c);
  const request = {
    accountId: String(p.accountId),
    deviceId: p.deviceId,
    signerPubHex: hex(ed25519PublicKey(seed)),
    method,
    path,
    requestId: randHex(16),
    issuedAt: c.now(),
  };
  return {
    "x-flagship-device-id": p.deviceId,
    "x-flagship-device-pub": request.signerPubHex,
    "x-flagship-request-id": request.requestId,
    "x-flagship-issued-at": String(request.issuedAt),
    "x-flagship-signature": ed25519SignHex(canonicalDirectoryRequest(request), seed),
  };
}

/**
 * Every pending draft op in the `.com` lane, opened and checked: `[{op, envelope}]`. Each envelope must be signed by
 * a device whose grant verifies under the account's admin root (or its account key, which signs member grants).
 */
export async function loadDraftOps(deps = {}) {
  const c = ctx(deps);
  const username = usernameOf(c);
  const r = await c.readFetch(`${c.apex}/api/accounts/${encodeURIComponent(username)}/voici-drafts`, { cache: "no-store" }, { username });
  if (r.status === 404) return [];
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  const list = Array.isArray(body) ? body : body.drafts ?? body.ops ?? [];
  const keys = deps.accountKeys ?? (await fetchAccountKeys(username, deps));
  const signers = [keys.adminRootPub, keys.irkPub].filter((k) => /^[0-9a-f]{64}$/.test(k ?? ""));
  const draftsKey = deriveVoiciDraftsKey(umkOf(c));
  const out = [];
  for (const item of list) {
    const raw = item?.envelope ?? item;
    const checked = checkVoiciDraft(raw, {
      username,
      checkGrant: (grant, sig, devicePub) => {
        if (String(grant?.devicePubHex ?? "").toLowerCase() !== devicePub || String(grant?.username ?? "").toLowerCase() !== username) return false;
        let bytes;
        try {
          bytes = deviceGrantCanonicalBytes(grant);
        } catch {
          return false;
        }
        return signers.some((pub) => ed25519VerifyHex(sig, bytes, pub));
      },
    });
    if (!checked.ok) continue;
    const op = openVoiciDraft(draftsKey, username, checked.envelope.msgId, b64Decode(checked.envelope.bodyB64));
    if (op) out.push({ op, envelope: checked.envelope });
  }
  return out;
}

export const TAG_VOICI_DRAFTS_CONSUME = "flagship/voici-drafts-consume/v1";

/** `flagship/voici-drafts-consume/v1|<u>|<opIds sorted, joined ,>|<issuedAt>` (the iOS and Android wire). */
export function canonicalDraftsConsume(username, opIds, issuedAt) {
  const ids = [...opIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return new TextEncoder().encode([TAG_VOICI_DRAFTS_CONSUME, String(username).toLowerCase(), ids.join(","), String(issuedAt)].join("|"));
}

/** Deletes the drafts an admin device just published; signed by the sensitive key. Body `{opIds, issuedAt, signerPub, signature}`. */
export async function consumeDraftOps(opIds, deps = {}) {
  if (!opIds.length) return;
  const c = ctx(deps);
  const username = usernameOf(c);
  const signer = deps.signer ?? (await ownPageSigner(deps));
  if (!signer) throw new VoiciError("not-admin");
  const issuedAt = c.now();
  const signature = await signer.sign(canonicalDraftsConsume(username, opIds, issuedAt));
  const r = await c.fetch(`${c.apex}/api/accounts/${encodeURIComponent(username)}/voici-drafts/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opIds, issuedAt, signerPub: signer.pub, signature }),
  });
  if (!r.ok) throw await readError(r);
}

// ── the Messages state blob (§10.1) ───────────────────────────────────────

/** `{state, version}`: the account's sealed state, opened (an empty one at version 0 when there is none). */
export async function loadMessagesState(deps = {}) {
  const c = ctx(deps);
  const username = usernameOf(c);
  const r = await c.readFetch(`${c.apex}/api/accounts/${encodeURIComponent(username)}/messages-state`, { cache: "no-store" }, { username });
  if (r.status === 404) return { state: emptyMessagesState(), version: 0 };
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  const blob = body?.state === undefined ? body : body.state;
  if (!blob) return { state: emptyMessagesState(), version: 0 };
  const state = openMessagesState(deriveMessagesStateKey(umkOf(c)), username, blob);
  if (!state) throw new VoiciError("state-unreadable");
  return { state, version: blob.version };
}

/**
 * Applies `change(state)` (returns the new state) and writes it with `version = stored + 1`; on a conflict it
 * merges with the stored state and retries (at most 3 times). Returns `{state, version}`.
 */
export async function updateMessagesState(change, deps = {}) {
  const c = ctx(deps);
  const username = usernameOf(c);
  const key = deriveMessagesStateKey(umkOf(c));
  let cur = deps.current ?? (await loadMessagesState(deps));
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = change(structuredClone(cur.state));
    const version = cur.version + 1;
    const blob = sealMessagesState(key, username, version, next);
    const path = `/api/accounts/${username}/messages-state`;
    const r = await c.fetch(`${c.apex}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await deviceHeaders(c, "PUT", path)) },
      body: JSON.stringify(blob),
    });
    if (r.ok) return { state: next, version };
    const err = await readError(r);
    if (r.status !== 409) throw err;
    const storedBlob = err.body?.state ?? err.body?.stored ?? null;
    const stored = storedBlob ? openMessagesState(key, username, storedBlob) : null;
    // Merge what this device knew with what was stored, then apply the change once more on top.
    cur = stored ? { state: mergeMessagesState(cur.state, stored), version: storedBlob.version } : await loadMessagesState(deps);
  }
  throw new VoiciError("state-conflict");
}

// ── the inbox (§7, §8.3, §12.1) ───────────────────────────────────────────

/** The CA keys `.com`'s blessing authorizes (attestations are checked against them); empty until one is verified. */
export function caKeysNow(trust = serverTrust) {
  const v = trust.verdict;
  return v?.trusted && typeof v.caPubkey === "string" ? [v.caPubkey] : [];
}

/**
 * Reads the inbox and opens every message to this page: `{conversations, blocks, revoked, cursor}`. A conversation
 * is `{conv, pseudonymPub, threadPub, messages:[{msgId, seq, sentAt, mine, text, envelope, fetchedAt, direct}]}`
 * sorted by (sentAt, msgId). Anything that fails a check (§12.1) is dropped without logging its content. History is
 * checked for signatures only (A §7.3), so the attestation and the delegation are taken as of the message's sentAt.
 */
export async function loadInbox(page, deps = {}) {
  const c = ctx(deps);
  const username = usernameOf(c);
  const r = await c.readFetch(`${c.apex}/api/voici/pages/${encodeURIComponent(username)}/inbox?since=${encodeURIComponent(deps.since ?? "")}`, { cache: "no-store" }, { username });
  if (r.status === 404) return { conversations: [], blocks: [], revoked: [], cursor: "" };
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  return openInbox(page, body, { umk: umkOf(c), caKeys: deps.caKeys ?? caKeysNow(), origin: deps.origin ?? voiciWebOrigin() });
}

/** Pure part of {@link loadInbox}: verify and open an inbox answer. */
export function openInbox(page, body, { umk, caKeys, origin }) {
  const pageId = page.index.pageId;
  const blocks = new Set((Array.isArray(body?.blocks) ? body.blocks : []).filter((x) => typeof x === "string"));
  const revoked = new Set((Array.isArray(body?.revoked) ? body.revoked : []).filter((x) => typeof x === "string"));
  const epochs = new Map();
  const keysFor = (epoch) => {
    if (!epochs.has(epoch)) epochs.set(epoch, ownerKeys(umk, pageId, epoch));
    return epochs.get(epoch);
  };
  // Keys derive from the UMK and the epoch, so an inbox rotation keeps the older messages readable here.
  const allKeys = [];
  for (let e = page.index.inboxEpoch; e >= 1; e--) allKeys.push(keysFor(e));
  const signPubs = new Set(allKeys.map((k) => hex(k.sign.publicKey)));
  const open = (env) => {
    for (const k of allKeys) {
      const o = openVoiciBody(b64Decode(env.bodyB64), { conv: env.conv, msgId: env.msgId }, k.inbox.seed);
      if (o.ok || o.code !== "no-wrap") return o;
    }
    return { ok: false, code: "no-wrap" };
  };
  const convs = new Map();
  const conv = (id) => {
    if (!convs.has(id)) convs.set(id, { conv: id, pseudonymPub: null, threadPub: null, messages: [] });
    return convs.get(id);
  };
  const seen = new Set();
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.messages) ? body.messages : [];
  for (const item of items) {
    const raw = item?.envelope ?? item;
    const meta = { fetchedAt: typeof item?.fetchedAt === "number" ? item.fetchedAt : null, direct: item?.direct === true };
    if (raw?.kind === "voici-message") {
      const at = typeof raw.sentAt === "number" ? raw.sentAt : 0;
      const m = checkVoiciMessage(raw, { pageId, acceptsMessages: true, origin, caKeys, now: at, revoked });
      if (!m.ok) continue;
      const env = m.envelope;
      if (seen.has(`${env.conv}|${env.msgId}`)) continue;
      const opened = open(env);
      if (!opened.ok) continue;
      seen.add(`${env.conv}|${env.msgId}`);
      const cv = conv(env.conv);
      cv.pseudonymPub = env.from;
      if (!cv.threadAt || m.cred.threadStmt.issuedAt >= cv.threadAt) {
        cv.threadPub = m.cred.threadStmt.threadPub;
        cv.threadAt = m.cred.threadStmt.issuedAt;
      }
      cv.messages.push({ msgId: env.msgId, seq: env.seq, sentAt: env.sentAt, mine: false, text: opened.plaintext.text, envelope: env, ...meta });
    } else if (raw?.kind === "voici-reply") {
      const from = typeof raw.from === "string" && signPubs.has(raw.from) ? raw.from : "";
      const m = checkVoiciReply(raw, { pageId, ownerSignPub: from });
      if (!m.ok) continue;
      const env = m.envelope;
      if (seen.has(`${env.conv}|${env.msgId}`)) continue;
      const opened = open(env);
      if (!opened.ok) continue;
      seen.add(`${env.conv}|${env.msgId}`);
      conv(env.conv).messages.push({ msgId: env.msgId, seq: env.seq, sentAt: env.sentAt, mine: true, text: opened.plaintext.text, envelope: env, ...meta });
    }
  }
  const conversations = [];
  for (const cv of convs.values()) {
    if (!cv.pseudonymPub) continue;
    cv.messages.sort((a, b) => a.sentAt - b.sentAt || (a.msgId < b.msgId ? -1 : 1));
    // A gap in a sender's seq shows "Some messages haven't arrived yet" until it fills (§7.3).
    const theirs = cv.messages.filter((m) => !m.mine).map((m) => m.seq).sort((a, b) => a - b);
    cv.gap = theirs.some((s, i) => s !== i + 1);
    delete cv.threadAt;
    conversations.push(cv);
  }
  conversations.sort((a, b) => lastAt(b) - lastAt(a));
  return { conversations, blocks: [...blocks], revoked: [...revoked], cursor: typeof body?.cursor === "string" ? body.cursor : "" };
}

const lastAt = (cv) => cv.messages[cv.messages.length - 1]?.sentAt ?? 0;

/** A conversation is a request until the owner replied or tapped Accept (§11.1). */
export function isRequest(cv, state) {
  return !cv.messages.some((m) => m.mine) && !state.accepted.includes(cv.conv);
}

/** Unread: the newest message from the visitor is after the read mark. */
export function isUnread(cv, state) {
  const theirs = cv.messages.filter((m) => !m.mine);
  const last = theirs[theirs.length - 1];
  if (!last) return false;
  const mark = state.readUpTo[cv.conv];
  if (!mark) return true;
  const i = cv.messages.findIndex((m) => m.msgId === mark);
  return i < 0 || cv.messages.indexOf(last) > i;
}

/** Signs and posts a reply to one conversation (§7.4). Returns the envelope. */
export async function sendReply(page, cv, text, deps = {}) {
  const c = ctx(deps);
  const umk = umkOf(c);
  const keys = ownerKeys(umk, page.index.pageId, page.index.inboxEpoch);
  if (!cv.threadPub) throw new VoiciError("no-thread-key");
  const msgId = randHex(16);
  const sentAt = c.now();
  const ownerSignPub = hex(keys.sign.publicKey);
  const mine = cv.messages.filter((m) => m.mine && m.envelope.from === ownerSignPub);
  const seq = mine.reduce((n, m) => Math.max(n, m.seq), 0) + 1;
  const body = sealVoiciBody({
    conv: cv.conv,
    msgId,
    sentAt,
    fromPub: ownerSignPub,
    recipients: [hexToBytes(cv.threadPub), keys.inbox.publicKey],
    plaintext: { v: 1, text, replyTo: null },
  });
  const envelope = signWebEnvelopeEd25519(
    { v: 1, kind: "voici-reply", audience: page.index.pageId, conv: cv.conv, from: ownerSignPub, msgId, seq, sentAt, bodyB64: b64Encode(body), cred: { pageSeq: page.index.seq } },
    keys.sign.seed,
  );
  const r = await c.fetch(`${c.apex}/api/voici/web/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope, direct: false }) });
  if (!r.ok) throw await readError(r);
  return envelope;
}

/** The signed `.com` filter for one pseudonym (§9.1). */
export async function postBlock(page, pseudonymPub, op, deps = {}) {
  const c = ctx(deps);
  const keys = ownerKeys(umkOf(c), page.index.pageId, page.index.inboxEpoch);
  const block = { pageId: page.index.pageId, pseudonymPub, op, issuedAt: c.now() };
  const signature = signVoiciBlock(block, keys.sign.seed);
  const r = await c.fetch(`${c.apex}/api/voici/pages/${encodeURIComponent(usernameOf(c))}/block`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block, signature }),
  });
  if (!r.ok) throw await readError(r);
}

/**
 * Reports one message (§9.2). The webapp never attaches the text: sealing it to Flagship's abuse key is not in
 * client code (F), so `attached` is always null here.
 */
export async function postMessageReport(page, envelope, reason, deps = {}) {
  const c = ctx(deps);
  const keys = ownerKeys(umkOf(c), page.index.pageId, page.index.inboxEpoch);
  const report = { kind: "message", pageId: page.index.pageId, envelope, reason, attached: null, issuedAt: c.now() };
  const signature = signVoiciMessageReport(report, keys.sign.seed);
  const r = await c.fetch(`${c.apex}/api/voici/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ report, signature }),
  });
  if (!r.ok) throw await readError(r);
}
