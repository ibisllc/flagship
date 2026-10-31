/**
 * Who may serve what, and until when (plan H1-H9, docs/architecture-v2/issuance-and-lease-records.md; owner
 * decisions of 2026-10-31). The relay enforces it; the issuance service reads the same records.
 *
 *   flagship/serving-policy/v1|<account>|<box>|<regGen>|<policyGen>|<grace>|<onLapse>|<scopeSha256>|<issuedAt>
 *   flagship/renewal-key-delegation/v1|<account>|<renewalPub>|<deviceId>|<issuedAt>
 *   flagship/serving-lease/v1|<account>|<box>|<regGen>|<policyGen>|<leaseId>|<issuedAt>|<notAfter>
 *   flagship/revocation-entry/v1|<sequence>|<kind>|<account>|<subject>|<generation>|<revokedAt>
 *   flagship/certificate-order/v1|<class>|<device>|<regGen>|<csrSha256>|<requestId>|<issuedAt>
 *   flagship/route-claim/v1|<account>|<phoneRoutePub>|<hostname>|<generation>|<sessionNonce>|<issuedAt>
 *
 * The admin root signs the policy (how long a box keeps serving apps with no admin device opening Flagship: 7 days,
 * 30 days or indefinitely) and each device's renewal-key delegation. Under an indefinite policy (the default) the
 * policy alone authorizes serving: there are no leases. Under a finite one, an admin device signs a lease when the
 * app is opened, never further ahead than the grace, bound to the policy generation (shortening the grace advances
 * it, so an older, longer lease stops counting). A lease is checked against the admin key `.com` publishes AND the
 * key the box pinned; both must be the same key. Revocation is a signed, sequenced log `.com` pushes to the relays.
 *
 * One setting, two enforcers, one deadline (owner, 2026-10-31: the old box-enforced dead-man lock, deadMan.ts, is
 * folded in here). `onLapse` says what happens when the lease runs out: `stop-apps` (the relay stops routing the
 * box's apps) or `lock-server` (also: the box restarts with its disk locked and starts again only when an admin
 * approves on a phone). The same lease keeps both going: the relay checks it for app routes, the box for staying
 * unlocked. Locking needs a time limit.
 *
 * A box's exact control name never needs a lease (recovery stays possible); only app routes do.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_SERVING_POLICY = "flagship/serving-policy/v1";
export const TAG_RENEWAL_KEY_DELEGATION = "flagship/renewal-key-delegation/v1";
export const TAG_SERVING_LEASE = "flagship/serving-lease/v1";
export const TAG_REVOCATION_ENTRY = "flagship/revocation-entry/v1";
export const TAG_CERTIFICATE_ORDER = "flagship/certificate-order/v1";
export const TAG_ROUTE_CLAIM = "flagship/route-claim/v1";

export type ServingGrace = "7d" | "30d" | "indefinite";
/** What happens when no admin device renewed within the grace. */
export type ServingOnLapse = "stop-apps" | "lock-server";
export const GRACE_MS: Readonly<Record<Exclude<ServingGrace, "indefinite">, number>> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
/** The grace a new server starts with. */
export const DEFAULT_SERVING_GRACE: ServingGrace = "indefinite";
/** How far a signer's clock may run ahead of the verifier's. */
export const SERVING_CLOCK_SKEW_MS = 5 * 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const enc = (parts: Array<string | number>): Bytes => new TextEncoder().encode(parts.join("|"));

function hexField(name: string, v: unknown, re = HEX64): asserts v is string {
  if (typeof v !== "string" || !re.test(v)) throw new Error(`${name} must be lowercase hex of the right length`);
}
function intField(name: string, v: unknown, min = 0): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new Error(`${name} must be a safe integer ≥ ${min}`);
}
function accountField(v: unknown): asserts v is string {
  if (typeof v !== "string" || !ACCOUNT.test(v)) throw new Error("account must be a lowercase account name");
}

// ── serving-policy ────────────────────────────────────────────────────────

export interface ServingPolicy {
  account: string;
  /** The box's identity public key. */
  box: string;
  /** Registration generation: an owner re-enrolment starts a new one; revocation ends one for good. */
  regGen: number;
  /** Advances on every new policy for this box (a shorter grace must outdate older leases). */
  policyGen: number;
  grace: ServingGrace;
  /** `lock-server` only with a finite grace. */
  onLapse: ServingOnLapse;
  /** SHA-256 of the box's canonical name list (canonicalNameList). */
  scopeSha256: string;
  issuedAt: number;
}

export function canonicalServingPolicy(p: ServingPolicy): Bytes {
  accountField(p.account);
  hexField("box", p.box);
  intField("regGen", p.regGen, 1);
  intField("policyGen", p.policyGen, 1);
  if (p.grace !== "7d" && p.grace !== "30d" && p.grace !== "indefinite") throw new Error("grace must be 7d, 30d or indefinite");
  if (p.onLapse !== "stop-apps" && p.onLapse !== "lock-server") throw new Error("onLapse must be stop-apps or lock-server");
  if (p.onLapse === "lock-server" && p.grace === "indefinite") throw new Error("locking needs a time limit");
  hexField("scopeSha256", p.scopeSha256);
  intField("issuedAt", p.issuedAt);
  return enc([TAG_SERVING_POLICY, p.account, p.box, p.regGen, p.policyGen, p.grace, p.onLapse, p.scopeSha256, p.issuedAt]);
}

// ── renewal-key-delegation ────────────────────────────────────────────────

export interface RenewalKeyDelegation {
  account: string;
  /** The device's hardware-held renewal key (Secure Enclave / StrongBox / non-extractable WebCrypto). */
  renewalPub: string;
  /** The device it lives on (its account device key); removing the device revokes the renewal key too. */
  deviceId: string;
  issuedAt: number;
}

export function canonicalRenewalKeyDelegation(d: RenewalKeyDelegation): Bytes {
  accountField(d.account);
  hexField("renewalPub", d.renewalPub);
  hexField("deviceId", d.deviceId);
  intField("issuedAt", d.issuedAt);
  return enc([TAG_RENEWAL_KEY_DELEGATION, d.account, d.renewalPub, d.deviceId, d.issuedAt]);
}

// ── serving-lease ─────────────────────────────────────────────────────────

export interface ServingLease {
  account: string;
  box: string;
  regGen: number;
  policyGen: number;
  /** 32 lowercase hex, unique per lease. */
  leaseId: string;
  issuedAt: number;
  /** App routes stop at this time unless a newer lease arrives. */
  notAfter: number;
}

export function canonicalServingLease(l: ServingLease): Bytes {
  accountField(l.account);
  hexField("box", l.box);
  intField("regGen", l.regGen, 1);
  intField("policyGen", l.policyGen, 1);
  hexField("leaseId", l.leaseId, HEX32);
  intField("issuedAt", l.issuedAt);
  intField("notAfter", l.notAfter);
  if (l.notAfter <= l.issuedAt) throw new Error("notAfter must be after issuedAt");
  return enc([TAG_SERVING_LEASE, l.account, l.box, l.regGen, l.policyGen, l.leaseId, l.issuedAt, l.notAfter]);
}

/** The lease an admin device signs when the app is opened: the full grace ahead of now. Null under an indefinite policy. */
export function leaseFor(policy: ServingPolicy, now: number, leaseId: string): ServingLease | null {
  if (policy.grace === "indefinite") return null;
  return { account: policy.account, box: policy.box, regGen: policy.regGen, policyGen: policy.policyGen, leaseId, issuedAt: now, notAfter: now + GRACE_MS[policy.grace] };
}

// ── revocation-entry ──────────────────────────────────────────────────────

export type RevocationKind = "box" | "renewal-key";

export interface RevocationEntry {
  /** 1, 2, 3, …: one per committed revocation, never reused. */
  sequence: number;
  kind: RevocationKind;
  account: string;
  /** The box's identity key, or the renewal key. */
  subject: string;
  /** The box's registration generation that ends (0 for a renewal key). */
  generation: number;
  revokedAt: number;
}

export function canonicalRevocationEntry(e: RevocationEntry): Bytes {
  intField("sequence", e.sequence, 1);
  if (e.kind !== "box" && e.kind !== "renewal-key") throw new Error("kind must be box or renewal-key");
  accountField(e.account);
  hexField("subject", e.subject);
  intField("generation", e.generation, e.kind === "box" ? 1 : 0);
  if (e.kind === "renewal-key" && e.generation !== 0) throw new Error("a renewal key's revocation has generation 0");
  intField("revokedAt", e.revokedAt);
  return enc([TAG_REVOCATION_ENTRY, e.sequence, e.kind, e.account, e.subject, e.generation, e.revokedAt]);
}

// ── certificate-order ─────────────────────────────────────────────────────

export type CertificateClass = "control" | "apps" | "phone";

export interface CertificateOrder {
  class: CertificateClass;
  /** The ordering device's identity key (a box for control/apps, a phone for phone). */
  device: string;
  regGen: number;
  /** SHA-256 of the DER CSR; the issuance service derives the names itself and only checks the CSR asks for exactly those. */
  csrSha256: string;
  requestId: string;
  issuedAt: number;
}

export function canonicalCertificateOrder(o: CertificateOrder): Bytes {
  if (o.class !== "control" && o.class !== "apps" && o.class !== "phone") throw new Error("class must be control, apps or phone");
  hexField("device", o.device);
  intField("regGen", o.regGen, o.class === "phone" ? 0 : 1);
  hexField("csrSha256", o.csrSha256);
  hexField("requestId", o.requestId, HEX32);
  intField("issuedAt", o.issuedAt);
  return enc([TAG_CERTIFICATE_ORDER, o.class, o.device, o.regGen, o.csrSha256, o.requestId, o.issuedAt]);
}

// ── route-claim (the phone's bare <user> name) ────────────────────────────

export interface RouteClaim {
  account: string;
  phoneRoutePub: string;
  /** Exactly `<account>.<services apex>`. */
  hostname: string;
  /** A higher generation from the same phone supersedes at once. */
  generation: number;
  sessionNonce: string;
  issuedAt: number;
}

export function canonicalRouteClaim(c: RouteClaim): Bytes {
  accountField(c.account);
  hexField("phoneRoutePub", c.phoneRoutePub);
  legacyFieldGuard("hostname", c.hostname);
  if (c.hostname !== c.hostname.toLowerCase() || !c.hostname.startsWith(`${c.account}.`) || c.hostname.split(".").length < 3) {
    throw new Error("hostname must be the account's own bare name");
  }
  intField("generation", c.generation, 1);
  hexField("sessionNonce", c.sessionNonce, HEX32);
  intField("issuedAt", c.issuedAt);
  return enc([TAG_ROUTE_CLAIM, c.account, c.phoneRoutePub, c.hostname, c.generation, c.sessionNonce, c.issuedAt]);
}

// ── signatures ────────────────────────────────────────────────────────────

const CANONICAL = {
  "serving-policy": canonicalServingPolicy,
  "renewal-key-delegation": canonicalRenewalKeyDelegation,
  "serving-lease": canonicalServingLease,
  "revocation-entry": canonicalRevocationEntry,
  "certificate-order": canonicalCertificateOrder,
  "route-claim": canonicalRouteClaim,
} as const;
export type ServingRecordKind = keyof typeof CANONICAL;
type RecordOf<K extends ServingRecordKind> = Parameters<(typeof CANONICAL)[K]>[0];

export function signServingRecord<K extends ServingRecordKind>(kind: K, r: RecordOf<K>, sign: (msg: Bytes) => Bytes): Bytes {
  return sign((CANONICAL[kind] as (x: RecordOf<K>) => Bytes)(r));
}

/** Strict Ed25519 over the record's canonical bytes; false for any malformed record, key or signature. */
export function verifyServingRecord<K extends ServingRecordKind>(kind: K, r: RecordOf<K>, sigHex: string, pubHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/.test(sigHex) || !HEX64.test(pubHex)) return false;
    return ed.verify(fromHex(sigHex), (CANONICAL[kind] as (x: RecordOf<K>) => Bytes)(r), fromHex(pubHex));
  } catch {
    return false;
  }
}

function fromHex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── the canonical name list ───────────────────────────────────────────────

export interface ScopedName {
  class: CertificateClass;
  name: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A DNS name in the form a list holds it: lowercase, ASCII (punycode), a leading `*.` only for wildcards. */
export function isListedName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  return labels.every((l, i) => (i === 0 && l === "*") || LABEL.test(l));
}

/**
 * The canonical form of a name list: `<class> <name>` lines, sorted bytewise, no duplicates, joined by `\n`.
 * Refuses a name that is not in list form or appears under two classes.
 */
export function canonicalNameList(names: readonly ScopedName[]): string {
  const byName = new Map<string, CertificateClass>();
  for (const n of names) {
    if (n.class !== "control" && n.class !== "apps" && n.class !== "phone") throw new Error(`unknown class for ${n.name}`);
    if (!isListedName(n.name)) throw new Error(`not a listed name: ${n.name}`);
    if (n.class !== "apps" && n.name.startsWith("*.")) throw new Error(`only app names may be wildcards: ${n.name}`);
    const had = byName.get(n.name);
    if (had && had !== n.class) throw new Error(`${n.name} is listed as both ${had} and ${n.class}`);
    byName.set(n.name, n.class);
  }
  return [...byName].map(([name, cls]) => `${cls} ${name}`).sort().join("\n");
}

export function nameListSha256(names: readonly ScopedName[]): string {
  return hex(sha256(new TextEncoder().encode(canonicalNameList(names))));
}

/** The names a box holds: its exact control name, and the app wildcards under it and under its account. */
export function boxNameList(server: string, account: string, apex: string): ScopedName[] {
  const control = `${server}.${account}.${apex}`;
  return [
    { class: "control", name: control },
    { class: "apps", name: `*.${control}` },
    { class: "apps", name: `*.${account}.${apex}` },
  ];
}

/**
 * The route allocator's collision rule: an app's exact route name may never be one of the account's control names
 * (a server's own name) or the phone's bare account name. Returns the names that collide.
 */
export function routeCollisions(o: { controlNames: readonly string[]; phoneName: string; appNames: readonly string[] }): string[] {
  const reserved = new Set([...o.controlNames.map((n) => n.toLowerCase()), o.phoneName.toLowerCase()]);
  return o.appNames.filter((n) => reserved.has(n.toLowerCase()));
}

// ── the revocation log a relay keeps ──────────────────────────────────────

export interface RevocationState {
  /** The last sequence applied; 0 before any. */
  sequence: number;
  /** `<account>|<box>` → the lowest revoked generation (every generation at or below it is revoked). */
  boxes: Map<string, number>;
  renewalKeys: Set<string>;
}

export function emptyRevocationState(): RevocationState {
  return { sequence: 0, boxes: new Map(), renewalKeys: new Set() };
}

export type RevocationApply = { ok: true; state: RevocationState; applied: number } | { ok: false; reason: "gap" | "bad-signature" | "malformed"; at: number };

/**
 * Apply pushed entries in order. An entry at or below the current sequence is a duplicate and skipped; one that
 * skips a number is a gap (fetch "since N" first); a bad signature stops at that entry. The state passed in is
 * never changed.
 */
export function applyRevocationEntries(
  state: RevocationState,
  entries: ReadonlyArray<{ entry: RevocationEntry; signature: string }>,
  revocationKeyHex: string,
): RevocationApply {
  const next: RevocationState = { sequence: state.sequence, boxes: new Map(state.boxes), renewalKeys: new Set(state.renewalKeys) };
  let applied = 0;
  for (const { entry, signature } of [...entries].sort((a, b) => a.entry.sequence - b.entry.sequence)) {
    try {
      canonicalRevocationEntry(entry);
    } catch {
      return { ok: false, reason: "malformed", at: Number(entry?.sequence) || 0 };
    }
    if (entry.sequence <= next.sequence) continue;
    if (entry.sequence !== next.sequence + 1) return { ok: false, reason: "gap", at: next.sequence + 1 };
    if (!verifyServingRecord("revocation-entry", entry, signature, revocationKeyHex)) return { ok: false, reason: "bad-signature", at: entry.sequence };
    if (entry.kind === "box") {
      const key = `${entry.account}|${entry.subject}`;
      next.boxes.set(key, Math.max(next.boxes.get(key) ?? 0, entry.generation));
    } else {
      next.renewalKeys.add(entry.subject);
    }
    next.sequence = entry.sequence;
    applied++;
  }
  return { ok: true, state: next, applied };
}

export function boxRevoked(state: RevocationState, account: string, box: string, regGen: number): boolean {
  return (state.boxes.get(`${account}|${box}`) ?? 0) >= regGen;
}

// ── the relay's decision ──────────────────────────────────────────────────

export interface SignedServingRecord<T> {
  record: T;
  signature: string;
}

export interface ServingInput {
  account: string;
  box: string;
  regGen: number;
  /** The admin key `.com` publishes for the account, and the one the box pinned (sent in its HELLO). */
  adminKeyFromCom: string;
  adminKeyFromBox: string;
  policy: SignedServingRecord<ServingPolicy> | null;
  /** The leases the box presents; the best valid one counts. */
  leases: ReadonlyArray<SignedServingRecord<ServingLease> & { delegation?: SignedServingRecord<RenewalKeyDelegation> }>;
  revocations: RevocationState;
  /** The verifier's own clock. */
  now: number;
}

export type ServingReason =
  | "admin-keys-differ"
  | "revoked"
  | "no-policy"
  | "policy-signature"
  | "policy-mismatch"
  | "no-lease"
  | "lease-expired";

export type ServingDecision =
  | { control: true; apps: true; until: number | null; policyGen: number; onLapse: ServingOnLapse }
  | { control: boolean; apps: false; reason: ServingReason; lock: boolean };

/**
 * May this box's tunnel stay up (control), and may its app routes be served (apps)? Control needs only a registered,
 * unrevoked box whose admin keys agree; apps also need a valid policy and, under a finite grace, a live lease.
 * `until` is when app routes stop without a newer lease (null: indefinitely), and `onLapse` what happens then.
 * `lock` is true when the owner's verified policy says `lock-server` and no live lease is left: the box itself
 * restarts with its disk locked (it calls this with its own pinned admin key as both keys).
 */
export function servingDecision(i: ServingInput): ServingDecision {
  if (!HEX64.test(i.adminKeyFromCom) || i.adminKeyFromCom !== i.adminKeyFromBox) return { control: false, apps: false, reason: "admin-keys-differ", lock: false };
  if (boxRevoked(i.revocations, i.account, i.box, i.regGen)) return { control: false, apps: false, reason: "revoked", lock: false };
  const admin = i.adminKeyFromCom;
  if (!i.policy) return { control: true, apps: false, reason: "no-policy", lock: false };
  const p = i.policy.record;
  if (!verifyServingRecord("serving-policy", p, i.policy.signature, admin)) return { control: true, apps: false, reason: "policy-signature", lock: false };
  if (p.account !== i.account || p.box !== i.box || p.regGen !== i.regGen) return { control: true, apps: false, reason: "policy-mismatch", lock: false };
  if (p.grace === "indefinite") return { control: true, apps: true, until: null, policyGen: p.policyGen, onLapse: p.onLapse };
  const graceMs = GRACE_MS[p.grace];
  let best = 0;
  let sawLease = false;
  for (const l of i.leases) {
    const r = l.record;
    if (r.account !== p.account || r.box !== p.box || r.regGen !== p.regGen || r.policyGen !== p.policyGen) continue;
    if (r.issuedAt > i.now + SERVING_CLOCK_SKEW_MS || r.notAfter - r.issuedAt > graceMs) continue;
    if (!leaseSignedByAdmin(l, admin, p.account, i.revocations)) continue;
    sawLease = true;
    best = Math.max(best, r.notAfter);
  }
  const lock = p.onLapse === "lock-server";
  if (!sawLease) return { control: true, apps: false, reason: "no-lease", lock };
  if (best <= i.now) return { control: true, apps: false, reason: "lease-expired", lock };
  return { control: true, apps: true, until: best, policyGen: p.policyGen, onLapse: p.onLapse };
}

function leaseSignedByAdmin(
  l: SignedServingRecord<ServingLease> & { delegation?: SignedServingRecord<RenewalKeyDelegation> },
  admin: string,
  account: string,
  revocations: RevocationState,
): boolean {
  if (verifyServingRecord("serving-lease", l.record, l.signature, admin)) return true;
  const d = l.delegation;
  if (!d || d.record.account !== account || revocations.renewalKeys.has(d.record.renewalPub)) return false;
  if (!verifyServingRecord("renewal-key-delegation", d.record, d.signature, admin)) return false;
  return verifyServingRecord("serving-lease", l.record, l.signature, d.record.renewalPub);
}
