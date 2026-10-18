// Builds test-vectors/security-notice/vectors.json (docs/security-notices.md).
// Regenerate with:
//   npx tsx packages/protocol/tests/genSecurityNoticeVectors.ts
// Every input is fixed and Ed25519 is deterministic, so the output is
// byte-stable; securityNoticeVectors.test.ts fails when the file drifts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { ed } from "../src/edSync.js";
import {
  acceptSecurityNotice,
  canonicalSecurityNotice,
  parseSecurityNotice,
  securityNoticeOutcome,
  securityNoticeProblem,
  signSecurityNotice,
  verifySecurityNotice,
  type SecurityNotice,
  type SecurityNoticeBody,
  type SecurityNoticeClient,
  type SecurityNoticeStore,
} from "../src/securityNotice.js";

const fill = (b: number) => new Uint8Array(32).fill(b);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const DAY = 24 * 3600_000;

export const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-vectors/security-notice/vectors.json",
);

export const T0 = 1792000000000;

const authoritySeed = fill(0x77);
const otherSeed = fill(0x78);
const authority = { publicKey: ed.getPublicKey(authoritySeed), privateKey: authoritySeed };
const other = { publicKey: ed.getPublicKey(otherSeed), privateKey: otherSeed };
const authorityPub = bytesToHex(authority.publicKey);
const otherPub = bytesToHex(other.publicKey);

const base = (over: Partial<SecurityNoticeBody>): SecurityNoticeBody => ({
  seq: 1,
  kind: "maintenance",
  validFrom: T0,
  validUntil: T0 + 8 * DAY,
  eventAt: T0 + 7 * DAY,
  lockFrom: 0,
  platforms: {},
  advisoryId: "",
  deprecatesProtocol: 0,
  reason: "",
  message: "We will update on {date}. Flagship may be briefly unavailable.",
  ...over,
});

const required = (over: Partial<SecurityNoticeBody> = {}): SecurityNoticeBody =>
  base({
    seq: 3,
    kind: "update-required",
    validFrom: T0,
    validUntil: T0 + 30 * DAY,
    eventAt: T0 + 14 * DAY,
    lockFrom: T0 + 14 * DAY,
    platforms: { android: { minBuild: 40, minProtocol: 2 }, ios: { minBuild: 12, minProtocol: 2 }, web: { minBuild: 150, minProtocol: 2 } },
    advisoryId: "FSA-2026-001",
    deprecatesProtocol: 1,
    reason: "A flaw in how a signed message is checked lets an attacker act as you.",
    message: "You must update Flagship by {date}. Older versions will stop working.",
    ...over,
  });

const sign = (b: SecurityNoticeBody): SecurityNotice => signSecurityNotice(b, authority);
const json = (n: unknown) => JSON.parse(JSON.stringify(n)) as Record<string, unknown>;

export function buildSecurityNoticeVectors(): unknown {
  const maintenance = sign(base({}));
  const advisory = sign(
    base({
      seq: 2,
      kind: "update-advisory",
      eventAt: 0,
      platforms: { ios: { minBuild: 12, minProtocol: 0 }, android: { minBuild: 40, minProtocol: 0 } },
      advisoryId: "FSA-2026-000",
      message: "A new version is available with security fixes. Please update.",
    }),
  );
  const lock = sign(required());
  const immediate = sign(required({ seq: 4, lockFrom: T0, eventAt: 0, message: "You must update Flagship now. Older versions will stop working." }));
  const clear = sign(base({ seq: 5, kind: "none", eventAt: 0, message: "" }));

  const positive = [
    { name: "maintenance", notice: json(maintenance), canonical: text(canonicalSecurityNotice(maintenance, maintenance.signedBy)) },
    { name: "update-advisory", notice: json(advisory), canonical: text(canonicalSecurityNotice(advisory, advisory.signedBy)) },
    { name: "update-required with a grace window", notice: json(lock), canonical: text(canonicalSecurityNotice(lock, lock.signedBy)) },
    { name: "update-required with no window", notice: json(immediate), canonical: text(canonicalSecurityNotice(immediate, immediate.signedBy)) },
    { name: "none (all clear)", notice: json(clear), canonical: text(canonicalSecurityNotice(clear, clear.signedBy)) },
  ];

  const tamper = (n: SecurityNotice, patch: Record<string, unknown>) => ({ ...json(n), ...patch });
  const forged = signSecurityNotice(required(), other);
  const reject = [
    { name: "a changed message", notice: tamper(lock, { message: "You must update Flagship by {date}. Older versions will stop. " }), expect: "signature-invalid" },
    { name: "a lowered minimum build", notice: tamper(lock, { platforms: { ios: { minBuild: 99, minProtocol: 2 }, android: { minBuild: 40, minProtocol: 2 }, web: { minBuild: 150, minProtocol: 2 } } }), expect: "signature-invalid" },
    { name: "a later lockFrom", notice: tamper(lock, { lockFrom: T0 + 20 * DAY }), expect: "signature-invalid" },
    { name: "a longer window than 30 days", notice: tamper(lock, { validUntil: T0 + 31 * DAY }), expect: "malformed" },
    { name: "update-required without an advisory id", notice: tamper(lock, { advisoryId: "" }), expect: "malformed" },
    { name: "a signature of the wrong length", notice: tamper(lock, { signature: lock.signature.slice(2) }), expect: "malformed" },
    { name: "signed by a key that is not the authority", notice: json(forged), expect: "unauthorized-signer" },
    { name: "a wrong envelope version", notice: tamper(lock, { version: 2 }), expect: "malformed" },
    { name: "an unknown platform", notice: tamper(lock, { platforms: { desktop: { minBuild: 1, minProtocol: 0 } } }), expect: "malformed" },
  ];

  const unsignable: { name: string; body: SecurityNoticeBody; code: string }[] = [
    { name: "a window of 31 days", body: required({ validUntil: T0 + 31 * DAY }), code: "window-too-long" },
    { name: "a window that ends before it starts", body: required({ validUntil: T0 - 1 }), code: "window-order" },
    { name: "update-required without an advisory id", body: required({ advisoryId: "" }), code: "advisory-required" },
    { name: "update-required without a reason", body: required({ reason: "" }), code: "reason-required" },
    { name: "update-required without platforms", body: required({ platforms: {} }), code: "platforms-required" },
    { name: "update-required whose lock starts before it is valid", body: required({ lockFrom: T0 - 1 }), code: "bad-lock-from" },
    { name: "update-required whose lock starts after it ends", body: required({ lockFrom: T0 + 30 * DAY }), code: "bad-lock-from" },
    { name: "a deprecation the minimum protocol does not enforce", body: required({ deprecatesProtocol: 2 }), code: "deprecates-not-enforced" },
    { name: "a maintenance notice with a lock", body: base({ lockFrom: T0 + DAY }), code: "lock-from-not-allowed" },
    { name: "a maintenance notice with a minimum", body: base({ platforms: { ios: { minBuild: 5, minProtocol: 0 } } }), code: "minimum-not-allowed" },
    { name: "an advisory with no minimum", body: base({ kind: "update-advisory", eventAt: 0, message: "Please update.", platforms: { ios: { minBuild: 0, minProtocol: 0 } } }), code: "minimum-required" },
    { name: "a message with a link", body: base({ message: "Update at https://example.com now" }), code: "message-has-link" },
    { name: "a message with a pipe", body: base({ message: "a|b" }), code: "bad-message" },
    { name: "a message over 280 characters", body: base({ message: "x".repeat(281) }), code: "bad-message" },
    { name: "a {date} with no event", body: base({ eventAt: 0 }), code: "date-token-needs-event" },
    { name: "an event outside the window", body: base({ eventAt: T0 + 9 * DAY }), code: "bad-event-at" },
    { name: "an empty message", body: base({ message: "" }), code: "message-required" },
    { name: "seq 0", body: base({ seq: 0 }), code: "bad-seq" },
    { name: "an unsafe integer", body: base({ validFrom: 2 ** 60, validUntil: 2 ** 60 + 1 }), code: "bad-time" },
  ];

  const ios = (build: number, protocol = 1): SecurityNoticeClient => ({ platform: "ios", build, protocol });
  const web = (build: number, protocol = 1): SecurityNoticeClient => ({ platform: "web", build, protocol });
  const android = (build: number, protocol = 1): SecurityNoticeClient => ({ platform: "android", build, protocol });
  const outcomeOf = (n: SecurityNotice, c: SecurityNoticeClient, now: number) => {
    const o = securityNoticeOutcome(n, c, now);
    return o.action === "none" ? { action: "none", why: o.why } : o.action === "banner" ? { action: "banner", style: o.style } : { action: "lock" };
  };
  const o = (name: string, n: SecurityNotice, client: SecurityNoticeClient, now: number) => ({
    name,
    notice: json(n),
    client,
    now,
    expect: outcomeOf(n, client, now),
  });
  const outcomes = [
    o("maintenance shows to everyone", maintenance, ios(1), T0 + DAY),
    o("maintenance is not yet valid", maintenance, ios(1), T0 - 1),
    o("maintenance shows at validFrom", maintenance, ios(1), T0),
    o("maintenance has expired at validUntil", maintenance, ios(1), T0 + 8 * DAY),
    o("advisory nags a build below the minimum", advisory, ios(11), T0 + DAY),
    o("advisory is silent for the minimum build", advisory, ios(12), T0 + DAY),
    o("advisory is silent for another platform", advisory, web(1), T0 + DAY),
    o("update-required nags during the grace window", lock, ios(11, 1), T0 + DAY),
    o("update-required locks at lockFrom", lock, ios(11, 1), T0 + 14 * DAY),
    o("update-required locks after lockFrom for a low protocol only", lock, ios(50, 1), T0 + 15 * DAY),
    o("update-required spares a client at the minimum", lock, ios(12, 2), T0 + 15 * DAY),
    o("update-required spares a client above the minimum", lock, ios(13, 3), T0 + 15 * DAY),
    o("update-required is silent for another platform when unlisted", sign(required({ platforms: { ios: { minBuild: 12, minProtocol: 2 } }, deprecatesProtocol: 1 })), android(1, 1), T0 + 15 * DAY),
    o("update-required never locks past validUntil", lock, ios(11, 1), T0 + 30 * DAY),
    o("update-required locks the web shell below its minimum", lock, web(149, 2), T0 + 15 * DAY),
    o("update-required with no window locks at once", immediate, ios(11, 1), T0 + 1),
    o("update-required is not yet valid", lock, ios(11, 1), T0 - 1),
    o("none shows nothing", clear, ios(1), T0 + DAY),
  ];

  const store = (highestSeq: number, notice: SecurityNotice | null): SecurityNoticeStore => ({ highestSeq, notice });
  const acc = (name: string, st: SecurityNoticeStore, candidate: unknown, keys: string[]) => {
    const r = acceptSecurityNotice(st, candidate, keys);
    return {
      name,
      store: { highestSeq: st.highestSeq, notice: st.notice ? json(st.notice) : null },
      candidate: candidate === null ? null : json(candidate),
      authorityKeys: keys,
      expect: { highestSeq: r.store.highestSeq, seq: r.store.notice ? r.store.notice.seq : null, refused: r.refused },
    };
  };
  const accept = [
    acc("the first notice is stored", store(0, null), lock, [authorityPub]),
    acc("a newer notice replaces the stored one", store(3, lock), clear, [authorityPub]),
    acc("an older notice is refused as a rollback", store(5, clear), lock, [authorityPub]),
    acc("the same seq again changes nothing", store(3, lock), lock, [authorityPub]),
    acc("a notice from the wrong signer is refused", store(0, null), forged, [authorityPub]),
    acc("no authority keys refuses everything", store(0, null), lock, []),
    acc("an empty response changes nothing", store(3, lock), null, [authorityPub]),
    acc("garbage changes nothing", store(3, lock), { type: "SecurityNotice" }, [authorityPub]),
    acc("a tampered notice is refused", store(0, null), tamper(lock, { reason: "x" }), [authorityPub]),
  ];

  // The canonical problem codes must agree with what parse enforces.
  for (const u of unsignable) {
    if (securityNoticeProblem(u.body, authorityPub) !== u.code) throw new Error(`vector "${u.name}" no longer breaks ${u.code}`);
  }
  for (const r of reject) {
    const parsed = parseSecurityNotice(r.notice);
    const got = parsed ? (verifySecurityNotice(parsed, [authorityPub]) as { ok: boolean; reason?: string }) : { ok: false, reason: "malformed" };
    if (got.ok || got.reason !== r.expect) throw new Error(`reject vector "${r.name}" gave ${JSON.stringify(got)}`);
  }

  return {
    about:
      "flagship/security-notice/v1 (docs/security-notices.md). canonical: the exact signed string. positive: notices that parse and verify under keys.authorityPubHex. reject: notices that must not be accepted, with the reason (malformed = fails the rules before any signature check; signature-invalid; unauthorized-signer). unsignable: bodies that break a rule, so no canonical string exists (code = the first rule broken, checked in the order the spec lists). outcomes: what a verified notice shows for a client at a clock (none/banner/lock). accept: how a stored state absorbs a fetched candidate (anti-rollback, fail open); expect.seq is the seq of the notice kept, or null. Seeds are raw Ed25519 seeds. All times are epoch ms; T0 = 1792000000000.",
    keys: {
      authoritySeedHex: bytesToHex(authoritySeed),
      authorityPubHex: authorityPub,
      otherSeedHex: bytesToHex(otherSeed),
      otherPubHex: otherPub,
    },
    t0: T0,
    positive,
    reject,
    unsignable,
    outcomes,
    accept,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, JSON.stringify(buildSecurityNoticeVectors(), null, 2) + "\n");
  console.log(`wrote ${VECTORS_PATH}`);
}
