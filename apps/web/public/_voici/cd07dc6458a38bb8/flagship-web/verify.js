// Verify before anything else (docs/voici-and-messages.md §4.2, §7.4, §12.1). Every byte a website gets from
// storage or from `.com` passes through here first: a size cap, then the signature (or the hash the signed index
// names), and only then is it parsed further or shown. A failure yields a code and nothing from the input.
//
//   pageSignerOf(account)                          the key a page index must be signed with, from GET /api/username/<u>
//   verifyPageIndex(input, account, o)             the signed index ({ok, index} | {ok:false, code})
//   pieceRef(index, role)                          the {role, sha256, size} the index lists for a role, or null
//   verifyPiece(bytes, ref)                        bytes are exactly the listed piece (size, then SHA-256)
//   readProfilePiece / readChunkPiece / readImagePiece   verify, then parse, then cross-check with the index
//   loadVoiciPage(o)                               fetch + verify the index and the account key; a reader for pieces
//   localSeqStore(storage?)                        the highest verified seq per pageId (anti-rollback, §2.9)
//   verifyThreadItem(input, ctx)                   one envelope of the visitor's thread: signatures, then decrypt

import {
  VOICI_AVATAR_MAX_BYTES,
  VOICI_CARD_IMAGE_MAX_BYTES,
  VOICI_CHUNK_MAX_BYTES,
  VOICI_INDEX_MAX_BYTES,
  VOICI_PROFILE_MAX_BYTES,
  WEB_ENVELOPE_MAX_BYTES,
  b64Decode,
  canonicalVoiciThreadStatement,
  checkVoiciPageIndex,
  checkVoiciReply,
  checkWebDelegation,
  ed25519VerifyHex,
  isLowerHex,
  isVoiciJpeg,
  openVoiciBody,
  parseVoiciChunkPiece,
  parseVoiciProfilePiece,
  parseVoiciThreadStatement,
  parseWebEnvelope,
  sha256Hex,
  verifyWebEnvelopeSignature,
  voiciConv,
} from "./proto/lib/voiciProtocol.js";

const USERNAME = /^[a-z0-9](?:-?[a-z0-9]){0,31}$/;
const dec = (b) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);

/** The page signer the account pins: its admin root, else its IRK (the sensitive-key rule, §1). */
export function pageSignerOf(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)) return null;
  if (isLowerHex(account.adminRootPub, 32)) return { kind: "admin-root", pub: account.adminRootPub };
  if (account.adminRootPub == null && isLowerHex(account.irkPub, 32)) return { kind: "irk", pub: account.irkPub };
  return null;
}

/**
 * input: the index as bytes, text or a parsed value. account: GET /api/username/<u>.
 * o = {username, highestSeenSeq?, pageId?}. Codes: too-large, malformed, no-account, wrong-username,
 * not-sensitive-key, bad-signature, wrong-page, rolled-back.
 */
export function verifyPageIndex(input, account, o) {
  let v = input;
  if (input instanceof Uint8Array || typeof input === "string") {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    if (bytes.length > VOICI_INDEX_MAX_BYTES) return { ok: false, code: "too-large" };
    try {
      v = JSON.parse(dec(bytes));
    } catch {
      return { ok: false, code: "malformed" };
    }
  }
  if (!USERNAME.test(o.username)) return { ok: false, code: "malformed" };
  const signer = pageSignerOf(account);
  if (!signer || account.username !== o.username) return { ok: false, code: "no-account" };
  return checkVoiciPageIndex(v, {
    username: o.username,
    sensitiveKind: signer.kind,
    sensitivePub: signer.pub,
    ...(o.highestSeenSeq != null ? { highestSeenSeq: o.highestSeenSeq } : {}),
    ...(o.pageId !== undefined ? { pageId: o.pageId } : {}),
  });
}

export function pieceRef(index, role) {
  return index.pieces.find((p) => p.role === role) ?? null;
}

export function pieceRefBySha(index, sha256) {
  return index.pieces.find((p) => p.sha256 === sha256) ?? null;
}

/** The number of post chunks the index lists (chunk-0 … chunk-(n-1), contiguous by the index rules). */
export function chunkCount(index) {
  return index.pieces.filter((p) => p.role.startsWith("chunk-")).length;
}

export function verifyPiece(bytes, ref) {
  return !!ref && bytes instanceof Uint8Array && bytes.length === ref.size && sha256Hex(bytes) === ref.sha256;
}

/** The profile piece: hash first, then the strict schema, then its avatar must be the index's avatar piece. */
export function readProfilePiece(bytes, index) {
  const ref = pieceRef(index, "profile");
  if (!ref || bytes.length > VOICI_PROFILE_MAX_BYTES || !verifyPiece(bytes, ref)) return null;
  const profile = parseVoiciProfilePiece(bytes);
  if (!profile) return null;
  if ((profile.avatar ?? null) !== (pieceRef(index, "avatar")?.sha256 ?? null)) return null;
  return profile;
}

/** Chunk n: hash, schema, and every card image it names must be a card piece of the index. */
export function readChunkPiece(bytes, index, n) {
  const ref = pieceRef(index, `chunk-${n}`);
  if (!ref || bytes.length > VOICI_CHUNK_MAX_BYTES || !verifyPiece(bytes, ref)) return null;
  const chunk = parseVoiciChunkPiece(bytes, n);
  if (!chunk) return null;
  for (const p of chunk.posts) {
    for (const l of p.links) {
      const img = l.card?.image;
      if (img && pieceRef(index, `card-${img.slice(0, 16)}`)?.sha256 !== img) return null;
    }
  }
  return chunk;
}

/** A JPEG piece (avatar or card image): listed, size cap by role, hash, JPEG magic. */
export function readImagePiece(bytes, index, sha256) {
  const ref = pieceRefBySha(index, sha256);
  if (!ref || (ref.role !== "avatar" && !ref.role.startsWith("card-"))) return null;
  const cap = ref.role === "avatar" ? VOICI_AVATAR_MAX_BYTES : VOICI_CARD_IMAGE_MAX_BYTES;
  if (bytes.length > cap || !verifyPiece(bytes, ref) || !isVoiciJpeg(bytes)) return null;
  return bytes;
}

/** Highest verified index seq per pageId, in localStorage (or the given Storage). */
export function localSeqStore(storage = globalThis.localStorage) {
  const key = (pageId) => `flagship-web:voici-seq:${pageId}`;
  return {
    get(pageId) {
      try {
        const n = Number(storage?.getItem(key(pageId)));
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
    set(pageId, seq) {
      try {
        const cur = this.get(pageId);
        if (cur === null || seq > cur) storage?.setItem(key(pageId), String(seq));
      } catch {
        /* private mode: the check simply has no memory */
      }
    },
  };
}

/** Reads a response body with a hard cap, so a hostile server can't make the page buffer gigabytes. */
export async function readCapped(res, cap) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!res.body || typeof res.body.getReader !== "function") {
    const b = new Uint8Array(await res.arrayBuffer());
    return b.length > cap ? null : b;
  }
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const NO_CREDS = { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors" };

/**
 * Fetch and verify a page (§4.2): the signed index from files (`<filesBase>/v1/u/<u>.json`) and the account's keys
 * from `.com` (`<apiBase>/api/username/<u>`) in parallel; check the signature and the seq against `seqStore`.
 * o = {username, filesBase, apiBase, fetch?, seqStore?}. Answers {ok:true, index, reader} or {ok:false, code} with
 * code not-found | unavailable | too-large | malformed | no-account | wrong-username | not-sensitive-key |
 * bad-signature | rolled-back. `reader` fetches pieces under the index and verifies each before returning it.
 */
export async function loadVoiciPage(o) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  if (!USERNAME.test(o.username)) return { ok: false, code: "not-found" };
  let idxRes;
  let accRes;
  try {
    [idxRes, accRes] = await Promise.all([
      f(`${o.filesBase}/v1/u/${o.username}.json`, { ...NO_CREDS }),
      f(`${o.apiBase}/api/username/${o.username}`, { ...NO_CREDS, headers: { accept: "application/json" } }),
    ]);
  } catch {
    return { ok: false, code: "unavailable" };
  }
  if (idxRes.status === 404 || accRes.status === 404) return { ok: false, code: "not-found" };
  if (!idxRes.ok || !accRes.ok) return { ok: false, code: "unavailable" };
  const idxBytes = await readCapped(idxRes, VOICI_INDEX_MAX_BYTES);
  if (!idxBytes) return { ok: false, code: "too-large" };
  const accBytes = await readCapped(accRes, 16 * 1024);
  let account = null;
  try {
    account = accBytes ? JSON.parse(dec(accBytes)) : null;
  } catch {
    account = null;
  }
  const seqStore = o.seqStore ?? localSeqStore();
  let peek = null;
  try {
    peek = JSON.parse(dec(idxBytes));
  } catch {
    return { ok: false, code: "malformed" };
  }
  const seen = typeof peek?.pageId === "string" ? seqStore.get(peek.pageId) : null;
  const r = verifyPageIndex(peek, account, { username: o.username, ...(seen !== null ? { highestSeenSeq: seen } : {}) });
  if (!r.ok) return r;
  seqStore.set(r.index.pageId, r.index.seq);
  return { ok: true, index: r.index, reader: pieceReader(r.index, o.filesBase, f) };
}

/** Fetches pieces of one verified index; every method verifies before it returns, and returns null on any failure. */
export function pieceReader(index, filesBase, f = globalThis.fetch.bind(globalThis)) {
  const cache = new Map();
  const get = (ref, cap) => {
    if (!ref) return Promise.resolve(null);
    if (!cache.has(ref.sha256)) {
      cache.set(
        ref.sha256,
        (async () => {
          try {
            const res = await f(`${filesBase}/v1/p/${index.pageId}/${ref.sha256}`, { ...NO_CREDS });
            if (!res.ok) return null;
            return await readCapped(res, Math.min(cap, ref.size));
          } catch {
            return null;
          }
        })(),
      );
    }
    return cache.get(ref.sha256);
  };
  return {
    async profile() {
      const b = await get(pieceRef(index, "profile"), VOICI_PROFILE_MAX_BYTES);
      return b ? readProfilePiece(b, index) : null;
    },
    chunkCount: () => chunkCount(index),
    async chunk(n) {
      const b = await get(pieceRef(index, `chunk-${n}`), VOICI_CHUNK_MAX_BYTES);
      return b ? readChunkPiece(b, index, n) : null;
    },
    async image(sha256) {
      const ref = pieceRefBySha(index, sha256);
      const b = await get(ref, ref?.role === "avatar" ? VOICI_AVATAR_MAX_BYTES : VOICI_CARD_IMAGE_MAX_BYTES);
      return b ? readImagePiece(b, index, sha256) : null;
    },
  };
}

/**
 * One item of the visitor's own thread (§7.3, §7.4): checked, then opened with the thread key T.
 * ctx = {pageId, ownerSignPub, pseudonymPub, threadSeed (bytes), origin}. A visitor message must be by P through a
 * delegation P signed for this origin and page (valid at its sentAt), signed by that delegation's browser key; a reply
 * must be by the page's current ownerSignPub. Freshness is not checked (history). Answers
 * {ok:true, mine, envelope, plaintext} | {ok:false, code}.
 */
export function verifyThreadItem(input, ctx) {
  if (typeof input === "string" && input.length > WEB_ENVELOPE_MAX_BYTES) return { ok: false, code: "too-large" };
  const env = parseWebEnvelope(input);
  if (!env) return { ok: false, code: "malformed" };
  if (env.audience !== ctx.pageId) return { ok: false, code: "wrong-audience" };
  const conv = voiciConv(ctx.pageId, ctx.pseudonymPub);
  if (env.conv !== conv) return { ok: false, code: "wrong-conv" };
  let mine;
  if (env.kind === "voici-message") {
    if (env.sigAlg !== "p256" || env.from !== ctx.pseudonymPub) return { ok: false, code: "bad-signature" };
    const c = env.cred;
    const del = checkWebDelegation(c.delegation, c.delegationSig, {
      scope: "voici-messages",
      origin: ctx.origin,
      audience: ctx.pageId,
      principalPub: ctx.pseudonymPub,
      now: env.sentAt,
    });
    if (!del.ok) return { ok: false, code: "bad-delegation" };
    const ts = parseVoiciThreadStatement(c.threadStmt);
    if (!ts || ts.pageId !== ctx.pageId || ts.pseudonymPub !== ctx.pseudonymPub) return { ok: false, code: "bad-thread" };
    if (!ed25519VerifyHex(c.threadSig, canonicalVoiciThreadStatement(ts), ctx.pseudonymPub)) return { ok: false, code: "bad-thread" };
    if (!verifyWebEnvelopeSignature(env, del.delegation.delegatePub)) return { ok: false, code: "bad-signature" };
    mine = true;
  } else if (env.kind === "voici-reply") {
    const r = checkVoiciReply(env, { pageId: ctx.pageId, ownerSignPub: ctx.ownerSignPub, conv });
    if (!r.ok) return r;
    mine = false;
  } else {
    return { ok: false, code: "wrong-kind" };
  }
  const opened = openVoiciBody(b64Decode(env.bodyB64), { conv, msgId: env.msgId }, ctx.threadSeed);
  if (!opened.ok) return opened;
  return { ok: true, mine, envelope: env, plaintext: opened.plaintext };
}
