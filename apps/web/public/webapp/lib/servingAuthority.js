// The serving authority, webapp side: the owner's one dead-man setting
// (docs/architecture-v2/serving-wiring.md §4, issuance-and-lease-records.md §5).
//
// A server's `serving-policy/v1` (signed by the admin root) says how long it
// keeps serving its apps when no admin device opens Flagship: 7 days, 30 days
// or with no time limit, and whether it also locks itself when that runs out.
// Under a finite policy every admin device signs a `serving-lease/v1` each time
// the app is opened, with a renewal key: a non-extractable WebCrypto ECDSA P-256
// key kept in IndexedDB, delegated once by the admin root
// (`renewal-key-delegation/v1`). No prompt, nothing under an indefinite policy.
//
// Canonical bytes mirror @flagship/protocol servingAuthority.ts byte for byte
// (shared vectors: packages/protocol/test-vectors/serving-authority/vectors.json).

import {
  activeProfileId,
  bytesToHex,
  deriveAccountDeviceKeyFromSeed,
  kvGet,
  kvPut,
  servingRenewalKeyRecordKey,
  signWithAdminRoot,
  signWithIrk,
} from "../keystore.js";
import { getSession } from "./state.js";
import { getActiveProfile } from "./profiles.js";
import { controlApex } from "./apex.js";
import { accountReadFetch } from "./accountRead.js";
import { screensFetchForPod } from "./api.js";
import { isCompanionProfile } from "./companionGuard.js";
import { isDemoProfile } from "./demoAccount.js";
import { SERVER_ADMIN_ONLY } from "./addServerGate.js";

import { tr } from "./i18n.js";
export const TAG_SERVING_POLICY = "flagship/serving-policy/v1";
export const TAG_RENEWAL_KEY_DELEGATION = "flagship/renewal-key-delegation/v1";
export const TAG_SERVING_LEASE = "flagship/serving-lease/v1";

export const GRACES = ["7d", "30d", "indefinite"];
export const GRACE_MS = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
export const ON_LAPSE = ["stop-apps", "lock-server"];

/** Foreground renewals run at most this often (a new lease a few times a day is plenty). */
export const RENEW_MIN_INTERVAL_MS = 30 * 60_000;
/** While the app stays open, renew again this often. */
export const RENEW_PERIOD_MS = 3 * 3_600_000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const P256_PUB = /^0[23][0-9a-f]{64}$/;
const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function te(parts) {
  return new TextEncoder().encode(parts.join("|"));
}
function hexField(name, v, re = HEX64) {
  if (typeof v !== "string" || !re.test(v)) throw new Error(`${name} must be lowercase hex of the right length`);
}
function intField(name, v, min = 0) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new Error(`${name} must be a safe integer ≥ ${min}`);
}
function accountField(v) {
  if (typeof v !== "string" || !ACCOUNT.test(v)) throw new Error("account must be a lowercase account name");
}

// ── canonical bytes ─────────────────────────────────────────────────────────

/** `flagship/serving-policy/v1|<account>|<box>|<regGen>|<policyGen>|<grace>|<onLapse>|<scopeSha256>|<issuedAt>` */
export function canonicalServingPolicy(p) {
  accountField(p.account);
  hexField("box", p.box);
  intField("regGen", p.regGen, 1);
  intField("policyGen", p.policyGen, 1);
  if (!GRACES.includes(p.grace)) throw new Error("grace must be 7d, 30d or indefinite");
  if (!ON_LAPSE.includes(p.onLapse)) throw new Error("onLapse must be stop-apps or lock-server");
  if (p.onLapse === "lock-server" && p.grace === "indefinite") throw new Error("locking needs a time limit");
  hexField("scopeSha256", p.scopeSha256);
  intField("issuedAt", p.issuedAt);
  return te([TAG_SERVING_POLICY, p.account, p.box, p.regGen, p.policyGen, p.grace, p.onLapse, p.scopeSha256, p.issuedAt]);
}

/** `flagship/renewal-key-delegation/v1|<account>|p256|<renewalPub>|<deviceId>|<issuedAt>` */
export function canonicalRenewalKeyDelegation(d) {
  accountField(d.account);
  if (d.alg !== "p256") throw new Error("alg must be p256");
  hexField("renewalPub", d.renewalPub, P256_PUB);
  hexField("deviceId", d.deviceId);
  intField("issuedAt", d.issuedAt);
  return te([TAG_RENEWAL_KEY_DELEGATION, d.account, d.alg, d.renewalPub, d.deviceId, d.issuedAt]);
}

/** `flagship/serving-lease/v1|<account>|<box>|<regGen>|<policyGen>|<leaseId>|<issuedAt>|<notAfter>` */
export function canonicalServingLease(l) {
  accountField(l.account);
  hexField("box", l.box);
  intField("regGen", l.regGen, 1);
  intField("policyGen", l.policyGen, 1);
  hexField("leaseId", l.leaseId, HEX32);
  intField("issuedAt", l.issuedAt);
  intField("notAfter", l.notAfter);
  if (l.notAfter <= l.issuedAt) throw new Error("notAfter must be after issuedAt");
  return te([TAG_SERVING_LEASE, l.account, l.box, l.regGen, l.policyGen, l.leaseId, l.issuedAt, l.notAfter]);
}

/** The lease an admin device signs when the app is opened: the full grace ahead of now. Null under an indefinite policy. */
export function leaseFor(policy, now, leaseId) {
  if (!policy || policy.grace === "indefinite" || !GRACE_MS[policy.grace]) return null;
  return {
    account: policy.account,
    box: policy.box,
    regGen: policy.regGen,
    policyGen: policy.policyGen,
    leaseId,
    issuedAt: now,
    notAfter: now + GRACE_MS[policy.grace],
  };
}

export function isFinitePolicy(policy) {
  return !!policy && (policy.grace === "7d" || policy.grace === "30d");
}

// ── P-256: what WebCrypto gives, in the form the protocol takes ─────────────

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N >> 1n;

function bigFrom(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
function bytes32(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * WebCrypto ECDSA answers IEEE-P1363 `r‖s` (64 bytes) with either S; the
 * protocol takes only the low one (`s ≤ n/2`), so a high S becomes `n − s`
 * (the same signature, mirrored). Returns a new array.
 */
export function normalizeLowS(sig) {
  if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Error("a P-256 signature is 64 bytes r‖s");
  const s = bigFrom(sig.subarray(32));
  if (s === 0n || s >= P256_N) throw new Error("not a P-256 signature");
  const out = new Uint8Array(sig);
  if (s > P256_HALF_N) out.set(bytes32(P256_N - s), 32);
  return out;
}

/** SEC1 compressed form (33 bytes) of an uncompressed P-256 point (65 bytes, 0x04‖x‖y). */
export function compressP256(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 0x04) throw new Error("expected an uncompressed P-256 point");
  const out = new Uint8Array(33);
  out[0] = raw[64] & 1 ? 0x03 : 0x02;
  out.set(raw.subarray(1, 33), 1);
  return out;
}

/** Sign a lease with a renewal key: ECDSA P-256, SHA-256, compact low-S `r‖s` hex. */
export async function signLeaseP256(lease, privateKey) {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, canonicalServingLease(lease)));
  return bytesToHex(normalizeLowS(sig));
}

// ── the renewal key (non-extractable, in IndexedDB) ─────────────────────────

const ensuring = new Map();

function kvOf(deps) {
  return deps.kv ?? { get: kvGet, put: kvPut };
}
function recordKeyOf(deps) {
  return deps.recordKey ?? servingRenewalKeyRecordKey(activeProfileId());
}

/** This device's renewal key record, or null when it holds none. */
export async function loadRenewalKey(deps = {}) {
  const rec = await kvOf(deps).get(recordKeyOf(deps));
  return rec && rec.privateKey && typeof rec.pubHex === "string" && P256_PUB.test(rec.pubHex) ? rec : null;
}

/**
 * The renewal key, made on first use: ECDSA P-256 with `extractable: false`
 * (the private half never leaves the browser's key store; IndexedDB keeps the
 * CryptoKey object itself). `{ privateKey, publicKey, pubHex, createdAt, delegation }`.
 */
export async function ensureRenewalKey(deps = {}) {
  const key = recordKeyOf(deps);
  const have = await loadRenewalKey(deps);
  if (have) return have;
  let pending = ensuring.get(key);
  if (!pending) {
    pending = (async () => {
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      const rec = {
        version: 1,
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
        pubHex: bytesToHex(compressP256(raw)),
        createdAt: (deps.now ?? Date.now)(),
        delegation: null,
      };
      await kvOf(deps).put(key, rec);
      return rec;
    })().finally(() => ensuring.delete(key));
    ensuring.set(key, pending);
  }
  return pending;
}

// ── who signs the account's serving records ─────────────────────────────────

/**
 * The account's sensitive-order key on this device: the admin root, or the
 * IRK on a demo account (which pins none). Null on any other device: a
 * non-admin device sees the setting but never signs it.
 */
export function servingSigner(session = getSession(), profile = getActiveProfile()) {
  if (!session?.umk) return null;
  if (session.adminRootSeed instanceof Uint8Array) {
    const seed = session.adminRootSeed;
    return { kind: "admin", sign: (bytes) => signWithAdminRoot(seed, bytes) };
  }
  if (isDemoProfile(profile)) {
    const umk = session.umk;
    return { kind: "irk", sign: (bytes) => signWithIrk(umk, bytes) };
  }
  return null;
}

export function canEditServing(session = getSession(), profile = getActiveProfile()) {
  return !isCompanionProfile() && servingSigner(session, profile) !== null;
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

function accountOf(session) {
  return String(session?.username ?? "").toLowerCase();
}

async function postJson(url, body, deps) {
  const f = deps.fetch ?? fetch;
  return f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * The renewal key, delegated by the admin root for this account. The signed
 * delegation is kept with the key and posted to `.com` until it takes it, so
 * it is signed only once. Returns the key record.
 */
export async function ensureDelegation(deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  const signer = deps.signer ?? servingSigner(session, profile);
  if (!signer || signer.kind !== "admin") throw new Error("only an admin device delegates a renewal key");
  const account = accountOf(session);
  let rec = await ensureRenewalKey(deps);
  if (!(rec.delegation && rec.delegation.record?.account === account && rec.delegation.record?.renewalPub === rec.pubHex)) {
    const deviceId = deps.deviceId ?? (await accountDeviceKeyHex(session, profile));
    const record = { account, alg: "p256", renewalPub: rec.pubHex, deviceId, issuedAt: (deps.now ?? Date.now)() };
    const signature = bytesToHex(await signer.sign(canonicalRenewalKeyDelegation(record)));
    rec = { ...rec, delegation: { record, signature, posted: false } };
    await kvOf(deps).put(recordKeyOf(deps), rec);
  }
  if (!rec.delegation.posted) {
    const comBase = deps.comBase ?? controlApex();
    const r = await postJson(
      `${comBase}/api/accounts/${encodeURIComponent(account)}/renewal-delegations`,
      { delegation: rec.delegation.record, signature: rec.delegation.signature },
      deps,
    ).catch(() => null);
    const code = r && r.status === 409 ? ((await r.json().catch(() => null))?.code ?? "") : "";
    // A revoked renewal key never comes back: forget it, so the next renewal makes and delegates a new one.
    if (code === "renewal-key-revoked") {
      await kvOf(deps).put(recordKeyOf(deps), null);
      return null;
    }
    // 409 renewal-key-taken: `.com` already holds this delegation (one per renewal key).
    if (r && (r.ok || r.status === 409)) {
      rec = { ...rec, delegation: { ...rec.delegation, posted: true } };
      await kvOf(deps).put(recordKeyOf(deps), rec);
    }
  }
  return rec;
}

/** This device's account device key (the delegation's `deviceId`), hex. */
async function accountDeviceKeyHex(session, profile) {
  if (!profile?.accountId || !HEX32.test(profile.deviceId ?? "")) throw new Error("this device has no account device key");
  const key = await deriveAccountDeviceKeyFromSeed(session.umk, profile.accountId, profile.deviceId);
  return bytesToHex(key.publicKey);
}

// ── reading the account's servers ───────────────────────────────────────────

/** `GET /api/accounts/:u/serving`: one row per server, or null when it can't be read. */
export async function fetchServing(username, deps = {}) {
  const u = String(username ?? "").toLowerCase();
  if (!u) return null;
  const comBase = deps.comBase ?? controlApex();
  const url = `${comBase}/api/accounts/${encodeURIComponent(u)}/serving`;
  try {
    const r = deps.fetch
      ? await deps.fetch(url, { cache: "no-store" })
      : await accountReadFetch(url, { cache: "no-store" }, { baseUrl: comBase });
    if (!r?.ok) return null;
    const body = await r.json();
    const rows = Array.isArray(body) ? body : Array.isArray(body?.servers) ? body.servers : null;
    return rows ? rows.filter((s) => s && typeof s.serverDomain === "string") : null;
  } catch {
    return null;
  }
}

// ── signing leases ──────────────────────────────────────────────────────────

/**
 * Sign one lease per finite policy in `rows` (each `{serverDomain, policy:{record}}`).
 * Returns `[{serverDomain, lease, signature, delegation|null}]`.
 */
export async function signLeases(rows, deps = {}) {
  const session = deps.session ?? getSession();
  const signer = deps.signer ?? servingSigner(session, deps.profile ?? getActiveProfile());
  if (!signer) return [];
  const account = accountOf(session);
  const now = (deps.now ?? Date.now)();
  const due = rows.filter((s) => isFinitePolicy(s?.policy?.record) && s.policy.record.account === account);
  if (!due.length) return [];
  const rec = signer.kind === "admin" ? await ensureDelegation({ ...deps, session, signer }) : null;
  const out = [];
  for (const s of due) {
    const lease = leaseFor(s.policy.record, now, randomHex(16));
    if (!lease) continue;
    const signature = rec ? await signLeaseP256(lease, rec.privateKey) : bytesToHex(await signer.sign(canonicalServingLease(lease)));
    out.push({
      serverDomain: s.serverDomain,
      lease,
      signature,
      delegation: rec ? { record: rec.delegation.record, signature: rec.delegation.signature } : null,
    });
  }
  return out;
}

/** Post signed leases to `.com` in one call, and to each box (best effort). */
export async function deliverLeases(signed, deps = {}) {
  if (!signed.length) return { accepted: 0, refused: [] };
  const session = deps.session ?? getSession();
  const account = accountOf(session);
  const comBase = deps.comBase ?? controlApex();
  let result = { accepted: 0, refused: [], ok: false };
  try {
    const r = await postJson(
      `${comBase}/api/accounts/${encodeURIComponent(account)}/serving-leases`,
      {
        leases: signed.map((x) => ({
          lease: x.lease,
          signature: x.signature,
          ...(x.delegation ? { delegationPub: x.delegation.record.renewalPub } : {}),
        })),
      },
      deps,
    );
    const body = await r.json().catch(() => ({}));
    result = {
      ok: r.ok,
      accepted: Number.isFinite(body?.accepted) ? body.accepted : r.ok ? signed.length : 0,
      refused: Array.isArray(body?.refused) ? body.refused : [],
    };
  } catch {
    // `.com` unreachable: the box copies below still keep it serving.
  }
  await Promise.all(
    signed.map((x) =>
      boxPost(
        x.serverDomain,
        {
          leases: [{ record: x.lease, signature: x.signature, ...(x.delegation ? { delegationPub: x.delegation.record.renewalPub } : {}) }],
          ...(x.delegation ? { delegations: [x.delegation] } : {}),
        },
        deps,
      ),
    ),
  );
  return result;
}

/** `POST /api/screens/serving` on one box; never throws (the box may be off or older). */
async function boxPost(serverDomain, body, deps) {
  try {
    const send = deps.boxFetch ?? ((fqdn, path, init) => screensFetchForPod(fqdn, path, init));
    await send(String(serverDomain).toLowerCase(), "/api/screens/serving", { method: "POST", body: JSON.stringify(body) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The renewal on app open: on an admin device, sign a lease for every server
 * whose policy is finite and send them. Silent; nothing under an indefinite policy.
 */
export async function renewServingLeases(deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  const signer = deps.signer ?? servingSigner(session, profile);
  if (!signer || !accountOf(session)) return { signed: 0 };
  // A fresh install holds no renewal key: make it now, even with nothing to renew yet.
  if (signer.kind === "admin") await ensureRenewalKey(deps).catch(() => null);
  const rows = deps.rows ?? (await fetchServing(accountOf(session), deps));
  if (!rows) return { signed: 0 };
  const signed = await signLeases(rows, { ...deps, session, profile, signer });
  if (!signed.length) return { signed: 0 };
  const r = await deliverLeases(signed, { ...deps, session });
  noteLeases(signed, deps);
  return { signed: signed.length, ...r };
}

// What this device last signed, per server: the line can show a lease that `.com` hasn't echoed back yet.
const lastSigned = new Map();
function noteLeases(signed) {
  for (const x of signed) lastSigned.set(String(x.serverDomain).toLowerCase(), x.lease.notAfter);
}
export function lastSignedUntil(serverDomain) {
  return lastSigned.get(String(serverDomain ?? "").toLowerCase()) ?? null;
}

/** May this tab renew now: unlocked, an owner (not a remote browser), on an admin device. */
export function canRenewServing(isUnlocked) {
  try {
    return !!isUnlocked() && !isCompanionProfile() && servingSigner() !== null && !!getSession()?.username;
  } catch {
    return false;
  }
}

/**
 * Renew on load, whenever the app comes back to the foreground (at most every
 * `minIntervalMs`), and every `periodMs` while it stays open and visible.
 */
export function startServingRenewal({
  isActive,
  renew = () => renewServingLeases(),
  now = Date.now,
  minIntervalMs = RENEW_MIN_INTERVAL_MS,
  periodMs = RENEW_PERIOD_MS,
  target = globalThis,
}) {
  let lastAt = -Infinity;
  let running = null;
  const sync = async ({ force = false } = {}) => {
    let active = false;
    try {
      active = isActive();
    } catch {
      active = false;
    }
    if (!active) return null;
    if (running) return running;
    if (!force && now() - lastAt < minIntervalMs) return null;
    lastAt = now();
    running = Promise.resolve()
      .then(renew)
      .catch(() => null);
    try {
      return await running;
    } finally {
      running = null;
    }
  };
  const visible = () => target.document?.visibilityState !== "hidden";
  try {
    target.document?.addEventListener("visibilitychange", () => {
      if (visible()) void sync();
    });
    target.addEventListener?.("focus", () => void sync());
    // Unlocking (or switching account) shows a view: the first chance after a load.
    target.document?.addEventListener("flagship:view-shown", () => void sync());
  } catch {
    /* no DOM */
  }
  const timer = periodMs > 0 && typeof target.setInterval === "function"
    ? target.setInterval(() => {
        if (visible()) void sync({ force: true });
      }, periodMs)
    : null;
  void sync({ force: true });
  return { sync, stop: () => timer && target.clearInterval?.(timer) };
}

// ── the policy editor's order ───────────────────────────────────────────────

export class ServingPolicyError extends Error {
  constructor(message, status = 0, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * What a server's page needs to show and edit its setting, from the box's
 * `server-detail.serving` and `.com`'s row (either may be missing on an older
 * box or before `.com` answers): `{grace, onLapse, until, policyGen, regGen, scopeSha256, boxPub}`.
 */
export function servingView({ detail = null, row = null, pod = null, serverDomain = "" } = {}) {
  const policy = row?.policy?.record ?? null;
  if (!detail && !row) return null;
  const grace = GRACES.includes(row?.grace) ? row.grace : GRACES.includes(policy?.grace) ? policy.grace : GRACES.includes(detail?.grace) ? detail.grace : "indefinite";
  const onLapseRaw = row?.onLapse ?? policy?.onLapse ?? detail?.onLapse;
  const onLapse = grace !== "indefinite" && onLapseRaw === "lock-server" ? "lock-server" : "stop-apps";
  const untils = [row?.until, detail?.until, serverDomain ? lastSignedUntil(serverDomain) : null].filter((n) => typeof n === "number" && n > 0);
  const regGen = Number.isSafeInteger(row?.regGen) ? row.regGen : Number.isSafeInteger(detail?.regGen) ? detail.regGen : null;
  const gens = [policy?.policyGen, detail?.policyGen].filter((n) => Number.isSafeInteger(n));
  const boxPub = String(row?.boxPub ?? detail?.boxPub ?? policy?.box ?? pod?.identityPubKey ?? "").toLowerCase();
  return {
    grace,
    onLapse,
    until: grace === "indefinite" ? null : untils.length ? Math.max(...untils) : null,
    policyGen: gens.length ? Math.max(...gens) : 0,
    regGen,
    scopeSha256: typeof detail?.scopeSha256 === "string" ? detail.scopeSha256 : null,
    boxPub: HEX64.test(boxPub) ? boxPub : null,
  };
}

/**
 * Sign a new `serving-policy/v1` for one server (policyGen = current + 1),
 * post it to `.com` and the box, and when it is finite sign the first lease at
 * once. Throws a ServingPolicyError with `.com`'s sentence when refused.
 */
export async function saveServingPolicy({ serverDomain, view, grace, onLapse }, deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  const signer = deps.signer ?? servingSigner(session, profile);
  if (!signer) throw new ServingPolicyError(SERVER_ADMIN_ONLY, 403, "not-admin");
  if (!GRACES.includes(grace)) throw new ServingPolicyError(`unknown time limit: ${String(grace)}`);
  if (!view?.boxPub || !view?.scopeSha256 || !Number.isSafeInteger(view?.regGen)) {
    throw new ServingPolicyError(tr("This server hasn't reported its setting yet. Update it, then try again."), 0, "no-scope");
  }
  const account = accountOf(session);
  const policy = {
    account,
    box: view.boxPub,
    regGen: view.regGen,
    policyGen: (view.policyGen || 0) + 1,
    grace,
    onLapse: grace === "indefinite" ? "stop-apps" : onLapse === "lock-server" ? "lock-server" : "stop-apps",
    scopeSha256: view.scopeSha256,
    issuedAt: (deps.now ?? Date.now)(),
  };
  const signature = bytesToHex(await signer.sign(canonicalServingPolicy(policy)));
  const comBase = deps.comBase ?? controlApex();
  let r;
  try {
    r = await postJson(`${comBase}/api/accounts/${encodeURIComponent(account)}/serving-policy`, { policy, signature }, deps);
  } catch {
    throw new ServingPolicyError(tr("Couldn't reach flagshipserver.com."), 0, "network");
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new ServingPolicyError(typeof body?.error === "string" && body.error ? body.error : `HTTP ${r.status}`, r.status, String(body?.code ?? ""));
  }
  await boxPost(serverDomain, { policy: { record: policy, signature } }, deps);
  let until = null;
  if (isFinitePolicy(policy)) {
    const signed = await signLeases([{ serverDomain, policy: { record: policy, signature } }], { ...deps, session, profile, signer }).catch(() => []);
    if (signed.length) {
      await deliverLeases(signed, { ...deps, session });
      noteLeases(signed);
      until = signed[0].lease.notAfter;
    }
  }
  return { policy, signature, until };
}
