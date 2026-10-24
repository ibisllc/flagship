#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for `flagship/pq-session/v1` (docs/architecture-v2/pq-suites.md §13). The
 * TypeScript port (packages/protocol/src/pqSession.ts) GENERATES them; the TS, Rust, Swift and
 * Kotlin tests check every case.
 *
 * Run:          npx tsx tools/pq-session-vectors.ts
 * CI freshness: npx tsx tools/pq-session-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hybridSigKeygen, hybridSign } from "../packages/protocol/src/pqHybrid.js";
import { canonicalPqKeyBinding, verifyPqKeyBinding, type PqKeyBindingStatement, type PqKeyBindingWire, type VerifiedPqKeyBinding } from "../packages/protocol/src/pqTrust.js";
import {
  acceptPqSession,
  completePqSession,
  finishPqSession,
  pqSessionAcceptTbs,
  pqSessionHelloBytes,
  pqSessionSealRecord,
  startPqSession,
  TAG_PQ_SESSION_ACCEPT,
  type PqSessionIdentity,
  type PqSessionInitiatorRole,
} from "../packages/protocol/src/pqSession.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/pq-session/vectors.json");

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
const zero = (s: string, from: number, to: number): string => s.slice(0, from * 2) + "00".repeat(to - from) + s.slice(to * 2);
const flip = (s: string, at: number): string => s.slice(0, at * 2) + ((parseInt(s.slice(at * 2, at * 2 + 2), 16) ^ 1).toString(16).padStart(2, "0")) + s.slice(at * 2 + 2);

const NOW = 1_790_000_000_000;
const SERVER = "home.alice.flagship.services";
const SIBLING = "home2.alice.flagship.services";
const DEVICE = "7f3a9c0b1d2e4f5a6b7c8d9e0f1a2b3c";

interface Party {
  name: string;
  role: PqKeyBindingStatement["role"];
  subject: string;
  edSeed: Uint8Array;
  mldsaSeed: Uint8Array;
  secret: Uint8Array;
  wire: PqKeyBindingWire;
  binding: VerifiedPqKeyBinding;
  identity: PqSessionIdentity;
}

function party(name: string, role: PqKeyBindingStatement["role"], subject: string, a: number, b: number): Party {
  const edSeed = fill(32, a);
  const mldsaSeed = fill(32, b);
  const { publicKey, secretKey } = hybridSigKeygen(edSeed, mldsaSeed);
  const st: PqKeyBindingStatement = { role, subjectId: subject, ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: NOW - 86_400_000 };
  const wire: PqKeyBindingWire = { v: 1, ...st, signature: hex(hybridSign(secretKey, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st), { deterministic: true })) };
  const binding = verifyPqKeyBinding(wire, { role, subjectId: subject, ed25519PubHex: st.ed25519PubHex, now: NOW });
  const identity: PqSessionIdentity = { binding, sign: (purpose, payload) => hybridSign(secretKey, purpose, payload, { deterministic: true }) };
  return { name, role, subject, edSeed, mldsaSeed, secret: secretKey, wire, binding, identity };
}

const BOX = party("box", "box-stk", SERVER, 0x11, 0x22);
const PHONE = party("phone", "device", DEVICE, 0x33, 0x44);
const SIB = party("sibling", "box-stk", SIBLING, 0x55, 0x66);
const ROGUE = party("rogue", "device", DEVICE, 0x77, 0x88);

const RAND = {
  ephemeralSeed: fill(32, 0xa1),
  helloNonce: fill(32, 0xa2),
  encapsulation: fill(64, 0xa3),
  acceptNonce: fill(32, 0xa4),
};

function lookup(trusted: Party[]) {
  return (role: PqSessionInitiatorRole, subject: string, keyIdHex: string) =>
    trusted.find((p) => p.role === role && p.subject === subject && p.binding.keyIdHex === keyIdHex)?.binding ?? null;
}

async function transcript(initiator: Party, role: PqSessionInitiatorRole) {
  const st = startPqSession({ responder: SERVER, responderBinding: BOX.binding, initiatorRole: role, identity: initiator.identity, now: NOW, randomness: RAND });
  const hello = st.hello;
  const { accept, pending } = await acceptPqSession({ hello, identity: BOX.identity, lookupInitiator: lookup([PHONE, SIB]), now: NOW + 100, randomness: RAND });
  const { finish, session: ini } = await finishPqSession(st, accept, NOW + 200);
  const res = completePqSession(pending, finish, NOW + 300);
  const k = (ini as unknown as { keys: { sessionId: Uint8Array; initiatorToResponder: Uint8Array; responderToInitiator: Uint8Array } }).keys;
  const kr = (res as unknown as { keys: typeof k }).keys;
  if (hex(k.sessionId) !== hex(kr.sessionId) || hex(k.initiatorToResponder) !== hex(kr.initiatorToResponder)) throw new Error("sides disagree");
  const req0 = new TextEncoder().encode(JSON.stringify({ method: "GET", path: "/api/screens/home", headers: { authorization: "Bearer s3cr3t" }, body: "" }));
  const req1 = new TextEncoder().encode(JSON.stringify({ method: "POST", path: "/api/screens/services/chess/env", headers: { "content-type": "application/json" }, body: Buffer.from('{"name":"A"}').toString("base64") }));
  const resp1 = new TextEncoder().encode(JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}').toString("base64") }));
  const r0 = ini.sealRequest(req0, NOW + 400);
  const r1 = ini.sealRequest(req1, NOW + 500);
  const o1 = res.openRequest(r1.record, NOW + 500);
  const o0 = res.openRequest(r0.record, NOW + 501);
  if (hex(o0.plaintext) !== hex(req0) || hex(o1.plaintext) !== hex(req1)) throw new Error("records disagree");
  const s1 = res.sealResponse(1, resp1);
  if (hex(ini.openResponse(1, s1)) !== hex(resp1)) throw new Error("response disagrees");
  return {
    hello,
    helloBytesHex: hex(pqSessionHelloBytes({
      responder: hello.responder,
      initiatorRole: hello.initiatorRole,
      initiatorSubject: hello.initiatorSubject,
      initiatorKeyId: unhex(hello.initiatorKeyId),
      responderKeyId: unhex(hello.responderKeyId),
      ephemeralPub: unhex(hello.ephemeralPub),
      nonce: unhex(hello.nonce),
      issuedAt: hello.issuedAt,
    })),
    accept,
    finish,
    keys: { sessionIdHex: hex(k.sessionId), initiatorToResponderHex: hex(k.initiatorToResponder), responderToInitiatorHex: hex(k.responderToInitiator) },
    records: [
      { dir: 1, seq: 0, plaintextHex: hex(req0), recordHex: hex(r0.record) },
      { dir: 1, seq: 1, plaintextHex: hex(req1), recordHex: hex(r1.record) },
      { dir: 2, seq: 1, plaintextHex: hex(resp1), recordHex: hex(s1) },
    ],
  };
}

const phone = await transcript(PHONE, "device");
const sibling = await transcript(SIB, "box-stk");

const h = phone.hello;
const a = phone.accept;
const f = phone.finish;
const ED = 64;

// An accept for the genuine hello, signed by another box key over the genuine bytes.
const tbsA = pqSessionAcceptTbs(unhex(phone.helloBytesHex), SERVER, unhex(a.enc), unhex(a.nonce), a.issuedAt);
const otherSig = hex(hybridSign(SIB.secret, TAG_PQ_SESSION_ACCEPT, tbsA, { deterministic: true }));

const helloCases = [
  { name: "extra-field", hello: { ...h, extra: 1 }, expect: "session-malformed" },
  { name: "missing-field", hello: (({ nonce: _n, ...r }) => r)(h), expect: "session-malformed" },
  { name: "bad-version", hello: { ...h, v: 2 }, expect: "session-malformed" },
  { name: "short-nonce", hello: { ...h, nonce: h.nonce.slice(2) }, expect: "session-malformed" },
  { name: "upper-hex", hello: { ...h, nonce: h.nonce.toUpperCase() }, expect: "session-malformed" },
  { name: "unknown-role", hello: { ...h, initiatorRole: "account-irk" }, expect: "session-malformed" },
  { name: "other-responder", hello: { ...h, responder: SIBLING }, expect: "responder-mismatch" },
  { name: "other-responder-key", hello: { ...h, responderKeyId: SIB.binding.keyIdHex }, expect: "responder-mismatch" },
  { name: "stale", hello: { ...h, issuedAt: NOW - 400_000 }, expect: "session-stale" },
  { name: "future", hello: { ...h, issuedAt: NOW + 400_000 }, expect: "session-stale" },
  { name: "unknown-initiator-key", hello: { ...h, initiatorKeyId: ROGUE.binding.keyIdHex }, expect: "unknown-initiator" },
  { name: "role-relabelled", hello: { ...h, initiatorRole: "box-stk" }, expect: "unknown-initiator" },
  { name: "small-order-x25519", hello: { ...h, ephemeralPub: zero(h.ephemeralPub, 1184, 1216) }, expect: "bad-public-key" },
];

const acceptCases = [
  { name: "extra-field", accept: { ...a, extra: 1 }, expect: "session-malformed" },
  { name: "classical-only-signature", accept: { ...a, signature: a.signature.slice(0, ED * 2) }, expect: "session-malformed" },
  { name: "ed25519-half-zeroed", accept: { ...a, signature: zero(a.signature, 0, ED) }, expect: "bad-signature" },
  { name: "mldsa-half-zeroed", accept: { ...a, signature: zero(a.signature, ED, 3373) }, expect: "bad-signature" },
  { name: "signed-by-other-box", accept: { ...a, signature: otherSig }, expect: "bad-signature" },
  { name: "enc-tampered", accept: { ...a, enc: flip(a.enc, 5) }, expect: "bad-signature" },
  { name: "nonce-tampered", accept: { ...a, nonce: flip(a.nonce, 0) }, expect: "bad-signature" },
  { name: "confirm-tampered", accept: { ...a, confirm: flip(a.confirm, 0) }, expect: "confirm-failed" },
  { name: "stale", accept: { ...a, issuedAt: NOW - 400_000 }, expect: "session-stale" },
];

const finishCases = [
  { name: "extra-field", finish: { ...f, extra: 1 }, expect: "session-malformed" },
  { name: "classical-only-signature", finish: { ...f, signature: f.signature.slice(0, ED * 2) }, expect: "session-malformed" },
  { name: "ed25519-half-zeroed", finish: { ...f, signature: zero(f.signature, 0, ED) }, expect: "bad-signature" },
  { name: "mldsa-half-zeroed", finish: { ...f, signature: zero(f.signature, ED, 3373) }, expect: "bad-signature" },
  { name: "signed-by-sibling-transcript", finish: { ...f, signature: sibling.finish.signature }, expect: "bad-signature" },
  { name: "confirm-tampered", finish: { ...f, confirm: flip(f.confirm, 31) }, expect: "confirm-failed" },
];

const r = phone.records;
const recordCases = [
  { name: "replayed-request", side: "responder", sequence: [r[0]!.recordHex, r[0]!.recordHex], expect: "replay" },
  { name: "tampered-request", side: "responder", sequence: [flip(r[0]!.recordHex, 12)], expect: "decrypt-failed" },
  { name: "seq-rewritten", side: "responder", sequence: [flip(r[0]!.recordHex, 7)], expect: "decrypt-failed" },
  { name: "truncated", side: "responder", sequence: [r[0]!.recordHex.slice(0, 40)], expect: "decrypt-failed" },
  { name: "response-as-request", side: "responder", sequence: [r[2]!.recordHex], expect: "decrypt-failed" },
  { name: "response-for-other-request", side: "initiator", expectSeq: 0, record: r[2]!.recordHex, expect: "replay" },
  { name: "request-as-response", side: "initiator", expectSeq: 0, record: r[0]!.recordHex, expect: "decrypt-failed" },
];

// The record layer alone, for ports that check it without a handshake.
const rk = unhex(phone.keys.initiatorToResponderHex);
if (hex(pqSessionSealRecord(rk, unhex(phone.keys.sessionIdHex), 1, 0, unhex(r[0]!.plaintextHex))) !== r[0]!.recordHex) throw new Error("record not deterministic");

const partyOut = (p: Party) => ({ name: p.name, role: p.role, subject: p.subject, edSeedHex: hex(p.edSeed), mldsaSeedHex: hex(p.mldsaSeed), binding: p.wire, keyIdHex: p.binding.keyIdHex });

const out = {
  about:
    "flagship/pq-session/v1 (docs/architecture-v2/pq-suites.md §13). DRAFT, pending Q01 external cryptographic review. Generated by tools/pq-session-vectors.ts; TS, Rust, Swift and Kotlin check every case. Signatures are deterministic (ML-DSA rnd = 0^32); production signing is hedged. The responder trusts the parties named in `responderTrusts`; times: hello at `now`, accept at now+100, finish at now+200, complete at now+300, records at now+400.",
  now: NOW,
  parties: [BOX, PHONE, SIB, ROGUE].map(partyOut),
  responder: "box",
  responderTrusts: ["phone", "sibling"],
  randomness: { ephemeralSeedHex: hex(RAND.ephemeralSeed), helloNonceHex: hex(RAND.helloNonce), encapsulationHex: hex(RAND.encapsulation), acceptNonceHex: hex(RAND.acceptNonce) },
  transcripts: [
    { name: "phone-to-box", initiator: "phone", ...phone },
    { name: "sibling-to-box", initiator: "sibling", ...sibling },
  ],
  invalid: { hello: helloCases, accept: acceptCases, finish: finishCases, records: recordCases },
};

const text = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/pq-session-vectors.ts`);
    process.exit(1);
  }
  console.log("pq-session vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
