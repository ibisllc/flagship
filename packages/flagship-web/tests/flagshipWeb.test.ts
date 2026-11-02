// flagship-web against the shared vectors (packages/protocol/test-vectors/voici and messages), byte for byte, with
// Node's WebCrypto standing in for the browser's: verify-first page loading, the browser-key signatures, the message
// envelope, the thread fetch, page reports, delivery (direct + ack, mailbox fallback) and the whole sign-in over a
// fake /qr-pipe relay driven by a fake app that signs with the vector keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as W from "../src/index.js";
import { protocolDrift } from "../scripts/sync-protocol.mjs";
import { gcm, p256, x25519 } from "../src/proto/vendor/noble-post-quantum/pq-seal.js";

const P = W.protocol;
const dir = join(import.meta.dirname, "..", "..", "protocol", "test-vectors");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(dir, "voici", "vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(join(dir, "messages", "vectors.json"), "utf8"));
const h = (s: string): Uint8Array => P.hexToBytes(s);
const enc = new TextEncoder();
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const D = M.derivations;
const t0: number = M.t0;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** The vector browser key (keys.browserPriv) as a WebCrypto key, non-extractable like a real B. */
async function vectorBrowserKey(): Promise<CryptoKey> {
  const d = h(M.keys.browserPriv);
  const pub = p256.getPublicKey(d, false);
  const jwk = { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: false };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function vectorSession(privateKey: CryptoKey) {
  const a = M.signIn.answer;
  return {
    v: 1,
    pageId: D.pageId,
    username: "alice",
    origin: M.constants.webOrigin,
    privateKey,
    delegatePub: a.delegation.delegatePub,
    pseudonymPub: a.pseudonymPub,
    attestation: a.attestation,
    delegation: a.delegation,
    delegationSig: a.delegationSig,
    threadStmt: a.threadStmt,
    threadSig: a.threadSig,
    threadSeed: a.threadSeed,
  };
}

describe("flagship-web", () => {
  it("carries a byte-identical copy of the webapp's protocol port", () => {
    expect(protocolDrift()).toEqual([]);
  });

  it("verifies the signed page index before anything else", () => {
    const account = { username: "alice", irkPub: V.keys.irkPub, adminRootPub: V.keys.adminRootPub };
    const idx = V.index.signed;
    const text = JSON.stringify(idx);
    expect(W.pageSignerOf(account)).toEqual({ kind: "admin-root", pub: V.keys.adminRootPub });
    expect(W.pageSignerOf({ username: "alice", irkPub: V.keys.irkPub, adminRootPub: null })).toEqual({ kind: "irk", pub: V.keys.irkPub });
    const ok = W.verifyPageIndex(enc.encode(text), account, { username: "alice" });
    expect(ok.ok && ok.index.seq).toBe(idx.seq);
    expect(W.verifyPageIndex(text, account, { username: "alice", highestSeenSeq: idx.seq + 1 })).toEqual({ ok: false, code: "rolled-back" });
    expect(W.verifyPageIndex(text, { ...account, username: "bob" }, { username: "alice" })).toEqual({ ok: false, code: "no-account" });
    expect(W.verifyPageIndex(text, { ...account, adminRootPub: null }, { username: "alice" }).ok).toBe(false);
    expect(W.verifyPageIndex({ ...idx, acceptsMessages: idx.acceptsMessages ? 0 : 1 }, account, { username: "alice" })).toEqual({ ok: false, code: "bad-signature" });
    expect(W.verifyPageIndex("{", account, { username: "alice" })).toEqual({ ok: false, code: "malformed" });
    expect(W.verifyPageIndex(new Uint8Array(300 * 1024 + 1), account, { username: "alice" })).toEqual({ ok: false, code: "too-large" });
    for (const c of V.index.checks) {
      if (c.ctx.username !== "alice") continue;
      const acc = { username: "alice", adminRootPub: c.ctx.sensitiveKind === "admin-root" ? c.ctx.sensitivePub : null, irkPub: c.ctx.sensitiveKind === "irk" ? c.ctx.sensitivePub : V.keys.irkPub };
      const r = W.verifyPageIndex(c.index, acc, { username: "alice", highestSeenSeq: c.ctx.highestSeenSeq, pageId: c.ctx.pageId });
      expect(r.ok ? "ok" : r.code, c.name).toBe(c.expected);
    }
  });

  it("loads a page through a verifying reader and refuses a swapped piece", async () => {
    const idx = V.index.signed;
    const pieces = new Map<string, Uint8Array>();
    pieces.set(W.pieceRef(idx, "profile").sha256, enc.encode(V.pieces.profileText));
    V.pieces.chunkTexts.forEach((t: string, n: number) => pieces.set(W.pieceRef(idx, `chunk-${n}`).sha256, enc.encode(t)));
    pieces.set(W.pieceRef(idx, "avatar").sha256, h(V.pieces.avatarHex));
    for (const p of idx.pieces.filter((x: { role: string }) => x.role.startsWith("card-"))) pieces.set(p.sha256, h(V.pieces.cardImageHex));
    const account = { username: "alice", irkPub: V.keys.irkPub, adminRootPub: V.keys.adminRootPub };
    const seqs = new Map<string, number>();
    const seqStore = { get: (p: string) => seqs.get(p) ?? null, set: (p: string, s: number) => void seqs.set(p, s) };
    let tamper = false;
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://files.voi.ci/v1/u/alice.json") return new Response(JSON.stringify(idx));
      if (url === "https://flagshipserver.com/api/username/alice") return new Response(JSON.stringify(account));
      const m = url.match(/^https:\/\/files\.voi\.ci\/v1\/p\/([0-9a-f]{32})\/([0-9a-f]{64})$/);
      if (m && m[1] === idx.pageId && pieces.has(m[2]!)) {
        const b = pieces.get(m[2]!)!;
        return new Response(tamper ? b.map((x, i) => (i === 3 ? x ^ 1 : x)) : b);
      }
      return new Response("no", { status: 404 });
    };
    const o = { username: "alice", filesBase: "https://files.voi.ci", apiBase: "https://flagshipserver.com", fetch, seqStore };
    const r = await W.loadVoiciPage(o);
    expect(r.ok).toBe(true);
    expect(calls.every((c) => c.init.credentials === "omit")).toBe(true);
    expect(seqs.get(idx.pageId)).toBe(idx.seq);
    const profile = await r.reader.profile();
    expect(profile).toEqual(V.pieces.profile);
    const n = r.reader.chunkCount();
    expect(n).toBe(V.pieces.chunkTexts.length);
    const last = await r.reader.chunk(n - 1);
    expect(last.chunk).toBe(n - 1);
    expect(await r.reader.image(profile.avatar)).toEqual(h(V.pieces.avatarHex));
    expect(await r.reader.image("00".repeat(32))).toBeNull();

    tamper = true;
    const r2 = await W.loadVoiciPage({ ...o, seqStore: { get: () => null, set: () => {} } });
    expect(await r2.reader.profile()).toBeNull();
    expect(await r2.reader.chunk(0)).toBeNull();

    seqs.set(idx.pageId, idx.seq + 1);
    expect(await W.loadVoiciPage(o)).toEqual({ ok: false, code: "rolled-back" });
    expect(await W.loadVoiciPage({ ...o, username: "Bad Name" })).toEqual({ ok: false, code: "not-found" });
    expect(await W.loadVoiciPage({ ...o, username: "carol" })).toEqual({ ok: false, code: "not-found" });
  });

  it("signs with a WebCrypto browser key in the form receivers verify", async () => {
    const b = await W.createBrowserKey();
    expect(b.delegatePub).toMatch(/^04[0-9a-f]{128}$/);
    await expect(crypto.subtle.exportKey("pkcs8", b.privateKey)).rejects.toThrow();
    const msg = enc.encode("hello");
    const sig = await W.signP256(b.privateKey, msg);
    expect(P.p256VerifyP1363(sig, msg, b.delegatePub)).toBe(true);
    const k = await vectorBrowserKey();
    expect(P.p256VerifyP1363(await W.signP256(k, msg), msg, M.keys.browserPub)).toBe(true);
  });

  it("builds the vector message byte for byte (signature: verify-only, ECDSA is randomized)", async () => {
    const session = vectorSession(await vectorBrowserKey());
    const index = { ...V.index.signed, pageId: D.pageId, inboxPub: D.inboxPub };
    const r = M.message.randomness;
    const env = await W.buildVoiciMessage({
      session,
      index,
      text: M.message.plaintext.text,
      replyTo: null,
      seq: 1,
      sentAt: t0,
      msgId: M.message.envelope.msgId,
      randomness: { cek: h(r.cek), nonce: h(r.nonce), eseeds: r.eseeds.map(h) },
    });
    const { sig, ...rest } = env;
    const { sig: _vsig, ...want } = M.message.envelope;
    expect(rest).toEqual(want);
    expect(dec(P.canonicalWebEnvelope(env))).toBe(M.message.canonical);
    expect(P.p256VerifyP1363(sig, P.canonicalWebEnvelope(env), M.keys.browserPub)).toBe(true);
    const check = P.checkVoiciMessage(env, { pageId: D.pageId, acceptsMessages: true, origin: M.constants.webOrigin, caKeys: [M.keys.caPub], now: t0 });
    expect(check.ok).toBe(true);
    await expect(W.buildVoiciMessage({ session, index, text: "‮evil", seq: 1 })).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("verifies and opens thread items with the thread key, and refuses forgeries", () => {
    const ctx = { pageId: D.pageId, ownerSignPub: D.ownerSignPub, pseudonymPub: D.pseudonymPub, threadSeed: h(D.threadSeed), origin: M.constants.webOrigin };
    const mine = W.verifyThreadItem(M.message.envelope, ctx);
    expect(mine).toMatchObject({ ok: true, mine: true, plaintext: M.message.plaintext });
    const reply = W.verifyThreadItem(M.reply.envelope, ctx);
    expect(reply).toMatchObject({ ok: true, mine: false, plaintext: M.reply.plaintext });
    expect(W.verifyThreadItem({ ...M.reply.envelope, seq: 2 }, ctx)).toEqual({ ok: false, code: "bad-signature" });
    expect(W.verifyThreadItem({ ...M.message.envelope, sentAt: t0 + 1 }, ctx)).toEqual({ ok: false, code: "bad-signature" });
    expect(W.verifyThreadItem(M.reply.envelope, { ...ctx, ownerSignPub: M.keys.devicePub }).ok).toBe(false);
    expect(W.verifyThreadItem(M.message.envelope, { ...ctx, pseudonymPub: D.otherPagePseudonymPub }).ok).toBe(false);
    expect(W.verifyThreadItem(M.message.envelope, { ...ctx, origin: "https://evil.example" })).toEqual({ ok: false, code: "bad-delegation" });
    expect(W.verifyThreadItem({ ...M.message.envelope, kind: "voici-draft" }, ctx).ok).toBe(false);
    expect(W.verifyThreadItem("x".repeat(70_000), ctx)).toEqual({ ok: false, code: "too-large" });
  });

  it("thread fetch and page report bytes match the vectors", async () => {
    const k = await vectorBrowserKey();
    const f = M.threadFetch;
    expect(dec(W.canonicalVoiciThreadFetch(f.fetch))).toBe(f.canonical);
    expect(P.p256VerifyP1363(f.signature, enc.encode(f.canonical), M.keys.browserPub)).toBe(true);
    const session = vectorSession(k);
    const body = await W.signVoiciThreadFetch(session, { since: f.fetch.since, issuedAt: f.fetch.issuedAt });
    expect(body.conv).toBe(f.fetch.conv);
    expect(P.p256VerifyP1363(body.sig, enc.encode(f.canonical), M.keys.browserPub)).toBe(true);
    expect(Object.keys(body.cred).sort()).toEqual(["attestation", "delegation", "delegationSig", "threadSig", "threadStmt"]);
    expect(() => W.canonicalVoiciThreadFetch({ ...f.fetch, since: "a|b" })).toThrow();

    const pr = M.reports.page;
    const anon = await W.buildPageReport({ ...pr.report });
    expect(anon).toEqual({ ...pr.report, signer: null });
    expect(dec(P.canonicalVoiciReport(anon))).toBe(pr.canonical);
    const signed = await W.buildPageReport({ ...pr.report, session });
    expect(P.verifyVoiciPageReportSignature(pr.report, signed.signer.sig, M.keys.browserPub)).toBe(true);
    expect(P.verifyVoiciPageReportSignature(pr.report, pr.signature, M.keys.browserPub)).toBe(true);
    expect(signed.signer.delegation).toEqual(session.delegation);
  });

  it("delivers direct when the phone is live and its ack verifies, else through the mailbox", async () => {
    const env = M.message.envelope;
    const seen: { url: string; init: RequestInit }[] = [];
    let live = true;
    let ack = M.ack.message;
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url === "https://alice.flagship.services/api/phone/live")
        return live ? Response.json({ live: true, account: "alice", ownerSignPub: D.ownerSignPub }) : new Response("", { status: 404 });
      if (url === "https://alice.flagship.services/api/phone/deliver") return Response.json({ ack });
      if (url === "https://flagshipserver.com/api/voici/web/send") return Response.json({ accepted: true });
      return new Response("", { status: 500 });
    };
    const o = { username: "alice", servicesApex: "flagship.services", ownerSignPub: D.ownerSignPub, apiBase: "https://flagshipserver.com", fetch };
    expect(await W.pingPhone(o)).toBe(true);
    expect(await W.pingPhone({ ...o, ownerSignPub: M.keys.devicePub })).toBe(false);
    const d = await W.deliverEnvelope(env, o);
    expect(d).toMatchObject({ ok: true, via: "phone" });
    const post = seen.find((s) => s.url.endsWith("/api/phone/deliver"))!;
    expect((post.init.headers as Record<string, string>)["content-type"]).toBe("application/flagship-envelope+json");
    expect(post.init.credentials).toBe("omit");

    ack = { ...M.ack.message, receivedAt: M.ack.message.receivedAt + 1 };
    expect(await W.deliverEnvelope(env, o)).toEqual({ ok: true, via: "mailbox" });
    live = false;
    expect(await W.deliverEnvelope(env, o)).toEqual({ ok: true, via: "mailbox" });

    const refusing = async () => Response.json({ error: "slow down", code: "first-contact-limit", retryAfterSec: 90 }, { status: 429 });
    expect(await W.sendToMailbox(env, { apiBase: "https://flagshipserver.com", fetch: refusing })).toEqual({ ok: false, code: "first-contact-limit", status: 429, retryAfterSec: 90 });
    expect(await W.sendToMailbox(env, { apiBase: "https://x", fetch: async () => { throw new Error("offline"); } })).toEqual({ ok: false, code: "unreachable" });
  });

  it("fetches the thread with a signed request and hands back unverified items", async () => {
    const session = vectorSession(await vectorBrowserKey());
    let body: Record<string, unknown> = {};
    const fetch = async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ items: [{ envelope: M.message.envelope, storedAt: t0, fetchedAt: null, direct: false }, { nope: 1 }], next: "c_13" });
    };
    const r = await W.fetchThread(session, { apiBase: "https://flagshipserver.com", since: "c_12", fetch });
    expect(r).toMatchObject({ ok: true, next: "c_13" });
    expect(r.items).toHaveLength(1);
    expect(Object.keys(body).sort()).toEqual(["conv", "cred", "issuedAt", "sig", "since"]);
    const bytes = W.canonicalVoiciThreadFetch(body as never);
    expect(P.p256VerifyP1363(body.sig as string, bytes, M.keys.browserPub)).toBe(true);
  });

  it("signs in over the pipe: the app's sealed answer becomes a stored session; bad answers are refused", async () => {
    const run = async (mutate: (a: Record<string, unknown>, req: { delegatePub: string; nonce: string }) => void = () => {}, expire = false) => {
      const sockets: FakeWs[] = [];
      class FakeWs {
        url: string;
        listeners: Record<string, ((e: { data?: string }) => void)[]> = {};
        closed = false;
        constructor(url: string) {
          this.url = url;
          sockets.push(this);
          queueMicrotask(() => this.emit("message", { data: JSON.stringify({ kind: "accepted" }) }));
        }
        addEventListener(t: string, f: (e: { data?: string }) => void) {
          (this.listeners[t] ??= []).push(f);
        }
        emit(t: string, e: { data?: string }) {
          for (const f of this.listeners[t] ?? []) f(e);
        }
        send() {
          throw new Error("browser sends nothing");
        }
        close() {
          this.closed = true;
        }
      }
      const store = W.memoryStore();
      const links: string[] = [];
      const codes: string[] = [];
      const s = W.startVoiciSignIn({
        pageId: D.pageId,
        username: "alice",
        origin: "https://voi.ci",
        apex: "flagshipserver.com",
        store,
        caKeys: [M.keys.caPub],
        WebSocketImpl: FakeWs,
        now: () => t0,
        onLink: (l: string) => links.push(l),
        onCode: (c: string) => codes.push(c),
      });
      while (links.length === 0) await new Promise((r) => setTimeout(r, 5));
      if (expire) {
        sockets[0]!.emit("message", { data: JSON.stringify({ kind: "expired" }) });
        expect(links).toHaveLength(2);
        expect(sockets[0]!.closed).toBe(true);
      }
      const ws = sockets.at(-1)!;
      expect(ws.url).toMatch(/^wss:\/\/flagshipserver\.com\/qr-pipe\/[A-Za-z0-9_-]+\?role=browser$/);
      const link = W.parseSignInLink(links.at(-1)!, "https://voi.ci");
      expect(link.request).toMatchObject({ pageId: D.pageId, username: "alice", origin: "https://voi.ci" });
      expect(new URL(links.at(-1)!).search).toBe("");
      // The app: its own X25519, the same code, the answer sealed under the pipe key.
      const appSk = crypto.getRandomValues(new Uint8Array(32));
      const appPk = b64u(x25519.getPublicKey(appSk));
      ws.emit("message", { data: JSON.stringify({ kind: "peer-hello", phonePk: appPk }) });
      const appMat = W.pipeMaterial(appSk, link.pkB64u);
      expect(codes.at(-1)).toBe(appMat.sas);
      const att = M.attestation.signed;
      const delegation = {
        scope: "voici-messages",
        origin: "https://voi.ci",
        audience: D.pageId,
        principalPub: D.pseudonymPub,
        delegateAlg: "p256",
        delegatePub: link.request.delegatePub,
        issuedAt: t0 - 60_000,
        expiresAt: att.expiresAt,
        nonce: link.request.nonce,
      };
      const answer: Record<string, unknown> = {
        kind: "flagship/voici-sign-in/v1",
        pageId: D.pageId,
        pseudonymPub: D.pseudonymPub,
        attestation: att,
        delegation,
        delegationSig: P.signWebDelegation(delegation, h(D.pseudonymSeed)),
        threadStmt: M.threadStatement.statement,
        threadSig: M.threadStatement.signature,
        threadSeed: D.threadSeed,
      };
      mutate(answer, link.request);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = gcm(appMat.key, nonce).encrypt(enc.encode(JSON.stringify(answer)));
      ws.emit("message", { data: JSON.stringify({ kind: "peer-deliver", ciphertext: b64u(ct), nonce: b64u(nonce) }) });
      return { done: s.done, store };
    };

    const { done, store } = await run(() => {}, true);
    const session = await done;
    expect(session).toMatchObject({ pageId: D.pageId, pseudonymPub: D.pseudonymPub, threadSeed: D.threadSeed });
    expect(await W.listVoiciSessions(store)).toEqual([D.pageId]);
    const loaded = await W.loadVoiciSession(store, D.pageId, { now: t0 });
    expect(loaded?.delegatePub).toBe(session.delegatePub);
    expect(await W.loadVoiciSession(store, D.pageId, { now: M.attestation.signed.expiresAt })).toBeNull();
    expect(await W.listVoiciSessions(store)).toEqual([]);

    // The session sends a message the owner side accepts and opens, and the browser opens again from its thread.
    const index = { ...V.index.signed, pageId: D.pageId, inboxPub: D.inboxPub };
    const env = await W.buildVoiciMessage({ session, index, text: "Hi! Café?", seq: 1, sentAt: t0 });
    const check = P.checkVoiciMessage(env, { pageId: D.pageId, acceptsMessages: true, origin: "https://voi.ci", caKeys: [M.keys.caPub], now: t0 });
    expect(check.ok).toBe(true);
    expect(P.openVoiciBody(P.b64Decode(env.bodyB64), { conv: env.conv, msgId: env.msgId }, h(D.inboxSeed))).toMatchObject({ ok: true, plaintext: { text: "Hi! Café?" } });
    expect(W.verifyThreadItem(env, { pageId: D.pageId, ownerSignPub: D.ownerSignPub, pseudonymPub: D.pseudonymPub, threadSeed: h(D.threadSeed), origin: "https://voi.ci" })).toMatchObject({ ok: true, mine: true });

    await expect((await run((a) => ((a.delegation as Record<string, unknown>).nonce = "00".repeat(16)))).done).rejects.toMatchObject({ code: "bad-delegation" });
    await expect((await run((a) => (a.threadSeed = "11".repeat(32)))).done).rejects.toMatchObject({ code: "bad-thread" });
    await expect((await run((a) => (a.pageId = "aa".repeat(16)))).done).rejects.toMatchObject({ code: "malformed" });
  });

  it("parses only well-formed sign-in links", () => {
    const good = W.signInLink({ apex: "flagshipserver.com", sid: "abc_-", pkB64u: b64u(new Uint8Array(32)), pageId: D.pageId, username: "alice", delegatePub: M.keys.browserPub, nonce: "5e".repeat(16) });
    expect(W.parseSignInLink(good, "https://voi.ci")).not.toBeNull();
    expect(W.parseSignInLink(good.replace("u=alice", "u=Alice"), "https://voi.ci")).toBeNull();
    expect(W.parseSignInLink(good.replace("https:", "http:"), "https://voi.ci")).toBeNull();
    expect(W.parseSignInLink(good.replace("/voici-sign-in", "/remote"), "https://voi.ci")).toBeNull();
  });
});
