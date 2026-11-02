import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  checkVoiciMessage,
  signAccountDirectoryRequest,
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
import { adminPub, buildPage, caPub, fakeBucket, hex, irkPub, ORIGIN, ownerSign, PAGE_ID, uploadHeaders, USER, visitor } from "./support/voiciFixture.js";

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
  const deps: VoiciMailboxDeps = {
    voici: storage.voici,
    origin: ORIGIN,
    caKeys: () => [caPub],
    limitSend: async () => limits.ip,
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
      usernames: storage.usernames,
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
  return { storage, bucket, deps, owner, send, pushes, limits, deviceAuth, setNow: (t: number) => (now = t) };
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
    expect((await handleVoiciRevoke(m.deps, { revoke, signature: signWebDelegationRevoke(revoke, v.pseud.seed), delegation: v.cred.delegation, delegationSig: v.cred.delegationSig })).status).toBe(200);
    expect((await m.send(v.message(T0))).body.code).toBe("revoked");
    const w = visitor(T0, 3);
    await m.send(w.message(T0));
    const r3 = { delegatePub: w.browserPub, issuedAt: T0 };
    expect((await handleVoiciRevoke(m.deps, { revoke: r3, signature: signWebDelegationRevoke(r3, w.pseud.seed), principalPub: other.pPub })).status).toBe(403);
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
