import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { p256 } from "@noble/curves/nist.js";
import {
  b64Encode,
  canonicalWebDelegationRevoke,
  checkVoiciMessage,
  sealVoiciBody,
  signAccountDirectoryRequest,
  signWebDelegation,
  signWebEnvelopeEd25519,
  signVoiciBlock,
  signVoiciThreadFetchP256,
  signWebDelegationRevoke,
  ed,
  type VoiciMessageCheckContext,
} from "@flagship/protocol";
import {
  checkVoiciMessageFast,
  handleMessagesStateGet,
  handleMessagesStatePut,
  handleVoiciBlock,
  handleVoiciInbox,
  handleVoiciPublish,
  handleVoiciRevoke,
  handleVoiciSend,
  handleVoiciThread,
  handleVoiciPieceUpload,
  runVoiciGc,
  voiciPieceKey,
  type VoiciMailboxDeps,
  type VoiciOwnerDeps,
} from "../src/index.js";
import { adminPub, buildPage, caPub, fakeBucket, hex, inbox, irkPub, ORIGIN, ownerSign, PAGE_ID, uploadHeaders, USER, visitor } from "./support/voiciFixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/messages/vectors.json"), "utf8"));
const T0 = 1_800_000_000_000;

describe("checkVoiciMessageFast", () => {
  it("gives checkVoiciMessage's verdict on every shared vector", async () => {
    for (const c of vectors.message.checks as { name: string; envelope: unknown; ctx: Record<string, unknown>; expected: string }[]) {
      const ctx = c.ctx as unknown as VoiciMessageCheckContext & { blocked?: string[]; revoked?: string[]; rateLimited?: boolean };
      const slow = checkVoiciMessage(c.envelope, {
        ...ctx,
        blocked: ctx.blocked ? new Set(ctx.blocked) : undefined,
        revoked: ctx.revoked ? new Set(ctx.revoked) : undefined,
        rateLimit: ctx.rateLimited ? () => "rate-limited" : undefined,
      } as VoiciMessageCheckContext);
      const fast = await checkVoiciMessageFast(c.envelope, new TextEncoder().encode(JSON.stringify(c.envelope)).length, {
        pageId: ctx.pageId,
        acceptsMessages: ctx.acceptsMessages,
        origin: ctx.origin,
        caKeys: ctx.caKeys,
        now: ctx.now,
        isBlocked: async (p) => !!ctx.blocked?.includes(p),
        isRevoked: async (d) => !!ctx.revoked?.includes(d),
        rateLimit: async () => (ctx.rateLimited ? "rate-limited" : null),
      });
      const verdict = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
      expect([c.name, verdict(fast)]).toEqual([c.name, c.expected]);
      expect(verdict(fast)).toBe(verdict(slow as { ok: boolean; code?: string }));
    }
  });
});

async function mailbox(opts: { accepts?: 0 | 1 } = {}) {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: USER, irkPubHex: irkPub, adminRootPubHex: adminPub, claimedAt: 1 });
  const bucket = fakeBucket();
  let now = T0;
  const pagesDeps = { voici: storage.voici, usernames: storage.usernames, bucket, now: () => now };
  const page = buildPage({ seq: 1, issuedAt: T0, accepts: opts.accepts ?? 1 });
  for (const bytes of page.pieces.values()) await handleVoiciPieceUpload(pagesDeps, USER, uploadHeaders(bytes, T0), bytes);
  expect((await handleVoiciPublish(pagesDeps, USER, JSON.stringify(page.index))).status).toBe(200);
  const pushes: string[] = [];
  const limits = { ip: null as number | null, page: null as number | null };
  const calls = { caKeys: 0, limitSend: 0 };
  const deps: VoiciMailboxDeps = {
    voici: storage.voici,
    origin: ORIGIN,
    caKeys: () => (calls.caKeys++, [caPub]),
    limitSend: async () => (calls.limitSend++, limits.ip),
    limitNewConversation: async () => limits.page,
    push: { message: async (_u, kind) => (pushes.push(kind), 1), pageDrafts: async () => 0 },
    now: () => now,
  };
  const deviceSeed = new Uint8Array(32).fill(0x72);
  const device = { privateKey: deviceSeed, publicKey: ed.getPublicKey(deviceSeed) };
  const deviceId = "cd".repeat(16);
  await storage.deviceIdentities.put({ accountId: USER, deviceId, devicePubHex: hex(device.publicKey), platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null });
  let rid = 0;
  const owner: VoiciOwnerDeps = {
    voici: storage.voici,
    readTokens: {
      secret: undefined,
      // A demo account: its demo row and an account row marked demo (security review M5).
      usernames: { get: async (u: string) => ({ ...(await storage.usernames.get(u))!, isDemo: true }) } as never,
      identities: storage.deviceIdentities,
      servers: storage.servers,
      demoUsers: { get: async () => ({ username: USER }) } as never,
      nonces: { claim: async () => true },
    },
    directory: { identities: storage.deviceIdentities, nonces: { claim: async () => true }, now: () => now },
    now: () => now,
  };
  const deviceAuth = (method: string, path: string) => {
    const request = { accountId: USER, deviceId, signerPubHex: hex(device.publicKey), method, path, requestId: (++rid).toString(16).padStart(32, "0"), issuedAt: now };
    return { request, signature: signAccountDirectoryRequest(request, device) };
  };
  const send = async (env: unknown, direct = false) => {
    const r = await handleVoiciSend(deps, JSON.stringify(direct ? { envelope: env, direct } : env));
    return { status: r.status, body: r.body as Record<string, unknown> };
  };
  return { storage, bucket, deps, owner, send, pushes, limits, calls, deviceAuth, setNow: (t: number) => (now = t) };
}

describe("voi.ci send", () => {
  it("stores a message once, pushes a request, and caps a conversation at 3 before a reply", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    const first = v.message(T0);
    expect((await m.send(first)).body).toEqual({ ok: true, status: "accepted", msgId: first.msgId, storedAt: T0 });
    expect((await m.send(first, true)).body).toEqual({ ok: true, status: "accepted", msgId: first.msgId });
    await m.send(v.message(T0));
    await m.send(v.message(T0));
    expect(m.pushes).toEqual(["message-request"]);
    const fourth = await m.send(v.message(T0));
    expect([fourth.status, fourth.body.code]).toEqual([429, "awaiting-reply"]);
    expect((await m.send(v.reply(T0, "aa".repeat(16)))).body.status).toBe("accepted");
    m.setNow(T0 + 2 * 3_600_000);
    expect((await m.send(v.message(T0 + 2 * 3_600_000))).status).toBe(200);
    expect(m.pushes).toEqual(["message-request", "message"]);
  });

  it("drops a blocked sender without saying so, and lets an unblocked one past the cap", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    const order = (op: "block" | "unblock", issuedAt: number) => ({ pageId: PAGE_ID, pseudonymPub: v.pPub, op, issuedAt });
    const block = order("block", T0);
    expect((await handleVoiciBlock(m.owner, USER, { block, signature: signVoiciBlock(block, ownerSign.seed) })).status).toBe(200);
    const env = v.message(T0);
    expect((await m.send(env)).body).toEqual({ ok: true, status: "accepted", msgId: env.msgId });
    expect(await m.storage.voici.listInbox(PAGE_ID, 0, 10)).toEqual([]);
    const unblock = order("unblock", T0 + 1);
    await handleVoiciBlock(m.owner, USER, { block: unblock, signature: signVoiciBlock(unblock, ownerSign.seed) });
    for (let i = 0; i < 4; i++) expect((await m.send(v.message(T0))).status).toBe(200);
    const forged = order("block", T0 + 2);
    expect((await handleVoiciBlock(m.owner, USER, { block: forged, signature: signVoiciBlock(forged, new Uint8Array(32).fill(9)) })).status).toBe(403);
  });

  it("refuses a page that does not accept, a busy page, a limited network and a reply to nobody", async () => {
    const closed = await mailbox({ accepts: 0 });
    expect((await closed.send(visitor(T0).message(T0))).body.code).toBe("not-accepting");
    const m = await mailbox();
    m.limits.page = 600;
    const busy = await m.send(visitor(T0).message(T0));
    expect([busy.status, busy.body.code, busy.body.retryAfterSec]).toEqual([429, "page-busy", 600]);
    m.limits.page = null;
    m.limits.ip = 120;
    expect((await m.send(visitor(T0, 2).message(T0))).body).toMatchObject({ code: "rate-limited", retryAfterSec: 120 });
    m.limits.ip = null;
    expect((await m.send(visitor(T0, 3).reply(T0, "bb".repeat(16)))).body.code).toBe("not-found");
    expect((await m.send({ v: 1 })).body.code).toBe("malformed");
  });
});

describe("voi.ci thread, inbox, revoke, state", () => {
  it("serves the visitor's own thread to its browser key, with delivery", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    await m.send(v.message(T0));
    await m.send(v.reply(T0, "aa".repeat(16)));
    const fetchBody = (since: string) => {
      const fetch = { conv: v.conv, since, issuedAt: T0 };
      return { ...fetch, sig: signVoiciThreadFetchP256(fetch, v.browserPriv), cred: v.cred };
    };
    type Items = { items: { id: string; envelope: { kind: string }; fetchedAt: number | null; direct: boolean }[]; next: string };
    const b1 = (await handleVoiciThread(m.deps, fetchBody(""))).body as Items;
    expect(b1.items.map((x) => [x.envelope.kind, x.fetchedAt, x.direct])).toEqual([["voici-message", null, false], ["voici-reply", null, false]]);
    const inbox = await handleVoiciInbox(m.owner, USER, "", null);
    const ib = inbox.body as { items: unknown[]; cursor: string; blocks: string[]; revoked: string[] };
    expect([ib.items.length, ib.blocks, ib.revoked]).toEqual([2, [], []]);
    const b2 = (await handleVoiciThread(m.deps, fetchBody(""))).body as Items;
    expect(b2.items[0]!.fetchedAt).toBe(T0);
    expect(((await handleVoiciThread(m.deps, fetchBody(b1.next))).body as Items).items).toEqual([]);
    const wrapped = { fetch: { conv: v.conv, since: "", issuedAt: T0 }, signature: fetchBody("").sig, cred: v.cred };
    expect((await handleVoiciThread(m.deps, wrapped)).status).toBe(200);
    const other = visitor(T0, 2);
    const stolen = { fetch: { conv: v.conv, since: "", issuedAt: T0 }, signature: signVoiciThreadFetchP256({ conv: v.conv, since: "", issuedAt: T0 }, other.browserPriv), cred: other.cred };
    expect(((await handleVoiciThread(m.deps, stolen)).body as { code: string }).code).toBe("wrong-conv");
  });

  it("signs a browser key out for good: sends and thread fetches refused", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    const revoke = { delegatePub: v.browserPub, issuedAt: T0 };
    const other = visitor(T0, 2);
    expect((await handleVoiciRevoke(m.deps, { revoke, signature: signWebDelegationRevoke(revoke, other.pseud.seed), delegation: v.cred.delegation, delegationSig: v.cred.delegationSig })).status).toBe(403);
    const delegateSig = hex(p256.sign(canonicalWebDelegationRevoke(revoke), v.browserPriv, { lowS: true }));
    expect((await handleVoiciRevoke(m.deps, { revoke, signature: signWebDelegationRevoke(revoke, v.pseud.seed), delegation: v.cred.delegation, delegationSig: v.cred.delegationSig, delegateSig })).status).toBe(200);
    expect((await m.send(v.message(T0))).body.code).toBe("revoked");
    const w = visitor(T0, 3);
    await m.send(w.message(T0));
    const r3 = { delegatePub: w.browserPub, issuedAt: T0 };
    expect((await handleVoiciRevoke(m.deps, { revoke: r3, signature: signWebDelegationRevoke(r3, w.pseud.seed), principalPub: other.pPub })).status).toBe(403);
    // A stranger who knows w's browser key signs with its own pseudonym: it never sent with that key, so nothing is stored.
    const stranger = await handleVoiciRevoke(m.deps, { revoke: r3, signature: signWebDelegationRevoke(r3, other.pseud.seed), principalPub: other.pPub });
    expect([stranger.status, (stranger.body as { code: string }).code]).toEqual([404, "unknown-delegate"]);
    expect(await m.deps.voici.isRevoked(w.browserPub, w.pPub, T0)).toBe(false);
    expect((await handleVoiciRevoke(m.deps, { revoke: r3, signature: signWebDelegationRevoke(r3, w.pseud.seed), principalPub: w.pPub })).status).toBe(200);
    expect((await m.send(w.message(T0))).body.code).toBe("revoked");
    const inbox = await handleVoiciInbox(m.owner, USER, "", null);
    expect((inbox.body as { revoked: string[] }).revoked).toEqual([v.browserPub, w.browserPub].sort());
  });

  it("moves the state blob only to the next version", async () => {
    const m = await mailbox();
    const path = `/api/accounts/${USER}/messages-state`;
    const blob = (version: number) => JSON.stringify({ state: { version, nonce: "00".repeat(12), ct: "AAAA" } });
    expect((await handleMessagesStatePut(m.owner, USER, m.deviceAuth("PUT", path), blob(1))).status).toBe(200);
    const conflict = await handleMessagesStatePut(m.owner, USER, m.deviceAuth("PUT", path), blob(1));
    expect([conflict.status, (conflict.body as { code: string }).code]).toEqual([409, "version-conflict"]);
    expect((await handleMessagesStatePut(m.owner, USER, undefined, blob(2))).status).toBe(403);
    expect((await handleMessagesStateGet(m.owner, USER, null)).body).toEqual({ version: 1, nonce: "00".repeat(12), ct: "AAAA" });
    const bare = JSON.stringify({ version: 2, nonce: "00".repeat(12), ct: "AAAA" });
    expect((await handleMessagesStatePut(m.owner, USER, m.deviceAuth("PUT", path), bare)).status).toBe(200);
  });

  it("collects old pieces, mail, drafts and revocations", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    await m.send(v.message(T0));
    await m.storage.voici.putPiece({ pageId: PAGE_ID, sha256: "ab".repeat(32), username: USER, size: 1, jpeg: false, uploadedAt: T0, unreferencedAt: T0 });
    m.bucket.objects.set(voiciPieceKey(PAGE_ID, "ab".repeat(32)), { bytes: new Uint8Array(1) });
    expect(await runVoiciGc({ voici: m.storage.voici, bucket: m.bucket }, T0 + 31 * 86_400_000)).toEqual({ pieces: 1, messages: 0, drafts: 0, revoked: 0, alerts: 0 });
    expect(m.bucket.objects.has(voiciPieceKey(PAGE_ID, "ab".repeat(32)))).toBe(false);
    expect((await runVoiciGc({ voici: m.storage.voici, bucket: m.bucket }, T0 + 181 * 86_400_000)).messages).toBe(1);
  });
});

/** A voici-reply signed by any page owner's key, into any conversation. */
function forgedReply(pageId: string, seed: Uint8Array, conv: string, msgId: string, sentAt: number) {
  const from = hex(ed.getPublicKey(seed));
  const body = sealVoiciBody({ conv, msgId, sentAt, fromPub: from, recipients: [inbox.publicKey, inbox.publicKey], plaintext: { v: 1, text: "Hi!", replyTo: null } });
  return signWebEnvelopeEd25519({ v: 1, kind: "voici-reply", audience: pageId, conv, from, msgId, seq: 1, sentAt, bodyB64: b64Encode(body), cred: { pageSeq: 1 } }, seed);
}

const MALLORY_PAGE = "a0".repeat(16);
const mallorySeed = new Uint8Array(32).fill(0x7a);
async function malloryPage(m: Awaited<ReturnType<typeof mailbox>>) {
  await m.storage.voici.publishPage(
    { username: "mallory", pageId: MALLORY_PAGE, seq: 1, issuedAt: 1, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: hex(ed.getPublicKey(mallorySeed)), indexJson: "{}", publishedAt: 1 },
    0,
  );
}

describe("a reply stays in its own page's conversations (security review M2)", () => {
  it("refuses a reply another page's owner signs into this page's conversation, and the cap still holds", async () => {
    const m = await mailbox();
    await malloryPage(m);
    const v = visitor(T0);
    for (let i = 0; i < 3; i++) expect((await m.send(v.message(T0))).status).toBe(200);
    const forged = await m.send(forgedReply(MALLORY_PAGE, mallorySeed, v.conv, "ee".repeat(16), T0));
    expect([forged.status, forged.body.code]).toEqual([404, "not-found"]);
    expect(await m.storage.voici.listInbox(MALLORY_PAGE, 0, 10)).toEqual([]);
    const fourth = await m.send(v.message(T0));
    expect([fourth.status, fourth.body.code]).toEqual([429, "awaiting-reply"]);
    // The real owner's reply still opens the conversation.
    expect((await m.send(v.reply(T0, "aa".repeat(16)))).body.status).toBe("accepted");
    expect((await m.send(v.message(T0))).status).toBe(200);
  });

  it("never counts or shows another page's row in a conversation, however it got there", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    for (let i = 0; i < 3; i++) await m.send(v.message(T0));
    const planted = forgedReply(MALLORY_PAGE, mallorySeed, v.conv, "ef".repeat(16), T0);
    await m.storage.voici.insertMessage({
      pageId: MALLORY_PAGE, conv: v.conv, msgId: planted.msgId, kind: "voici-reply", fromPub: planted.from, delegatePub: null, sentAt: T0,
      envelope: JSON.stringify(planted), size: 1, direct: false, pushed: false, storedAt: T0,
    });
    expect((await m.send(v.message(T0))).body.code).toBe("awaiting-reply");
    const fetch = { conv: v.conv, since: "", issuedAt: T0 };
    const thread = (await handleVoiciThread(m.deps, { ...fetch, sig: signVoiciThreadFetchP256(fetch, v.browserPriv), cred: v.cred })).body as { items: { envelope: { kind: string } }[] };
    expect(thread.items.map((x) => x.envelope.kind)).toEqual(["voici-message", "voici-message", "voici-message"]);
  });
});

describe("voi.ci send: a replay costs the network's budget, not the signature checks (Low b)", () => {
  it("counts a replayed envelope against the per-IP limit and answers it without verifying again", async () => {
    const m = await mailbox();
    const env = visitor(T0).message(T0);
    expect((await m.send(env)).body.storedAt).toBe(T0);
    const [ca, ip] = [m.calls.caKeys, m.calls.limitSend];
    expect((await m.send(env)).body).toEqual({ ok: true, status: "accepted", msgId: env.msgId });
    expect([m.calls.caKeys, m.calls.limitSend]).toEqual([ca, ip + 1]);
    m.limits.ip = 90;
    const limited = await m.send(env);
    expect([limited.status, limited.body.code, limited.body.retryAfterSec]).toEqual([429, "rate-limited", 90]);
    expect(m.calls.caKeys).toBe(ca);
  });

  it("still verifies an envelope that reuses a stored msgId with other content", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    const env = v.message(T0, "Hello", "12".repeat(16));
    await m.send(env);
    const tampered = { ...env, seq: env.seq + 1 };
    expect((await m.send(tampered)).body.code).toBe("bad-signature");
  });
});

describe("voi.ci revoke: only the key's own pseudonym, only for itself (Low a)", () => {
  it("refuses a stranger's self-made delegation for someone else's browser key", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    await m.send(v.message(T0));
    const stranger = visitor(T0, 2);
    // The stranger delegates to v's browser key under its own pseudonym and signs the revoke itself.
    const delegation = { ...stranger.cred.delegation, delegatePub: v.browserPub };
    const revoke = { delegatePub: v.browserPub, issuedAt: T0 };
    const r = await handleVoiciRevoke(m.deps, {
      revoke,
      signature: signWebDelegationRevoke(revoke, stranger.pseud.seed),
      delegation,
      delegationSig: signWebDelegation(delegation, stranger.pseud.seed),
    });
    expect([r.status, (r.body as { code: string }).code]).toEqual([404, "unknown-delegate"]);
    expect((await m.send(v.message(T0))).status).toBe(200);
    // A signature by a key that is not the delegate's proves nothing either.
    const wrongSig = hex(p256.sign(canonicalWebDelegationRevoke(revoke), stranger.browserPriv, { lowS: true }));
    const r2 = await handleVoiciRevoke(m.deps, {
      revoke,
      signature: signWebDelegationRevoke(revoke, stranger.pseud.seed),
      delegation,
      delegationSig: signWebDelegation(delegation, stranger.pseud.seed),
      delegateSig: wrongSig,
    });
    expect(r2.status).toBe(403);
    expect((await m.send(v.message(T0))).status).toBe(200);
  });

  it("keeps one pseudonym's revocation from touching another pseudonym's use of the same key", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    await m.send(v.message(T0));
    const stranger = visitor(T0, 2);
    // Even a stored revocation under the stranger's pseudonym leaves v's delegation alone.
    await m.storage.voici.revokeDelegate({ delegatePub: v.browserPub, pageId: PAGE_ID, principalPub: stranger.pPub, expiresAt: T0 + 86_400_000, revokedAt: T0 });
    expect((await m.send(v.message(T0))).status).toBe(200);
    const revoke = { delegatePub: v.browserPub, issuedAt: T0 };
    expect((await handleVoiciRevoke(m.deps, { revoke, signature: signWebDelegationRevoke(revoke, v.pseud.seed), principalPub: v.pPub })).status).toBe(200);
    expect((await m.send(v.message(T0))).body.code).toBe("revoked");
  });

  it("keeps a revocation no longer than a delegation can live, whatever expiry the delegation names", async () => {
    const m = await mailbox();
    const v = visitor(T0);
    await m.send(v.message(T0));
    const delegation = { ...v.cred.delegation, expiresAt: T0 + 3650 * 86_400_000 };
    const revoke = { delegatePub: v.browserPub, issuedAt: T0 };
    expect(
      (await handleVoiciRevoke(m.deps, { revoke, signature: signWebDelegationRevoke(revoke, v.pseud.seed), delegation, delegationSig: signWebDelegation(delegation, v.pseud.seed) })).status,
    ).toBe(200);
    expect(await m.storage.voici.isRevoked(v.browserPub, v.pPub, T0 + 29 * 86_400_000)).toBe(true);
    expect(await m.storage.voici.isRevoked(v.browserPub, v.pPub, T0 + 31 * 86_400_000)).toBe(false);
  });
});
