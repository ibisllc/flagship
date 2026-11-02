#!/usr/bin/env -S npx tsx
/**
 * Writes the shared vectors for voi.ci pages and Messages (docs/voici-and-messages.md) from the TypeScript
 * implementation in packages/protocol/src (voiciPage.ts, voiciMessages.ts, webEnvelope.ts, webDelegation.ts,
 * messagesAttestation.ts, voiciText.ts, voiciPseudonymName.ts, phoneRoute.ts):
 *
 *   packages/protocol/test-vectors/voici/vectors.json     text rules, links, sites, names, pieces, the index and
 *                                                          its refusals, piece upload, chunking, the merge
 *   packages/protocol/test-vectors/messages/vectors.json  derivations, canonical JSON, base64, attestation and
 *                                                          abuse tag, delegation, thread statement, message / reply
 *                                                          / draft envelopes and every refusal, open, ack, block,
 *                                                          thread fetch, revoke, state blob, reports, sign-in, the
 *                                                          phone endpoint's web policy
 *
 *   npx tsx tools/voici-vectors.ts          write
 *   npx tsx tools/voici-vectors.ts --check  fail when either file is stale
 *
 * Every case carries the expected answer and the generator stops when the TypeScript answer differs, so a negative
 * vector can never silently turn into an accepting one. All randomness is fixed (seeds of one repeated byte); P-256
 * signatures are RFC 6979 (deterministic) here, so ports verify them rather than reproduce them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import * as P from "../packages/protocol/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT_VOICI = resolve(ROOT, "packages/protocol/test-vectors/voici/vectors.json");
const OUT_MESSAGES = resolve(ROOT, "packages/protocol/test-vectors/messages/vectors.json");

const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const enc = new TextEncoder();
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
function want<T>(name: string, got: T, expected: T): T {
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  return got;
}
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code!);

// ── fixed keys ─────────────────────────────────────────────────────────────

const ownerUmk = { seed: fill(32, 0x11) };
const visitorUmk = { seed: fill(32, 0x22) };
const adminRootSeed = fill(32, 0x33);
const adminRootPub = H(P.ed.getPublicKey(adminRootSeed));
const irkSeed = fill(32, 0x34);
const caSeed = fill(32, 0x44);
const caPub = H(P.ed.getPublicKey(caSeed));
const caTrackSeed = fill(32, 0x45);
const abuseSeed = fill(32, 0x55);
const abusePub = P.hybridSealKeygen(abuseSeed).publicKey;
const browserPriv = fill(32, 0x66);
const browserPub = H(p256.getPublicKey(browserPriv, false));
const otherBrowserPriv = fill(32, 0x67);
const otherBrowserPub = H(p256.getPublicKey(otherBrowserPriv, false));
const deviceSeed = fill(32, 0x77);
const devicePub = H(P.ed.getPublicKey(deviceSeed));
const phoneRouteSeed = fill(32, 0x78);
const phoneRoutePub = H(P.ed.getPublicKey(phoneRouteSeed));
const USER = "alice";
const VISITOR = "bob";
const PAGE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const OTHER_PAGE = "aa".repeat(16);
const EPOCH = 1;
const ORIGIN = P.VOICI_WEB_ORIGIN;

const inbox = P.deriveVoiciInboxKey(ownerUmk, PAGE_ID, EPOCH);
const ownerSign = P.deriveVoiciOwnerSignKey(ownerUmk, PAGE_ID, EPOCH);
const msecret = P.deriveMessagesSecret(visitorUmk);
const pseud = P.deriveMessagesPseudonymKey(msecret, PAGE_ID);
const thread = P.deriveMessagesThreadKey(msecret, PAGE_ID);
const PPUB = H(pseud.publicKey);
const TPUB = H(thread.publicKey);
const CONV = P.voiciConv(PAGE_ID, PPUB);
const draftsKey = P.deriveVoiciDraftsKey(ownerUmk);
const stateKey = P.deriveMessagesStateKey(ownerUmk);

// ═════════════════════════════════════ voici ═════════════════════════════════════

const textCases = (
  [
    ["displayName", "Alice", "ok"],
    ["displayName", "", "too-short"],
    ["displayName", "a".repeat(64), "ok"],
    ["displayName", "a".repeat(65), "too-long"],
    ["displayName", "😀".repeat(64), "ok"],
    ["displayName", "Line\nbreak", "control"],
    ["bio", "Line\nbreak", "ok"],
    ["bio", "tab\there", "control"],
    ["bio", "del\u007f", "control"],
    ["bio", "c1\u0085", "control"],
    ["bio", "rtl ‮evil", "bidi"],
    ["bio", "iso ⁧x", "bidi"],
    ["bio", "bom﻿", "bom"],
    ["bio", "​start", "edge-invisible"],
    ["bio", "end‍", "edge-invisible"],
    ["bio", "mid‍dle", "ok"],
    ["bio", "é", "not-nfc"],
    ["bio", "é", "ok"],
    ["bio", "lone \uD800", "surrogate"],
    ["messageText", "x".repeat(2000), "ok"],
    ["messageText", "x".repeat(2001), "too-long"],
    ["messageText", "", "too-short"],
    ["linkLabel", "a".repeat(41), "too-long"],
    ["nickname", "Mum", "ok"],
    ["reportNote", "", "ok"],
  ] as [P.VoiciTextField, string, string][]
).map(([field, input, expected]) => ({ field, input, expected: want(`text ${field} ${JSON.stringify(input)}`, P.checkVoiciText(field, input) ?? "ok", expected) }));

const prepareCases = [
  ["bio", "é"],
  ["displayName", "Amélie"],
  ["bio", "‮"],
].map(([field, input]) => {
  const r = P.prepareVoiciText(field as P.VoiciTextField, input!);
  return { field, input, expected: r.ok ? { ok: true, text: r.text } : { ok: false, code: r.code } };
});

const urlCases = (
  [
    ["https://github.com/alice", false, null],
    ["https://example.com", false, null],
    ["https://example.com:8443/x?y=1#z", false, null],
    ["https://xn--bcher-kva.example/", false, null],
    ["http://example.com", false, "scheme"],
    ["javascript:alert(1)", false, "scheme"],
    ["https://user@example.com/", false, "malformed"],
    ["https://Example.com/", false, "malformed"],
    ["https://example/", false, "malformed"],
    ["https://exa mple.com/", false, "malformed"],
    ["https://example.com/<script>", false, "malformed"],
    ["https://example.com:0/", false, "malformed"],
    ["https://bücher.example/", false, "malformed"],
    ["mailto:alice@example.com", true, null],
    ["mailto:alice@example.com", false, "scheme"],
    ["mailto:alice@", true, "malformed"],
    ["https://example.com/" + "a".repeat(492), false, null],
    ["https://example.com/" + "a".repeat(493), false, "too-long"],
  ] as [string, boolean, string | null][]
).map(([url, allowMailto, expected]) => ({ url, allowMailto, expected: want(`url ${url}`, P.checkVoiciLinkUrl(url, allowMailto), expected) }));

const linkTexts = [
  "see https://example.com/a). ok",
  "HTTPS://Example.COM/Path and https://b.example",
  "no link: https://u@evil.com/x or https://evil.com:8080/",
  "xhttps://glued.example no",
  "end https://example.com.",
  "https://a.example/?q=1&r=2#frag, https://single",
  "(https://wrapped.example/path)",
  "bare http://plain.example and ftp://x.example",
].map((text) => ({ text, matches: P.findVoiciLinks(text) }));

const siteCases = [
  "https://github.com/alice",
  "https://gist.github.com/alice",
  "https://notgithub.com/alice",
  "https://www.youtube.com/@alice",
  "https://youtu.be/xyz",
  "https://x.com/alice",
  "https://box.com/alice",
  "https://mastodon.social/@alice",
  "https://fosstodon.org/@alice",
  "https://fosstodon.org/@alice@other.example",
  "https://example.com/users/alice",
  "https://notes.alice.flagship.services/",
  "mailto:alice@example.com",
  "http://github.com/alice",
].map((url) => ({ url, site: P.voiciLinkSite(url) }));
want("site github", siteCases[0]!.site, "github");
want("site mastodon path", siteCases[8]!.site, "mastodon");

const pseudonymNames = [PPUB, "00".repeat(32), "ff".repeat(32)].map((pub) => ({ pub, code: P.voiciPseudonymCode(pub), name: P.voiciPseudonymName(pub) }));
const namespaceKeys = ["Alice", "halloween-party", "a-b-c-d"].map((name) => ({ name, key: P.voiciNamespaceKey(name) }));

// JPEGs: SOI, an optional APPn segment, SOS, EOI (not decodable, enough for the magic and segment checks)
const jpegPlain = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const jpegExif = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x45, 0x78, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const jpegIcc = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xe2, 0x00, 0x02, 0xff, 0xd9]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegs = [
  ["plain", jpegPlain],
  ["exif", jpegExif],
  ["icc", jpegIcc],
  ["png", png],
].map(([name, b]) => ({ name, hex: H(b as Uint8Array), isJpeg: P.isVoiciJpeg(b as Uint8Array), hasMetadata: P.voiciJpegHasMetadata(b as Uint8Array) }));
want("exif metadata", jpegs[1]!.hasMetadata, true);

// pieces
const avatar = jpegPlain;
const cardImg = Uint8Array.from([...jpegPlain.slice(0, 14), 0x33, 0x44, 0xff, 0xd9]);
const avatarSha = P.sha256Hex(avatar);
const cardSha = P.sha256Hex(cardImg);
const profile: P.VoiciProfile = {
  v: 1,
  displayName: "Alice Martin",
  bio: "Gardener.\nBuilds things with Flagship. Café owner.",
  avatar: avatarSha,
  theme: "classic",
  links: [
    { url: "https://github.com/alice", label: "Code", site: "github" },
    { url: "https://fosstodon.org/@alice", label: "Toots", site: "mastodon" },
    { url: "mailto:alice@example.com", label: "Mail", site: "email" },
  ],
};
const posts: P.VoiciPost[] = Array.from({ length: 22 }, (_, i) => ({
  id: (i + 1).toString(16).padStart(32, "0"),
  createdAt: T0 - (30 - i) * DAY,
  editedAt: i === 3 ? T0 - 2 * DAY : null,
  text: i === 0 ? "First post! «Bonjour» — see https://example.com" : `Post number ${i + 1}`,
  links:
    i === 21
      ? [{ url: "https://example.com/article", card: { title: "An article", site: "Example", description: "What it says.", image: cardSha } }]
      : i === 0
        ? [{ url: "https://example.com", card: null }]
        : [],
}));
const chunkPosts = P.chunkVoiciPosts(posts);
want("two chunks", chunkPosts.map((c) => c.length), [20, 2]);
const profileBytes = P.canonicalJsonBytes(profile);
const chunkBytes = chunkPosts.map((c, n) => P.canonicalJsonBytes({ v: 1, chunk: n, posts: c }));
if (!P.parseVoiciProfilePiece(profileBytes)) throw new Error("profile piece");
chunkBytes.forEach((b, n) => {
  if (!P.parseVoiciChunkPiece(b, n)) throw new Error(`chunk ${n}`);
});

const badProfiles: [string, unknown][] = [
  ["extra key", { ...profile, extra: 1 }],
  ["missing theme", (({ theme: _t, ...r }) => r)(profile)],
  ["unknown theme", { ...profile, theme: "neon" }],
  ["display name too long", { ...profile, displayName: "a".repeat(65) }],
  ["bidi in bio", { ...profile, bio: "x‮y" }],
  ["http link", { ...profile, links: [{ url: "http://a.example", label: "A", site: null }] }],
  ["two mail links", { ...profile, links: [profile.links[2], { ...profile.links[2], label: "Mail 2" }] }],
  ["unknown site id", { ...profile, links: [{ ...profile.links[0], site: "myspace" }] }],
  ["13 links", { ...profile, links: Array.from({ length: 13 }, (_, i) => ({ url: `https://a${i}.example`, label: "L", site: null })) }],
  ["avatar not a hash", { ...profile, avatar: "abc" }],
  ["version 2", { ...profile, v: 2 }],
];
const profilePieces = [
  { name: "valid", text: new TextDecoder().decode(profileBytes), expected: true },
  { name: "not canonical (whitespace)", text: JSON.stringify(profile, null, 1), expected: false },
  { name: "not canonical (key order)", text: JSON.stringify(profile), expected: false },
  { name: "leading byte-order mark", text: "\uFEFF" + new TextDecoder().decode(profileBytes), expected: false },
  ...badProfiles.map(([name, v]) => ({ name, text: P.canonicalJson(v), expected: false })),
].map((c) => ({ ...c, expected: want(`profile ${c.name}`, P.parseVoiciProfilePiece(enc.encode(c.text)) !== null, c.expected) }));

const badChunks: [string, unknown, number][] = [
  ["wrong chunk number", { v: 1, chunk: 1, posts: chunkPosts[0] }, 0],
  ["21 posts", { v: 1, chunk: 0, posts: [...chunkPosts[0]!, posts[21]] }, 0],
  ["duplicate post id", { v: 1, chunk: 0, posts: [posts[0], posts[0]] }, 0],
  ["post text empty", { v: 1, chunk: 0, posts: [{ ...posts[1], text: "" }] }, 0],
  ["4 links", { v: 1, chunk: 0, posts: [{ ...posts[1], links: [1, 2, 3, 4].map((i) => ({ url: `https://a${i}.example`, card: null })) }] }, 0],
  ["card title too long", { v: 1, chunk: 0, posts: [{ ...posts[21], links: [{ url: "https://e.example", card: { title: "t".repeat(121), site: "", description: "", image: null } }] }] }, 0],
  ["mailto in a post", { v: 1, chunk: 0, posts: [{ ...posts[1], links: [{ url: "mailto:a@b.example", card: null }] }] }, 0],
];
const chunkPieces = [
  { name: "chunk 0", n: 0, text: new TextDecoder().decode(chunkBytes[0]), expected: true },
  { name: "chunk 1", n: 1, text: new TextDecoder().decode(chunkBytes[1]), expected: true },
  ...badChunks.map(([name, v, n]) => ({ name, n, text: P.canonicalJson(v), expected: false })),
].map((c) => ({ ...c, expected: want(`chunk ${c.name}`, P.parseVoiciChunkPiece(enc.encode(c.text), c.n) !== null, c.expected) }));

const pieces: P.VoiciPieceRef[] = [
  { role: "profile", sha256: P.sha256Hex(profileBytes), size: profileBytes.length },
  { role: "avatar", sha256: avatarSha, size: avatar.length },
  ...chunkBytes.map((b, n) => ({ role: `chunk-${n}`, sha256: P.sha256Hex(b), size: b.length })),
  { role: P.voiciCardRole(cardSha), sha256: cardSha, size: cardImg.length },
];
const indexBody = {
  username: USER,
  pageId: PAGE_ID,
  seq: 7,
  issuedAt: T0,
  acceptsMessages: 1 as const,
  inboxEpoch: EPOCH,
  inboxPub: H(inbox.publicKey),
  ownerSignPub: H(ownerSign.publicKey),
  pieces,
  signerKind: "admin-root" as const,
};
const index = P.signVoiciPageIndex(indexBody, adminRootSeed);
const parsedChunks = chunkBytes.map((b, n) => P.parseVoiciChunkPiece(b, n)!);
want("piece refs", P.voiciPieceRefsOk(index, profile, parsedChunks), true);
const reSign = (mut: (b: Record<string, unknown>) => void, seed = adminRootSeed) => {
  const b = clone(indexBody) as unknown as Record<string, unknown>;
  mut(b);
  return P.signVoiciPageIndex(b as never, seed);
};
const tamper = (mut: (b: Record<string, unknown>) => void) => {
  const b = clone(index) as unknown as Record<string, unknown>;
  mut(b);
  return b;
};
const readerCtx = { username: USER, sensitiveKind: "admin-root" as const, sensitivePub: adminRootPub };
const indexChecks = (
  [
    ["valid", index, readerCtx, "ok"],
    ["valid, seen an older seq", index, { ...readerCtx, highestSeenSeq: 6 }, "ok"],
    ["valid, seen the same seq", index, { ...readerCtx, highestSeenSeq: 7 }, "ok"],
    ["rolled back below a seen seq", index, { ...readerCtx, highestSeenSeq: 8 }, "rolled-back"],
    ["another username asked for", index, { ...readerCtx, username: "carol" }, "wrong-username"],
    ["signed by the IRK on an admin-root account", reSign((b) => (b.signerKind = "irk"), irkSeed), readerCtx, "not-sensitive-key"],
    ["signed by another key claiming admin-root", reSign(() => {}, irkSeed), readerCtx, "not-sensitive-key"],
    ["IRK account, IRK signer", reSign((b) => (b.signerKind = "irk"), irkSeed), { ...readerCtx, sensitiveKind: "irk", sensitivePub: H(P.ed.getPublicKey(irkSeed)) }, "ok"],
    ["seq tampered", tamper((b) => (b.seq = 8)), readerCtx, "bad-signature"],
    ["acceptsMessages tampered", tamper((b) => (b.acceptsMessages = 0)), readerCtx, "bad-signature"],
    ["piece hash tampered", tamper((b) => ((b.pieces as P.VoiciPieceRef[])[0]!.sha256 = "00".repeat(32))), readerCtx, "bad-signature"],
    ["inbox key swapped", tamper((b) => (b.inboxPub = H(P.deriveVoiciInboxKey(visitorUmk, PAGE_ID, 1).publicKey))), readerCtx, "bad-signature"],
    ["pieces not sorted", tamper((b) => (b.pieces as P.VoiciPieceRef[]).reverse()), readerCtx, "malformed"],
    ["no profile piece", tamper((b) => (b.pieces = (b.pieces as P.VoiciPieceRef[]).filter((p) => p.role !== "profile"))), readerCtx, "malformed"],
    ["chunks not contiguous", tamper((b) => (b.pieces = (b.pieces as P.VoiciPieceRef[]).filter((p) => p.role !== "chunk-0"))), readerCtx, "malformed"],
    ["card role not its hash", tamper((b) => ((b.pieces as P.VoiciPieceRef[]).find((p) => p.role.startsWith("card-"))!.role = "card-0000000000000000")), readerCtx, "malformed"],
    ["avatar over 150 KiB", tamper((b) => ((b.pieces as P.VoiciPieceRef[]).find((p) => p.role === "avatar")!.size = 150 * 1024 + 1)), readerCtx, "malformed"],
    ["unknown role", tamper((b) => ((b.pieces as P.VoiciPieceRef[])[0]!.role = "script")), readerCtx, "malformed"],
    ["acceptsMessages true not 1", tamper((b) => (b.acceptsMessages = true)), readerCtx, "malformed"],
    ["seq 0", tamper((b) => (b.seq = 0)), readerCtx, "malformed"],
    ["extra key", tamper((b) => (b.html = "<b>")), readerCtx, "malformed"],
    ["username with a separator", tamper((b) => (b.username = "al|ce")), readerCtx, "malformed"],
  ] as [string, unknown, Parameters<typeof P.checkVoiciPageIndex>[1], string][]
).map(([name, idx, ctx, expected]) => ({ name, index: idx, ctx, expected: want(`index ${name}`, code(P.checkVoiciPageIndex(idx, ctx)), expected) }));

const pubCtx = { ...readerCtx, storedSeq: 6, storedPageId: PAGE_ID, now: T0 + 60_000 };
const publishChecks = (
  [
    ["next seq", index, pubCtx, "ok"],
    ["first publish", reSign((b) => (b.seq = 1)), { ...pubCtx, storedSeq: 0, storedPageId: null }, "ok"],
    ["same seq again", index, { ...pubCtx, storedSeq: 7 }, "seq-conflict"],
    ["skips a seq", index, { ...pubCtx, storedSeq: 5 }, "seq-conflict"],
    ["issued 11 minutes ago", index, { ...pubCtx, now: T0 + 11 * 60_000 }, "stale"],
    ["issued 11 minutes ahead", index, { ...pubCtx, now: T0 - 11 * 60_000 }, "stale"],
    ["another pageId than stored", index, { ...pubCtx, storedPageId: OTHER_PAGE }, "wrong-page"],
    ["not the sensitive key", index, { ...pubCtx, sensitivePub: devicePub }, "not-sensitive-key"],
  ] as [string, unknown, Parameters<typeof P.checkVoiciPublish>[1], string][]
).map(([name, idx, ctx, expected]) => ({ name, index: idx, ctx, expected: want(`publish ${name}`, code(P.checkVoiciPublish(idx, ctx)), expected) }));

const upload = { username: USER, pageId: PAGE_ID, sha256: avatarSha, size: avatar.length, issuedAt: T0 };
const uploadSig = P.signVoiciPieceUpload(upload, adminRootSeed);
const uploadCases = [
  { name: "valid", upload, signature: uploadSig, expected: true },
  { name: "size changed", upload: { ...upload, size: avatar.length + 1 }, signature: uploadSig, expected: false },
  { name: "another page", upload: { ...upload, pageId: OTHER_PAGE }, signature: uploadSig, expected: false },
].map((c) => ({ ...c, expected: want(`upload ${c.name}`, P.verifyVoiciPieceUpload(c.upload, c.signature, adminRootPub), c.expected) }));

// merge
const op = (o: Partial<P.VoiciDraftOp> & { op: P.VoiciDraftOp["op"]; at: number; opId: string }): P.VoiciDraftOp => ({ v: 1, deviceId: "device-2", ...o }) as P.VoiciDraftOp;
const published: P.VoiciPageState = { profile, acceptsMessages: 1, chunks: chunkPosts, issuedAt: T0 };
const newPost = (n: number, at: number, text = `Draft ${n}`): P.VoiciPost => ({ id: (0x100 + n).toString(16).padStart(32, "0"), createdAt: at, editedAt: null, text, links: [] });
const small: P.VoiciPageState = { profile, acceptsMessages: 0, chunks: [[posts[0]!, posts[1]!]], issuedAt: T0 };
const mergeCases = [
  { name: "add to a full last chunk opens a new one", published: { ...published, chunks: [chunkPosts[0]!] }, ops: [op({ opId: "01".repeat(16), op: "post-add", at: T0 + 1, post: newPost(1, T0 + 1) })] },
  { name: "add to the last chunk", published, ops: [op({ opId: "01".repeat(16), op: "post-add", at: T0 + 1, post: newPost(1, T0 + 1) })] },
  { name: "delete beats an edit", published: small, ops: [op({ opId: "02".repeat(16), op: "post-delete", at: T0 + 1, postId: posts[1]!.id }), op({ opId: "03".repeat(16), op: "post-edit", at: T0 + 2, post: { ...posts[1]!, editedAt: T0 + 2, text: "edited" } })] },
  { name: "older edit loses", published: { ...small, chunks: [[posts[0]!, posts[3]!]] }, ops: [op({ opId: "04".repeat(16), op: "post-edit", at: T0 + 1, post: { ...posts[3]!, editedAt: T0 - 3 * DAY, text: "older" } })] },
  { name: "newer edit wins", published: small, ops: [op({ opId: "05".repeat(16), op: "post-edit", at: T0 + 5, post: { ...posts[1]!, editedAt: T0 + 5, text: "newer" } })] },
  { name: "profile before the publish loses, after wins", published: small, ops: [op({ opId: "06".repeat(16), op: "profile", at: T0 - 1, profile: { ...profile, displayName: "Old" } }), op({ opId: "07".repeat(16), op: "profile", at: T0 + 1, profile: { ...profile, displayName: "New" } })] },
  { name: "accept messages, ops in at order", published: small, ops: [op({ opId: "09".repeat(16), op: "accept-messages", at: T0 + 9, accepts: 0 }), op({ opId: "08".repeat(16), op: "accept-messages", at: T0 + 8, accepts: 1 })] },
  { name: "two adds keep creation order", published: small, ops: [op({ opId: "0b".repeat(16), op: "post-add", at: T0 + 2, post: newPost(2, T0 + 2) }), op({ opId: "0a".repeat(16), op: "post-add", at: T0 + 3, post: newPost(3, T0 - 40 * DAY) })] },
].map((c) => {
  for (const o of c.ops) if (!P.parseVoiciDraftOp(o)) throw new Error(`merge op ${c.name}`);
  return { ...c, expected: P.mergeVoiciPage(c.published, c.ops) };
});
want("delete beats edit", mergeCases[2]!.expected.chunks, [[posts[0]!]]);

const voici = {
  description:
    "voi.ci page vectors (docs/voici-and-messages.md §2-§5), produced by packages/protocol/src. Generated by tools/voici-vectors.ts; do not edit. Seeds are test-only (32 bytes of one value). Text lengths count code points after NFC. `expected` is \"ok\" or the refusal code the TypeScript returns.",
  t0: T0,
  keys: { adminRootSeed: H(adminRootSeed), adminRootPub, irkSeed: H(irkSeed), irkPub: H(P.ed.getPublicKey(irkSeed)), ownerUmk: H(ownerUmk.seed) },
  constants: {
    profileMaxBytes: P.VOICI_PROFILE_MAX_BYTES,
    chunkMaxBytes: P.VOICI_CHUNK_MAX_BYTES,
    chunkMaxPosts: P.VOICI_CHUNK_MAX_POSTS,
    avatarMaxBytes: P.VOICI_AVATAR_MAX_BYTES,
    cardImageMaxBytes: P.VOICI_CARD_IMAGE_MAX_BYTES,
    indexMaxBytes: P.VOICI_INDEX_MAX_BYTES,
    indexMaxPieces: P.VOICI_INDEX_MAX_PIECES,
    indexSkewMs: P.VOICI_INDEX_SKEW_MS,
    linkUrlMax: P.VOICI_LINK_URL_MAX,
    textRules: P.VOICI_TEXT_RULES,
  },
  text: { check: textCases, prepare: prepareCases },
  linkUrls: urlCases,
  linkMatches: linkTexts,
  linkSites: { table: P.VOICI_LINK_SITES, cases: siteCases },
  pseudonymNames,
  namespaceKeys,
  jpegs,
  pieces: {
    avatarHex: H(avatar),
    cardImageHex: H(cardImg),
    profile,
    profileText: new TextDecoder().decode(profileBytes),
    chunkTexts: chunkBytes.map((b) => new TextDecoder().decode(b)),
    profileCases: profilePieces,
    chunkCases: chunkPieces,
  },
  index: {
    body: indexBody,
    canonical: new TextDecoder().decode(P.canonicalVoiciPageIndex(index)),
    signed: index,
    pieceRefsOk: true,
    checks: indexChecks,
    publishChecks,
  },
  pieceUpload: { canonical: new TextDecoder().decode(P.canonicalVoiciPieceUpload(upload)), signerPub: adminRootPub, cases: uploadCases },
  chunking: { posts: posts.map((p) => p.id), chunks: chunkPosts.map((c) => c.map((p) => p.id)) },
  merge: mergeCases,
};


// ═════════════════════════════════════ messages ═════════════════════════════════════

const derivations = {
  ownerUmk: H(ownerUmk.seed),
  visitorUmk: H(visitorUmk.seed),
  pageId: PAGE_ID,
  inboxEpoch: EPOCH,
  inboxSeed: H(inbox.seed),
  inboxPub: H(inbox.publicKey),
  inboxPubSha256: P.sha256Hex(inbox.publicKey),
  inboxEpoch2Seed: H(P.deriveVoiciInboxKey(ownerUmk, PAGE_ID, 2).seed),
  ownerSignSeed: H(ownerSign.seed),
  ownerSignPub: H(ownerSign.publicKey),
  messagesSecret: H(msecret),
  pseudonymSeed: H(pseud.seed),
  pseudonymPub: PPUB,
  otherPagePseudonymPub: H(P.deriveMessagesPseudonymKey(msecret, OTHER_PAGE).publicKey),
  threadSeed: H(thread.seed),
  threadPub: TPUB,
  threadPubSha256: P.sha256Hex(thread.publicKey),
  draftsKey: H(draftsKey),
  stateKey: H(stateKey),
  conv: CONV,
  pseudonymName: P.voiciPseudonymName(PPUB),
};

const canonicalJsonCases = [
  { name: "sorted keys, no spaces", value: { b: 1, a: [true, null, "x"] } },
  { name: "escapes", value: { s: "quote \" back \\ nl \n tab \t bell \u0007 del \u007f é 😀  " } },
  { name: "nested", value: { z: { y: [], x: {} }, a: 0 } },
].map((c) => ({ ...c, canonical: P.canonicalJson(c.value) }));
const canonicalJsonRefusals = [
  { name: "float", json: '{"a":1.5}' },
  { name: "unsafe integer", json: '{"a":9007199254740993}' },
].map((c) => {
  let threw = false;
  try {
    P.canonicalJson(JSON.parse(c.json));
  } catch {
    threw = true;
  }
  return { ...c, refused: want(`cjson ${c.name}`, threw, true) };
});
const base64Cases = [
  { b64: "", hex: "" },
  { b64: "AA==", hex: "00" },
  { b64: "AAE=", hex: "0001" },
  { b64: "AAEC", hex: "000102" },
  { b64: "+/8=", hex: "fbff" },
  { b64: "AAF=", hex: null },
  { b64: "AA=", hex: null },
  { b64: "AA-_", hex: null },
  { b64: "AA ==", hex: null },
].map((c) => ({ ...c, hex: want(`b64 ${c.b64}`, P.b64Decode(c.b64) ? H(P.b64Decode(c.b64)!) : null, c.hex) }));

// attestation
const attReq = { username: VISITOR, pseudonymPub: PPUB, renewOfHash: "", deviceCheckRef: "ios" as const, issuedAt: T0 - 60_000 };
const attReqSig = P.signMessagesKeyAttestationRequest(attReq, deviceSeed);
const abuseEseed = fill(64, 0x5a);
const abuseTagPlain = { v: 1 as const, username: VISITOR, accountCreatedAt: T0 - 100 * DAY, issuedAt: T0 - 60_000 };
const abuseTag = P.sealVoiciAbuseTag(abusePub, PPUB, abuseTagPlain, abuseEseed);
want("abuse tag opens", P.openVoiciAbuseTag(abuseSeed, PPUB, abuseTag), abuseTagPlain);
const att = P.signMessagesKeyAttestation({ pseudonymPub: PPUB, abuseEpoch: 3, issuedAt: T0 - 60_000, expiresAt: T0 - 60_000 + P.MESSAGES_ATTESTATION_TTL_MS }, abuseTag, caSeed);
const attT = (m: (a: Record<string, unknown>) => void) => {
  const a = clone(att) as unknown as Record<string, unknown>;
  m(a);
  return a;
};
const attCtx = { caKeys: [caPub], now: T0, pseudonymPub: PPUB };
const attestationChecks = (
  [
    ["valid", att, attCtx, "ok"],
    ["unknown CA", att, { ...attCtx, caKeys: [adminRootPub] }, "unknown-ca"],
    ["expiry extended", attT((a) => (a.expiresAt = (a.expiresAt as number) + DAY)), attCtx, "bad-signature"],
    ["abuse tag swapped (hash kept)", attT((a) => (a.abuseTag = P.b64Encode(P.sealVoiciAbuseTag(abusePub, PPUB, { ...abuseTagPlain, username: "carol" }, abuseEseed)))), attCtx, "bad-abuse-tag"],
    ["another pseudonym's key", att, { ...attCtx, pseudonymPub: derivations.otherPagePseudonymPub }, "wrong-key"],
    ["expired", att, { ...attCtx, now: att.expiresAt }, "expired"],
    ["not yet valid", att, { ...attCtx, now: att.issuedAt - 1 }, "not-yet-valid"],
    ["extra key", attT((a) => (a.username = VISITOR)), attCtx, "malformed"],
    ["abuse tag not base64", attT((a) => (a.abuseTag = "**")), attCtx, "malformed"],
  ] as [string, unknown, Parameters<typeof P.checkMessagesKeyAttestation>[1], string][]
).map(([name, a, c, expected]) => ({ name, attestation: a, ctx: c, expected: want(`att ${name}`, code(P.checkMessagesKeyAttestation(a, c)), expected) }));
const abuseEntry = { epoch: 3, xwingPub: H(abusePub), notBefore: T0 - 30 * DAY, notAfter: T0 + 60 * DAY };
const abuseEntrySig = P.signAbuseKeyEntry(abuseEntry, caTrackSeed);
want("abuse entry", P.verifyAbuseKeyEntry(abuseEntry, abuseEntrySig, [H(P.ed.getPublicKey(caTrackSeed))]), true);
want("abuse entry tampered", P.verifyAbuseKeyEntry({ ...abuseEntry, notAfter: abuseEntry.notAfter + 1 }, abuseEntrySig, [H(P.ed.getPublicKey(caTrackSeed))]), false);

// delegation
const delegation: P.WebDelegation = {
  scope: "voici-messages",
  origin: ORIGIN,
  audience: PAGE_ID,
  principalPub: PPUB,
  delegateAlg: "p256",
  delegatePub: browserPub,
  issuedAt: T0 - 60_000,
  expiresAt: T0 + 29 * DAY,
  nonce: "5e".repeat(16),
};
const delegationSig = P.signWebDelegation(delegation, pseud.seed);
const delWant = { scope: "voici-messages" as const, origin: ORIGIN, audience: PAGE_ID, principalPub: PPUB, now: T0, notAfter: att.expiresAt };
const delegationChecks = (
  [
    ["valid", delegation, delegationSig, delWant, "ok"],
    ["gym origin wanted", delegation, delegationSig, { ...delWant, origin: P.VOICI_WEB_ORIGIN_GYM }, "wrong-origin"],
    ["another page", delegation, delegationSig, { ...delWant, audience: OTHER_PAGE }, "wrong-audience"],
    ["another principal", delegation, delegationSig, { ...delWant, principalPub: derivations.otherPagePseudonymPub }, "wrong-principal"],
    ["outlives the attestation", delegation, delegationSig, { ...delWant, notAfter: delegation.expiresAt - 1 }, "too-long"],
    ["expired", delegation, delegationSig, { ...delWant, now: delegation.expiresAt }, "expired"],
    ["not yet valid", delegation, delegationSig, { ...delWant, now: delegation.issuedAt - 1 }, "not-yet-valid"],
    ["delegate key swapped", { ...delegation, delegatePub: otherBrowserPub }, delegationSig, delWant, "bad-signature"],
    ["signed by the owner key", delegation, P.signWebDelegation(delegation, ownerSign.seed), delWant, "bad-signature"],
    ["delegate not P-256 uncompressed", { ...delegation, delegatePub: "02" + browserPub.slice(2, 66) }, delegationSig, delWant, "malformed"],
    ["unknown scope", { ...delegation, scope: "admin" }, delegationSig, delWant, "malformed"],
    ["origin with a path", { ...delegation, origin: "https://voi.ci/x" }, delegationSig, delWant, "malformed"],
  ] as [string, unknown, string, Parameters<typeof P.checkWebDelegation>[2], string][]
).map(([name, d, sig, w, expected]) => ({ name, delegation: d, signature: sig, want: w, expected: want(`del ${name}`, code(P.checkWebDelegation(d, sig, w)), expected) }));
const revoke = { delegatePub: browserPub, issuedAt: T0 + 1000 };
const revokeSig = P.signWebDelegationRevoke(revoke, pseud.seed);

// thread statement
const threadStmt = { pageId: PAGE_ID, pseudonymPub: PPUB, threadPub: TPUB, issuedAt: T0 - 60_000 };
const threadSig = P.signVoiciThreadStatement(threadStmt, pseud.seed);

// a message
const MSG_ID = "4d".repeat(16);
const rnd = { cek: fill(32, 0xc1), nonce: fill(12, 0xc2), eseeds: [fill(64, 0xc3), fill(64, 0xc4)] };
const plaintext = { v: 1 as const, text: "Hello Alice!\nLoved the café post. https://example.com/x", replyTo: null };
const body = P.sealVoiciBody({ conv: CONV, msgId: MSG_ID, sentAt: T0, fromPub: PPUB, recipients: [inbox.publicKey, thread.publicKey], plaintext }, rnd);
const cred = { attestation: att, delegation, delegationSig, threadStmt, threadSig };
const unsignedMsg = { v: 1 as const, kind: "voici-message", audience: PAGE_ID, conv: CONV, from: PPUB, msgId: MSG_ID, seq: 1, sentAt: T0, bodyB64: P.b64Encode(body), cred };
const message = P.signWebEnvelopeP256(unsignedMsg, browserPriv);
const msgT = (m: (e: Record<string, unknown>) => void, resign = false) => {
  const e = clone(unsignedMsg) as unknown as Record<string, unknown>;
  m(e);
  if (resign) return P.signWebEnvelopeP256(e as never, browserPriv);
  return { ...e, sigAlg: "p256", sig: message.sig };
};
const msgCtx = { pageId: PAGE_ID, acceptsMessages: true, origin: ORIGIN, caKeys: [caPub], now: T0 + 30_000 };
type MsgCtxJson = Omit<P.VoiciMessageCheckContext, "blocked" | "revoked" | "rateLimit"> & { blocked?: string[]; revoked?: string[]; rateLimited?: boolean };
const toCtx = (c: MsgCtxJson): P.VoiciMessageCheckContext => ({
  ...c,
  blocked: c.blocked ? new Set(c.blocked) : undefined,
  revoked: c.revoked ? new Set(c.revoked) : undefined,
  rateLimit: c.rateLimited ? () => "rate-limited" : undefined,
});
const otherP = P.deriveMessagesPseudonymKey(msecret, OTHER_PAGE);
const messageChecks = (
  [
    ["valid", message, msgCtx, "ok"],
    ["too large", { ...message, pad: "x".repeat(70_000) }, msgCtx, "too-large"],
    ["extra key", { ...message, html: "<b>" }, msgCtx, "malformed"],
    ["body not canonical base64", { ...message, bodyB64: message.bodyB64 + "=" }, msgCtx, "malformed"],
    ["sealed body with one wrap", msgT((e) => (e.bodyB64 = P.b64Encode(P.canonicalJsonBytes({ ...JSON.parse(new TextDecoder().decode(body)), wraps: [JSON.parse(new TextDecoder().decode(body)).wraps[0]] }))), true), msgCtx, "malformed"],
    ["signed as ed25519", { ...message, sigAlg: "ed25519" }, msgCtx, "wrong-kind"],
    ["a reply kind", msgT((e) => (e.kind = "voici-reply"), true), msgCtx, "wrong-kind"],
    ["another page", message, { ...msgCtx, pageId: OTHER_PAGE }, "wrong-audience"],
    ["page not accepting", message, { ...msgCtx, acceptsMessages: false }, "not-accepting"],
    ["sender blocked", message, { ...msgCtx, blocked: [PPUB] }, "blocked"],
    ["browser key revoked", message, { ...msgCtx, revoked: [browserPub] }, "revoked"],
    ["rate limited", message, { ...msgCtx, rateLimited: true }, "rate-limited"],
    ["attestation from an unknown CA", message, { ...msgCtx, caKeys: [adminRootPub] }, "bad-attestation"],
    ["attestation expired", message, { ...msgCtx, now: att.expiresAt }, "bad-attestation"],
    ["from another pseudonym", msgT((e) => (e.from = H(otherP.publicKey)), true), msgCtx, "bad-attestation"],
    ["delegation for the gym origin", message, { ...msgCtx, origin: P.VOICI_WEB_ORIGIN_GYM }, "bad-delegation"],
    ["delegation signature forged", msgT((e) => ((e.cred as Record<string, unknown>).delegationSig = P.signWebDelegation(delegation, ownerSign.seed)), true), msgCtx, "bad-delegation"],
    ["thread key swapped", msgT((e) => ((e.cred as Record<string, unknown>).threadStmt = { ...threadStmt, threadPub: H(inbox.publicKey) }), true), msgCtx, "bad-thread"],
    ["thread statement for another page", msgT((e) => ((e.cred as Record<string, unknown>).threadStmt = { ...threadStmt, pageId: OTHER_PAGE }), true), msgCtx, "bad-thread"],
    ["conv of another page", msgT((e) => (e.conv = P.voiciConv(OTHER_PAGE, PPUB)), true), msgCtx, "wrong-conv"],
    ["text body swapped", msgT((e) => (e.bodyB64 = P.b64Encode(P.sealVoiciBody({ conv: CONV, msgId: MSG_ID, sentAt: T0, fromPub: PPUB, recipients: [inbox.publicKey, thread.publicKey], plaintext: { ...plaintext, text: "other" } }, rnd)))), msgCtx, "bad-signature"],
    ["seq changed", msgT((e) => (e.seq = 2)), msgCtx, "bad-signature"],
    ["signed by another browser key", P.signWebEnvelopeP256(unsignedMsg, otherBrowserPriv), msgCtx, "bad-signature"],
    ["sent 11 minutes ago", message, { ...msgCtx, now: T0 + 11 * 60_000 }, "stale"],
  ] as [string, unknown, MsgCtxJson, string][]
).map(([name, env, c, expected]) => ({ name, envelope: env, ctx: c, expected: want(`msg ${name}`, code(P.checkVoiciMessage(env, toCtx(c))), expected) }));

const openCases = [
  { name: "the owner's inbox key", seed: H(inbox.seed), conv: CONV, msgId: MSG_ID },
  { name: "the sender's thread key", seed: H(thread.seed), conv: CONV, msgId: MSG_ID },
  { name: "the next inbox epoch's key", seed: derivations.inboxEpoch2Seed, conv: CONV, msgId: MSG_ID },
  { name: "another msgId (context)", seed: H(inbox.seed), conv: CONV, msgId: "00".repeat(16) },
].map((c) => {
  const r = P.openVoiciBody(body, { conv: c.conv, msgId: c.msgId }, P.hexToBytes(c.seed));
  return { ...c, expected: r.ok ? { ok: true, plaintext: r.plaintext } : { ok: false, code: r.code } };
});
want("open inbox", openCases[0]!.expected, { ok: true, plaintext });
want("open epoch 2", openCases[2]!.expected, { ok: false, code: "no-wrap" });
want("open ctx", openCases[3]!.expected, { ok: false, code: "decrypt-failed" });

// a reply
const REPLY_ID = "5e".repeat(16);
const replyPlain = { v: 1 as const, text: "Thanks!", replyTo: MSG_ID };
const replyRnd = { cek: fill(32, 0xd1), nonce: fill(12, 0xd2), eseeds: [fill(64, 0xd3), fill(64, 0xd4)] };
const replyBody = P.sealVoiciBody({ conv: CONV, msgId: REPLY_ID, sentAt: T0 + 60_000, fromPub: H(ownerSign.publicKey), recipients: [thread.publicKey, inbox.publicKey], plaintext: replyPlain }, replyRnd);
const reply = P.signWebEnvelopeEd25519({ v: 1, kind: "voici-reply", audience: PAGE_ID, conv: CONV, from: H(ownerSign.publicKey), msgId: REPLY_ID, seq: 1, sentAt: T0 + 60_000, bodyB64: P.b64Encode(replyBody), cred: { pageSeq: 7 } }, ownerSign.seed);
want("reply opens with T", P.openVoiciBody(replyBody, { conv: CONV, msgId: REPLY_ID }, thread.seed).ok, true);
const replyCtx = { pageId: PAGE_ID, ownerSignPub: H(ownerSign.publicKey), conv: CONV };
const replyChecks = (
  [
    ["valid", reply, replyCtx, "ok"],
    ["valid and fresh at send", reply, { ...replyCtx, freshAt: T0 + 61_000 }, "ok"],
    ["stale at send", reply, { ...replyCtx, freshAt: T0 + 60_000 + 11 * 60_000 }, "stale"],
    ["another owner key", reply, { ...replyCtx, ownerSignPub: PPUB }, "bad-signature"],
    ["another conversation", reply, { ...replyCtx, conv: P.voiciConv(PAGE_ID, H(otherP.publicKey)) }, "wrong-conv"],
    ["pageSeq 0", { ...reply, cred: { pageSeq: 0 } }, replyCtx, "malformed"],
    ["cred with an attestation", { ...reply, cred: { pageSeq: 7, attestation: att } }, replyCtx, "malformed"],
    ["a message kind", { ...reply, kind: "voici-message" }, replyCtx, "wrong-kind"],
  ] as [string, unknown, Parameters<typeof P.checkVoiciReply>[1], string][]
).map(([name, env, c, expected]) => ({ name, envelope: env, ctx: c, expected: want(`reply ${name}`, code(P.checkVoiciReply(env, c)), expected) }));

// a draft
const OP_ID = "6f".repeat(16);
const draftOp: P.VoiciDraftOp = {
  v: 1,
  opId: OP_ID,
  op: "post-add",
  at: T0,
  deviceId: "device-2",
  post: { id: "ab".repeat(16), createdAt: T0, editedAt: null, text: "Written on my tablet", links: [{ url: "https://example.com/article", card: { title: "An article", site: "Example", description: "", image: cardSha } }] },
  images: [{ sha256: cardSha, data: P.b64Encode(cardImg) }],
};
const draftBody = P.sealVoiciDraft(draftsKey, USER, draftOp, fill(12, 0xe1));
const grant = { grantId: "g-1", username: USER, deviceId: "device-2", devicePubKey: devicePub, scopes: ["member"], issuedAt: T0 - DAY, expiresAt: T0 + 89 * DAY };
const grantSignature = H(P.ed.sign(enc.encode("test grant"), adminRootSeed));
const draft = P.signWebEnvelopeEd25519({ v: 1, kind: "voici-draft", audience: USER, conv: "", from: devicePub, msgId: OP_ID, seq: 1, sentAt: T0, bodyB64: P.b64Encode(draftBody), cred: { grant, grantSignature } }, deviceSeed);
want("draft opens", P.openVoiciDraft(draftsKey, USER, OP_ID, draftBody), draftOp);
want("draft wrong opId", P.openVoiciDraft(draftsKey, USER, "00".repeat(16), draftBody), null);
const grantOk = (g: unknown, s: string, pub: string) => P.canonicalJson(g) === P.canonicalJson(grant) && s === grantSignature && pub === devicePub;
const draftChecks = (
  [
    ["valid", draft, { username: USER }, "ok"],
    ["another account", draft, { username: VISITOR }, "wrong-audience"],
    ["grant not accepted", { ...draft, cred: { grant: { ...grant, scopes: ["admin"] }, grantSignature } }, { username: USER }, "bad-signature"],
    ["re-signed with a grant the account did not give", P.signWebEnvelopeEd25519({ ...draft, cred: { grant: { ...grant, scopes: ["admin"] }, grantSignature } }, deviceSeed), { username: USER }, "bad-grant"],
    ["conv not empty", { ...draft, conv: CONV }, { username: USER }, "malformed"],
    ["signed by another key", P.signWebEnvelopeEd25519({ ...draft }, ownerSign.seed), { username: USER }, "bad-signature"],
    ["stale at the phone", draft, { username: USER, freshAt: T0 + 11 * 60_000 }, "stale"],
  ] as [string, unknown, { username: string; freshAt?: number }, string][]
).map(([name, env, c, expected]) => ({ name, envelope: env, ctx: c, expected: want(`draft ${name}`, code(P.checkVoiciDraft(env, { ...c, checkGrant: grantOk })), expected) }));
const draftOpCases = [
  ["valid", draftOp, true],
  ["post-delete with a post", { ...draftOp, op: "post-delete" }, false],
  ["post-delete", { v: 1, opId: OP_ID, op: "post-delete", at: T0, deviceId: "device-2", postId: "ab".repeat(16) }, true],
  ["accept-messages 2", { v: 1, opId: OP_ID, op: "accept-messages", at: T0, deviceId: "device-2", accepts: 2 }, false],
  ["image hash wrong", { ...draftOp, images: [{ sha256: avatarSha, data: P.b64Encode(cardImg) }] }, false],
  ["image not a JPEG", { ...draftOp, images: [{ sha256: P.sha256Hex(png), data: P.b64Encode(png) }] }, false],
  ["unknown op", { ...draftOp, op: "page-delete" }, false],
].map(([name, o, expected]) => ({ name, op: o, expected: want(`op ${name}`, P.parseVoiciDraftOp(o) !== null, expected) }));

// ack, block, fetch
const ack = P.signVoiciAck({ conv: CONV, msgId: MSG_ID, receivedAt: T0 + 1_000, phoneRoutePub }, ownerSign.seed);
const draftAck = P.signVoiciAck({ conv: "", msgId: OP_ID, receivedAt: T0 + 1_000, phoneRoutePub }, adminRootSeed);
const ackCases = [
  { name: "valid", ack, signerPub: H(ownerSign.publicKey), want: { msgId: MSG_ID, conv: CONV }, expected: true },
  { name: "valid draft ack", ack: draftAck, signerPub: adminRootPub, want: { msgId: OP_ID, conv: "" }, expected: true },
  { name: "another message", ack, signerPub: H(ownerSign.publicKey), want: { msgId: REPLY_ID }, expected: false },
  { name: "phone key swapped", ack: { ...ack, phoneRoutePub: devicePub }, signerPub: H(ownerSign.publicKey), want: { msgId: MSG_ID }, expected: false },
  { name: "signed by another key", ack, signerPub: adminRootPub, want: { msgId: MSG_ID }, expected: false },
].map((c) => ({ ...c, expected: want(`ack ${c.name}`, P.verifyVoiciAck(c.ack, c.signerPub, c.want) !== null, c.expected) }));
const block = { pageId: PAGE_ID, pseudonymPub: PPUB, op: "block" as const, issuedAt: T0 + 5_000 };
const blockSig = P.signVoiciBlock(block, ownerSign.seed);
want("block unblock swap", P.verifyVoiciBlock({ ...block, op: "unblock" }, blockSig, H(ownerSign.publicKey)), false);
const fetch = { conv: CONV, since: "c_12", issuedAt: T0 + 2_000 };
const fetchSig = P.signVoiciThreadFetchP256(fetch, browserPriv);
want("fetch other since", P.verifyVoiciThreadFetch({ ...fetch, since: "" }, fetchSig, browserPub), false);

// state blob
const stateA: P.MessagesState = {
  ...P.emptyMessagesState(),
  nicknames: { [PPUB]: { name: "Bob from the café", at: T0 } },
  blocks: [H(otherP.publicKey)],
  accepted: [CONV],
  readUpTo: { [CONV]: MSG_ID },
  signedInSites: [{ pageId: PAGE_ID, delegatePub: browserPub, at: T0 }],
};
const stateB: P.MessagesState = {
  ...P.emptyMessagesState(),
  nicknames: { [PPUB]: { name: "Bobby", at: T0 + 1 } },
  archived: [CONV],
  pendingOps: [draftOp],
};
const stateSealed = P.sealMessagesState(stateKey, USER, 4, stateA, fill(12, 0xf1));
want("state opens", P.openMessagesState(stateKey, USER, stateSealed), stateA);
want("state other version", P.openMessagesState(stateKey, USER, { ...stateSealed, version: 5 }), null);

// reports
const report: P.VoiciMessageReport = { kind: "message", pageId: PAGE_ID, envelope: message, reason: "spam", attached: null, issuedAt: T0 + 9_000 };
const reportSig = P.signVoiciMessageReport(report, ownerSign.seed);
const reportText = P.sealVoiciReportText(abusePub, { conv: CONV, msgId: MSG_ID, ownerSignPub: H(ownerSign.publicKey), issuedAt: T0 + 9_000, plaintext }, fill(64, 0xa7));
want("report text opens", P.openVoiciReportText(abuseSeed, { conv: CONV, msgId: MSG_ID }, reportText), plaintext);
const reportWithText = { ...report, attached: P.b64Encode(reportText) };
const reportWithTextSig = P.signVoiciMessageReport(reportWithText, ownerSign.seed);
const pageReport: P.VoiciPageReport = { kind: "page", username: USER, seq: 7, reason: "impersonation", note: "This isn't the real Alice.", issuedAt: T0 + 9_000 };
const pageReportSig = H(p256.sign(P.canonicalVoiciReport(pageReport), browserPriv, { lowS: true }));

// sign-in
const signInRequest = { kind: P.TAG_VOICI_SIGN_IN_REQUEST, origin: ORIGIN, pageId: PAGE_ID, username: USER, delegatePub: browserPub, nonce: delegation.nonce };
const signInAnswer = { kind: P.TAG_VOICI_SIGN_IN, pageId: PAGE_ID, pseudonymPub: PPUB, attestation: att, delegation, delegationSig, threadStmt, threadSig, threadSeed: H(thread.seed) };
const signInCtx = { caKeys: [caPub], now: T0 };
const signInChecks = (
  [
    ["valid", signInAnswer, signInRequest, "ok"],
    ["delegation for another browser key", signInAnswer, { ...signInRequest, delegatePub: otherBrowserPub }, "bad-delegation"],
    ["another nonce", signInAnswer, { ...signInRequest, nonce: "00".repeat(16) }, "bad-delegation"],
    ["thread seed not the stated key", { ...signInAnswer, threadSeed: H(inbox.seed) }, signInRequest, "bad-thread"],
    ["another page", signInAnswer, { ...signInRequest, pageId: OTHER_PAGE }, "malformed"],
    ["attestation for another key", { ...signInAnswer, pseudonymPub: H(otherP.publicKey) }, signInRequest, "bad-attestation"],
  ] as [string, unknown, P.VoiciSignInRequest, string][]
).map(([name, a, req, expected]) => {
  if (!P.parseVoiciSignInRequest(req)) throw new Error(`sign-in request ${name}`);
  return { name, answer: a, request: req, expected: want(`sign-in ${name}`, code(P.checkVoiciSignInAnswer(a, { request: req, caKeys: signInCtx.caKeys, now: signInCtx.now })), expected) };
});

// phone endpoint web policy
const HOST = "alice.flagship.services";
const req = (o: Partial<P.PhoneWebRequest>): P.PhoneWebRequest => ({ method: "GET", path: "/api/phone/live", host: HOST, origin: null, contentType: null, acrMethod: null, acrHeaders: null, ...o });
const phoneWeb = [
  ["preflight from voi.ci", req({ method: "OPTIONS", path: "/api/phone/deliver", origin: ORIGIN, acrMethod: "POST", acrHeaders: "content-type" })],
  ["preflight asking for another header", req({ method: "OPTIONS", path: "/api/phone/deliver", origin: ORIGIN, acrMethod: "POST", acrHeaders: "content-type, authorization" })],
  ["preflight for live", req({ method: "OPTIONS", origin: ORIGIN, acrMethod: "GET", acrHeaders: "" })],
  ["preflight from another site", req({ method: "OPTIONS", path: "/api/phone/deliver", origin: "https://evil.example", acrMethod: "POST", acrHeaders: "content-type" })],
  ["live from voi.ci", req({ origin: ORIGIN })],
  ["live from a native app", req({})],
  ["live from a sibling app", req({ origin: "https://notes.alice.flagship.services" })],
  ["deliver from voi.ci", req({ method: "POST", path: "/api/phone/deliver", origin: ORIGIN, contentType: "application/flagship-envelope+json" })],
  ["deliver as text/plain", req({ method: "POST", path: "/api/phone/deliver", origin: ORIGIN, contentType: "text/plain" })],
  ["deliver with a charset", req({ method: "POST", path: "/api/phone/deliver", origin: ORIGIN, contentType: "application/flagship-envelope+json; charset=utf-8" })],
  ["deliver from a native app", req({ method: "POST", path: "/api/phone/deliver", contentType: "application/flagship-envelope+json" })],
  ["GET deliver", req({ path: "/api/phone/deliver", origin: ORIGIN })],
  ["retired session route from voi.ci", req({ method: "POST", path: "/api/phone/session", origin: ORIGIN })],
  ["another route, no Origin", req({ path: "/" })],
  ["wrong host", req({ host: "bob.flagship.services", origin: ORIGIN })],
  ["gym origin on prod", req({ origin: P.VOICI_WEB_ORIGIN_GYM })],
].map(([name, r]) => ({ name, request: r, hostname: HOST, origins: P.PHONE_WEB_ORIGINS, expected: P.phoneWebCheck(r as P.PhoneWebRequest, { hostname: HOST, origins: P.PHONE_WEB_ORIGINS }) }));
want("preflight ok", phoneWeb[0]!.expected.kind, "preflight");
want("evil origin", phoneWeb[3]!.expected, { kind: "refuse", status: 403, code: "origin" });
const liveAnswers = [
  [{ live: true, account: USER, ownerSignPub: H(ownerSign.publicKey) }, true],
  [{ live: true, account: USER }, false],
  [{ live: "yes", account: USER, ownerSignPub: H(ownerSign.publicKey) }, false],
  [{ live: true, account: USER, ownerSignPub: H(ownerSign.publicKey), session: "x" }, false],
].map(([answer, expected]) => ({ answer, expected: want("live answer", P.parsePhoneLiveAnswer(answer) !== null, expected) }));

const messages = {
  description:
    "Messages vectors (docs/voici-and-messages.md §1, §6-§10), produced by packages/protocol/src. Generated by tools/voici-vectors.ts; do not edit. Seeds and randomness are test-only (bytes of one value). P-256 signatures are deterministic (RFC 6979) here: ports verify them; a port's own P-256 signatures differ and must verify the same. `expected` is \"ok\" or the refusal code the TypeScript returns. Envelope check contexts: `blocked`/`revoked` are sets; `rateLimited: true` means the rate-limit hook refuses.",
  t0: T0,
  keys: {
    caSeed: H(caSeed),
    caPub,
    caTrackSeed: H(caTrackSeed),
    caTrackPub: H(P.ed.getPublicKey(caTrackSeed)),
    abuseSeed: H(abuseSeed),
    abusePub: H(abusePub),
    adminRootSeed: H(adminRootSeed),
    adminRootPub,
    browserPriv: H(browserPriv),
    browserPub,
    otherBrowserPub,
    deviceSeed: H(deviceSeed),
    devicePub,
    phoneRoutePub,
  },
  constants: {
    envelopeMaxBytes: P.WEB_ENVELOPE_MAX_BYTES,
    envelopeMaxBodyBytes: P.WEB_ENVELOPE_MAX_BODY_BYTES,
    draftMaxEnvelopeBytes: P.VOICI_DRAFT_MAX_ENVELOPE_BYTES,
    draftMaxBodyBytes: P.VOICI_DRAFT_MAX_BODY_BYTES,
    sendSkewMs: P.VOICI_SEND_SKEW_MS,
    attestationTtlMs: P.MESSAGES_ATTESTATION_TTL_MS,
    phoneDeliverMaxBytes: P.PHONE_DELIVER_MAX_BYTES,
    phoneWebOrigins: P.PHONE_WEB_ORIGINS,
    phoneWebOriginsGym: P.PHONE_WEB_ORIGINS_GYM,
    webOrigin: P.VOICI_WEB_ORIGIN,
    webOriginGym: P.VOICI_WEB_ORIGIN_GYM,
  },
  derivations,
  canonicalJson: { cases: canonicalJsonCases, refusals: canonicalJsonRefusals },
  base64: base64Cases,
  attestation: {
    request: attReq,
    requestCanonical: new TextDecoder().decode(P.canonicalMessagesKeyAttestationRequest(attReq)),
    requestSignature: attReqSig,
    abuseTagPlaintext: abuseTagPlain,
    abuseTagEseed: H(abuseEseed),
    abuseTagHex: H(abuseTag),
    signed: att,
    canonical: new TextDecoder().decode(P.canonicalMessagesKeyAttestation(att)),
    renewOfHash: P.messagesAttestationHash(att),
    checks: attestationChecks,
    abuseKeyEntry: { entry: abuseEntry, canonical: new TextDecoder().decode(P.canonicalAbuseKeyEntry(abuseEntry)), signature: abuseEntrySig },
  },
  delegation: {
    delegation,
    canonical: new TextDecoder().decode(P.canonicalWebDelegation(delegation)),
    signature: delegationSig,
    checks: delegationChecks,
    revoke: { revoke, canonical: new TextDecoder().decode(P.canonicalWebDelegationRevoke(revoke)), signature: revokeSig },
  },
  threadStatement: { statement: threadStmt, canonical: new TextDecoder().decode(P.canonicalVoiciThreadStatement(threadStmt)), signature: threadSig },
  message: {
    plaintext,
    plaintextCanonical: P.canonicalJson(plaintext),
    randomness: { cek: H(rnd.cek), nonce: H(rnd.nonce), eseeds: rnd.eseeds.map(H) },
    bodyText: new TextDecoder().decode(body),
    envelope: message,
    canonical: new TextDecoder().decode(P.canonicalWebEnvelope(message)),
    checks: messageChecks,
    open: openCases,
  },
  reply: {
    plaintext: replyPlain,
    randomness: { cek: H(replyRnd.cek), nonce: H(replyRnd.nonce), eseeds: replyRnd.eseeds.map(H) },
    bodyText: new TextDecoder().decode(replyBody),
    envelope: reply,
    canonical: new TextDecoder().decode(P.canonicalWebEnvelope(reply)),
    checks: replyChecks,
  },
  draft: {
    username: USER,
    op: draftOp,
    nonce: H(fill(12, 0xe1)),
    bodyText: new TextDecoder().decode(draftBody),
    envelope: draft,
    grantAccepted: { grant, grantSignature, devicePub },
    checks: draftChecks,
    opCases: draftOpCases,
  },
  ack: { message: ack, draft: draftAck, canonical: new TextDecoder().decode(P.canonicalVoiciAck(ack)), cases: ackCases },
  block: { block, canonical: new TextDecoder().decode(P.canonicalVoiciBlock(block)), signature: blockSig },
  threadFetch: { fetch, canonical: new TextDecoder().decode(P.canonicalVoiciThreadFetch(fetch)), signature: fetchSig },
  state: {
    username: USER,
    version: 4,
    a: stateA,
    b: stateB,
    merged: P.mergeMessagesState(stateA, stateB),
    nonce: H(fill(12, 0xf1)),
    sealed: stateSealed,
  },
  reports: {
    message: { report, canonical: new TextDecoder().decode(P.canonicalVoiciReport(report)), signature: reportSig },
    messageWithText: { report: reportWithText, canonical: new TextDecoder().decode(P.canonicalVoiciReport(reportWithText)), signature: reportWithTextSig, eseed: H(fill(64, 0xa7)) },
    page: { report: pageReport, canonical: new TextDecoder().decode(P.canonicalVoiciReport(pageReport)), signature: pageReportSig },
  },
  signIn: { request: signInRequest, answer: signInAnswer, ctx: signInCtx, checks: signInChecks },
  phoneWeb: { cases: phoneWeb, liveAnswers },
};

// ── write / check ──────────────────────────────────────────────────────────

let stale = false;
for (const [out, doc] of [
  [OUT_VOICI, voici],
  [OUT_MESSAGES, messages],
] as const) {
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    let cur = "";
    try {
      cur = readFileSync(out, "utf8");
    } catch {
      /* missing */
    }
    if (cur !== text) {
      console.error(`${out} is stale; run npx tsx tools/voici-vectors.ts`);
      stale = true;
    }
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`wrote ${out} (${text.length} bytes)`);
  }
}
if (stale) process.exit(1);
if (process.argv.includes("--check")) console.log("voici + messages vectors up to date");
