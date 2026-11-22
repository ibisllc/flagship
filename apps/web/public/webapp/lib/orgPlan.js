// The org's Business plan in the webapp (docs/plans-and-backup-offer.md "As built"). The protocol is the bundled
// packages/protocol code (vendor/flagship-org: orgPlan, orgWallet, voucherBatch); the org's wallet is sealed under
// the org key ring's `wallet` key, which only org admins open, and every write carries one org admin's approval.
//
//   loadOrgPlan          GET  /api/orgs/<id>/plan                 (public)
//   openOrgWallet        GET  /api/orgs/<id>/voucher-wallet       (ciphertext; opened with the ring's `wallet` key)
//   updateOrgWallet      PUT  /api/orgs/<id>/voucher-wallet       (one org admin's approval, compare-and-set)
//   orgSpendTick         the org trickle: seats × 6 a month, a voucher at a time, through the private relay
//   importVoucherFiles   voucher files (a company batch, a colleague's leftovers) into the org wallet
//   buyBatch / finishBatches  a company's invoiced batch (Stripe Checkout with the tax id and an invoice; card, or bank
//                        transfer when `.com` offers it), from one
//                        seed kept in this browser and in a batch key file the buyer may save
//   refreshAfterRotation every voucher an earlier `wallet` key could read is exchanged for a fresh one, so an admin
//                        who left can't spend them

import * as org from "../vendor/flagship-org/org.js";
import { finalizeVoucher, newVoucherRequest } from "./vouchers.js";
import { approvalBy, keyContext, orgApi, withSeatAdminKey } from "./orgSeat.js";
import { PlanError, loadPaymentsConfig, redeemVouchers } from "./plan.js";
import { controlApex } from "./apex.js";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(String(h).match(/../g) ?? [], (x) => parseInt(x, 16));
const DAY = 86_400_000;
const BATCH_KEY = "flagship.voucherBatches.v1";

function c0(deps = {}) {
  return {
    call: deps.call ?? orgApi(deps),
    fetch: deps.fetch ?? ((...a) => globalThis.fetch(...a)),
    apex: (deps.apex ?? controlApex()).replace(/\/+$/, ""),
    now: deps.now ?? Date.now,
    rand: deps.rand ?? (() => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32),
    store: deps.store ?? globalThis.localStorage,
  };
}

/** `GET /plan`: {status, seatLimit, paidSeats, paidUntil, trialEndsAt, coveredUntil, liveSeats, price}. */
export async function loadOrgPlan(orgId, deps = {}) {
  return c0(deps).call("GET", `/api/orgs/${orgId}/plan`);
}

/** The terms orgPlan.ts computes with, from the served plan. */
export const termsOf = (p) => ({ trialEndsAt: p.trialEndsAt, trialSeats: p.status === "trial" ? p.seatLimit : 0, paidSeats: p.paidSeats, paidUntil: p.paidUntil });

/** The seats the org pays for at least: the minimum, or the live seats when there are more. */
export const minPayableSeats = (cfg, p) => Math.max(cfg.business.minSeats, p.liveSeats ?? 0);

/** Price lines from the served numbers (never hard-coded): per seat and for `seats` a month, in USD. */
export function priceOf(cfg, seats) {
  const perSeat = cfg.business.unitsPerSeatMonth * cfg.unitUsd;
  return { perSeat, perMonth: perSeat * seats, units: org.orgMonthlyUnits(cfg, seats) };
}

// ── the wallet key ─────────────────────────────────────────────────────────

/**
 * Every `wallet` key version sealed to this seat, newest last: [{version, key}]. When the org has none yet and this
 * seat is an org admin, `create` makes version 1 (sealed to every org admin with a KEM key) and posts it.
 */
export async function walletKeys(seat, snap, { umk, create = false, now = Date.now(), deps = {} } = {}) {
  const { call } = c0(deps);
  let kc = await keyContext(call, snap, now);
  let chain = kc.rings.chains.get(org.orgKeyChainId("wallet", "*")) ?? [];
  if (chain.length === 0 && create && seat.adminBinding) {
    const b = await withSeatAdminKey(seat, umk, async (secret) =>
      org.rotateOrgKey({ ctx: kc.ctx, rings: kc.rings, kind: "wallet", scope: "*", pending: [], issuedAt: now, approve: (order, v) => approvalBy(seat, secret, order, v, now) }),
    );
    await call("POST", `/api/orgs/${seat.orgId}/keys`, b);
    kc = await keyContext(call, snap, now);
    chain = kc.rings.chains.get(org.orgKeyChainId("wallet", "*")) ?? [];
  }
  const kem = org.orgKemKeyPair(org.deriveOrgSeatKemSeed(umk, seat.orgId));
  const out = [];
  try {
    for (const b of chain) {
      try {
        out.push({ version: b.ring.version, key: org.deriveOrgWalletKey(org.openOrgKeyRing(b, `seat:${seat.seatId}`, kem.kemSecret), seat.orgId) });
      } catch {
        /* a version not sealed to this seat */
      }
    }
  } finally {
    kem.kemSecret.fill(0);
  }
  return { keys: out, newest: chain.length > 0 ? chain[chain.length - 1].ring.version : 0 };
}

// ── the wallet ─────────────────────────────────────────────────────────────

/** {wallet, version, keyVersion}: the org's wallet (empty, version 0, when none was saved). */
export async function openOrgWallet(seat, cfg, keys, deps = {}) {
  const { call } = c0(deps);
  let blob;
  try {
    blob = await call("GET", `/api/orgs/${seat.orgId}/voucher-wallet`);
  } catch (e) {
    if (e.status === 404) return { wallet: org.emptyOrgVoucherWallet(minPayableSeats(cfg, { liveSeats: 0 }), cfg.overage.defaultCapUnits), version: 0, keyVersion: 0 };
    throw e;
  }
  const k = keys.keys.find((x) => x.version === blob.keyVersion);
  const wallet = k ? org.openOrgVoucherWallet(k.key, seat.orgId, blob) : null;
  if (!wallet) throw new PlanError("wallet-unreadable");
  return { wallet, version: blob.version, keyVersion: blob.keyVersion };
}

/**
 * Applies `change` and saves, sealed under the newest `wallet` key, approved by this seat's admin key. A conflict
 * (another admin saved first) merges both sides and tries again.
 */
export async function updateOrgWallet(seat, snap, cfg, keys, change, { umk, current = null, now = Date.now(), deps = {} } = {}) {
  const { call } = c0(deps);
  const newest = keys.keys[keys.keys.length - 1];
  if (!newest) throw new PlanError("wallet-key-missing");
  let cur = current ?? (await openOrgWallet(seat, cfg, keys, deps));
  let next = change(cur.wallet);
  for (let attempt = 0; attempt < 4; attempt++) {
    const blob = org.sealOrgVoucherWallet(newest.key, seat.orgId, newest.version, cur.version + 1, next);
    const write = org.orgWalletWriteFor(seat.orgId, blob, now);
    const approval = await withSeatAdminKey(seat, umk, async (secret) => approvalBy(seat, secret, org.canonicalOrgWalletWrite(write), snap.state.current.version, now));
    try {
      await call("PUT", `/api/orgs/${seat.orgId}/voucher-wallet`, { blob, write, approvals: [approval] });
      return { wallet: next, version: blob.version, keyVersion: newest.version };
    } catch (e) {
      if (e.status !== 409) throw e;
      cur = await openOrgWallet(seat, cfg, keys, deps);
      next = org.mergeOrgVoucherWallets(next, cur.wallet);
    }
  }
  throw new PlanError("wallet-conflict");
}

/** The org wallet's balance, as about how many months it pays for `seats`. */
export function orgBalance(cfg, wallet) {
  const seats = wallet.settings.seats;
  const monthly = org.orgMonthlyUnits(cfg, seats);
  return { vouchers: wallet.vouchers.length, months: Math.floor(wallet.vouchers.length / monthly), seats };
}

// ── spending ───────────────────────────────────────────────────────────────

const nextKey = (orgId) => `flagship.orgVouchers.nextSpendAt.${orgId}`;

/**
 * One tick of the org trickle on an org admin's browser: spends what `orgTrickleStep` says through the private relay
 * and records the spent vouchers. Returns {spent, refused?}.
 */
export async function orgSpendTick(seat, snap, { umk, plan, cfg, keys, current = null, deps = {} } = {}) {
  const c = c0(deps);
  const now = c.now();
  const cur = current ?? (await openOrgWallet(seat, cfg, keys, deps));
  const w = cur.wallet;
  const seats = Math.max(w.settings.seats, minPayableSeats(cfg, plan));
  let nextSpendAt = Number(c.store?.getItem?.(nextKey(seat.orgId)) ?? 0) || 0;
  const step = org.orgTrickleStep(cfg, { now, enabled: w.settings.autoPay, balance: w.vouchers.length, terms: termsOf(plan), seats, nextSpendAt }, c.rand());
  nextSpendAt = step.nextSpendAt;
  try {
    c.store?.setItem?.(nextKey(seat.orgId), String(nextSpendAt));
  } catch {
    /* storage off: the next tick schedules again */
  }
  if (step.spend === 0) return { spent: 0, wallet: cur };
  const vouchers = w.vouchers.slice(0, step.spend);
  let drop = vouchers.map(org.voucherNullifier);
  let refused = null;
  try {
    await redeemVouchers("", "business", vouchers, { ...deps, orgSpend: { org: seat.orgId, seats }, spendKind: "trickle" });
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    refused = e.code;
    if (e.code === "voucher-spent" && Array.isArray(e.body?.spent)) drop = e.body.spent;
    else if (e.code === "bad-voucher" && typeof e.body?.nullifier === "string") drop = [e.body.nullifier];
    else return { spent: 0, refused, wallet: cur };
  }
  const saved = await updateOrgWallet(seat, snap, cfg, keys, (x) => org.markOrgVouchersSpent(x, drop), { umk, current: cur, now, deps });
  return { spent: refused ? 0 : vouchers.length, refused, wallet: saved };
}

/** Saves new settings (seat count, auto-pay) into the org wallet. */
export function saveOrgWalletSettings(seat, snap, cfg, keys, patch, opts) {
  const now = opts?.now ?? Date.now();
  return updateOrgWallet(seat, snap, cfg, keys, (w) => ({ ...w, settings: { ...w.settings, ...patch, updatedAt: now } }), opts);
}

// ── voucher files ──────────────────────────────────────────────────────────

/** Parses voucher files ({name, text}); returns {vouchers, bad: [file names]}. */
export function readVoucherFiles(files) {
  const vouchers = [];
  const bad = [];
  for (const f of files) {
    const v = org.parseVoucherFile(f.text);
    if (v) vouchers.push(...v);
    else bad.push(f.name);
  }
  return { vouchers, bad };
}

/** Adds the vouchers of voucher files to the org wallet; refuses the whole import when any file is not one. */
export async function importVoucherFiles(seat, snap, cfg, keys, files, opts) {
  const { vouchers, bad } = readVoucherFiles(files);
  if (bad.length > 0) throw new PlanError("voucher-file-bad", { files: bad });
  const saved = await updateOrgWallet(seat, snap, cfg, keys, (w) => org.addOrgVouchers(w, vouchers), opts);
  return { added: vouchers.length, wallet: saved };
}

/** Voucher files of `perFile` vouchers each (the staff perk), as {name, text}. */
export function voucherFilesOf(vouchers, perFile) {
  return org.splitVoucherFiles(vouchers, perFile).map((text, i) => ({ name: `flagship-vouchers-${i + 1}-${org.voucherFileId(text)}.json`, text }));
}

// ── the invoiced batch ─────────────────────────────────────────────────────

export function pendingBatches(store = globalThis.localStorage) {
  try {
    const v = JSON.parse(store?.getItem(BATCH_KEY) ?? "[]");
    return Array.isArray(v) ? v.map((x) => org.parseVoucherBatchKey(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveBatches(list, store) {
  try {
    store?.setItem(BATCH_KEY, JSON.stringify(list.map((b) => org.voucherBatchKeyText(b))));
  } catch {
    /* storage off: the buyer keeps the batch key file */
  }
}

/** Forgets a batch in this browser once its vouchers are safe (in a wallet or saved as files). */
export function forgetBatch(session, store = globalThis.localStorage) {
  saveBatches(pendingBatches(store).filter((b) => b.session !== session), store);
}

/** Adds a batch key file (from another computer) to this browser's pending batches. */
export function addBatchKey(text, store = globalThis.localStorage) {
  const b = org.parseVoucherBatchKey(text);
  if (!b || !b.session) throw new PlanError("batch-key-bad");
  saveBatches([...pendingBatches(store).filter((x) => x.session !== b.session), b], store);
  return b;
}

/**
 * Starts a company's invoiced batch of `units`: a fresh seed, every blinded request made from it, and a Stripe
 * Checkout that commits to them. Returns {url, keyFile}: the buyer saves the key file before paying (it finishes the
 * batch from any computer; it is a secret). `deps.method` "bank" pays by bank transfer (only while `.com` offers it):
 * Stripe shows the company its bank details and the batch finishes once the whole transfer has arrived.
 */
export async function buyBatch(units, deps = {}) {
  const c = c0(deps);
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  const method = deps.method === "bank" ? "bank" : "card";
  if (!pc.rails?.stripe) throw new PlanError("rail-off");
  if (method === "bank" && !pc.rails?.stripeBank) throw new PlanError("bank-off");
  const b = pc.config.business;
  if (!Number.isSafeInteger(units) || units < b.batchMinUnits || units > b.batchMaxUnits) throw new PlanError("batch-size", { min: b.batchMinUnits, max: b.batchMaxUnits });
  const key = pc.keys.find((k) => k.issuing !== false);
  if (!key) throw new PlanError("no-key");
  const seed = deps.seed ?? crypto.getRandomValues(new Uint8Array(32));
  const { commit } = org.batchRequests(key, seed, units);
  const r = await c.fetch(`${c.apex}/api/vouchers/stripe/batch-checkout`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(method === "bank" ? { v: 1, units, k: key.keyId, commit, method } : { v: 1, units, k: key.keyId, commit }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const code = typeof body?.code === "string" ? body.code : "failed";
    throw new PlanError(method === "bank" && code === "rail-off" ? "bank-off" : code, { status: r.status, body });
  }
  if (typeof body?.url !== "string" || !body.url.startsWith("https://") || typeof body?.sessionId !== "string") throw new PlanError("failed");
  const batch = { k: key.keyId, units, seed: hex(seed), session: body.sessionId };
  saveBatches([...pendingBatches(c.store).filter((x) => x.session !== batch.session), { kind: "flagship-voucher-batch", v: 1, ...batch }], c.store);
  return { url: body.url, keyFile: { name: `flagship-batch-${body.sessionId.slice(-8)}.json`, text: org.voucherBatchKeyText(batch) } };
}

/**
 * Asks for a paid batch's signatures, in chunks, and returns its vouchers (null while it is unpaid: a bank transfer
 * can take days). The batch stays pending in this browser until the caller has put the vouchers somewhere.
 */
export async function finishBatch(batch, deps = {}) {
  const c = c0(deps);
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  const key = pc.keys.find((k) => k.keyId === batch.k);
  if (!key) throw new PlanError("no-key");
  const seed = unhex(batch.seed);
  const { blinded } = org.batchRequests(key, seed, batch.units);
  const sigs = [];
  while (sigs.length < batch.units) {
    const r = await c.fetch(`${c.apex}/api/vouchers/batch-issue`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, session: batch.session, k: batch.k, blinded, from: sigs.length }),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      if (body?.code === "payment-unpaid") return null;
      throw new PlanError(typeof body?.code === "string" ? body.code : "failed", { status: r.status, body });
    }
    if (!Array.isArray(body?.sigs) || body.sigs.length === 0 || body.from !== sigs.length) throw new PlanError("failed");
    sigs.push(...body.sigs);
  }
  return org.finalizeBatchVouchers(key, seed, 0, sigs);
}

// ── after a `wallet` key rotation ──────────────────────────────────────────

/**
 * When the wallet is sealed under an older `wallet` key than the newest (an admin left and the key rotated), every
 * voucher in it is exchanged for a fresh one, then the wallet is sealed under the new key. Returns how many moved.
 */
export async function refreshAfterRotation(seat, snap, cfg, keys, { umk, current = null, now = Date.now(), deps = {} } = {}) {
  const c = c0(deps);
  const cur = current ?? (await openOrgWallet(seat, cfg, keys, deps));
  if (cur.version === 0 || cur.keyVersion >= keys.newest) return { moved: 0, wallet: cur };
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  const key = pc.keys.find((k) => k.issuing !== false);
  if (!key) throw new PlanError("no-key");
  const fresh = [];
  const spent = [];
  const old = cur.wallet.vouchers;
  for (let i = 0; i < old.length; i += cfg.maxPerRequest) {
    const part = old.slice(i, i + cfg.maxPerRequest);
    const reqs = part.map(() => newVoucherRequest(key));
    const r = await c.fetch(`${c.apex}/api/vouchers/exchange`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, k: key.keyId, vouchers: part, blinded: reqs.map((q) => q.blinded) }),
    });
    const body = await r.json().catch(() => null);
    if (r.ok && Array.isArray(body?.sigs)) {
      fresh.push(...reqs.map((q, j) => finalizeVoucher(key, q.pending, body.sigs[j])));
      spent.push(...part.map(org.voucherNullifier));
    } else if (body?.code === "voucher-spent" && Array.isArray(body.spent)) {
      spent.push(...body.spent);
    } else {
      throw new PlanError(typeof body?.code === "string" ? body.code : "failed", { status: r.status, body });
    }
  }
  const saved = await updateOrgWallet(seat, snap, cfg, keys, (w) => org.addOrgVouchers(org.markOrgVouchersSpent(w, spent), fresh), { umk, current: cur, now, deps });
  return { moved: fresh.length, wallet: saved };
}

export const _test = { unhex, DAY };
