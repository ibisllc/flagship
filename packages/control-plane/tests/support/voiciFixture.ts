/** A voi.ci owner and visitor built from the protocol's own signers, for the `.com` pages and mailbox tests. */
import {
  b64Encode,
  canonicalJsonBytes,
  deriveMessagesPseudonymKey,
  deriveMessagesSecret,
  deriveMessagesThreadKey,
  deriveVoiciInboxKey,
  deriveVoiciOwnerSignKey,
  ed,
  sha256Hex,
  sealVoiciBody,
  signMessagesKeyAttestation,
  signVoiciPageIndex,
  signVoiciPieceUpload,
  signVoiciThreadStatement,
  signWebDelegation,
  signWebEnvelopeEd25519,
  signWebEnvelopeP256,
  voiciCardRole,
  voiciConv,
  type VoiciPageIndex,
  type VoiciPieceRef,
  type VoiciPost,
  type VoiciProfile,
  type WebEnvelope,
} from "@flagship/protocol";
import { p256 } from "@noble/curves/nist.js";

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

export const USER = "alice";
export const PAGE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
export const ORIGIN = "https://voi.ci";
export const adminSeed = fill(32, 0x33);
export const adminPub = hex(ed.getPublicKey(adminSeed));
export const irkSeed = fill(32, 0x34);
export const irkPub = hex(ed.getPublicKey(irkSeed));
export const caSeed = fill(32, 0x41);
export const caPub = hex(ed.getPublicKey(caSeed));
const ownerUmk = { seed: fill(32, 0x11) };
export const inbox = deriveVoiciInboxKey(ownerUmk, PAGE_ID, 1);
export const ownerSign = deriveVoiciOwnerSignKey(ownerUmk, PAGE_ID, 1);

export const JPEG = Uint8Array.from(Buffer.from("ffd8ffe000044a46ffda00021122ffd9", "hex"));
export const CARD_JPEG = Uint8Array.from(Buffer.from("ffd8ffe000044a46ffda000211223344ffd9", "hex"));

export function profile(over: Partial<VoiciProfile> = {}): VoiciProfile {
  return { v: 1, displayName: "Alice Martin", bio: "Gardener.", avatar: sha256Hex(JPEG), theme: "classic", links: [], ...over };
}

export function post(n: number, card = false): VoiciPost {
  return {
    id: n.toString(16).padStart(32, "0"),
    createdAt: 1_797_000_000_000 + n,
    editedAt: null,
    text: `Post ${n}`,
    links: card ? [{ url: "https://example.com", card: { title: "Example", site: "example.com", description: "", image: sha256Hex(CARD_JPEG) } }] : [],
  };
}

export interface BuiltPage {
  index: VoiciPageIndex;
  pieces: Map<string, Uint8Array>;
}

/** A signed index and its pieces: a profile, the avatar unless `prof.avatar` is null, chunks of the posts, and card images. */
export function buildPage(o: {
  seq: number;
  issuedAt: number;
  posts?: VoiciPost[][];
  prof?: VoiciProfile;
  accepts?: 0 | 1;
  signer?: "admin-root" | "irk";
  pageId?: string;
  username?: string;
}): BuiltPage {
  const pieces = new Map<string, Uint8Array>();
  const refs: VoiciPieceRef[] = [];
  const add = (role: string, bytes: Uint8Array) => {
    const sha = sha256Hex(bytes);
    pieces.set(sha, bytes);
    refs.push({ role: role === "card" ? voiciCardRole(sha) : role, sha256: sha, size: bytes.length });
  };
  const prof = o.prof ?? profile();
  add("profile", canonicalJsonBytes(prof));
  if (prof.avatar) add("avatar", JPEG);
  const chunks = o.posts ?? [];
  chunks.forEach((posts, n) => add(`chunk-${n}`, canonicalJsonBytes({ v: 1, chunk: n, posts })));
  if (chunks.some((c) => c.some((p) => p.links.some((l) => l.card?.image)))) add("card", CARD_JPEG);
  const index = signVoiciPageIndex(
    {
      username: o.username ?? USER,
      pageId: o.pageId ?? PAGE_ID,
      seq: o.seq,
      issuedAt: o.issuedAt,
      acceptsMessages: o.accepts ?? 1,
      inboxEpoch: 1,
      inboxPub: hex(inbox.publicKey),
      ownerSignPub: hex(ownerSign.publicKey),
      pieces: refs,
      signerKind: o.signer ?? "admin-root",
    },
    o.signer === "irk" ? irkSeed : adminSeed,
  );
  return { index, pieces };
}

export function uploadHeaders(bytes: Uint8Array, issuedAt: number, o: { seed?: Uint8Array; pageId?: string; username?: string } = {}) {
  const pageId = o.pageId ?? PAGE_ID;
  const signature = signVoiciPieceUpload({ username: o.username ?? USER, pageId, sha256: sha256Hex(bytes), size: bytes.length, issuedAt }, o.seed ?? adminSeed);
  return { pageId, issuedAt: String(issuedAt), signature };
}

/** A visitor with a pseudonym toward PAGE_ID, an attestation and a delegated browser key. */
export function visitor(t0: number, n = 1) {
  const secret = deriveMessagesSecret({ seed: fill(32, 0x20 + n) });
  const pseud = deriveMessagesPseudonymKey(secret, PAGE_ID);
  const thread = deriveMessagesThreadKey(secret, PAGE_ID);
  const pPub = hex(pseud.publicKey);
  const browserPriv = fill(32, 0x50 + n);
  const browserPub = hex(p256.getPublicKey(browserPriv, false));
  const attestation = signMessagesKeyAttestation(
    { pseudonymPub: pPub, abuseEpoch: 1, issuedAt: t0 - 60_000, expiresAt: t0 + 30 * 86_400_000 },
    fill(48, 0x61),
    caSeed,
  );
  const delegation = {
    scope: "voici-messages" as const,
    origin: ORIGIN,
    audience: PAGE_ID,
    principalPub: pPub,
    delegateAlg: "p256" as const,
    delegatePub: browserPub,
    issuedAt: t0 - 60_000,
    expiresAt: t0 + 29 * 86_400_000,
    nonce: "5e".repeat(16),
  };
  const threadStmt = { pageId: PAGE_ID, pseudonymPub: pPub, threadPub: hex(thread.publicKey), issuedAt: t0 - 60_000 };
  const cred = {
    attestation,
    delegation,
    delegationSig: signWebDelegation(delegation, pseud.seed),
    threadStmt,
    threadSig: signVoiciThreadStatement(threadStmt, pseud.seed),
  };
  const conv = voiciConv(PAGE_ID, pPub);
  let seq = 0;
  return {
    pPub,
    pseud,
    browserPriv,
    browserPub,
    cred,
    conv,
    message(sentAt: number, text = "Hello", msgId?: string): WebEnvelope {
      seq++;
      const id = msgId ?? seq.toString(16).padStart(32, "0");
      const body = sealVoiciBody({ conv, msgId: id, sentAt, fromPub: pPub, recipients: [inbox.publicKey, thread.publicKey], plaintext: { v: 1, text, replyTo: null } });
      return signWebEnvelopeP256({ v: 1, kind: "voici-message", audience: PAGE_ID, conv, from: pPub, msgId: id, seq, sentAt, bodyB64: b64Encode(body), cred }, browserPriv);
    },
    reply(sentAt: number, msgId: string): WebEnvelope {
      const from = hex(ownerSign.publicKey);
      const body = sealVoiciBody({ conv, msgId, sentAt, fromPub: from, recipients: [thread.publicKey, inbox.publicKey], plaintext: { v: 1, text: "Hi!", replyTo: null } });
      return signWebEnvelopeEd25519({ v: 1, kind: "voici-reply", audience: PAGE_ID, conv, from, msgId, seq: 1, sentAt, bodyB64: b64Encode(body), cred: { pageSeq: 1 } }, ownerSign.seed);
    },
  };
}

/** An in-memory R2 bucket that counts its reads. */
export function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string; cacheControl?: string }>();
  const stats = { gets: 0, puts: 0, deletes: 0 };
  return {
    objects,
    stats,
    async put(key: string, value: Uint8Array | string, opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } }) {
      stats.puts++;
      objects.set(key, { bytes: typeof value === "string" ? new TextEncoder().encode(value) : value, ...opts?.httpMetadata });
    },
    async get(key: string) {
      stats.gets++;
      const o = objects.get(key);
      return o ? { arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer, size: o.bytes.length } : null;
    },
    async delete(keys: string | string[]) {
      stats.deletes++;
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}
