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
//   buyWithStripe       POST /api/vouchers/stripe/checkout       (the order: a pack, the key, a commitment; no account)
//   finishShopOrders    POST /api/vouchers/paid-issue            (back from Stripe: signatures for the paid session)
//   buyVouchersSignedOut / finishSignedOutOrders                  the same shop with no account in this browser at all:
//                       the vouchers wait here until loaded into an app by a voucher link (lib/voucherLink.js)
//   prepareVoucherLink / commitVoucherLink                        a voucher link into this account's wallet, checked
//                       here alone (cached keys, no network); offline it waits in this browser's inbox

import {
  addVouchers,
  cryptoRand,
  DEFAULT_PAYMENTS_CONFIG,
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
  voucherOrderCommit,
} from "./vouchers.js";
import { accountReadFetch } from "./accountRead.js";
import { parseVoucherLink, planVoucherLinkImport } from "./voucherLink.js";
import { tr } from "./i18n.js";
import {
  ohttpSpendMayGoDirect,
  parseOhttpPublicConfig,
  planLapseInMs,
  relayRetryAfterMs,
  RelayUnavailableError,
  sendThroughRelays,
} from "./ohttp.js";
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
const relayKey = (u) => `flagship.vouchers.relay.${u}`;

/**
 * How spends reached `.com` lately, per browser and account (docs/outbound-proxy.md "Failure handling"):
 * `{failures, retryAt, wentDirect}`. Never money; only when to try the private relay again and what the Plan
 * section says about it.
 */
export function relayStateOf(deps = {}) {
  const c = ctx(deps);
  try {
    const v = JSON.parse(c.store.get(relayKey(usernameOf(c))) ?? "null");
    if (v && typeof v === "object") {
      return { failures: Number(v.failures) || 0, retryAt: Number(v.retryAt) || 0, wentDirect: v.wentDirect === true };
    }
  } catch {
    /* unreadable: start fresh */
  }
  return { failures: 0, retryAt: 0, wentDirect: false };
}

function saveRelayState(c, s) {
  c.store.set(relayKey(usernameOf(c)), JSON.stringify(s));
}

/**
 * The one privacy line under the plan: waiting for the relay, the last spend went direct, who runs the relay, or
 * no relay. Returns `{text, tone}`; tone is "info" (never an error: our relay failing breaks nothing).
 */
export function relayPrivacyLine(ohttp, relay, now = Date.now()) {
  const first = ohttp?.relays?.[0] ?? null;
  if (first && relay.failures > 0 && relay.retryAt > now) {
    return { id: "waiting", text: tr("The private relay isn't answering. Payments wait and try again; your plan stays active meanwhile.") };
  }
  if (first && relay.wentDirect) {
    return { id: "went-direct", text: tr("The private relay wasn't answering, so the last payment went straight to Flagship.") };
  }
  if (first && !first.interim) {
    return { id: "third-party", text: tr("Payments go through {0}'s private relay, so Flagship doesn't see your network address when you pay.", first.operator) };
  }
  if (first) {
    return {
      id: "interim",
      text: tr("Payments go through a private relay that Flagship runs for now. It keeps your address out of the payment logs, but it isn't an independent operator yet."),
    };
  }
  return { id: "none", text: tr("Flagship can see your network address when you pay. It keeps none of it.") };
}

// ── reads ──────────────────────────────────────────────────────────────────

const KEYS_KEY = "flagship.payments.keys";

/** The voucher keys this browser last read from `.com` (public): what a voucher link is checked against, offline. */
export function knownVoucherKeys(deps = {}) {
  const c = ctx(deps);
  try {
    const v = JSON.parse(c.store.get(KEYS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => rsaFromVoucherKey(k) !== null) : [];
  } catch {
    return [];
  }
}

/** {config, keys (checked against their ids), testIssue}. Falls back to the defaults when `.com` can't be reached. */
export async function loadPaymentsConfig(deps = {}) {
  const c = ctx(deps);
  try {
    const r = await c.fetch(`${c.apex}/api/payments/config`, { credentials: "omit", cache: "no-store" });
    if (!r.ok) throw await readError(r);
    const body = await r.json();
    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => rsaFromVoucherKey(k) !== null) : [];
    try {
      if (keys.length > 0) c.store.set(KEYS_KEY, JSON.stringify(keys.map((k) => ({ keyId: k.keyId, nHex: k.nHex, eHex: k.eHex }))));
    } catch {
      /* the cache is a convenience: a voucher link then asks to open Plan once */
    }
    const ohttp = parseOhttpPublicConfig(body?.ohttp, new URL(c.apex).hostname);
    const rails = {
      stripe: body?.rails?.stripe === true,
      stripeBank: body?.rails?.stripe === true && body?.rails?.stripeBank === true,
      apple: body?.rails?.apple === true,
      google: body?.rails?.google === true,
    };
    return { config: mergePaymentsConfig(body?.config), keys, testIssue: body?.testIssue === true, rails, ohttp };
  } catch {
    return {
      config: mergePaymentsConfig(null),
      keys: [],
      testIssue: false,
      rails: { stripe: false, stripeBank: false, apple: false, google: false },
      ohttp: parseOhttpPublicConfig(null),
    };
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

/**
 * POST /api/vouchers/redeem through the private relay. With `deps.orgSpend = {org, seats}` it pays an org's Business
 * seats (or its overage) instead of an account's plan (lib/orgPlan.js).
 * Through the private relay (`deps.ohttp`, docs/outbound-proxy.md "Failure handling"):
 * `{ok, credited, spent, paidUntil?, topUpBytes?}` or a PlanError with `.body.spent`. When every relay fails, the
 * spend goes directly (marked) only if `ohttpSpendMayGoDirect(deps.spendKind, deps.lapseInMs)` allows; otherwise a
 * PlanError `relay-waiting` (nothing was sent, so nothing is spent).
 */
export async function redeemVouchers(username, forWhat, vouchers, deps = {}) {
  const c = ctx(deps);
  const kind = deps.spendKind ?? (forWhat === "overage" ? "overage" : "trickle");
  const lapseInMs = deps.lapseInMs === undefined ? null : deps.lapseInMs;
  let r;
  try {
    r = await sendThroughRelays(
      {
        url: `${c.apex}/api/vouchers/redeem`,
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(
          JSON.stringify(
            deps.orgSpend
              ? { v: 1, org: deps.orgSpend.org, for: forWhat, ...(forWhat === "business" ? { seats: deps.orgSpend.seats } : {}), vouchers }
              : { v: 1, username, for: forWhat, vouchers },
          ),
        ),
      },
      { config: deps.ohttp ?? null, mayGoDirect: (reason) => reason === "unconfigured" || ohttpSpendMayGoDirect(kind, lapseInMs), fetch: c.fetch },
    );
  } catch (e) {
    if (e instanceof RelayUnavailableError) throw new PlanError("relay-waiting", { reason: e.reason });
    throw e;
  }
  const relay = relayStateOf(deps);
  if (r.path === "ohttp") saveRelayState(c, { failures: 0, retryAt: 0, wentDirect: false });
  else if (r.fallbackReason !== "unconfigured") saveRelayState(c, { ...relay, wentDirect: true });
  let body = null;
  try {
    body = JSON.parse(new TextDecoder().decode(r.body));
  } catch {
    /* no body */
  }
  if (r.status < 200 || r.status >= 300) {
    const code = typeof body?.code === "string" ? body.code : r.status === 404 ? "not-found" : r.status === 429 ? "rate-limited" : "failed";
    throw new PlanError(code, { status: r.status, body });
  }
  return body;
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
    else if (e.code === "relay-waiting") {
      // Nothing left the browser: try the relay again later (5 min doubling, at most 6 h).
      const r = relayStateOf(deps);
      const failures = r.failures + 1;
      saveRelayState(c, { ...r, failures, retryAt: c.now() + relayRetryAfterMs(failures) });
      return { credited: 0, refused: "relay-waiting", saved: cur, paidUntil: null };
    } else throw e;
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
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  const cfg = pc.config;
  const ohttp = deps.ohttp ?? pc.ohttp ?? null;
  let cur = deps.current ?? (await loadWallet(cfg, deps));
  const s = cur.wallet.settings;
  const did = { planSpent: 0, overageSpent: 0, waiting: false };
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
  const graceMs = cfg.graceHours * 3_600_000;
  const lapseInMs = planLapseInMs(paid.plan ? paid.paidUntil : 0, graceMs, now);
  const spendKind = deps.interactive ? "interactive" : "trickle";
  // The relay failed lately: wait for its retry time unless this spend may go direct anyway.
  const relay = relayStateOf(deps);
  const waitRelay = (kind, lapse) =>
    (ohttp?.relays?.length ?? 0) > 0 && relay.failures > 0 && now < relay.retryAt && !ohttpSpendMayGoDirect(kind, lapse);
  if (step.spend > 0 && waitRelay(spendKind, lapseInMs)) did.waiting = true;
  else if (step.spend > 0) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await spendAndRecord(cfg, cur, s.plan, takeVouchers(cur.wallet, step.spend), { ...deps, ohttp, spendKind, lapseInMs });
      if (out.refused === "relay-waiting") {
        did.waiting = true;
        break;
      }
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
      if (waitRelay("overage", null)) {
        did.waiting = true;
      } else {
        const out = await spendAndRecord(cfg, cur, "overage", takeVouchers(cur.wallet, cfg.overage.blockUnits), { ...deps, ohttp, spendKind: "overage" });
        cur = out.saved;
        did.overageSpent += out.credited;
        if (out.refused === "relay-waiting") did.waiting = true;
      }
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

// ── the web shop (docs/payments-privacy-and-rails.md §11) ─────────────────

const SHOP_KEY = "flagship.shop.pending";
/** A Checkout Session lives 24 hours; an order still unpaid a day later is dropped. */
const SHOP_ORDER_MAX_AGE_MS = 25 * 3_600_000;

/** The orders this browser started and hasn't been paid out for: [{sessionId, username, k, units, blinded, pending, at}]. */
export function pendingShopOrders(store = browserStore) {
  try {
    const v = JSON.parse(store.get(SHOP_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((o) => o && typeof o.sessionId === "string" && Array.isArray(o.pending) && Array.isArray(o.blinded)) : [];
  } catch {
    return [];
  }
}

function savePendingShopOrders(orders, store) {
  store.set(SHOP_KEY, JSON.stringify(orders));
}

/**
 * Starts a card purchase of `units` vouchers: makes the blinded requests, asks `.com` for a Stripe Checkout Session
 * that commits to them (and names nobody), keeps the order in this browser, and returns Stripe's page to open.
 */
export async function buyWithStripe(units, deps = {}) {
  const c = ctx(deps);
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  if (!pc.rails?.stripe) throw new PlanError("rail-off");
  if (!pc.config.packs.includes(units)) throw new PlanError("malformed");
  const key = pc.keys.find((k) => k.issuing !== false);
  if (!key) throw new PlanError("no-key");
  const reqs = Array.from({ length: units }, () => newVoucherRequest(key));
  const blinded = reqs.map((q) => q.blinded);
  const r = await c.fetch(`${c.apex}/api/vouchers/stripe/checkout`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, units, k: key.keyId, commit: voucherOrderCommit(key.keyId, blinded) }),
  });
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  if (typeof body?.url !== "string" || !body.url.startsWith("https://") || typeof body?.sessionId !== "string") throw new PlanError("failed");
  const orders = pendingShopOrders(c.store).filter((o) => o.sessionId !== body.sessionId);
  orders.push({ sessionId: body.sessionId, username: usernameOf(c), k: key.keyId, units, blinded, pending: reqs.map((q) => q.pending), at: c.now() });
  savePendingShopOrders(orders, c.store);
  return { url: body.url, sessionId: body.sessionId };
}

/**
 * Asks for the signatures of every paid order this browser holds for the signed-in account, adds the vouchers to
 * the wallet, and forgets the order once the wallet is saved. An unpaid order waits (a day at most); one `.com`
 * refuses for good is dropped. Returns {added, refused: [codes]}.
 */
export async function finishShopOrders(deps = {}) {
  const c = ctx(deps);
  const u = usernameOf(c);
  const out = { added: 0, refused: [] };
  const all = pendingShopOrders(c.store);
  const mine = all.filter((o) => o.username === u);
  if (mine.length === 0) return out;
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  let cur = deps.current ?? null;
  for (const o of mine) {
    const key = pc.keys.find((k) => k.keyId === o.k);
    const drop = () => savePendingShopOrders(pendingShopOrders(c.store).filter((x) => x.sessionId !== o.sessionId), c.store);
    if (!key) {
      if (pc.keys.length > 0) {
        drop();
        out.refused.push("no-key");
      }
      continue;
    }
    let r;
    try {
      r = await c.fetch(`${c.apex}/api/vouchers/paid-issue`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 1, rail: "stripe", proof: { sessionId: o.sessionId }, k: o.k, blinded: o.blinded }),
      });
    } catch {
      continue;
    }
    if (!r.ok) {
      const err = await readError(r);
      const waits = err.code === "payment-unpaid" || err.code === "rail-unreachable" || err.code === "rate-limited" || r.status >= 500;
      if (waits && c.now() - o.at < SHOP_ORDER_MAX_AGE_MS) continue;
      drop();
      out.refused.push(err.code);
      continue;
    }
    const body = await r.json();
    if (!Array.isArray(body?.sigs) || body.sigs.length !== o.pending.length) continue;
    const vouchers = o.pending.map((p, i) => finalizeVoucher(key, p, body.sigs[i]));
    cur = await updateWallet(pc.config, (w) => addVouchers(w, vouchers), { ...deps, ...(cur ? { current: cur } : {}) });
    drop();
    out.added += vouchers.length;
  }
  return { ...out, wallet: cur };
}

const SHOP_RETURN_KEY = "flagship.shop.return";

/** Back from Stripe (`?shop=stripe|cancel`): note it for after the unlock and take it off the address bar. */
export function takeShopReturn(loc = globalThis.location, hist = globalThis.history, session = globalThis.sessionStorage) {
  try {
    const u = new URL(loc.href);
    const shop = u.searchParams.get("shop");
    if (shop !== "stripe" && shop !== "cancel") return null;
    u.searchParams.delete("shop");
    u.searchParams.delete("session_id");
    hist?.replaceState({}, "", u.pathname + (u.search === "?" ? "" : u.search) + u.hash);
    session?.setItem(SHOP_RETURN_KEY, shop);
    return shop;
  } catch {
    return null;
  }
}

/** The return noted by takeShopReturn, once. */
export function consumeShopReturn(session = globalThis.sessionStorage) {
  try {
    const v = session?.getItem(SHOP_RETURN_KEY) ?? null;
    session?.removeItem(SHOP_RETURN_KEY);
    return v;
  } catch {
    return null;
  }
}

// ── the shop with no account (docs/anonymous-vouchers.md "Voucher links") ──
//
// A person with only a phone buys on this page in the phone's browser, signed out. The order names nobody, as
// above, and is kept apart from the signed-in orders: once paid, the unblinded vouchers wait in this browser until
// they are loaded into an app through a voucher link (the fragment never reaches a server) or saved as a file.

const ANON_KEY = "flagship.shop.signedOut";
const READY_KEY = "flagship.shop.ready";

function readList(store, key, ok) {
  try {
    const v = JSON.parse(store.get(key) ?? "[]");
    return Array.isArray(v) ? v.filter(ok) : [];
  } catch {
    return [];
  }
}

/** Signed-out orders not paid out yet: [{sessionId, k, units, blinded, pending, at}]. */
export function signedOutShopOrders(store = browserStore) {
  return readList(store, ANON_KEY, (o) => o && typeof o.sessionId === "string" && Array.isArray(o.pending) && Array.isArray(o.blinded));
}

/** Paid-out purchases waiting to be loaded: [{sessionId, vouchers, at}]. Bearer vouchers: whoever holds them spends them. */
export function readyShopVouchers(store = browserStore) {
  return readList(store, READY_KEY, (o) => o && typeof o.sessionId === "string" && Array.isArray(o.vouchers) && o.vouchers.length > 0);
}

/** Forget one paid-out purchase in this browser (after it was loaded or saved). */
export function forgetReadyShopVouchers(sessionId, store = browserStore) {
  store.set(READY_KEY, JSON.stringify(readyShopVouchers(store).filter((o) => o.sessionId !== sessionId)));
}

/** buyWithStripe with no account: the same order, kept as a signed-out one. Returns Stripe's page to open. */
export async function buyVouchersSignedOut(units, deps = {}) {
  const c = ctx(deps);
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  if (!pc.rails?.stripe) throw new PlanError("rail-off");
  if (!pc.config.packs.includes(units)) throw new PlanError("malformed");
  const key = pc.keys.find((k) => k.issuing !== false);
  if (!key) throw new PlanError("no-key");
  const reqs = Array.from({ length: units }, () => newVoucherRequest(key));
  const blinded = reqs.map((q) => q.blinded);
  const r = await c.fetch(`${c.apex}/api/vouchers/stripe/checkout`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, units, k: key.keyId, commit: voucherOrderCommit(key.keyId, blinded) }),
  });
  if (!r.ok) throw await readError(r);
  const body = await r.json();
  if (typeof body?.url !== "string" || !body.url.startsWith("https://") || typeof body?.sessionId !== "string") throw new PlanError("failed");
  const orders = signedOutShopOrders(c.store).filter((o) => o.sessionId !== body.sessionId);
  orders.push({ sessionId: body.sessionId, k: key.keyId, units, blinded, pending: reqs.map((q) => q.pending), at: c.now() });
  c.store.set(ANON_KEY, JSON.stringify(orders));
  return { url: body.url, sessionId: body.sessionId };
}

/**
 * Asks for the signatures of the signed-out orders and keeps the unblinded vouchers as ready purchases. Returns
 * {ready: number of vouchers made ready, waiting: orders still unpaid, refused: [codes]}.
 */
export async function finishSignedOutOrders(deps = {}) {
  const c = ctx(deps);
  const out = { ready: 0, waiting: 0, refused: [] };
  const orders = signedOutShopOrders(c.store);
  if (orders.length === 0) return out;
  const pc = deps.paymentsConfig ?? (await loadPaymentsConfig(deps));
  const drop = (id) => c.store.set(ANON_KEY, JSON.stringify(signedOutShopOrders(c.store).filter((x) => x.sessionId !== id)));
  for (const o of orders) {
    const key = pc.keys.find((k) => k.keyId === o.k);
    if (!key) {
      out.waiting++;
      continue;
    }
    let r;
    try {
      r = await c.fetch(`${c.apex}/api/vouchers/paid-issue`, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: 1, rail: "stripe", proof: { sessionId: o.sessionId }, k: o.k, blinded: o.blinded }),
      });
    } catch {
      out.waiting++;
      continue;
    }
    if (!r.ok) {
      const err = await readError(r);
      const waits = err.code === "payment-unpaid" || err.code === "rail-unreachable" || err.code === "rate-limited" || r.status >= 500;
      if (waits && c.now() - o.at < SHOP_ORDER_MAX_AGE_MS) {
        out.waiting++;
        continue;
      }
      drop(o.sessionId);
      out.refused.push(err.code);
      continue;
    }
    const body = await r.json();
    if (!Array.isArray(body?.sigs) || body.sigs.length !== o.pending.length) {
      out.waiting++;
      continue;
    }
    const vouchers = o.pending.map((p, i) => finalizeVoucher(key, p, body.sigs[i]));
    const ready = readyShopVouchers(c.store).filter((x) => x.sessionId !== o.sessionId);
    ready.push({ sessionId: o.sessionId, vouchers, at: c.now() });
    c.store.set(READY_KEY, JSON.stringify(ready));
    drop(o.sessionId);
    out.ready += vouchers.length;
  }
  return out;
}

// ── a voucher link into this account's wallet ─────────────────────────────

const inboxKey = (u) => `flagship.vouchers.inbox.${u}`;

/** Vouchers a link added while `.com` couldn't be reached: they join the wallet at the next tick. */
export function voucherInbox(deps = {}) {
  const c = ctx(deps);
  return readList(c.store, inboxKey(usernameOf(c)), (v) => v && typeof v.k === "string" && typeof v.n === "string");
}

const isNetworkError = (e) => !(e instanceof PlanError) || e.code === "failed" || (typeof e.status === "number" && e.status >= 500);

/**
 * Reads a voucher link and decides what it would add, on this device alone: the signatures against the keys this
 * browser holds (knownVoucherKeys), the wallet's own vouchers and spends. Without `.com` the wallet can't be read,
 * so duplicates are checked against this browser's inbox only (adding twice is harmless: the wallet keeps one copy).
 * Returns {outcome, link?, plan?, current?, offline}; outcome is a parse code ("damaged", "newer", "not-a-link"),
 * "locked", "not-admin", or the plan's outcome.
 */
export async function prepareVoucherLink(raw, deps = {}) {
  const c = ctx(deps);
  const link = parseVoucherLink(raw);
  if (!link.ok) return { outcome: link.code, offline: false };
  if (!(c.session?.umk instanceof Uint8Array) || !usernameOf(c)) return { outcome: "locked", offline: false };
  if (!c.isAdmin()) return { outcome: "not-admin", offline: false };
  const keys = knownVoucherKeys(deps);
  const cfg = deps.config ?? DEFAULT_PAYMENTS_CONFIG;
  let current = null;
  let offline = false;
  try {
    current = deps.current ?? (await loadWallet(cfg, deps));
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    offline = true;
  }
  const wallet = current ? current.wallet : { ...emptyVoucherWallet(cfg.overage.defaultCapUnits), vouchers: voucherInbox(deps) };
  const plan = planVoucherLinkImport(wallet, link.vouchers, keys);
  return { outcome: plan.outcome, link, plan, current, offline };
}

/** Adds what prepareVoucherLink planned. Online it saves the wallet; offline (or if the save can't reach `.com`) the vouchers wait in the inbox. Returns {added, parked}. */
export async function commitVoucherLink(prep, deps = {}) {
  const c = ctx(deps);
  const add = prep?.plan?.outcome === "add" ? prep.plan.add : [];
  if (add.length === 0) return { added: 0, parked: false };
  const park = () => {
    const have = voucherInbox(deps);
    c.store.set(inboxKey(usernameOf(c)), JSON.stringify([...have, ...add.filter((v) => !have.some((h) => h.k === v.k && h.n === v.n))]));
    return { added: add.length, parked: true };
  };
  if (prep.offline || !prep.current) return park();
  try {
    const saved = await updateWallet(deps.config ?? DEFAULT_PAYMENTS_CONFIG, (w) => addVouchers(w, add), { ...deps, current: prep.current });
    return { added: add.length, parked: false, wallet: saved };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return park();
  }
}

/** The inbox into the wallet, once `.com` answers; quiet on failure (the next tick tries again). */
export async function flushVoucherInbox(deps = {}) {
  const c = ctx(deps);
  const waiting = voucherInbox(deps);
  if (waiting.length === 0) return { added: 0 };
  const cfg = deps.config ?? DEFAULT_PAYMENTS_CONFIG;
  const saved = await updateWallet(cfg, (w) => addVouchers(w, waiting), deps);
  c.store.set(inboxKey(usernameOf(c)), "[]");
  return { added: waiting.length, wallet: saved };
}
