// The account's plan and its voucher wallet in the webapp (docs/payments-privacy-and-rails.md "As built"). The
// wallet is sealed under a key from the account's UMK and synced through `.com` like the call hours
// (lib/voiciOwner.js loadCallSettings / saveCallHours); `.com` sees ciphertext padded to 4 KiB steps. Only an admin
// device of the account spends: a trickle of one voucher at a random moment while the plan is less than ten days
// ahead, at once when it is less than three, and a prepaid overage block when the month's egress runs low.
//
//   loadPaymentsConfig  GET  /api/payments/config                (public)
//   loadPlanState       GET  /api/users/<u>/plan-attestation     (read token)
//   loadAllowance       GET  /api/users/<u>/allowance            (read token)
//   loadWallet / updateWallet  GET / PUT /api/accounts/<u>/voucher-wallet (read token / device-signed, compare-and-set)
//   redeemVouchers      POST /api/vouchers/redeem                (no credential, no cookie: nothing names the caller)
//   spendTick           the trickle and the overage rule, once
//   addTestVouchers     POST /api/vouchers/test-issue            (only when the server says testIssue: the gym)

import {
  addVouchers,
  cryptoRand,
  deriveVoucherWalletKey,
  emptyVoucherWallet,
  finalizeVoucher,
  isPaidPlan,
  markVouchersSpent,
  mergePaymentsConfig,
  mergeVoucherWallets,
  newVoucherRequest,
  openVoucherWallet,
  overagePeriod,
  overageStep,
  planAheadMs,
  planOfTier,
  planUnitMs,
  rsaFromVoucherKey,
  sealVoucherWallet,
  takeVouchers,
  trickleStep,
  voucherNullifier,
} from "./vouchers.js";
import { accountReadFetch } from "./accountRead.js";
import { canSignAdminOrders } from "./addServerGate.js";
import { controlApex } from "./apex.js";
import { getActiveProfile } from "./profiles.js";
import { getSession } from "./state.js";
import { deviceHeaders } from "./voiciOwner.js";

const GB = 1024 ** 3;
const DAY_MS = 86_400_000;

export class PlanError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = "PlanError";
    this.code = code;
    Object.assign(this, extra);
  }
}

async function readError(r) {
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* no body */
  }
  const code = typeof body?.code === "string" ? body.code : r.status === 404 ? "not-found" : r.status === 429 ? "rate-limited" : "failed";
  return new PlanError(code, { status: r.status, body });
}

function ctx(deps = {}) {
  return {
    fetch: deps.fetch ?? ((...a) => globalThis.fetch(...a)),
    readFetch: deps.readFetch ?? accountReadFetch,
    now: deps.now ?? Date.now,
    rand: deps.rand ?? cryptoRand,
    session: deps.session ?? getSession(),
    profile: deps.profile ?? getActiveProfile(),
    apex: deps.apex ?? controlApex(),
    deviceSeed: deps.deviceSeed ?? null,
    store: deps.store ?? browserStore,
    isAdmin: deps.isAdmin ?? (() => canSignAdminOrders()),
  };
}

const usernameOf = (c) => String(c.session?.username ?? "").toLowerCase();
const umkOf = (c) => {
  const umk = c.session?.umk;
  if (!(umk instanceof Uint8Array)) throw new PlanError("locked");
  return { seed: umk };
};

/** Per-browser scheduling (when the next unhurried spend is due). Never money: the vouchers live in the wallet. */
const browserStore = {
  get(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* storage off: the next tick schedules again */
    }
  },
};
const nextSpendKey = (u) => `flagship.vouchers.nextSpendAt.${u}`;

// ── reads ──────────────────────────────────────────────────────────────────

/** {config, keys (checked against their ids), testIssue}. Falls back to the defaults when `.com` can't be reached. */
export async function loadPaymentsConfig(deps = {}) {
  const c = ctx(deps);
  try {
    const r = await c.fetch(`${c.apex}/api/payments/config`, { credentials: "omit", cache: "no-store" });
    if (!r.ok) throw await readError(r);
    const body = await r.json();
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => rsaFromVoucherKey(k) !== null) : [];
    return { config: mergePaymentsConfig(body?.config), keys, testIssue: body?.testIssue === true };
  } catch {
    return { config: mergePaymentsConfig(null), keys: [], testIssue: false };
  }
}

/** {plan: null | "pro" | "pro-max", paidUntil}. The tier is the effective one (inside the grace it still reads paid). */
export async function loadPlanState(deps = {}) {
  const c = ctx(deps);
  const u = usernameOf(c);
  const r = await c.readFetch(`${c.apex}/api/users/${encodeURIComponent(u)}/plan-attestation`, { cache: "no-store" }, { username: u });
  if (!r.ok) throw await readError(r);
  const a = await r.json();
  const plan = planOfTier(String(a?.tier ?? "free"));
  return { plan, paidUntil: plan && Number.isSafeInteger(a?.paidUntil) ? a.paidUntil : 0 };
}

/** The month's egress (`remainingBytes`, `quotaBytes`, …), or null when it can't be read. */
export async function loadAllowance(deps = {}) {
  const c = ctx(deps);
  const u = usernameOf(c);
  try {
    const r = await c.readFetch(`${c.apex}/api/users/${encodeURIComponent(u)}/allowance`, { cache: "no-store" }, { username: u });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** {wallet, version}: the account's wallet (empty, version 0, when none was saved). */
export async function loadWallet(cfg, deps = {}) {
  const c = ctx(deps);
  const u = usernameOf(c);
  const r = await c.readFetch(`${c.apex}/api/accounts/${encodeURIComponent(u)}/voucher-wallet`, { cache: "no-store" }, { username: u });
  if (r.status === 404) return { wallet: emptyVoucherWallet(cfg.overage.defaultCapUnits), version: 0 };
  if (!r.ok) throw await readError(r);
  const blob = await r.json();
  const wallet = openVoucherWallet(deriveVoucherWalletKey(umkOf(c)), blob);
  if (!wallet) throw new PlanError("wallet-unreadable");
  return { wallet, version: blob.version };
}

/**
 * Applies `change` to the stored wallet and saves it. Another device saving first (409 version-conflict) merges:
 * both sides' vouchers and spends, the newer settings.
 */
export async function updateWallet(cfg, change, deps = {}) {
  const c = ctx(deps);
  const u = usernameOf(c);
  const key = deriveVoucherWalletKey(umkOf(c));
  let cur = deps.current ?? (await loadWallet(cfg, deps));
  let next = change(cur.wallet);
  for (let attempt = 0; attempt < 4; attempt++) {
    const version = cur.version + 1;
    const path = `/api/accounts/${u}/voucher-wallet`;
    const r = await c.fetch(`${c.apex}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await deviceHeaders(c, "PUT", path)) },
      body: JSON.stringify(sealVoucherWallet(key, version, next)),
    });
    if (r.ok) return { wallet: next, version };
    const err = await readError(r);
    if (r.status !== 409) throw err;
    const stored = err.body?.wallet ?? null;
    const opened = stored ? openVoucherWallet(key, stored) : null;
    cur = opened ? { wallet: opened, version: stored.version } : await loadWallet(cfg, deps);
    next = mergeVoucherWallets(next, cur.wallet);
  }
  throw new PlanError("wallet-conflict");
}

// ── spending ───────────────────────────────────────────────────────────────

/** POST /api/vouchers/redeem: `{ok, credited, spent, paidUntil?, topUpBytes?}` or a PlanError with `.body.spent`. */
export async function redeemVouchers(username, forWhat, vouchers, deps = {}) {
  const c = ctx(deps);
  const r = await c.fetch(`${c.apex}/api/vouchers/redeem`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, username, for: forWhat, vouchers }),
  });
  if (!r.ok) throw await readError(r);
  return r.json();
}

/**
 * Spend `vouchers` for `forWhat` and record the outcome in the wallet: sent vouchers are spent once `.com` answers
 * (credited or already spent); a voucher `.com` refuses as bad is dropped. Returns {credited, refused?}.
 */
async function spendAndRecord(cfg, cur, forWhat, vouchers, deps) {
  const c = ctx(deps);
  const sent = vouchers.map(voucherNullifier);
  let res = null;
  let refused = null;
  let drop = [];
  try {
    res = await redeemVouchers(usernameOf(c), forWhat, vouchers, deps);
    drop = sent;
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    refused = e.code;
    if (e.code === "voucher-spent" && Array.isArray(e.body?.spent)) drop = e.body.spent;
    else if (e.code === "bad-voucher" && typeof e.body?.nullifier === "string") drop = [e.body.nullifier];
    else if (e.code === "plan-paid-ahead" || e.code === "overage-needs-plan" || e.code === "overage-block-size") drop = [];
    else throw e;
  }
  const credited = res?.credited ?? 0;
  const period = overagePeriod(c.now());
  const saved = await updateWallet(
    cfg,
    (w) => {
      let next = markVouchersSpent(w, drop);
      if (forWhat === "overage" && credited > 0) {
        const units = next.overage.period === period ? next.overage.units : 0;
        next = { ...next, overage: { period, units: units + credited } };
      }
      return next;
    },
    { ...deps, current: cur },
  );
  return { credited, refused, saved, paidUntil: res?.paidUntil ?? null };
}

/**
 * One tick of automatic spending, on an admin device with the account key: the trickle for the chosen plan, then
 * the overage rule. Returns what it did (`{skipped}` when it may not spend here).
 */
export async function spendTick(deps = {}) {
  const c = ctx(deps);
  if (!c.isAdmin()) return { skipped: "not-admin" };
  if (!(c.session?.umk instanceof Uint8Array)) return { skipped: "locked" };
  const u = usernameOf(c);
  const { config: cfg } = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  let cur = deps.current ?? (await loadWallet(cfg, deps));
  const s = cur.wallet.settings;
  const did = { planSpent: 0, overageSpent: 0 };
  if (!isPaidPlan(s.plan) || !s.autoPay) return { ...did, wallet: cur };
  const now = c.now();
  const paid = deps.planState ?? (await loadPlanState(deps));
  const unitMs = planUnitMs(cfg, s.plan);
  const stored = Number(c.store.get(nextSpendKey(u)) ?? 0);
  const step = trickleStep(
    {
      now,
      enabled: true,
      balance: cur.wallet.vouchers.length,
      aheadMs: planAheadMs(cfg, s.plan, paid, now),
      startAt: s.startAt,
      nextSpendAt: Number.isSafeInteger(stored) && stored >= 0 ? stored : 0,
      unitMs,
      lowWaterMs: cfg.trickle.lowWaterDays * DAY_MS,
      highWaterMs: cfg.trickle.highWaterDays * DAY_MS,
      maxPerRequest: cfg.maxPerRequest,
    },
    c.rand(),
  );
  c.store.set(nextSpendKey(u), String(step.nextSpendAt));
  let planNow = paid;
  if (step.spend > 0) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await spendAndRecord(cfg, cur, s.plan, takeVouchers(cur.wallet, step.spend), deps);
      cur = out.saved;
      did.planSpent += out.credited;
      if (out.paidUntil) planNow = { plan: s.plan, paidUntil: out.paidUntil };
      if (out.refused !== "voucher-spent" || cur.wallet.vouchers.length === 0) break;
    }
  }
  if (isPaidPlan(planNow.plan) && planNow.paidUntil + cfg.graceHours * 3_600_000 >= now) {
    const allowance = deps.allowance !== undefined ? deps.allowance : await loadAllowance(deps);
    const period = overagePeriod(now);
    if (
      allowance &&
      typeof allowance.remainingBytes === "number" &&
      overageStep({
        paid: true,
        remainingBytes: allowance.remainingBytes,
        buyBelowBytes: cfg.overage.buyBelowGb * GB,
        capUnits: cur.wallet.settings.overageCapUnits,
        spentUnits: cur.wallet.overage.period === period ? cur.wallet.overage.units : 0,
        blockUnits: cfg.overage.blockUnits,
        balance: cur.wallet.vouchers.length,
      })
    ) {
      const out = await spendAndRecord(cfg, cur, "overage", takeVouchers(cur.wallet, cfg.overage.blockUnits), deps);
      cur = out.saved;
      did.overageSpent += out.credited;
    }
  }
  return { ...did, wallet: cur };
}

/**
 * Saves the owner's choices (plan, auto-pay, the overage cap, the random start). A newly chosen paid plan with the
 * random start gets a start time up to `activationDelayMaxHours` away; without it the next tick spends at once.
 */
export async function saveSettings(cfg, patch, deps = {}) {
  const c = ctx(deps);
  const now = c.now();
  return updateWallet(
    cfg,
    (w) => {
      const prev = w.settings;
      const next = { ...prev, ...patch, updatedAt: Math.max(now, prev.updatedAt + 1) };
      const newPlan = isPaidPlan(next.plan) && next.plan !== prev.plan;
      if (newPlan || patch.delayStart !== undefined) {
        next.startAt = next.delayStart && isPaidPlan(next.plan) ? now + Math.floor(c.rand() * cfg.activationDelayMaxHours * 3_600_000) : 0;
      }
      if (!isPaidPlan(next.plan)) next.startAt = 0;
      return { ...w, settings: next };
    },
    deps,
  );
}

/** The gym's free test vouchers: `count` (at most 30) requests signed by `.com`, finalized and saved. */
export async function addTestVouchers(count = 30, deps = {}) {
  const c = ctx(deps);
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  if (!pc.testIssue) throw new PlanError("issue-off");
  const key = pc.keys.find((k) => k.issuing !== false);
  if (!key) throw new PlanError("no-key");
  const reqs = Array.from({ length: Math.min(30, Math.max(1, count)) }, () => newVoucherRequest(key));
  const r = await c.fetch(`${c.apex}/api/vouchers/test-issue`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ k: key.keyId, blinded: reqs.map((q) => q.blinded) }),
  });
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  if (!Array.isArray(body?.sigs) || body.sigs.length !== reqs.length) throw new PlanError("failed");
  const vouchers = reqs.map((q, i) => finalizeVoucher(key, q.pending, body.sigs[i]));
  return updateWallet(pc.config, (w) => addVouchers(w, vouchers), deps);
}
