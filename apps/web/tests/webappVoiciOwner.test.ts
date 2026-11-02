// The webapp's owner side of voi.ci pages and Messages (apps/web/public/webapp/lib/voiciOwner.js, voiciSignIn.js,
// voiciImage.js; docs/voici-and-messages.md §3, §5, §6, §7, §10): publishing against a fake `.com`, the seq-conflict
// retry, opening a real visitor message and dropping a tampered one, the state blob's compare-and-set merge, the
// sign-in link and answer (checked with chunk A's own checkVoiciSignInAnswer), the avatar re-encode ladder.
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import * as P from "../public/webapp/lib/voiciProtocol.js";
import {
  buildVoiciIndex,
  canonicalDraftsConsume,
  consumeDraftOps,
  defaultVoiciProfile,
  makeDraftOp,
  openInbox,
  publishVoiciPage,
  updateMessagesState,
  isRequest,
  isUnread,
  voiciWebOrigin,
} from "../public/webapp/lib/voiciOwner.js";
import { approveSignIn, parseVoiciSignInLink, pagePseudonym } from "../public/webapp/lib/voiciSignIn.js";
import { canonicalVoiciThreadFetch, checkReplies, markReplySeen, rememberVisitedPage, threadFetchBody } from "../public/webapp/lib/voiciReplies.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reencodeAvatar, squareCrop, VoiciImageError } from "../public/webapp/lib/voiciImage.js";

const U = "alice";
const UMK = new Uint8Array(32).fill(7);
const ADMIN_SEED = new Uint8Array(32).fill(9);
const ADMIN_PUB = P.hex(P.ed25519PublicKey(ADMIN_SEED));
const CA_SEED = new Uint8Array(32).fill(3);
const CA_PUB = P.hex(P.ed25519PublicKey(CA_SEED));
const NOW = 1_800_000_000_000;
const signer = { kind: "admin-root", pub: ADMIN_PUB, sign: async (b: Uint8Array) => P.ed25519SignHex(b, ADMIN_SEED) };
const session = { umk: UMK, username: U, adminRootSeed: ADMIN_SEED };
const profile = { accountId: U, deviceId: "a1".repeat(16) };

/** An in-memory `.com` for one account's page: pieces, publish (seq compare-and-set), username keys, state. */
function fakeCom() {
  const pieces = new Map<string, Uint8Array>();
  const state: { index: any; blob: any; publishes: any[]; conflictOnce: any } = { index: null, blob: null, publishes: [], conflictOnce: null };
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === `/api/username/${U}`) return json(200, { adminRootPub: ADMIN_PUB, irkPub: "11".repeat(32) });
    if (u.pathname === `/api/voici/pages/${U}` && (init.method ?? "GET") === "GET") return state.index ? json(200, { index: state.index }) : json(404, { code: "not-found" });
    if (u.pathname === `/api/voici/pages/${U}/pieces` && init.method === "POST") {
      const bytes = new Uint8Array(init.body);
      const sha = P.sha256Hex(bytes);
      expect(sha).toBe(init.headers["x-flagship-sha256"]);
      expect(Number(init.headers["x-flagship-size"])).toBe(bytes.length);
      expect(init.headers["x-flagship-signer-pub"]).toBe(ADMIN_PUB);
      const ok = P.verifyVoiciPieceUpload(
        { username: U, pageId: init.headers["x-flagship-page-id"], sha256: sha, size: bytes.length, issuedAt: Number(init.headers["x-flagship-issued-at"]) },
        init.headers["x-flagship-signature"],
        ADMIN_PUB,
      );
      if (!ok) return json(403, { code: "bad-signature" });
      pieces.set(sha, bytes);
      return json(200, { ok: true });
    }
    const piece = /^\/api\/voici\/pages\/alice\/pieces\/([0-9a-f]{64})$/.exec(u.pathname);
    if (piece) return pieces.has(piece[1]) ? new Response(pieces.get(piece[1])) : json(404, { code: "not-found" });
    if (u.pathname === `/api/voici/pages/${U}/publish`) {
      const idx = JSON.parse(init.body).index;
      if (state.conflictOnce) {
        const stored = state.conflictOnce;
        state.conflictOnce = null;
        state.index = stored;
        return json(409, { code: "seq-conflict", index: stored });
      }
      const r = P.checkVoiciPublish(idx, { username: U, sensitiveKind: "admin-root", sensitivePub: ADMIN_PUB, storedSeq: state.index?.seq ?? 0, storedPageId: state.index?.pageId ?? null, now: NOW });
      if (!r.ok) return json(409, { code: r.code });
      for (const p of idx.pieces) if (!pieces.has(p.sha256)) return json(400, { code: "missing-piece" });
      state.index = idx;
      state.publishes.push(idx);
      return json(200, { ok: true });
    }
    if (u.pathname === `/api/accounts/${U}/messages-state`) {
      if ((init.method ?? "GET") === "GET") return state.blob ? json(200, state.blob) : json(404, { code: "not-found" });
      const blob = JSON.parse(init.body);
      if (blob.version !== (state.blob?.version ?? 0) + 1) return json(409, { code: "version-conflict", state: state.blob });
      state.blob = blob;
      return json(200, { ok: true });
    }
    return json(404, { code: "not-found" });
  };
  return { fetch, state, pieces };
}

const deps = (com: ReturnType<typeof fakeCom>, extra: Record<string, unknown> = {}) => ({
  fetch: com.fetch,
  readFetch: (url: string, init: unknown) => com.fetch(url, init as any),
  now: () => NOW,
  session,
  profile,
  apex: "https://flagshipserver.com",
  signer,
  deviceSeed: new Uint8Array(32).fill(5),
  ...extra,
});

const post = (id: string, text: string, createdAt = NOW - 1000) => ({ id, createdAt, editedAt: null, text, links: [] });

describe("publishing a page from the webapp", () => {
  it("first publish uploads the pieces and signs seq 1 with the admin root", async () => {
    const com = fakeCom();
    const profileOp = makeDraftOp("profile", { profile: { ...defaultVoiciProfile(U), displayName: "Alice", bio: "Hi" } }, { deviceId: "d", now: NOW - 10 });
    const postOp = makeDraftOp("post-add", { post: post("ab".repeat(16), "First post") }, { deviceId: "d", now: NOW - 5 });
    const page = await publishVoiciPage({ ops: [profileOp, postOp] }, deps(com, { published: null }));
    expect(page.index.seq).toBe(1);
    expect(page.profile.displayName).toBe("Alice");
    expect(com.state.publishes).toHaveLength(1);
    const checked = P.checkVoiciPageIndex(com.state.index, { username: U, sensitiveKind: "admin-root", sensitivePub: ADMIN_PUB });
    expect(checked.ok).toBe(true);
    const keys = { inbox: P.deriveVoiciInboxKey({ seed: UMK }, page.index.pageId, 1), sign: P.deriveVoiciOwnerSignKey({ seed: UMK }, page.index.pageId, 1) };
    expect(page.index.inboxPub).toBe(P.hex(keys.inbox.publicKey));
    expect(page.index.ownerSignPub).toBe(P.hex(keys.sign.publicKey));
    expect(page.index.pieces.map((p: any) => p.role).sort()).toEqual(["chunk-0", "profile"]);
  });

  it("only new pieces upload, and a seq conflict merges onto the newer page and retries", async () => {
    const com = fakeCom();
    const first = await publishVoiciPage({ ops: [makeDraftOp("post-add", { post: post("01".repeat(16), "one") }, { now: NOW - 9 })] }, deps(com, { published: null }));
    // Another admin device publishes seq 2 meanwhile.
    const other = await buildVoiciIndex({
      username: U,
      published: first,
      merged: { profile: first.profile, acceptsMessages: 1, chunks: [[...first.chunks[0], post("02".repeat(16), "two", NOW - 500)]] },
      images: new Map(),
      signer,
      umk: { seed: UMK },
      now: NOW,
    });
    for (const u of other.uploads) com.pieces.set(u.sha256, u.bytes);
    com.state.conflictOnce = other.index;
    const page = await publishVoiciPage({ ops: [makeDraftOp("post-add", { post: post("03".repeat(16), "three", NOW - 100) }, { now: NOW - 1 })] }, deps(com, { published: first }));
    expect(page.index.seq).toBe(3);
    expect(page.acceptsMessages).toBe(1);
    expect(page.chunks.flat().map((p: any) => p.text)).toEqual(["one", "two", "three"]);
    expect(page.index.pageId).toBe(first.index.pageId);
  });
});

/** A signed-in visitor writing to the page: P, T, an attestation from CA_SEED, a P-256 browser key. */
function visitor(pageId: string, inboxPub: string) {
  const secret = P.deriveMessagesSecret({ seed: new Uint8Array(32).fill(42) });
  const p = P.deriveMessagesPseudonymKey(secret, pageId);
  const t = P.deriveMessagesThreadKey(secret, pageId);
  const Ppub = P.hex(p.publicKey);
  const tag = new Uint8Array(64).fill(1);
  const att: any = { kind: "MessagesKeyAttestation", version: 1, pseudonymPub: Ppub, abuseEpoch: 1, abuseTagHash: P.sha256Hex(tag), abuseTag: P.b64Encode(tag), issuedAt: NOW - 86_400_000, expiresAt: NOW + 86_400_000, signedBy: CA_PUB };
  att.signature = P.ed25519SignHex(P.canonicalMessagesKeyAttestation(att), CA_SEED);
  const bSk = new Uint8Array(32).fill(8);
  const bPub = P.hex(p256.getPublicKey(bSk, false));
  const delegation = { scope: "voici-messages", origin: "https://voi.ci", audience: pageId, principalPub: Ppub, delegateAlg: "p256", delegatePub: bPub, issuedAt: NOW - 1000, expiresAt: att.expiresAt, nonce: "00".repeat(16) };
  const threadStmt = { pageId, pseudonymPub: Ppub, threadPub: P.hex(t.publicKey), issuedAt: NOW - 1000 };
  const cred = { attestation: att, delegation, delegationSig: P.signWebDelegation(delegation, p.seed), threadStmt, threadSig: P.signVoiciThreadStatement(threadStmt, p.seed) };
  const conv = P.voiciConv(pageId, Ppub);
  let seq = 0;
  const send = (text: string, sentAt = NOW - 500) => {
    const msgId = P.hex(crypto.getRandomValues(new Uint8Array(16)));
    const body = P.sealVoiciBody({ conv, msgId, sentAt, fromPub: Ppub, recipients: [P.hexToBytes(inboxPub), t.publicKey], plaintext: { v: 1, text, replyTo: null } });
    return P.signWebEnvelopeP256({ v: 1, kind: "voici-message", audience: pageId, conv, from: Ppub, msgId, seq: ++seq, sentAt, bodyB64: P.b64Encode(body), cred }, bSk);
  };
  return { Ppub, conv, t, send };
}

describe("the inbox", () => {
  it("opens a visitor's message, drops a tampered one, and opens the owner's own reply", async () => {
    const com = fakeCom();
    const page = await publishVoiciPage({ ops: [makeDraftOp("accept-messages", { accepts: 1 }, { now: NOW - 1 })] }, deps(com, { published: null }));
    const v = visitor(page.index.pageId, page.index.inboxPub);
    const good = v.send("Hello https://example.com/x there");
    const bad = { ...v.send("evil"), sentAt: NOW - 400 };
    const inbox = openInbox(page, { items: [{ envelope: good, storedAt: NOW }, { envelope: bad, storedAt: NOW }], blocks: [], revoked: [] }, { umk: { seed: UMK }, caKeys: [CA_PUB], origin: voiciWebOrigin("flagshipserver.com") });
    expect(inbox.conversations).toHaveLength(1);
    const cv = inbox.conversations[0];
    expect(cv.pseudonymPub).toBe(v.Ppub);
    expect(cv.messages.map((m: any) => m.text)).toEqual(["Hello https://example.com/x there"]);
    expect(cv.threadPub).toBe(P.hex(v.t.publicKey));
    // seq 2 was dropped, seq 1 arrived: no gap. An unknown CA drops everything.
    expect(cv.gap).toBe(false);
    expect(openInbox(page, { items: [{ envelope: good, storedAt: NOW }] }, { umk: { seed: UMK }, caKeys: ["ff".repeat(32)], origin: "https://voi.ci" }).conversations).toHaveLength(0);
    const empty = P.emptyMessagesState();
    expect(isRequest(cv, empty)).toBe(true);
    expect(isUnread(cv, empty)).toBe(true);
    expect(isUnread(cv, { ...empty, readUpTo: { [cv.conv]: cv.messages[0].msgId } })).toBe(false);

    // The owner's reply, as sendReply builds it, opens on this device (its inbox copy) and on the visitor's (T).
    const keys = { inbox: P.deriveVoiciInboxKey({ seed: UMK }, page.index.pageId, 1), sign: P.deriveVoiciOwnerSignKey({ seed: UMK }, page.index.pageId, 1) };
    const msgId = "cd".repeat(16);
    const body = P.sealVoiciBody({ conv: cv.conv, msgId, sentAt: NOW, fromPub: P.hex(keys.sign.publicKey), recipients: [v.t.publicKey, keys.inbox.publicKey], plaintext: { v: 1, text: "Hi back", replyTo: null } });
    const reply = P.signWebEnvelopeEd25519({ v: 1, kind: "voici-reply", audience: page.index.pageId, conv: cv.conv, from: P.hex(keys.sign.publicKey), msgId, seq: 1, sentAt: NOW, bodyB64: P.b64Encode(body), cred: { pageSeq: 1 } }, keys.sign.seed);
    const both = openInbox(page, { items: [{ envelope: good, storedAt: NOW }, { envelope: reply, storedAt: NOW }] }, { umk: { seed: UMK }, caKeys: [CA_PUB], origin: "https://voi.ci" });
    expect(both.conversations[0].messages.map((m: any) => [m.mine, m.text])).toEqual([[false, "Hello https://example.com/x there"], [true, "Hi back"]]);
    expect(isRequest(both.conversations[0], empty)).toBe(false);
    expect(P.openVoiciBody(P.b64Decode(reply.bodyB64), { conv: cv.conv, msgId }, v.t.seed).ok).toBe(true);
  });
});

describe("consuming published drafts", () => {
  it("signs flagship/voici-drafts-consume/v1 over the sorted opIds with the sensitive key (the iOS/Android wire)", async () => {
    let sent: any = null;
    const fetch = async (url: string, init: any) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response("{}", { status: 200 });
    };
    await consumeDraftOps(["bb".repeat(16), "aa".repeat(16)], { fetch, now: () => NOW, session, profile, apex: "https://flagshipserver.com", signer });
    expect(sent.url).toBe("https://flagshipserver.com/api/accounts/alice/voici-drafts/consume");
    expect(new TextDecoder().decode(canonicalDraftsConsume(U, sent.body.opIds, NOW))).toBe(`flagship/voici-drafts-consume/v1|alice|${"aa".repeat(16)},${"bb".repeat(16)}|${NOW}`);
    expect(sent.body).toMatchObject({ issuedAt: NOW, signerPub: ADMIN_PUB });
    expect(P.ed25519VerifyHex(sent.body.signature, canonicalDraftsConsume(U, sent.body.opIds, NOW), ADMIN_PUB)).toBe(true);
  });
});

describe("the Messages state blob", () => {
  it("writes version 1, then merges on a conflict and writes stored + 1", async () => {
    const com = fakeCom();
    const d = deps(com);
    const a = await updateMessagesState((s: any) => ({ ...s, blocks: ["aa".repeat(32)] }), d);
    expect(a.version).toBe(1);
    // Another device wrote version 2 meanwhile.
    const stateKey = P.deriveMessagesStateKey({ seed: UMK });
    com.state.blob = P.sealMessagesState(stateKey, U, 2, { ...P.emptyMessagesState(), nicknames: { ["bb".repeat(32)]: { name: "Sam", at: 5 } }, blocks: ["aa".repeat(32)] });
    const b = await updateMessagesState((s: any) => ({ ...s, accepted: [...s.accepted, "cc".repeat(32)] }), { ...d, current: a });
    expect(b.version).toBe(3);
    const opened = P.openMessagesState(stateKey, U, com.state.blob);
    expect(opened?.nicknames["bb".repeat(32)]?.name).toBe("Sam");
    expect(opened?.accepted).toEqual(["cc".repeat(32)]);
    expect(opened?.blocks).toEqual(["aa".repeat(32)]);
  });
});

describe("Sign in with Flagship from the webapp", () => {
  const PAGE = "0123456789abcdef0123456789abcdef";
  const bSk = new Uint8Array(32).fill(4);
  const D = P.hex(p256.getPublicKey(bSk, false));
  const link = `https://flagshipserver.com/voici-sign-in#s=abcdefghijklmnop&k=${"A".repeat(43)}&p=${PAGE}&u=bob&d=${D}&n=${"12".repeat(16)}`;

  it("parses the sign-in link (the C: fragment form) and refuses anything else", () => {
    const parsed = parseVoiciSignInLink(link, "flagshipserver.com");
    expect(parsed).toMatchObject({ sid: "abcdefghijklmnop", browserPk: "A".repeat(43), pageId: PAGE, username: "bob" });
    expect(parsed!.request).toEqual({ kind: P.TAG_VOICI_SIGN_IN_REQUEST, origin: "https://voi.ci", pageId: PAGE, username: "bob", delegatePub: D, nonce: "12".repeat(16) });
    expect(parseVoiciSignInLink(link.replace("flagshipserver.com/", "gym.flagshipserver.com/"), "gym.flagshipserver.com")!.request.origin).toBe("https://gym.voi.ci");
    expect(parseVoiciSignInLink(link.replace(`&d=${D}`, ""), "flagshipserver.com")).toBeNull();
    expect(parseVoiciSignInLink(link.replace("/voici-sign-in", "/remote"), "flagshipserver.com")).toBeNull();
    expect(parseVoiciSignInLink(link.replace("https://flagshipserver.com", "https://evil.example"), "flagshipserver.com")).toBeNull();
    expect(parseVoiciSignInLink(link.replace(`p=${PAGE}`, "p=xyz"), "flagshipserver.com")).toBeNull();
  });

  it("answers with a delegation to the tab's key that voi.ci's check accepts, on the slow tier", async () => {
    const parsed = parseVoiciSignInLink(link, "flagshipserver.com")!;
    const request = parsed.request;
    const { p } = pagePseudonym(UMK, PAGE);
    const Ppub = P.hex(p.publicKey);
    let asked: any = null;
    const fetch = async (url: string, init: any) => {
      asked = { url, body: JSON.parse(init.body), headers: init.headers };
      const tag = new Uint8Array(32).fill(2);
      const att: any = { kind: "MessagesKeyAttestation", version: 1, pseudonymPub: Ppub, abuseEpoch: 1, abuseTagHash: P.sha256Hex(tag), abuseTag: P.b64Encode(tag), issuedAt: NOW, expiresAt: NOW + 30 * 86_400_000, signedBy: CA_PUB };
      att.signature = P.ed25519SignHex(P.canonicalMessagesKeyAttestation(att), CA_SEED);
      return new Response(JSON.stringify({ attestation: att }), { status: 200 });
    };
    let recorded: any = null;
    const answer = await approveSignIn(parsed, request, {
      fetch,
      now: () => NOW,
      session,
      profile,
      apex: "https://flagshipserver.com",
      deviceSeed: new Uint8Array(32).fill(5),
      caKeys: [CA_PUB],
      origin: "https://voi.ci",
      updateState: async (fn: any) => (recorded = fn(P.emptyMessagesState())),
    });
    expect(asked.url).toBe("https://flagshipserver.com/api/accounts/alice/messages-attestation");
    expect(asked.body.request.deviceCheckRef).toBe("none");
    expect(asked.body.request.pseudonymPub).toBe(Ppub);
    expect(P.verifyMessagesKeyAttestationRequest(asked.body.request, asked.body.signature, P.hex(P.ed25519PublicKey(new Uint8Array(32).fill(5))))).toBe(true);
    expect(asked.headers["x-flagship-device-id"]).toBe(profile.deviceId);
    const checked = P.checkVoiciSignInAnswer(answer, { request, caKeys: [CA_PUB], now: NOW });
    expect(checked.ok).toBe(true);
    expect(recorded.signedInSites).toEqual([{ pageId: PAGE, delegatePub: request.delegatePub, at: NOW }]);
    await expect(approveSignIn(parsed, { ...request, origin: "https://evil.example" }, { session, now: () => NOW, origin: "https://voi.ci" })).rejects.toMatchObject({ code: "bad-request" });
  });
});

describe("reply alerts on the visitor's side", () => {
  const M = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors", "messages", "vectors.json"), "utf8"));

  it("builds the thread-fetch bytes the shared vectors pin", () => {
    expect(new TextDecoder().decode(canonicalVoiciThreadFetch(M.threadFetch.fetch))).toBe(M.threadFetch.canonical);
  });

  it("signs its own delegated fetch and alerts once per newer owner reply that opens with T", async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const com = fakeCom();
    // Bob's page, owned by another UMK.
    const BOB_UMK = new Uint8Array(32).fill(11);
    const bobSigner = { kind: "admin-root", pub: ADMIN_PUB, sign: signer.sign };
    const built = await buildVoiciIndex({ username: "bob", published: null, merged: { profile: defaultVoiciProfile("bob"), acceptsMessages: 1, chunks: [] }, images: new Map(), signer: bobSigner, umk: { seed: BOB_UMK }, now: NOW });
    const pageId = built.index.pageId;
    const { p, t } = pagePseudonym(UMK, pageId);
    const Ppub = P.hex(p.publicKey);
    const conv = P.voiciConv(pageId, Ppub);
    const owner = P.deriveVoiciOwnerSignKey({ seed: BOB_UMK }, pageId, 1);
    const inbox = P.deriveVoiciInboxKey({ seed: BOB_UMK }, pageId, 1);
    const reply = (msgId: string, at: number, threadPub = t.publicKey) => {
      const body = P.sealVoiciBody({ conv, msgId, sentAt: at, fromPub: P.hex(owner.publicKey), recipients: [threadPub, inbox.publicKey], plaintext: { v: 1, text: "hi", replyTo: null } });
      return P.signWebEnvelopeEd25519({ v: 1, kind: "voici-reply", audience: pageId, conv, from: P.hex(owner.publicKey), msgId, seq: 1, sentAt: at, bodyB64: P.b64Encode(body), cred: { pageSeq: 1 } }, owner.seed);
    };
    const tag = new Uint8Array(32).fill(2);
    const att: any = { kind: "MessagesKeyAttestation", version: 1, pseudonymPub: Ppub, abuseEpoch: 1, abuseTagHash: P.sha256Hex(tag), abuseTag: P.b64Encode(tag), issuedAt: NOW - 1000, expiresAt: NOW + 20 * 86_400_000, signedBy: CA_PUB };
    att.signature = P.ed25519SignHex(P.canonicalMessagesKeyAttestation(att), CA_SEED);
    mem.set(`flagship.voici.att.alice.${pageId}`, JSON.stringify(att));
    let fetched: any = null;
    const items = [{ envelope: reply("aa".repeat(16), NOW - 50) }, { envelope: reply("bb".repeat(16), NOW - 10, P.deriveMessagesThreadKey(new Uint8Array(32), pageId).publicKey) }];
    const fetch = async (url: string, init: any = {}) => {
      const u = new URL(url);
      if (u.pathname === "/api/voici/pages/bob") return new Response(JSON.stringify({ index: built.index }));
      if (u.pathname === "/api/username/bob") return new Response(JSON.stringify({ adminRootPub: ADMIN_PUB, irkPub: "11".repeat(32) }));
      if (u.pathname === "/api/voici/web/thread") {
        fetched = JSON.parse(init.body);
        return new Response(JSON.stringify({ items, next: "" }));
      }
      return com.fetch(url, init);
    };
    globalThis.localStorage = storage as any;
    const deps = { fetch, now: () => NOW, session, profile, apex: "https://flagshipserver.com", caKeys: [CA_PUB], origin: "https://voi.ci", storage };
    rememberVisitedPage(pageId, "bob", deps);
    const alerts = await checkReplies(deps);
    // The second reply is sealed to another thread key: it doesn't count.
    expect(alerts).toEqual([{ pageId, username: "bob", at: NOW - 50 }]);
    // `.com`'s checks pass: delegation by P to the fetch's key, the thread statement, the P-256 signature.
    const d = P.checkWebDelegation(fetched.cred.delegation, fetched.cred.delegationSig, { scope: "voici-messages", origin: "https://voi.ci", audience: pageId, principalPub: Ppub, now: NOW, notAfter: att.expiresAt });
    expect(d.ok).toBe(true);
    expect(P.p256VerifyP1363(fetched.sig, canonicalVoiciThreadFetch(fetched), fetched.cred.delegation.delegatePub)).toBe(true);
    expect(fetched.conv).toBe(conv);
    markReplySeen(pageId, NOW - 50, deps);
    expect(await checkReplies(deps)).toEqual([]);
    expect((await threadFetchBody(pageId, deps)).body.cred.threadStmt.threadPub).toBe(P.hex(t.publicKey));
  });
});

describe("the page photo", () => {
  it("crops the centre square and steps the JPEG quality down until it fits", async () => {
    expect(squareCrop(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    const qualities: number[] = [];
    const jpeg = (n: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0, 0, 0xff, 0xda, ...new Array(n).fill(0)]);
    const bytes = await reencodeAvatar(new Blob([]), {
      decode: async () => ({ width: 1000, height: 800, source: {} }),
      encode: async (_s: unknown, crop: unknown, size: number, q: number) => {
        expect(size).toBe(512);
        expect(crop).toEqual({ sx: 100, sy: 0, side: 800 });
        qualities.push(q);
        return jpeg(q > 0.7 ? 200 * 1024 : 100 * 1024);
      },
    });
    expect(qualities).toEqual([0.82, 0.76, 0.7]);
    expect(bytes.length).toBeLessThanOrEqual(150 * 1024);
    await expect(reencodeAvatar(new Blob([]), { decode: async () => ({ width: 10, height: 10, source: {} }), encode: async () => jpeg(200 * 1024) })).rejects.toBeInstanceOf(VoiciImageError);
    // A browser's own APP2 (ICC) or an APP1 is dropped; the scan is kept as written.
    const withMeta = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 1, 2, 0xff, 0xe1, 0x00, 0x04, 0, 0, 0xff, 0xe2, 0x00, 0x03, 7, 0xff, 0xda, 9, 9]);
    const clean = await reencodeAvatar(new Blob([]), { decode: async () => ({ width: 10, height: 10, source: {} }), encode: async () => withMeta });
    expect([...clean]).toEqual([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 1, 2, 0xff, 0xda, 9, 9]);
    expect(P.voiciJpegHasMetadata(clean)).toBe(false);
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 0]);
    await expect(reencodeAvatar(new Blob([]), { decode: async () => ({ width: 10, height: 10, source: {} }), encode: async () => broken })).rejects.toMatchObject({ code: "unreadable" });
  });
});
