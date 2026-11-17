// The $1 voucher and the voucher wallet: browser port of packages/protocol/src/{blindRsa,voucher,voucherWallet,
// paymentsConfig}.ts, byte for byte (vectors packages/protocol/test-vectors/vouchers/, replayed by
// apps/web/tests/webappVouchers.test.ts). docs/payments-privacy-and-rails.md "As built".
//
//   RFC 9474 RSABSSA-SHA384-PSS-Randomized: newVoucherRequest → (issuer signs blind) → finalizeVoucher; verifyVoucher
//   voucherNullifier, voucherKeyId, rsaFromVoucherKey
//   wallet: deriveVoucherWalletKey, sealVoucherWallet, openVoucherWallet, mergeVoucherWallets, voucherWalletPlaintext
//   rules: trickleStep, overageStep, planAheadMs, planUnitMs, monthsOfPlan, DEFAULT_PAYMENTS_CONFIG, mergePaymentsConfig

import { sha256, sha384 } from "../vendor/noble-hashes/sha2.js";
import { aesGcm, b64Decode, b64Encode, canonicalJson, hex, hexToBytes, hkdfSha256, isLowerHex } from "./voiciCore.js";

const te = new TextEncoder();
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isTime = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const exactKeys = (r, keys) => Object.keys(r).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

// ── payment numbers (paymentsConfig.ts) ────────────────────────────────────

export const PAID_PLANS = ["pro", "pro-max"];
export const isPaidPlan = (v) => v === "pro" || v === "pro-max";
export const planOfTier = (tier) => (tier === "hobby" ? "pro" : tier === "maker" ? "pro-max" : null);

export const DEFAULT_PAYMENTS_CONFIG = {
  v: 1,
  unitUsd: 1,
  monthDays: 30,
  plans: { pro: { unitsPerMonth: 10, includedGb: 250 }, "pro-max": { unitsPerMonth: 20, includedGb: 500 } },
  overage: { blockUnits: 5, blockGb: 100, defaultCapUnits: 10, maxCapUnits: 100, buyBelowGb: 10 },
  graceHours: 72,
  maxAheadDays: 35,
  trickle: { lowWaterDays: 3, highWaterDays: 10 },
  activationDelayMaxHours: 24,
  packs: [10, 30, 120],
  maxPerRequest: 30,
  business: {
    unitsPerSeatMonth: 6,
    minSeats: 3,
    maxSeats: 10_000,
    egressGbPerSeat: 100,
    trialSeats: 10,
    trialDays: 30,
    batchMinUnits: 100,
    batchMaxUnits: 5000,
  },
};

const DAY_MS = 86_400_000;

/** A served config, trusted only for well-formed numbers: anything else keeps the default. */
export function mergePaymentsConfig(raw) {
  const d = DEFAULT_PAYMENTS_CONFIG;
  if (!isObj(raw)) return d;
  const pos = (v, fallback, max = 1_000_000) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max ? v : fallback);
  const plans = isObj(raw.plans) ? raw.plans : {};
  const plan = (p) => {
    const x = isObj(plans[p]) ? plans[p] : {};
    return { unitsPerMonth: pos(x.unitsPerMonth, d.plans[p].unitsPerMonth, 1000), includedGb: pos(x.includedGb, d.plans[p].includedGb) };
  };
  const ov = isObj(raw.overage) ? raw.overage : {};
  const tr = isObj(raw.trickle) ? raw.trickle : {};
  const bz = isObj(raw.business) ? raw.business : {};
  const db = d.business;
  const packs = Array.isArray(raw.packs) && raw.packs.length > 0 && raw.packs.length <= 6 && raw.packs.every((p) => pos(p, 0, 1000) > 0) ? raw.packs : d.packs;
  const out = {
    v: 1,
    unitUsd: pos(raw.unitUsd, d.unitUsd, 100),
    monthDays: pos(raw.monthDays, d.monthDays, 31),
    plans: { pro: plan("pro"), "pro-max": plan("pro-max") },
    overage: {
      blockUnits: pos(ov.blockUnits, d.overage.blockUnits, 100),
      blockGb: pos(ov.blockGb, d.overage.blockGb),
      defaultCapUnits: pos(ov.defaultCapUnits, d.overage.defaultCapUnits, 1000),
      maxCapUnits: pos(ov.maxCapUnits, d.overage.maxCapUnits, 10_000),
      buyBelowGb: pos(ov.buyBelowGb, d.overage.buyBelowGb),
    },
    graceHours: d.graceHours,
    maxAheadDays: pos(raw.maxAheadDays, d.maxAheadDays, 400),
    trickle: { lowWaterDays: pos(tr.lowWaterDays, d.trickle.lowWaterDays, 60), highWaterDays: pos(tr.highWaterDays, d.trickle.highWaterDays, 120) },
    activationDelayMaxHours: pos(raw.activationDelayMaxHours, d.activationDelayMaxHours, 24 * 7),
    packs: [...packs].sort((a, b) => a - b),
    maxPerRequest: pos(raw.maxPerRequest, d.maxPerRequest, 200),
    business: {
      unitsPerSeatMonth: pos(bz.unitsPerSeatMonth, db.unitsPerSeatMonth, 1000),
      minSeats: pos(bz.minSeats, db.minSeats, 1000),
      maxSeats: pos(bz.maxSeats, db.maxSeats, 1_000_000),
      egressGbPerSeat: pos(bz.egressGbPerSeat, db.egressGbPerSeat),
      trialSeats: pos(bz.trialSeats, db.trialSeats, 10_000),
      trialDays: pos(bz.trialDays, db.trialDays, 365),
      batchMinUnits: pos(bz.batchMinUnits, db.batchMinUnits, 100_000),
      batchMaxUnits: pos(bz.batchMaxUnits, db.batchMaxUnits, 100_000),
    },
  };
  if (out.business.maxSeats < out.business.minSeats || out.business.batchMaxUnits < out.business.batchMinUnits) out.business = db;
  if (out.trickle.highWaterDays <= out.trickle.lowWaterDays || out.maxAheadDays <= out.trickle.highWaterDays) out.trickle = d.trickle;
  if (out.maxAheadDays <= out.trickle.highWaterDays) out.maxAheadDays = d.maxAheadDays;
  return out;
}

export const planUnitMs = (cfg, plan) => Math.floor((cfg.monthDays * DAY_MS) / cfg.plans[plan].unitsPerMonth);
export const monthsOfPlan = (cfg, plan, balance) => Math.floor(balance / cfg.plans[plan].unitsPerMonth);

// ── RSA blind signatures (blindRsa.ts) ─────────────────────────────────────

const H_LEN = 48;
const S_LEN = 48;
const PREFIX_LEN = 32;

const bitLength = (x) => x.toString(2).length;
const modulusBytes = (pk) => Math.ceil(bitLength(pk.n) / 8);

function bytesToInt(b) {
  const h = hex(b);
  return h.length === 0 ? 0n : BigInt("0x" + h);
}

function intToBytes(x, len) {
  let h = x.toString(16);
  if (h.length > len * 2) throw new Error("integer too large");
  h = h.padStart(len * 2, "0");
  return hexToBytes(h);
}

function modPow(base, exp, m) {
  let r = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function modInv(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("not invertible");
  return ((oldS % m) + m) % m;
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function mgf1(seed, len) {
  const out = new Uint8Array(len);
  let off = 0;
  for (let c = 0; off < len; c++) {
    const h = sha384(concat(seed, new Uint8Array([(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255])));
    out.set(h.subarray(0, Math.min(h.length, len - off)), off);
    off += h.length;
  }
  return out;
}

function emsaPssEncode(msg, emBits, salt) {
  const emLen = Math.ceil(emBits / 8);
  if (emLen < H_LEN + S_LEN + 2) throw new Error("modulus too small");
  const h = sha384(concat(new Uint8Array(8), sha384(msg), salt));
  const db = new Uint8Array(emLen - H_LEN - 1);
  db[emLen - S_LEN - H_LEN - 2] = 0x01;
  db.set(salt, emLen - S_LEN - H_LEN - 1);
  const mask = mgf1(h, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >>> (8 * emLen - emBits);
  return concat(db, h, new Uint8Array([0xbc]));
}

function emsaPssVerify(msg, em, emBits) {
  const emLen = Math.ceil(emBits / 8);
  if (em.length !== emLen || emLen < H_LEN + S_LEN + 2 || em[emLen - 1] !== 0xbc) return false;
  const maskedDb = em.subarray(0, emLen - H_LEN - 1);
  const h = em.subarray(emLen - H_LEN - 1, emLen - 1);
  const topMask = 0xff >>> (8 * emLen - emBits);
  if ((maskedDb[0] & ~topMask & 0xff) !== 0) return false;
  const mask = mgf1(h, maskedDb.length);
  const db = new Uint8Array(maskedDb.length);
  for (let i = 0; i < db.length; i++) db[i] = maskedDb[i] ^ mask[i];
  db[0] &= topMask;
  const psLen = emLen - H_LEN - S_LEN - 2;
  for (let i = 0; i < psLen; i++) if (db[i] !== 0) return false;
  if (db[psLen] !== 0x01) return false;
  const h2 = sha384(concat(new Uint8Array(8), sha384(msg), db.subarray(db.length - S_LEN)));
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h2[i] ^ h[i];
  return diff === 0;
}

function rsaPssVerify(pk, msg, sig) {
  const kLen = modulusBytes(pk);
  if (sig.length !== kLen) return false;
  const s = bytesToInt(sig);
  if (s >= pk.n) return false;
  const emBits = bitLength(pk.n) - 1;
  let em;
  try {
    em = intToBytes(modPow(s, pk.e, pk.n), Math.ceil(emBits / 8));
  } catch {
    return false;
  }
  return emsaPssVerify(msg, em, emBits);
}

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

// ── the voucher (voucher.ts) ───────────────────────────────────────────────

export const TAG_VOUCHER = "flagship/voucher/v1";
export const TAG_VOUCHER_KEY = "flagship/voucher-key/v1";
export const TAG_VOUCHER_NULLIFIER = "flagship/voucher-nullifier/v1";
const KEY_ID = /^[0-9a-f]{16}$/;

const bigFromHex = (h) => (h.length === 0 ? 0n : BigInt("0x" + h));
const evenHex = (x) => {
  const h = x.toString(16);
  return h.length % 2 ? "0" + h : h;
};

export const voucherKeyId = (nHex, eHex) => hex(sha256(te.encode(`${TAG_VOUCHER_KEY}|${nHex}|${eHex}`))).slice(0, 16);

/** The RSA key of a served key, or null when its id doesn't match its numbers or it is too small. */
export function rsaFromVoucherKey(k) {
  if (!isObj(k) || typeof k.keyId !== "string" || !KEY_ID.test(k.keyId) || !isLowerHex(k.nHex) || !isLowerHex(k.eHex) || k.eHex.length === 0) return null;
  if (voucherKeyId(k.nHex, k.eHex) !== k.keyId) return null;
  const pk = { n: bigFromHex(k.nHex), e: bigFromHex(k.eHex) };
  if (bitLength(pk.n) < 2048 || k.nHex.length !== modulusBytes(pk) * 2) return null;
  if (pk.e < 3n || pk.e % 2n === 0n) return null;
  return pk;
}

export function voucherMessage(nonce) {
  if (nonce.length !== 32) throw new Error(`${TAG_VOUCHER}: nonce must be 32 bytes`);
  return concat(te.encode(`${TAG_VOUCHER}|`), nonce);
}

export const voucherPrepared = (v) => concat(hexToBytes(v.p), voucherMessage(hexToBytes(v.n)));
export const voucherNullifier = (v) => hex(sha256(te.encode(`${TAG_VOUCHER_NULLIFIER}|${v.k}|${v.n}`)));

/** What a Stripe order commits to before payment (protocol voucherRails.ts): the key and the blinded requests, in order. */
export const TAG_VOUCHER_ORDER = "flagship/voucher-order/v1";
export const voucherOrderCommit = (keyId, blinded) => hex(sha256(te.encode(`${TAG_VOUCHER_ORDER}|${keyId}|${blinded.join("|")}`)));

export function parseVoucher(v) {
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 4 || !["k", "p", "n", "s"].every((k) => keys.includes(k))) return null;
  if (typeof v.k !== "string" || !KEY_ID.test(v.k) || !isLowerHex(v.p, 32) || !isLowerHex(v.n, 32)) return null;
  if (typeof v.s !== "string" || !b64Decode(v.s)) return null;
  return { k: v.k, p: v.p, n: v.n, s: v.s };
}

/** One request under `key`: {pending (keep until signed), blinded (send)}. `opts` is for test vectors only. */
export function newVoucherRequest(key, opts = {}) {
  const pk = rsaFromVoucherKey(key);
  if (!pk) throw new Error(`${TAG_VOUCHER}: bad key`);
  const nonce = opts.nonce ?? random(32);
  const prefix = opts.prefix ?? random(PREFIX_LEN);
  if (prefix.length !== PREFIX_LEN) throw new Error("prefix must be 32 bytes");
  const prepared = concat(prefix, voucherMessage(nonce));
  const kLen = modulusBytes(pk);
  const salt = opts.salt ?? random(S_LEN);
  const m = bytesToInt(emsaPssEncode(prepared, bitLength(pk.n) - 1, salt));
  if (gcd(m, pk.n) !== 1n) throw new Error("invalid input");
  let r = opts.r;
  if (r === undefined) {
    do {
      r = bytesToInt(random(kLen)) % pk.n;
    } while (r < 2n || gcd(r, pk.n) !== 1n);
  }
  const inv = modInv(r, pk.n);
  const z = (m * modPow(r, pk.e, pk.n)) % pk.n;
  return { pending: { k: key.keyId, p: hex(prefix), n: hex(nonce), inv: evenHex(inv) }, blinded: b64Encode(intToBytes(z, kLen)) };
}

/** Unblind the issuer's answer; throws when it doesn't verify. */
export function finalizeVoucher(key, pending, blindSig) {
  const pk = rsaFromVoucherKey(key);
  if (!pk || pending.k !== key.keyId) throw new Error(`${TAG_VOUCHER}: bad key`);
  const bs = b64Decode(blindSig);
  const kLen = modulusBytes(pk);
  if (!bs || bs.length !== kLen) throw new Error(`${TAG_VOUCHER}: bad blind signature`);
  const sig = intToBytes((bytesToInt(bs) * bigFromHex(pending.inv)) % pk.n, kLen);
  if (!rsaPssVerify(pk, voucherPrepared(pending), sig)) throw new Error("the signer's blind signature doesn't verify");
  return { k: pending.k, p: pending.p, n: pending.n, s: b64Encode(sig) };
}

export function verifyVoucher(key, v) {
  const pk = rsaFromVoucherKey(key);
  if (!pk || !isObj(v) || v.k !== key.keyId) return false;
  const sig = b64Decode(v.s);
  if (!sig || !isLowerHex(v.p, 32) || !isLowerHex(v.n, 32)) return false;
  return rsaPssVerify(pk, voucherPrepared(v), sig);
}

// ── the wallet (voucherWallet.ts) ──────────────────────────────────────────

export const TAG_VOUCHER_WALLET = "flagship/voucher-wallet/v1";
export const VOUCHER_WALLET_MAX_VOUCHERS = 500;
export const VOUCHER_WALLET_MAX_SPENT = 2048;
export const VOUCHER_WALLET_BUCKET = 4096;
export const VOUCHER_WALLET_MAX_BYTES = 512 * 1024;
const PERIOD = /^(\d{4}-(0[1-9]|1[0-2]))?$/;

export function emptyVoucherWallet(overageCapUnits) {
  return {
    v: 1,
    vouchers: [],
    spent: [],
    settings: { plan: null, autoPay: true, overageCapUnits, delayStart: false, startAt: 0, updatedAt: 0 },
    overage: { period: "", units: 0 },
  };
}

const byKn = (a, b) => (a.k === b.k ? (a.n < b.n ? -1 : a.n > b.n ? 1 : 0) : a.k < b.k ? -1 : 1);

function parseSettings(v) {
  if (!isObj(v) || !exactKeys(v, ["plan", "autoPay", "overageCapUnits", "delayStart", "startAt", "updatedAt"])) return null;
  if (!(v.plan === null || isPaidPlan(v.plan)) || typeof v.autoPay !== "boolean" || typeof v.delayStart !== "boolean") return null;
  if (!isTime(v.overageCapUnits) || v.overageCapUnits > 10_000 || !isTime(v.startAt) || !isTime(v.updatedAt)) return null;
  return { plan: v.plan, autoPay: v.autoPay, overageCapUnits: v.overageCapUnits, delayStart: v.delayStart, startAt: v.startAt, updatedAt: v.updatedAt };
}

export function parseVoucherWallet(v) {
  if (!isObj(v)) return null;
  const keys = Object.keys(v).filter((k) => k !== "pad");
  if (keys.length !== 5 || !["v", "vouchers", "spent", "settings", "overage"].every((k) => keys.includes(k)) || v.v !== 1) return null;
  if ("pad" in v && (typeof v.pad !== "string" || !/^0*$/.test(v.pad))) return null;
  if (!Array.isArray(v.vouchers) || v.vouchers.length > VOUCHER_WALLET_MAX_VOUCHERS) return null;
  if (!Array.isArray(v.spent) || v.spent.length > VOUCHER_WALLET_MAX_SPENT || !v.spent.every((s) => isLowerHex(s, 32))) return null;
  const vouchers = [];
  for (const x of v.vouchers) {
    const p = parseVoucher(x);
    if (!p) return null;
    vouchers.push(p);
  }
  const settings = parseSettings(v.settings);
  if (!settings || !isObj(v.overage) || !exactKeys(v.overage, ["period", "units"])) return null;
  if (typeof v.overage.period !== "string" || !PERIOD.test(v.overage.period) || !isTime(v.overage.units)) return null;
  return normalizeVoucherWallet({ v: 1, vouchers, spent: v.spent, settings, overage: { period: v.overage.period, units: v.overage.units } });
}

export function normalizeVoucherWallet(w) {
  const spent = [...new Set(w.spent)].sort().slice(-VOUCHER_WALLET_MAX_SPENT);
  const spentSet = new Set(spent);
  const seen = new Set();
  const vouchers = [];
  for (const x of [...w.vouchers].sort(byKn)) {
    const id = `${x.k}|${x.n}`;
    if (seen.has(id) || spentSet.has(voucherNullifier(x))) continue;
    seen.add(id);
    vouchers.push(x);
  }
  return { v: 1, vouchers: vouchers.slice(0, VOUCHER_WALLET_MAX_VOUCHERS), spent, settings: { ...w.settings }, overage: { ...w.overage } };
}

export function mergeVoucherWallets(local, remote) {
  const settings = remote.settings.updatedAt > local.settings.updatedAt ? remote.settings : local.settings;
  const overage =
    local.overage.period === remote.overage.period
      ? { period: local.overage.period, units: Math.max(local.overage.units, remote.overage.units) }
      : local.overage.period > remote.overage.period
        ? local.overage
        : remote.overage;
  return normalizeVoucherWallet({ v: 1, vouchers: [...local.vouchers, ...remote.vouchers], spent: [...local.spent, ...remote.spent], settings, overage });
}

export const takeVouchers = (w, n) => normalizeVoucherWallet(w).vouchers.slice(0, Math.max(0, n));
export const markVouchersSpent = (w, nullifiers) => normalizeVoucherWallet({ ...w, spent: [...w.spent, ...nullifiers] });
export const addVouchers = (w, vouchers) => normalizeVoucherWallet({ ...w, vouchers: [...w.vouchers, ...vouchers] });

export function voucherWalletPlaintext(w) {
  const n = normalizeVoucherWallet(w);
  const bare = canonicalJson({ ...n, pad: "" });
  let bucket = VOUCHER_WALLET_BUCKET;
  while (bucket < bare.length) bucket *= 2;
  if (bucket > VOUCHER_WALLET_MAX_BYTES) throw new Error(`${TAG_VOUCHER_WALLET}: too large`);
  return canonicalJson({ ...n, pad: "0".repeat(bucket - bare.length) });
}

export const deriveVoucherWalletKey = (umk) => hkdfSha256(umk.seed, TAG_VOUCHER_WALLET, 32);

export function sealVoucherWallet(key, version, w, nonce = random(12)) {
  if (!isTime(version) || version < 1 || nonce.length !== 12) throw new Error(`${TAG_VOUCHER_WALLET}: bad input`);
  const ct = aesGcm(key, nonce, te.encode(`${TAG_VOUCHER_WALLET}|${version}`)).encrypt(te.encode(voucherWalletPlaintext(w)));
  return { version, nonce: hex(nonce), ct: b64Encode(ct) };
}

export function openVoucherWallet(key, blob) {
  if (!isObj(blob) || !exactKeys(blob, ["version", "nonce", "ct"]) || !isTime(blob.version) || !isLowerHex(blob.nonce, 12)) return null;
  const ct = b64Decode(blob.ct);
  if (!ct || ct.length > VOUCHER_WALLET_MAX_BYTES + 16) return null;
  try {
    const pt = aesGcm(key, hexToBytes(blob.nonce), te.encode(`${TAG_VOUCHER_WALLET}|${blob.version}`)).decrypt(ct);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt);
    const v = JSON.parse(text);
    return canonicalJson(v) === text ? parseVoucherWallet(v) : null;
  } catch {
    return null;
  }
}

// ── spending rules ─────────────────────────────────────────────────────────

export function planAheadMs(cfg, plan, paid, now) {
  if (!paid.plan || paid.paidUntil <= 0) return 0;
  if (paid.paidUntil + cfg.graceHours * 3_600_000 < now) return 0;
  const ahead = paid.paidUntil - now;
  if (paid.plan === plan || ahead <= 0) return paid.plan === plan ? ahead : 0;
  return Math.floor((ahead * planUnitMs(cfg, plan)) / planUnitMs(cfg, paid.plan));
}

export function trickleStep(t, rand) {
  if (!t.enabled || t.balance <= 0) return { spend: 0, nextSpendAt: 0 };
  if (t.now < t.startAt) return { spend: 0, nextSpendAt: t.nextSpendAt };
  const later = t.now + Math.floor(rand * t.unitMs);
  if (t.aheadMs < t.lowWaterMs) {
    const need = Math.ceil((t.lowWaterMs - t.aheadMs) / t.unitMs);
    return { spend: Math.max(1, Math.min(t.balance, need, t.maxPerRequest)), nextSpendAt: later };
  }
  if (t.aheadMs >= t.highWaterMs) return { spend: 0, nextSpendAt: 0 };
  if (t.nextSpendAt === 0) return { spend: 0, nextSpendAt: later };
  if (t.now >= t.nextSpendAt) return { spend: 1, nextSpendAt: later };
  return { spend: 0, nextSpendAt: t.nextSpendAt };
}

export const overageStep = (o) => o.paid && o.remainingBytes < o.buyBelowBytes && o.spentUnits + o.blockUnits <= o.capUnits && o.balance >= o.blockUnits;

export function overagePeriod(now) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A crypto-random number in [0, 1). */
export function cryptoRand() {
  const b = crypto.getRandomValues(new Uint32Array(2));
  return (b[0] * 2 ** 21 + (b[1] >>> 11)) / 2 ** 53;
}
