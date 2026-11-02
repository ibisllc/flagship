// Replays packages/protocol/test-vectors/voici/ and test-vectors/messages/ (tools/voici-vectors.ts) against the
// webapp's served port, apps/web/public/webapp/lib/voiciProtocol.js. Mirrors
// packages/protocol/tests/voiciVectors.test.ts; the abuse-key side (sealing tags, the key list) and the thread-fetch
// signature are not in the webapp, so those vectors are checked only as far as the webapp reads them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../public/webapp/lib/voiciProtocol.js";

const dir = join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(dir, "voici", "vectors.json"), "utf8")); // test-vectors/voici
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(join(dir, "messages", "vectors.json"), "utf8")); // test-vectors/messages
const h = (s: string): Uint8Array => P.hexToBytes(s);
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const enc = new TextEncoder();
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

describe("voici vectors (test-vectors/voici) in the webapp", () => {
  it("text rules, links, sites, names, namespace keys, JPEG checks", () => {
    for (const c of V.text.check) expect(P.checkVoiciText(c.field, c.input) ?? "ok", JSON.stringify(c.input)).toBe(c.expected);
    for (const c of V.text.prepare) expect(P.prepareVoiciText(c.field, c.input)).toEqual(c.expected);
    for (const c of V.linkUrls) expect(P.checkVoiciLinkUrl(c.url, c.allowMailto), c.url).toBe(c.expected);
    for (const c of V.linkMatches) expect(P.findVoiciLinks(c.text), c.text).toEqual(c.matches);
    expect(P.VOICI_LINK_SITES).toEqual(V.linkSites.table);
    for (const c of V.linkSites.cases) expect(P.voiciLinkSite(c.url), c.url).toBe(c.site);
    for (const c of V.pseudonymNames) expect([P.voiciPseudonymCode(c.pub), P.voiciPseudonymName(c.pub)]).toEqual([c.code, c.name]);
    for (const c of V.namespaceKeys) expect(P.voiciNamespaceKey(c.name)).toBe(c.key);
    for (const c of V.jpegs) expect([P.isVoiciJpeg(h(c.hex)), P.voiciJpegHasMetadata(h(c.hex))]).toEqual([c.isJpeg, c.hasMetadata]);
  });

  it("constants match", () => {
    const c = V.constants;
    expect([P.VOICI_PROFILE_MAX_BYTES, P.VOICI_CHUNK_MAX_BYTES, P.VOICI_CHUNK_MAX_POSTS, P.VOICI_AVATAR_MAX_BYTES, P.VOICI_CARD_IMAGE_MAX_BYTES]).toEqual([
      c.profileMaxBytes,
      c.chunkMaxBytes,
      c.chunkMaxPosts,
      c.avatarMaxBytes,
      c.cardImageMaxBytes,
    ]);
    expect([P.VOICI_INDEX_MAX_BYTES, P.VOICI_INDEX_MAX_PIECES, P.VOICI_INDEX_SKEW_MS, P.VOICI_LINK_URL_MAX]).toEqual([c.indexMaxBytes, c.indexMaxPieces, c.indexSkewMs, c.linkUrlMax]);
    expect(P.VOICI_TEXT_RULES).toEqual(c.textRules);
  });

  it("pieces parse or are refused", () => {
    expect(P.canonicalJson(V.pieces.profile)).toBe(V.pieces.profileText);
    for (const c of V.pieces.profileCases) expect(P.parseVoiciProfilePiece(enc.encode(c.text)) !== null, c.name).toBe(c.expected);
    for (const c of V.pieces.chunkCases) expect(P.parseVoiciChunkPiece(enc.encode(c.text), c.n) !== null, c.name).toBe(c.expected);
  });

  it("the index: bytes, signature, reader and publish checks", () => {
    const idx = V.index.signed;
    expect(dec(P.canonicalVoiciPageIndex(idx))).toBe(V.index.canonical);
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
    expect(dec(P.canonicalVoiciPieceUpload(u.cases[0].upload))).toBe(u.canonical);
    for (const c of u.cases) expect(P.verifyVoiciPieceUpload(c.upload, c.signature, u.signerPub), c.name).toBe(c.expected);
    expect(P.chunkVoiciPosts(V.chunking.posts)).toEqual(V.chunking.chunks);
    for (const c of V.merge) expect(P.mergeVoiciPage(c.published, c.ops), c.name).toEqual(c.expected);
  });
});

describe("messages vectors (test-vectors/messages) in the webapp", () => {
  const d = M.derivations;
  const owner = { seed: h(d.ownerUmk) };
  const visitor = { seed: h(d.visitorUmk) };

  it("derivations from fixed UMKs", () => {
    const inbox = P.deriveVoiciInboxKey(owner, d.pageId, d.inboxEpoch);
    expect([H(inbox.seed), H(inbox.publicKey)]).toEqual([d.inboxSeed, d.inboxPub]);
    expect(P.sha256Hex(inbox.publicKey)).toBe(d.inboxPubSha256);
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
    expect(P.sha256Hex(t.publicKey)).toBe(d.threadPubSha256);
    expect([H(P.deriveVoiciDraftsKey(owner)), H(P.deriveMessagesStateKey(owner))]).toEqual([d.draftsKey, d.stateKey]);
    expect(P.voiciConv(d.pageId, d.pseudonymPub)).toBe(d.conv);
    expect(P.voiciPseudonymName(d.pseudonymPub)).toBe(d.pseudonymName);
  });

  it("constants match", () => {
    const c = M.constants;
    expect([P.WEB_ENVELOPE_MAX_BYTES, P.WEB_ENVELOPE_MAX_BODY_BYTES, P.VOICI_DRAFT_MAX_ENVELOPE_BYTES, P.VOICI_DRAFT_MAX_BODY_BYTES]).toEqual([
      c.envelopeMaxBytes,
      c.envelopeMaxBodyBytes,
      c.draftMaxEnvelopeBytes,
      c.draftMaxBodyBytes,
    ]);
    expect([P.VOICI_SEND_SKEW_MS, P.MESSAGES_ATTESTATION_TTL_MS, P.PHONE_DELIVER_MAX_BYTES]).toEqual([c.sendSkewMs, c.attestationTtlMs, c.phoneDeliverMaxBytes]);
    expect([P.PHONE_WEB_ORIGINS, P.PHONE_WEB_ORIGINS_GYM, P.VOICI_WEB_ORIGIN, P.VOICI_WEB_ORIGIN_GYM]).toEqual([c.phoneWebOrigins, c.phoneWebOriginsGym, c.webOrigin, c.webOriginGym]);
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

  it("attestation request and the attestation check (tag hash only)", () => {
    const a = M.attestation;
    expect(dec(P.canonicalMessagesKeyAttestationRequest(a.request))).toBe(a.requestCanonical);
    expect(P.signMessagesKeyAttestationRequest(a.request, h(M.keys.deviceSeed))).toBe(a.requestSignature);
    expect(P.verifyMessagesKeyAttestationRequest(a.request, a.requestSignature, M.keys.devicePub)).toBe(true);
    expect(P.verifyMessagesKeyAttestationRequest({ ...a.request, deviceCheckRef: "none" }, a.requestSignature, M.keys.devicePub)).toBe(false);
    expect(dec(P.canonicalMessagesKeyAttestation(a.signed))).toBe(a.canonical);
    expect(P.parseMessagesKeyAttestation(a.signed)).toEqual(a.signed);
    expect(P.b64Encode(h(a.abuseTagHex))).toBe(a.signed.abuseTag);
    expect(P.sha256Hex(h(a.abuseTagHex))).toBe(a.signed.abuseTagHash);
    expect(P.messagesAttestationHash(a.signed)).toBe(a.renewOfHash);
    for (const c of a.checks) expect(code(P.checkMessagesKeyAttestation(c.attestation, c.ctx)), c.name).toBe(c.expected);
  });

  it("the hybrid seal reproduces the vectors' abuse tag and opens it (generic hybrid-seal/v1 port)", () => {
    const a = M.attestation;
    const purpose = ["flagship", "voici-abuse-tag", "v1"].join("/");
    const ctx = [enc.encode(d.pseudonymPub)];
    const plaintext = P.canonicalJsonBytes(a.abuseTagPlaintext);
    const sealed = P.hybridSealWithRandomness(
      h(M.keys.abusePub),
      { purpose, senderKeyId: P.sha256(h(d.pseudonymPub)), issuedAt: a.abuseTagPlaintext.issuedAt },
      ctx,
      plaintext,
      h(a.abuseTagEseed),
    );
    expect(H(sealed)).toBe(a.abuseTagHex);
    expect(H(P.hybridOpen(h(M.keys.abuseSeed), purpose, ctx, sealed).plaintext)).toBe(H(plaintext));
    expect(() => P.hybridOpen(h(M.keys.abuseSeed), purpose, [enc.encode(d.otherPagePseudonymPub)], sealed)).toThrow("decrypt-failed");
    expect(() => P.hybridOpen(h(M.keys.abuseSeed), P.TAG_VOICI_CEK, ctx, sealed)).toThrow("purpose-mismatch");
    expect(() => P.hybridOpen(h(d.threadSeed), purpose, ctx, sealed)).toThrow("recipient-mismatch");
    const { header } = P.decodeEnvelope(sealed);
    expect(H(header.recipientKeyId)).toBe(H(P.pqKeyId(P.SUITE_HYBRID_SEAL_V1, h(M.keys.abusePub))));
  });

  it("delegation, revoke and the thread statement", () => {
    const x = M.delegation;
    expect(dec(P.canonicalWebDelegation(x.delegation))).toBe(x.canonical);
    expect(P.signWebDelegation(x.delegation, h(d.pseudonymSeed))).toBe(x.signature);
    for (const c of x.checks) expect(code(P.checkWebDelegation(c.delegation, c.signature, c.want)), c.name).toBe(c.expected);
    expect(dec(P.canonicalWebDelegationRevoke(x.revoke.revoke))).toBe(x.revoke.canonical);
    expect(P.signWebDelegationRevoke(x.revoke.revoke, h(d.pseudonymSeed))).toBe(x.revoke.signature);
    expect(P.verifyWebDelegationRevoke(x.revoke.revoke, x.revoke.signature, d.pseudonymPub)).toBe(true);
    const t = M.threadStatement;
    expect(dec(P.canonicalVoiciThreadStatement(t.statement))).toBe(t.canonical);
    expect(P.signVoiciThreadStatement(t.statement, h(d.pseudonymSeed))).toBe(t.signature);
  });

  it("message: sealed body reproduced, envelope bytes, every check, open", () => {
    const m = M.message;
    const body = P.sealVoiciBody(
      { conv: d.conv, msgId: m.envelope.msgId, sentAt: m.envelope.sentAt, fromPub: d.pseudonymPub, recipients: [h(d.inboxPub), h(d.threadPub)], plaintext: m.plaintext },
      { cek: h(m.randomness.cek), nonce: h(m.randomness.nonce), eseeds: m.randomness.eseeds.map(h) },
    );
    expect(dec(body)).toBe(m.bodyText);
    expect(P.b64Encode(body)).toBe(m.envelope.bodyB64);
    expect(P.canonicalJson(m.plaintext)).toBe(m.plaintextCanonical);
    expect(dec(P.canonicalWebEnvelope(m.envelope))).toBe(m.canonical);
    expect(P.verifyWebEnvelopeSignature(m.envelope, M.keys.browserPub)).toBe(true);
    const { sig, sigAlg, ...unsigned } = m.envelope;
    expect([P.signWebEnvelopeP256(unsigned, h(M.keys.browserPriv)).sig, sigAlg]).toEqual([sig, "p256"]);
    expect(P.parseWebEnvelope(JSON.stringify(m.envelope))).toEqual(m.envelope);
    for (const c of m.checks) {
      const ctx = { ...c.ctx, blocked: c.ctx.blocked && new Set(c.ctx.blocked), revoked: c.ctx.revoked && new Set(c.ctx.revoked), rateLimit: c.ctx.rateLimited ? () => "rate-limited" : undefined };
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
    expect(dec(body)).toBe(r.bodyText);
    expect(dec(P.canonicalWebEnvelope(r.envelope))).toBe(r.canonical);
    expect(P.signWebEnvelopeEd25519({ ...r.envelope, sig: undefined, sigAlg: undefined }, h(d.ownerSignSeed)).sig).toBe(r.envelope.sig);
    for (const c of r.checks) expect(code(P.checkVoiciReply(c.envelope, c.ctx)), c.name).toBe(c.expected);
    const x = M.draft;
    expect(dec(P.sealVoiciDraft(h(d.draftsKey), x.username, x.op, h(x.nonce)))).toBe(x.bodyText);
    expect(P.openVoiciDraft(h(d.draftsKey), x.username, x.op.opId, enc.encode(x.bodyText))).toEqual(x.op);
    expect(P.openVoiciDraft(h(d.stateKey), x.username, x.op.opId, enc.encode(x.bodyText))).toBeNull();
    const ok = x.grantAccepted;
    const checkGrant = (g: unknown, s: string, pub: string) => P.canonicalJson(g) === P.canonicalJson(ok.grant) && s === ok.grantSignature && pub === ok.devicePub;
    for (const c of x.checks) expect(code(P.checkVoiciDraft(c.envelope, { ...c.ctx, checkGrant })), c.name).toBe(c.expected);
    for (const c of x.opCases) expect(P.parseVoiciDraftOp(c.op) !== null, c.name).toBe(c.expected);
  });

  it("ack, block, state blob, reports, sign-in, phone web policy", () => {
    expect(dec(P.canonicalVoiciAck(M.ack.message))).toBe(M.ack.canonical);
    for (const c of M.ack.cases) expect(P.verifyVoiciAck(c.ack, c.signerPub, c.want) !== null, c.name).toBe(c.expected);
    expect(dec(P.canonicalVoiciBlock(M.block.block))).toBe(M.block.canonical);
    expect(P.signVoiciBlock(M.block.block, h(d.ownerSignSeed))).toBe(M.block.signature);
    expect(P.verifyVoiciBlock(M.block.block, M.block.signature, d.ownerSignPub)).toBe(true);
    expect(P.parseVoiciBlock(M.block.block)).toEqual(M.block.block);
    // The thread fetch is signed by voi.ci's WebCrypto key; the webapp only checks the vector's P-256 signature.
    expect(P.p256VerifyP1363(M.threadFetch.signature, enc.encode(M.threadFetch.canonical), M.keys.browserPub)).toBe(true);
    const s = M.state;
    expect(P.parseMessagesState(s.a)).toEqual(s.a);
    expect(P.mergeMessagesState(s.a, s.b)).toEqual(s.merged);
    expect(P.sealMessagesState(h(d.stateKey), s.username, s.version, s.a, h(s.nonce))).toEqual(s.sealed);
    expect(P.openMessagesState(h(d.stateKey), s.username, s.sealed)).toEqual(s.a);
    expect(P.openMessagesState(h(d.stateKey), s.username, { ...s.sealed, version: s.version + 1 })).toBeNull();
    for (const k of ["message", "messageWithText", "page"]) {
      expect(dec(P.canonicalVoiciReport(M.reports[k].report)), k).toBe(M.reports[k].canonical);
    }
    expect(P.signVoiciMessageReport(M.reports.message.report, h(d.ownerSignSeed))).toBe(M.reports.message.signature);
    expect(P.verifyVoiciMessageReport(M.reports.message.report, M.reports.message.signature, d.ownerSignPub)).toBe(true);
    expect(P.verifyVoiciPageReportSignature(M.reports.page.report, M.reports.page.signature, M.keys.browserPub)).toBe(true);
    expect(P.parseVoiciSignInRequest(M.signIn.request)).toEqual(M.signIn.request);
    for (const c of M.signIn.checks) {
      expect(code(P.checkVoiciSignInAnswer(c.answer, { request: c.request, caKeys: M.signIn.ctx.caKeys, now: M.signIn.ctx.now })), c.name).toBe(c.expected);
    }
    for (const c of M.phoneWeb.cases) expect(P.phoneWebCheck(c.request, { hostname: c.hostname, origins: c.origins }), c.name).toEqual(c.expected);
    for (const c of M.phoneWeb.liveAnswers) expect(P.parsePhoneLiveAnswer(c.answer) !== null).toBe(c.expected);
  });
});

describe("properties", () => {
  it("random seals round-trip and never repeat", () => {
    const umk = { seed: new Uint8Array(32).fill(3) };
    const pid = "33".repeat(16);
    const inbox = P.deriveVoiciInboxKey(umk, pid, 1);
    const t = P.deriveMessagesThreadKey(P.deriveMessagesSecret(umk), pid);
    const o = { conv: "44".repeat(32), msgId: "55".repeat(16), sentAt: 1, fromPub: "66".repeat(32), recipients: [inbox.publicKey, t.publicKey], plaintext: { v: 1, text: "x", replyTo: null } };
    const a = P.sealVoiciBody(o);
    expect(H(a)).not.toBe(H(P.sealVoiciBody(o)));
    expect(P.openVoiciBody(a, o, t.seed)).toEqual({ ok: true, plaintext: o.plaintext });
    expect(P.openVoiciBody(a, o, inbox.seed)).toEqual({ ok: true, plaintext: o.plaintext });
    expect(() => P.sealVoiciBody({ ...o, plaintext: { v: 1, text: "a‮b", replyTo: null } })).toThrow();
    expect(() => P.deriveMessagesPseudonymKey(new Uint8Array(32), "XX")).toThrow();
  });

  it("the module is self-contained browser code", () => {
    const lib = join(import.meta.dirname, "..", "public", "webapp", "lib");
    for (const f of ["voiciProtocol.js", "voiciCore.js", "voiciText.js", "voiciPage.js", "voiciMessages.js"]) {
      const src = readFileSync(join(lib, f), "utf8");
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\.?\//);
    }
  });
});
