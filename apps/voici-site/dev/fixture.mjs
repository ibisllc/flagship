// Signed sample pages for the local preview (dev/serve.mjs), the screenshots (dev/screenshots.mjs) and a headless
// browser run of the site (chunk G). Signed with the shared test-vector keys, never a real key. `alice` uses the
// Messages vectors' page id and owner keys, so the vector message and reply are a real thread for her page.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../../../packages/flagship-web/src/proto/lib/voiciProtocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = join(here, "..", "..", "..", "packages", "protocol", "test-vectors");
export const V = JSON.parse(readFileSync(join(vectors, "voici", "vectors.json"), "utf8"));
export const M = JSON.parse(readFileSync(join(vectors, "messages", "vectors.json"), "utf8"));
const enc = new TextEncoder();
const DAY = 86_400_000;

export const ACCOUNT_KEYS = { adminRootSeed: V.keys.adminRootSeed, adminRootPub: V.keys.adminRootPub, irkPub: V.keys.irkPub };

const id = (n) => n.toString(16).padStart(32, "0");

const SAMPLES = {
  alice: {
    theme: "classic",
    pageId: M.derivations.pageId,
    accepts: 1,
    displayName: "Alice Martin",
    bio: "Gardener in Lyon. I build small, slow software with Flagship\nand write about soil, seeds and servers.",
    links: [
      { url: "https://github.com/alice", label: "Code", site: "github" },
      { url: "https://fosstodon.org/@alice", label: "Notes from the garden", site: "mastodon" },
      { url: "https://bsky.app/profile/alice.example", label: "Bluesky", site: "bluesky" },
      { url: "https://seeds.alice.example/catalogue", label: "Seed catalogue 2026", site: null },
      { url: "mailto:alice@example.com", label: "Write to me", site: "email" },
    ],
    posts: [
      { text: "Hello from my new page. Everything here is signed on my phone before it goes up.", links: [] },
      { text: "Tomatoes are in. Twelve varieties this year; the yellow pear ones were the surprise.", links: [] },
      {
        text: "I wrote up how the seed swap app works. It runs on the old laptop under my desk.",
        links: [{ url: "https://blog.alice.example/seed-swap", card: { title: "A seed swap that runs at home", site: "Alice's notes", description: "A tiny app, a shared list, and why nobody needs an account.", image: "card" } }],
      },
      { text: "Open garden this Saturday from 10. Bring cuttings!\nDetails: https://seeds.alice.example/open-day", links: [{ url: "https://seeds.alice.example/open-day", card: null }] },
    ],
  },
  bruno: {
    theme: "ink",
    pageId: "1a2b3c4d5e6f708192a3b4c5d6e7f801",
    accepts: 1,
    displayName: "Bruno Okafor",
    bio: "Night-shift radio. Records, tapes, and the occasional long walk.",
    links: [
      { url: "https://bruno.bandcamp.com", label: "Mixes", site: "bandcamp" },
      { url: "https://soundcloud.com/bruno", label: "Live sets", site: "soundcloud" },
      { url: "https://www.youtube.com/@bruno", label: "Studio diaries", site: "youtube" },
    ],
    posts: [{ text: "New mix up tonight. Two hours of dub and rain.", links: [] }],
  },
  cora: {
    theme: "sea",
    pageId: "2b3c4d5e6f708192a3b4c5d6e7f80192",
    accepts: 0,
    displayName: "Cora Lindqvist",
    bio: "Sailing instructor. Tide tables, knots and coffee.",
    links: [
      { url: "https://www.instagram.com/cora", label: "Photos from the water", site: "instagram" },
      { url: "https://www.strava.com/athletes/cora", label: "Strava", site: "strava" },
    ],
    posts: [],
  },
};

/**
 * A signed page and its pieces. images = {avatar?: Uint8Array, card?: Uint8Array} (real JPEGs from the screenshot
 * script; without them the page has no avatar and cards have no image). Returns {index, account, pieces: Map}.
 */
export function samplePage(username, images = {}, now = Date.now()) {
  const s = SAMPLES[username];
  if (!s) return null;
  const pieces = new Map();
  const refs = [];
  const add = (role, bytes) => {
    const sha = P.sha256Hex(bytes);
    pieces.set(sha, bytes);
    refs.push({ role: role === "card" ? P.voiciCardRole(sha) : role, sha256: sha, size: bytes.length });
    return sha;
  };
  const avatar = images.avatar ? add("avatar", images.avatar) : null;
  const cardSha = images.card ? add("card", images.card) : null;
  const profile = { v: 1, displayName: s.displayName, bio: s.bio, avatar, theme: s.theme, links: s.links };
  add("profile", enc.encode(P.canonicalJson(profile)));
  const posts = s.posts.map((p, i) => ({
    id: id(0x1000 + i),
    createdAt: now - (s.posts.length - i) * 3 * DAY,
    editedAt: null,
    text: p.text,
    links: p.links.map((l) => ({ url: l.url, card: l.card ? { ...l.card, image: l.card.image === "card" ? cardSha : null } : null })),
  }));
  P.chunkVoiciPosts(posts).forEach((c, n) => add(`chunk-${n}`, enc.encode(P.canonicalJson({ v: 1, chunk: n, posts: c }))));
  const index = P.signVoiciPageIndex(
    {
      username,
      pageId: s.pageId,
      seq: 3,
      issuedAt: now - DAY,
      acceptsMessages: s.accepts,
      inboxEpoch: 1,
      inboxPub: M.derivations.inboxPub,
      ownerSignPub: M.derivations.ownerSignPub,
      pieces: refs,
      signerKind: "admin-root",
    },
    P.hexToBytes(ACCOUNT_KEYS.adminRootSeed),
  );
  return { index, account: { username, irkPub: ACCOUNT_KEYS.irkPub, adminRootPub: ACCOUNT_KEYS.adminRootPub }, pieces };
}

export const SAMPLE_USERS = Object.keys(SAMPLES);

/** A short thread on alice's page between the vector visitor and alice, dated around `now` (signed fresh). */
export function sampleThread(now = Date.now()) {
  const D = M.derivations;
  const h = P.hexToBytes;
  const delegation = {
    scope: "voici-messages",
    origin: "https://voi.ci",
    audience: D.pageId,
    principalPub: D.pseudonymPub,
    delegateAlg: "p256",
    delegatePub: M.keys.browserPub,
    issuedAt: now - 3 * DAY,
    expiresAt: now + 20 * DAY,
    nonce: "5e".repeat(16),
  };
  const cred = {
    attestation: M.attestation.signed,
    delegation,
    delegationSig: P.signWebDelegation(delegation, h(D.pseudonymSeed)),
    threadStmt: M.threadStatement.statement,
    threadSig: M.threadStatement.signature,
  };
  const threadPub = h(M.threadStatement.statement.threadPub);
  const inboxPub = h(D.inboxPub);
  const lines = [
    { mine: true, at: now - 26 * 3_600_000, text: "Hi Alice! I loved the seed swap write-up. Is the open garden still on this Saturday?" },
    { mine: false, at: now - 25 * 3_600_000, text: "It is! From 10 until it gets dark. The map is here: https://seeds.alice.example/open-day" },
    { mine: true, at: now - 3 * 3_600_000, text: "Perfect. Can I bring a friend?" },
  ];
  let mySeq = 0;
  let ownerSeq = 0;
  return lines.map((l, i) => {
    const msgId = (i + 1).toString(16).padStart(32, "a");
    const base = { v: 1, audience: D.pageId, conv: D.conv, msgId, sentAt: l.at, bodyB64: "" };
    const plaintext = { v: 1, text: l.text, replyTo: null };
    if (l.mine) {
      const body = P.sealVoiciBody({ conv: D.conv, msgId, sentAt: l.at, fromPub: D.pseudonymPub, recipients: [inboxPub, threadPub], plaintext });
      const env = P.signWebEnvelopeP256({ ...base, kind: "voici-message", from: D.pseudonymPub, seq: ++mySeq, bodyB64: P.b64Encode(body), cred }, h(M.keys.browserPriv));
      return { envelope: env, storedAt: l.at, fetchedAt: l.at + 60_000, direct: i === 0 };
    }
    const body = P.sealVoiciBody({ conv: D.conv, msgId, sentAt: l.at, fromPub: D.ownerSignPub, recipients: [threadPub, inboxPub], plaintext });
    const env = P.signWebEnvelopeEd25519({ ...base, kind: "voici-reply", from: D.ownerSignPub, seq: ++ownerSeq, bodyB64: P.b64Encode(body), cred: { pageSeq: 3 } }, h(D.ownerSignSeed));
    return { envelope: env, storedAt: l.at, fetchedAt: null, direct: false };
  });
}
