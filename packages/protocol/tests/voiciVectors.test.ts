// Replays packages/protocol/test-vectors/voici/ and test-vectors/messages/ (tools/voici-vectors.ts) against the
// TypeScript, and checks the generator's output is fresh. Swift, Kotlin and the webapp read the same files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";

const dir = join(import.meta.dirname, "..", "test-vectors");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(dir, "voici", "vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(join(dir, "messages", "vectors.json"), "utf8"));
const h = (s: string) => P.hexToBytes(s);
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const enc = new TextEncoder();
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

describe("voici vectors (test-vectors/voici)", () => {
  it("text rules, links, sites, names, namespace keys, JPEG checks", () => {
    for (const c of V.text.check) expect(P.checkVoiciText(c.field, c.input) ?? "ok", JSON.stringify(c.input)).toBe(c.expected);
    for (const c of V.text.prepare) expect(P.prepareVoiciText(c.field, c.input)).toEqual(c.expected);
    for (const c of V.linkUrls) expect(P.checkVoiciLinkUrl(c.url, c.allowMailto), c.url).toBe(c.expected);
    for (const c of V.linkMatches) expect(P.findVoiciLinks(c.text), c.text).toEqual(c.matches);
    expect(P.VOICI_LINK_SITES).toEqual(V.linkSites.table);
    expect(V.linkSites.table).toEqual(JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "voiciLinkSites.json"), "utf8")));
    for (const c of V.linkSites.cases) expect(P.voiciLinkSite(c.url), c.url).toBe(c.site);
    for (const c of V.pseudonymNames) expect([P.voiciPseudonymCode(c.pub), P.voiciPseudonymName(c.pub)]).toEqual([c.code, c.name]);
    for (const c of V.jpegs) expect([P.isVoiciJpeg(h(c.hex)), P.voiciJpegHasMetadata(h(c.hex))]).toEqual([c.isJpeg, c.hasMetadata]);
  });

  it("pieces parse or are refused", () => {
    expect(P.canonicalJson(V.pieces.profile)).toBe(V.pieces.profileText);
    for (const c of V.pieces.profileCases) expect(P.parseVoiciProfilePiece(enc.encode(c.text)) !== null, c.name).toBe(c.expected);
    for (const c of V.pieces.chunkCases) expect(P.parseVoiciChunkPiece(enc.encode(c.text), c.n) !== null, c.name).toBe(c.expected);
  });

  it("the index: bytes, signature, reader and publish checks", () => {
    const idx = V.index.signed;
    expect(new TextDecoder().decode(P.canonicalVoiciPageIndex(idx))).toBe(V.index.canonical);
    expect(P.signVoiciPageIndex(V.index.body, h(V.keys.adminRootSeed))).toEqual(idx);
    const chunks = V.pieces.chunkTexts.map((t: string, n: number) => P.parseVoiciChunkPiece(enc.encode(t), n));
    expect(P.voiciPieceRefsOk(idx, V.pieces.profile, chunks)).toBe(true);
    expect(P.voiciPieceRefsOk(idx, { ...V.pieces.profile, avatar: null }, chunks)).toBe(false);
    for (const c of V.index.checks) expect(code(P.checkVoiciPageIndex(c.index, c.ctx)), c.name).toBe(c.expected);
    for (const c of V.index.publishChecks) expect(code(P.checkVoiciPublish(c.index, c.ctx)), c.name).toBe(c.expected);
    expect(P.parseVoiciPageIndex(JSON.stringify(idx))).toEqual(idx);
    expect(P.parseVoiciPageIndex("x".repeat(P.VOICI_INDEX_MAX_BYTES + 1))).toBeNull();
  });

  it("piece upload, chunking and the merge", () => {
    const u = V.pieceUpload;
    expect(new TextDecoder().decode(P.canonicalVoiciPieceUpload(u.cases[0].upload))).toBe(u.canonical);
    for (const c of u.cases) expect(P.verifyVoiciPieceUpload(c.upload, c.signature, u.signerPub), c.name).toBe(c.expected);
    for (const c of V.merge) expect(P.mergeVoiciPage(c.published, c.ops), c.name).toEqual(c.expected);
  });
});

describe("messages vectors (test-vectors/messages)", () => {
  const d = M.derivations;
  const owner = { seed: h(d.ownerUmk) };
  const visitor = { seed: h(d.visitorUmk) };

  it("derivations from fixed UMKs", () => {
    const inbox = P.deriveVoiciInboxKey(owner, d.pageId, d.inboxEpoch);
    expect([H(inbox.seed), H(inbox.publicKey)]).toEqual([d.inboxSeed, d.inboxPub]);
    expect(H(P.deriveVoiciInboxKey(owner, d.pageId, 2).seed)).toBe(d.inboxEpoch2Seed);
    const os = P.deriveVoiciOwnerSignKey(owner, d.pageId, d.inboxEpoch);
    expect([H(os.seed), H(os.publicKey)]).toEqual([d.ownerSignSeed, d.ownerSignPub]);
    const ms = P.deriveMessagesSecret(visitor);
    expect(H(ms)).toBe(d.messagesSecret);
    const p = P.deriveMessagesPseudonymKey(ms, d.pageId);
    expect([H(p.seed), H(p.publicKey)]).toEqual([d.pseudonymSeed, d.pseudonymPub]);
    expect(H(P.deriveMessagesPseudonymKey(ms, "aa".repeat(16)).publicKey)).toBe(d.otherPagePseudonymPub);
    const t = P.deriveMessagesThreadKey(ms, d.pageId);
    expect([H(t.seed), H(t.publicKey)]).toEqual([d.threadSeed, d.threadPub]);
    expect([H(P.deriveVoiciDraftsKey(owner)), H(P.deriveMessagesStateKey(owner))]).toEqual([d.draftsKey, d.stateKey]);
    expect(P.voiciConv(d.pageId, d.pseudonymPub)).toBe(d.conv);
    expect(P.voiciPseudonymName(d.pseudonymPub)).toBe(d.pseudonymName);
  });

  it("canonical JSON and base64", () => {
    for (const c of M.canonicalJson.cases) expect(P.canonicalJson(c.value)).toBe(c.canonical);
    for (const c of M.canonicalJson.refusals) expect(() => P.canonicalJson(JSON.parse(c.json))).toThrow();
    for (const c of M.base64) {
      const b = P.b64Decode(c.b64);
      expect(b ? H(b) : null, c.b64).toBe(c.hex);
      if (b) expect(P.b64Encode(b)).toBe(c.b64);
    }
  });

  it("attestation, abuse tag and the abuse key list", () => {
    const a = M.attestation;
    expect(new TextDecoder().decode(P.canonicalMessagesKeyAttestationRequest(a.request))).toBe(a.requestCanonical);
    expect(P.verifyMessagesKeyAttestationRequest(a.request, a.requestSignature, M.keys.devicePub)).toBe(true);
    expect(P.verifyMessagesKeyAttestationRequest({ ...a.request, deviceCheckRef: "none" }, a.requestSignature, M.keys.devicePub)).toBe(false);
    const tag = P.sealVoiciAbuseTag(h(M.keys.abusePub), d.pseudonymPub, a.abuseTagPlaintext, h(a.abuseTagEseed));
    expect(H(tag)).toBe(a.abuseTagHex);
    expect(P.openVoiciAbuseTag(h(M.keys.abuseSeed), d.pseudonymPub, tag)).toEqual(a.abuseTagPlaintext);
    expect(() => P.openVoiciAbuseTag(h(M.keys.abuseSeed), d.otherPagePseudonymPub, tag)).toThrow();
    const signed = P.signMessagesKeyAttestation(
      { pseudonymPub: a.signed.pseudonymPub, abuseEpoch: a.signed.abuseEpoch, issuedAt: a.signed.issuedAt, expiresAt: a.signed.expiresAt },
      tag,
      h(M.keys.caSeed),
    );
    expect(signed).toEqual(a.signed);
    expect(new TextDecoder().decode(P.canonicalMessagesKeyAttestation(signed))).toBe(a.canonical);
    expect(P.messagesAttestationHash(signed)).toBe(a.renewOfHash);
    for (const c of a.checks) expect(code(P.checkMessagesKeyAttestation(c.attestation, c.ctx)), c.name).toBe(c.expected);
    const e = a.abuseKeyEntry;
    expect(new TextDecoder().decode(P.canonicalAbuseKeyEntry(e.entry))).toBe(e.canonical);
    expect(P.verifyAbuseKeyEntry(e.entry, e.signature, [M.keys.caTrackPub])).toBe(true);
    expect(P.abuseKeyFor([e.entry], e.entry.notAfter)).toBeNull();
  });

  it("delegation, revoke and the thread statement", () => {
    const x = M.delegation;
    expect(new TextDecoder().decode(P.canonicalWebDelegation(x.delegation))).toBe(x.canonical);
    expect(P.signWebDelegation(x.delegation, h(d.pseudonymSeed))).toBe(x.signature);
    for (const c of x.checks) expect(code(P.checkWebDelegation(c.delegation, c.signature, c.want)), c.name).toBe(c.expected);
    expect(new TextDecoder().decode(P.canonicalWebDelegationRevoke(x.revoke.revoke))).toBe(x.revoke.canonical);
    expect(P.verifyWebDelegationRevoke(x.revoke.revoke, x.revoke.signature, d.pseudonymPub)).toBe(true);
    const t = M.threadStatement;
    expect(new TextDecoder().decode(P.canonicalVoiciThreadStatement(t.statement))).toBe(t.canonical);
    expect(P.signVoiciThreadStatement(t.statement, h(d.pseudonymSeed))).toBe(t.signature);
  });

  it("message: sealed body reproduced, envelope bytes, every check, open", () => {
    const m = M.message;
    const body = P.sealVoiciBody(
      { conv: d.conv, msgId: m.envelope.msgId, sentAt: m.envelope.sentAt, fromPub: d.pseudonymPub, recipients: [h(d.inboxPub), h(d.threadPub)], plaintext: m.plaintext },
      { cek: h(m.randomness.cek), nonce: h(m.randomness.nonce), eseeds: m.randomness.eseeds.map(h) },
    );
    expect(new TextDecoder().decode(body)).toBe(m.bodyText);
    expect(P.b64Encode(body)).toBe(m.envelope.bodyB64);
    expect(new TextDecoder().decode(P.canonicalWebEnvelope(m.envelope))).toBe(m.canonical);
    expect(P.verifyWebEnvelopeSignature(m.envelope, M.keys.browserPub)).toBe(true);
    for (const c of m.checks) {
      const ctx = { ...c.ctx, blocked: c.ctx.blocked && new Set(c.ctx.blocked), revoked: c.ctx.revoked && new Set(c.ctx.revoked), rateLimit: c.ctx.rateLimited ? () => "rate-limited" as const : undefined };
      expect(code(P.checkVoiciMessage(c.envelope, ctx)), c.name).toBe(c.expected);
    }
    for (const c of m.open) {
      const r = P.openVoiciBody(body, { conv: c.conv, msgId: c.msgId }, h(c.seed));
      expect(r.ok ? { ok: true, plaintext: r.plaintext } : { ok: false, code: r.code }, c.name).toEqual(c.expected);
    }
  });

  it("reply and draft", () => {
    const r = M.reply;
    const body = P.sealVoiciBody(
      { conv: d.conv, msgId: r.envelope.msgId, sentAt: r.envelope.sentAt, fromPub: d.ownerSignPub, recipients: [h(d.threadPub), h(d.inboxPub)], plaintext: r.plaintext },
      { cek: h(r.randomness.cek), nonce: h(r.randomness.nonce), eseeds: r.randomness.eseeds.map(h) },
    );
    expect(new TextDecoder().decode(body)).toBe(r.bodyText);
    expect(P.signWebEnvelopeEd25519({ ...r.envelope, sig: undefined, sigAlg: undefined }, h(d.ownerSignSeed)).sig).toBe(r.envelope.sig);
    for (const c of r.checks) expect(code(P.checkVoiciReply(c.envelope, c.ctx)), c.name).toBe(c.expected);
    const x = M.draft;
    expect(new TextDecoder().decode(P.sealVoiciDraft(h(d.draftsKey), x.username, x.op, h(x.nonce)))).toBe(x.bodyText);
    expect(P.openVoiciDraft(h(d.draftsKey), x.username, x.op.opId, enc.encode(x.bodyText))).toEqual(x.op);
    const ok = x.grantAccepted;
    const checkGrant = (g: unknown, s: string, pub: string) => P.canonicalJson(g) === P.canonicalJson(ok.grant) && s === ok.grantSignature && pub === ok.devicePub;
    for (const c of x.checks) expect(code(P.checkVoiciDraft(c.envelope, { ...c.ctx, checkGrant })), c.name).toBe(c.expected);
    for (const c of x.opCases) expect(P.parseVoiciDraftOp(c.op) !== null, c.name).toBe(c.expected);
  });

  it("ack, block, thread fetch, state blob, reports, sign-in, phone web policy", () => {
    expect(new TextDecoder().decode(P.canonicalVoiciAck(M.ack.message))).toBe(M.ack.canonical);
    for (const c of M.ack.cases) expect(P.verifyVoiciAck(c.ack, c.signerPub, c.want) !== null, c.name).toBe(c.expected);
    expect(new TextDecoder().decode(P.canonicalVoiciBlock(M.block.block))).toBe(M.block.canonical);
    expect(P.verifyVoiciBlock(M.block.block, M.block.signature, d.ownerSignPub)).toBe(true);
    expect(new TextDecoder().decode(P.canonicalVoiciThreadFetch(M.threadFetch.fetch))).toBe(M.threadFetch.canonical);
    expect(P.verifyVoiciThreadFetch(M.threadFetch.fetch, M.threadFetch.signature, M.keys.browserPub)).toBe(true);
    const s = M.state;
    expect(P.mergeMessagesState(s.a, s.b)).toEqual(s.merged);
    expect(P.sealMessagesState(h(d.stateKey), s.username, s.version, s.a, h(s.nonce))).toEqual(s.sealed);
    expect(P.openMessagesState(h(d.stateKey), s.username, s.sealed)).toEqual(s.a);
    for (const k of ["message", "messageWithText", "page"] as const) {
      expect(new TextDecoder().decode(P.canonicalVoiciReport(M.reports[k].report)), k).toBe(M.reports[k].canonical);
    }
    expect(P.verifyVoiciMessageReport(M.reports.message.report, M.reports.message.signature, d.ownerSignPub)).toBe(true);
    expect(P.p256VerifyP1363(M.reports.page.signature, enc.encode(M.reports.page.canonical), M.keys.browserPub)).toBe(true);
    for (const c of M.signIn.checks) {
      expect(code(P.checkVoiciSignInAnswer(c.answer, { request: c.request, caKeys: M.signIn.ctx.caKeys, now: M.signIn.ctx.now })), c.name).toBe(c.expected);
    }
    for (const c of M.phoneWeb.cases) expect(P.phoneWebCheck(c.request, { hostname: c.hostname, origins: c.origins }), c.name).toEqual(c.expected);
    for (const c of M.phoneWeb.liveAnswers) expect(P.parsePhoneLiveAnswer(c.answer) !== null).toBe(c.expected);
  });
});

describe("properties", () => {
  it("pseudonyms are per page and unrelated across pages; the inbox moves with the epoch", () => {
    const ms = P.deriveMessagesSecret({ seed: new Uint8Array(32).fill(9) });
    const a = P.deriveMessagesPseudonymKey(ms, "11".repeat(16));
    const b = P.deriveMessagesPseudonymKey(ms, "22".repeat(16));
    expect(H(a.publicKey)).not.toBe(H(b.publicKey));
    expect(H(P.deriveMessagesPseudonymKey(ms, "11".repeat(16)).publicKey)).toBe(H(a.publicKey));
    expect(() => P.deriveMessagesPseudonymKey(ms, "XX")).toThrow();
  });

  it("random seals round-trip and never repeat", () => {
    const umk = { seed: new Uint8Array(32).fill(3) };
    const pid = "33".repeat(16);
    const inbox = P.deriveVoiciInboxKey(umk, pid, 1);
    const t = P.deriveMessagesThreadKey(P.deriveMessagesSecret(umk), pid);
    const o = { conv: "44".repeat(32), msgId: "55".repeat(16), sentAt: 1, fromPub: "66".repeat(32), recipients: [inbox.publicKey, t.publicKey] as [Uint8Array, Uint8Array], plaintext: { v: 1 as const, text: "x", replyTo: null } };
    const a = P.sealVoiciBody(o);
    expect(H(a)).not.toBe(H(P.sealVoiciBody(o)));
    expect(P.openVoiciBody(a, o, t.seed)).toEqual({ ok: true, plaintext: o.plaintext });
    expect(() => P.sealVoiciBody({ ...o, plaintext: { v: 1, text: "a‮b", replyTo: null } })).toThrow();
  });

  it("the generator's output is fresh", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    execFileSync("npx", ["tsx", "tools/voici-vectors.ts", "--check"], { cwd: root, stdio: "pipe" });
  }, 120_000);
});
