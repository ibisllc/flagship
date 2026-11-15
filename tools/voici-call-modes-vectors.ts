/**
 * Shared vectors for page call modes, anonymous calls, the ring-back channel and the ring
 * (packages/protocol/src/voiciCallModes.ts) and sealed push tokens (pushTokenSeal.ts). Read by TS
 * (packages/protocol/tests/voiciCallModesVectors.test.ts) and the browser (packages/flagship-web), and by Swift,
 * Kotlin and Rust as their ports land.
 *
 *   npx tsx tools/voici-call-modes-vectors.ts          write
 *   npx tsx tools/voici-call-modes-vectors.ts --check  exit 1 when stale
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import * as P from "../packages/protocol/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "packages/protocol/test-vectors/voici-call-modes/vectors.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/messages/vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C: any = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const h = (s: string) => P.hexToBytes(s);
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code!);
const D = M.derivations;
const PAGE_ID: string = D.pageId;
const NOW = M.t0 + 30_000;
const ORIGIN = P.VOICI_WEB_ORIGIN;
type O = Record<string, unknown>;
const tweak = <T>(x: T, f: (o: O) => void): O => {
  const c = clone(x) as unknown as O;
  f(c);
  return c;
};
const expectAll = (name: string, cases: [string, unknown, string][], run: (input: unknown) => string) =>
  cases.map(([n, input, expect]) => {
    const got = run(input);
    if (got !== expect) throw new Error(`${name} vector "${n}": ${got} != ${expect}`);
    return { name: n, input, expect };
  });

// ── proof of work ──
const powSecret = fill(32, 0x51);
const challenge = P.issueVoiciCallPow({ pageId: PAGE_ID, issuedAt: NOW - 1_000, bits: 12, rand: "5a".repeat(16) }, powSecret);
const nonce = P.solveVoiciCallPow(challenge)!;
const wrongNonce = String(Number(nonce) + 1);
if (P.voiciCallPowSolves(challenge, wrongNonce)) throw new Error("pick another rand: the next nonce also solves");
const powChecks = [
  { name: "ok", challenge, now: NOW, expect: "ok" },
  { name: "another secret", challenge: P.issueVoiciCallPow({ pageId: PAGE_ID, issuedAt: NOW - 1_000, bits: 12, rand: "5a".repeat(16) }, fill(32, 0x52)), now: NOW, expect: "bad-mac" },
  { name: "bits raised after issue", challenge: challenge.replace("|12|", "|13|"), now: NOW, expect: "bad-mac" },
  { name: "another page", challenge: P.issueVoiciCallPow({ pageId: "ab".repeat(16), issuedAt: NOW - 1_000, bits: 12, rand: "5a".repeat(16) }, powSecret), now: NOW, expect: "wrong-page" },
  { name: "older than 2 minutes", challenge, now: NOW - 1_000 + P.VOICI_CALL_POW_TTL_MS + 1, expect: "expired" },
  { name: "bits below the floor", challenge: challenge.replace("|12|", "|08|"), now: NOW, expect: "malformed" },
];
for (const c of powChecks) {
  const got = P.checkVoiciCallPowChallenge(c.challenge, { secret: powSecret, pageId: PAGE_ID, now: c.now });
  if (got !== c.expect) throw new Error(`pow ${c.name}: ${got}`);
}

// ── the anonymous request ──
const browserPriv = fill(32, 0x61);
const browserPub = H(p256.getPublicKey(browserPriv, false));
const anonBody: P.VoiciCallRequestAnonBody = {
  pageId: PAGE_ID,
  conv: P.voiciAnonConv(PAGE_ID, browserPub),
  callId: "a10ca10ca10ca10ca10ca10ca10ca10c",
  browserPub,
  callerXwingPub: C.keys.callerXwingPub,
  offerSdp: C.sdp.offer,
  issuedAt: NOW,
  pow: { challenge, nonce },
};
const anon = P.signVoiciCallRequestAnonP256(anonBody, browserPriv);
const anonCtx = { pageId: PAGE_ID, acceptsCalls: true, callsFrom: "anyone", now: NOW };
const resignAnon = (f: (o: O) => void) => {
  const b = tweak(anonBody, f) as unknown as P.VoiciCallRequestAnonBody;
  return P.signVoiciCallRequestAnonP256(b, browserPriv);
};
const anonChecks = expectAll(
  "anon",
  [
    ["ok", anon, "ok"],
    ["extra key", tweak(anon, (o) => (o.extra = 1)), "malformed"],
    ["signed request kind", tweak(anon, (o) => (o.kind = "voici-call-request")), "malformed"],
    ["offer swapped after signing", tweak(anon, (o) => (o.offerSdp = C.sdp.answer)), "bad-signature"],
    ["nonce swapped after signing", tweak(anon, (o) => ((o.pow as O).nonce = wrongNonce)), "bad-pow"],
    ["wrong nonce, re-signed", resignAnon((o) => ((o.pow as O).nonce = wrongNonce)), "bad-pow"],
    ["challenge for another page", resignAnon((o) => ((o.pow as O).challenge = powChecks[3]!.challenge)), "bad-pow"],
    ["conv of another key", resignAnon((o) => (o.conv = P.voiciAnonConv(PAGE_ID, C.keys.browserPub))), "wrong-conv"],
    ["browser key compressed", tweak(anon, (o) => (o.browserPub = "02" + browserPub.slice(2, 66))), "malformed"],
    ["signed by another key", tweak(anon, (o) => (o.sig = H(p256.sign(P.canonicalVoiciCallRequestAnon(anonBody), fill(32, 0x62), { lowS: true })))), "bad-signature"],
    ["stale", resignAnon((o) => (o.issuedAt = NOW - 11 * 60_000)), "stale"],
    ["uppercase call id", tweak(anon, (o) => (o.callId = String(o.callId).toUpperCase())), "malformed"],
  ],
  (input) => code(P.checkVoiciCallRequestAnon(input, anonCtx)),
);
const anonModeChecks = [
  { name: "callback page", callsFrom: "callback", expect: "not-allowed" },
  { name: "accepted page", callsFrom: "accepted", expect: "not-allowed" },
  { name: "signed-in page", callsFrom: "signed-in", expect: "not-allowed" },
];
for (const c of anonModeChecks) if (code(P.checkVoiciCallRequestAnon(anon, { ...anonCtx, callsFrom: c.callsFrom })) !== c.expect) throw new Error(c.name);

// ── sealed push tokens ──
const relaySeed = fill(32, 0x71);
const relayPub = P.hybridSealKeygen(relaySeed).publicKey;
const tokens: P.PushTokenPlain[] = [
  { v: 1, platform: "apns", token: "ab".repeat(32), env: "production", topic: "com.flagshipserver.app" },
  { v: 1, platform: "apns-voip", token: "cd".repeat(32), env: "sandbox", topic: "com.flagshipserver.app.voip" },
  { v: 1, platform: "fcm", token: "fcm-token:APA91b_x" },
  { v: 1, platform: "unifiedpush", endpoint: "https://ntfy.example/up/abc" },
  { v: 1, platform: "webpush", endpoint: "https://fcm.googleapis.com/fcm/send/xyz", p256dh: Buffer.from(p256.getPublicKey(fill(32, 9), false)).toString("base64url"), auth: Buffer.from(fill(16, 3)).toString("base64url") },
];
const sealRand = (i: number) => fill(32 + P.HYBRID_SEAL_RANDOMNESS_LEN, 0x80 + i);
const sealed = tokens.map((t, i) => ({ plain: t, randomness: H(sealRand(i)), sealed: P.b64Encode(P.sealPushToken(relayPub, t, NOW, sealRand(i))) }));
for (const s of sealed) if (P.canonicalJson(P.openPushToken(relaySeed, P.b64Decode(s.sealed)!)) !== P.canonicalJson(s.plain)) throw new Error("push token round trip");
const twice = [P.b64Encode(P.sealPushToken(relayPub, tokens[0]!, NOW, sealRand(10))), P.b64Encode(P.sealPushToken(relayPub, tokens[0]!, NOW, sealRand(11)))];
if (twice[0] === twice[1]) throw new Error("fresh randomness must differ");
const badPlains: [string, unknown][] = [
  ["apns token uppercase", { ...tokens[0], token: "AB".repeat(32) }],
  ["apns with a voip topic", { ...tokens[0], topic: "com.flagshipserver.app.voip" }],
  ["voip without the voip topic", { ...tokens[1], topic: "com.flagshipserver.app" }],
  ["apns env unknown", { ...tokens[0], env: "dev" }],
  ["fcm extra key", { ...tokens[2], env: "production" }],
  ["unifiedpush over http", { ...tokens[3], endpoint: "http://ntfy.example/up/abc" }],
  ["unifiedpush with credentials", { ...tokens[3], endpoint: "https://u:p@ntfy.example/up" }],
  ["webpush short auth", { ...tokens[4], auth: "AAAA" }],
  ["unknown platform", { v: 1, platform: "sms", token: "x" }],
  ["v2", { ...tokens[2], v: 2 }],
];
for (const [n, p] of badPlains) if (P.parsePushTokenPlain(p) !== null) throw new Error(`push plain ${n}`);
const otherRelay = P.hybridSealKeygen(fill(32, 0x72));
const wrongRelaySealed = P.b64Encode(P.sealPushToken(otherRelay.publicKey, tokens[0]!, NOW, sealRand(12)));
if (P.openPushToken(relaySeed, P.b64Decode(wrongRelaySealed)!) !== null) throw new Error("other relay");

// ── the ring-back channel ──
const pseudonymSeed = h(D.pseudonymSeed);
const attach: P.VoiciRingBackOrder = { pageId: PAGE_ID, conv: D.conv, op: "attach", targets: [sealed[1]!.sealed, sealed[2]!.sealed], issuedAt: NOW };
const byApp = P.signVoiciRingBackPseudonym(attach, pseudonymSeed);
const cred = clone(M.message.envelope.cred);
const browserAttach: P.VoiciRingBackOrder = { ...attach, targets: [] };
const byBrowser = P.signVoiciRingBackBrowserP256(browserAttach, D.pseudonymPub, cred, h(M.keys.browserPriv));
const stop = P.signVoiciRingBackPseudonym({ pageId: PAGE_ID, conv: D.conv, op: "stop", targets: [], issuedAt: NOW }, pseudonymSeed);
const rbCtx = { pageId: PAGE_ID, origin: ORIGIN, caKeys: [M.keys.caPub], now: NOW };
const ringBackChecks = expectAll(
  "ring-back",
  [
    ["app attach", byApp, "ok"],
    ["browser attach without targets", byBrowser, "ok"],
    ["stop", stop, "ok"],
    ["targets swapped after signing", tweak(byApp, (o) => ((o.order as O).targets = [sealed[3]!.sealed])), "bad-signature"],
    ["op flipped after signing", tweak(stop, (o) => ((o.order as O).op = "attach")), "bad-signature"],
    ["stop with targets", tweak(stop, (o) => ((o.order as O).targets = [sealed[0]!.sealed])), "malformed"],
    ["nine targets", tweak(byApp, (o) => ((o.order as O).targets = Array.from({ length: 9 }, (_, i) => P.b64Encode(P.sealPushToken(relayPub, tokens[2]!, NOW, sealRand(20 + i)))))), "malformed"],
    ["the same target twice", tweak(byApp, (o) => ((o.order as O).targets = [sealed[1]!.sealed, sealed[1]!.sealed])), "malformed"],
    ["another pseudonym's conv", tweak(byApp, (o) => (o.from = D.otherPagePseudonymPub)), "wrong-conv"],
    ["another page", tweak(byApp, (o) => ((o.order as O).pageId = "ab".repeat(16))), "wrong-audience"],
    ["stale", P.signVoiciRingBackPseudonym({ ...attach, issuedAt: NOW - 11 * 60_000 }, pseudonymSeed), "stale"],
    ["browser order without cred", tweak(byBrowser, (o) => delete o.cred), "malformed"],
    ["browser order signed by another browser key", tweak(byBrowser, (o) => (o.sig = H(p256.sign(P.canonicalVoiciRingBack(browserAttach), fill(32, 0x63), { lowS: true })))), "bad-signature"],
    ["browser order, delegation of another page", tweak(byBrowser, (o) => ((o.cred as O).delegationSig = "00".repeat(64))), "bad-delegation"],
    ["pseudonym order claimed as the browser's", tweak(byApp, (o) => ((o.signer = "browser"), (o.cred = cred))), "bad-signature"],
  ],
  (input) => code(P.checkVoiciRingBackOrder(input, rbCtx)),
);

// ── the ring ──
const ringId = "71e771e771e771e771e771e771e771e7";
const hintEseed = fill(64, 0x91);
const hintBody = { pageId: PAGE_ID, username: "alice", conv: D.conv, ringId, media: "audio" as const, issuedAt: NOW };
const hint = P.b64Encode(P.sealVoiciRingHint(h(D.threadPub), hintBody, hintEseed));
const ring: P.VoiciRing = { pageId: PAGE_ID, conv: D.conv, ringId, hint, media: "audio", issuedAt: NOW };
const ringSig = P.signVoiciRing(ring, h(D.ownerSignSeed));
if (!P.verifyVoiciRing(ring, ringSig, D.ownerSignPub)) throw new Error("ring");
const ringChecks = [
  { name: "ok", ring, signature: ringSig, expect: true },
  { name: "hint swapped", ring: { ...ring, hint: P.b64Encode(P.sealVoiciRingHint(h(D.threadPub), hintBody, fill(64, 0x92))) }, signature: ringSig, expect: false },
  { name: "media raised", ring: { ...ring, media: "audio,video" }, signature: ringSig, expect: false },
  { name: "signed by the pseudonym", ring, signature: P.signVoiciRing(ring, pseudonymSeed), expect: false },
];
for (const c of ringChecks) if (P.verifyVoiciRing(c.ring as P.VoiciRing, c.signature, D.ownerSignPub) !== c.expect) throw new Error(`ring ${c.name}`);
const opened = P.openVoiciRingHint(h(D.threadSeed), D.conv, ringId, P.b64Decode(hint)!);
if (!opened || opened.username !== "alice") throw new Error("hint open");
if (P.openVoiciRingHint(h(D.threadSeed), D.conv, "00".repeat(16), P.b64Decode(hint)!) !== null) throw new Error("hint ring id");

const doc = {
  description: "voi.ci call modes, anonymous calls, the ring-back channel and the ring, sealed push tokens (docs/voici-calls.md). Generated by tools/voici-call-modes-vectors.ts.",
  now: NOW,
  pageId: PAGE_ID,
  origin: ORIGIN,
  caPub: M.keys.caPub,
  pow: { secret: H(powSecret), challenge, nonce, wrongNonce, bits: 12, checks: powChecks, minBits: P.VOICI_CALL_POW_MIN_BITS, maxBits: P.VOICI_CALL_POW_MAX_BITS, ttlMs: P.VOICI_CALL_POW_TTL_MS },
  anon: { browserPriv: H(browserPriv), browserPub, body: anonBody, signed: anon, canonical: new TextDecoder().decode(P.canonicalVoiciCallRequestAnon(anon)), hash: P.sha256Hex(P.canonicalVoiciCallRequestAnon(anon)), ctx: anonCtx, checks: anonChecks, modeChecks: anonModeChecks },
  pushToken: { relaySeed: H(relaySeed), relayPub: H(relayPub), now: NOW, sealed, badPlains: badPlains.map(([name, plain]) => ({ name, plain })), wrongRelaySealed, freshTwice: twice },
  ringBack: { app: byApp, browser: byBrowser, stop, canonical: new TextDecoder().decode(P.canonicalVoiciRingBack(attach)), ctx: rbCtx, checks: ringBackChecks },
  ring: { order: ring, signature: ringSig, canonical: new TextDecoder().decode(P.canonicalVoiciRing(ring)), hintPlain: { v: 1, ...hintBody }, hintEseed: H(hintEseed), threadSeed: D.threadSeed, threadPub: D.threadPub, ownerSignPub: D.ownerSignPub, checks: ringChecks },
};

const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(OUT, "utf8");
  } catch {
    /* missing */
  }
  if (cur !== text) {
    console.error(`${OUT} is stale; run npx tsx tools/voici-call-modes-vectors.ts`);
    process.exit(1);
  }
  console.log("voici-call-modes vectors up to date");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${text.length} bytes)`);
}
