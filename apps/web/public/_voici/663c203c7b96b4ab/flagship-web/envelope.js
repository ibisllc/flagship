// The signed web envelope from the browser side (docs/voici-and-messages.md §7): the browser key B (WebCrypto
// ECDSA P-256, non-extractable), signing with it, and building the requests a signed-in visitor makes. The bytes
// are the protocol package's (canonicalWebEnvelope, sealVoiciBody, canonicalVoiciReport); this module only adds the
// WebCrypto signature, which is IEEE P1363 r‖s already.
//
//   createBrowserKey(subtle?) -> {privateKey, publicKey, delegatePub}   a fresh B (private half non-extractable)
//   signP256(privateKey, bytes) -> hex(64 bytes)
//   randomHex(nBytes)
//   buildVoiciMessage(o) -> envelope                 seal to [inboxPub, threadPub], sign with B
//   canonicalVoiciThreadFetch(f) / signVoiciThreadFetch(session, o)   flagship/voici-thread-fetch/v1
//   buildPageReport(o) -> body                       flagship/voici-report/v1|page|…, signed with B when signed in

import {
  canonicalVoiciReport,
  canonicalWebEnvelope,
  hex,
  hexToBytes,
  isLowerHex,
  prepareVoiciText,
  sealVoiciBody,
  b64Encode,
  voiciConv,
} from "./proto/lib/voiciProtocol.js";

const enc = (s) => new TextEncoder().encode(s);

export const TAG_VOICI_THREAD_FETCH = "flagship/voici-thread-fetch/v1";
const CURSOR = /^[A-Za-z0-9_-]{0,64}$/;

export function randomHex(n) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

/** A fresh browser key B. Its private half can sign but never be exported (WebCrypto `extractable: false`). */
export async function createBrowserKey(subtle = globalThis.crypto.subtle) {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("flagship-web: unexpected P-256 public key encoding");
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, delegatePub: hex(raw) };
}

/** ECDSA P-256 / SHA-256 with B; WebCrypto answers r‖s (IEEE P1363), the form every receiver verifies. */
export async function signP256(privateKey, bytes, subtle = globalThis.crypto.subtle) {
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes));
  if (sig.length !== 64) throw new Error("flagship-web: unexpected ECDSA signature length");
  return hex(sig);
}

/** The cred every voici-message carries: the sign-in answer, minus T's seed. */
export function messageCred(session) {
  return {
    attestation: session.attestation,
    delegation: session.delegation,
    delegationSig: session.delegationSig,
    threadStmt: session.threadStmt,
    threadSig: session.threadSig,
  };
}

/**
 * A visitor's message to a page (§7.1, §7.2). o = {session, index (the verified page index), text, replyTo?, seq,
 * sentAt?, msgId?, randomness? (vectors only)}. The text is NFC-normalised and checked first; a refused text throws
 * an Error whose `code` is the refusal. The body is sealed to the page's inbox key and the visitor's own thread key.
 */
export async function buildVoiciMessage(o) {
  const s = o.session;
  if (o.index.pageId !== s.pageId) throw new Error("flagship-web: the session is for another page");
  const t = prepareVoiciText("messageText", o.text);
  if (!t.ok) throw Object.assign(new Error(`flagship-web: text refused (${t.code})`), { code: t.code });
  const replyTo = o.replyTo ?? null;
  if (replyTo !== null && !isLowerHex(replyTo, 16)) throw new Error("flagship-web: bad replyTo");
  if (!Number.isSafeInteger(o.seq) || o.seq < 1) throw new Error("flagship-web: bad seq");
  const msgId = o.msgId ?? randomHex(16);
  const sentAt = o.sentAt ?? Date.now();
  const conv = voiciConv(s.pageId, s.pseudonymPub);
  const body = sealVoiciBody(
    {
      conv,
      msgId,
      sentAt,
      fromPub: s.pseudonymPub,
      recipients: [hexToBytes(o.index.inboxPub), hexToBytes(s.threadStmt.threadPub)],
      plaintext: { v: 1, text: t.text, replyTo },
    },
    o.randomness,
  );
  const unsigned = {
    v: 1,
    kind: "voici-message",
    audience: s.pageId,
    conv,
    from: s.pseudonymPub,
    msgId,
    seq: o.seq,
    sentAt,
    bodyB64: b64Encode(body),
    cred: messageCred(s),
    sigAlg: "p256",
  };
  return { ...unsigned, sig: await signP256(s.privateKey, canonicalWebEnvelope(unsigned)) };
}

/** flagship/voici-thread-fetch/v1|<conv>|<since>|<issuedAt> (§8.3). */
export function canonicalVoiciThreadFetch(f) {
  if (!isLowerHex(f.conv, 32) || typeof f.since !== "string" || !CURSOR.test(f.since) || !Number.isSafeInteger(f.issuedAt) || f.issuedAt < 0) {
    throw new Error(`${TAG_VOICI_THREAD_FETCH}: bad field`);
  }
  return enc([TAG_VOICI_THREAD_FETCH, f.conv, f.since, String(f.issuedAt)].join("|"));
}

/** The body of POST /api/voici/web/thread: {conv, since, issuedAt, sig, cred}. */
export async function signVoiciThreadFetch(session, o = {}) {
  const f = { conv: voiciConv(session.pageId, session.pseudonymPub), since: o.since ?? "", issuedAt: o.issuedAt ?? Date.now() };
  return { ...f, sig: await signP256(session.privateKey, canonicalVoiciThreadFetch(f)), cred: messageCred(session) };
}

/**
 * The body of POST /api/voici/reports for a page (§9.2): {kind:"page", username, seq, reason, note, issuedAt, signer}.
 * signer is null (anonymous) or, with a session for this page, {delegation, delegationSig, sig} where sig is B's
 * P-256 signature over flagship/voici-report/v1|page|<username>|<seq>|<reason>|<H(note)>|<issuedAt>.
 */
export async function buildPageReport(o) {
  const note = (o.note ?? "").normalize("NFC");
  const r = { kind: "page", username: o.username, seq: o.seq, reason: o.reason, note, issuedAt: o.issuedAt ?? Date.now() };
  const bytes = canonicalVoiciReport(r);
  const s = o.session ?? null;
  const signer = s ? { delegation: s.delegation, delegationSig: s.delegationSig, sig: await signP256(s.privateKey, bytes) } : null;
  return { ...r, signer };
}
