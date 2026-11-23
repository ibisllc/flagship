// Blind-signed $1 vouchers at `.com` (docs/payments-privacy-and-rails.md "As built"): the published keys and payment
// numbers, issuing (admin and the gym only until the rails land), redeeming into plan time or an overage block, and
// the sealed wallet the account's devices sync.
//
// Privacy rules this file keeps:
// - Redeeming needs no account credential (anyone may pay anyone's bill) and nothing about the caller is stored: the
//   nullifier table holds the nullifier, its key and the day, never the account. The route takes no cookie and no
//   authorization header, so it can be sent through the OHTTP relay unchanged (ohttpGateway.ts allows it).
// - Issuing stores nothing at all (the rails will add an order hash, never an account).
// - Refusals carry a machine `code`; the apps turn it into a sentence from their i18n catalogs.
import {
  PLAN_TIER,
  isPaidPlan,
  mergePaymentsConfig,
  parseVoucher,
  planOfTier,
  planUnitMs,
  rsaFromVoucherKey,
  rsaPrivateKeyFromJwk,
  signBlindedVoucher,
  verifyVoucher,
  voucherKeyFromRsa,
  voucherNullifier,
  type PaidPlan,
  type PaymentsConfig,
  type RsaPrivateKey,
  type Voucher,
  type VoucherPublicKey,
} from "@flagship/protocol";
import type { BlindVoucherStorage, MeterStorage, TierStorage, UsernameStorage } from "@flagship/storage";
import { authorizeActiveDevice, type AccountDirectoryDeps, type DirectoryAuthorization } from "./accountDirectory.js";
import { ACCOUNT_KEY_HOLDERS_ONLY, ACCOUNT_READ_HEADERS, requireAccountRead, type AccountReadTokenDeps } from "./accountReadToken.js";
import { egressTopUpBytes, meterRecord } from "./meter.js";
import { checkOrgSpend, creditOrgSeats } from "./orgPlan.js";
import type { OrgDeps } from "./orgs.js";
import { grantTier } from "./tierGrant.js";
import { ok, type HandlerResponseWithHeaders } from "./types.js";

const DAY_MS = 86_400_000;
const GB = 1024 * 1024 * 1024;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const VOUCHER_WALLET_MAX_BODY = 1024 * 1024;

export interface VoucherSigningKey {
  pub: VoucherPublicKey;
  sk: RsaPrivateKey;
  /** Epoch ms after which the key no longer signs (0: no end). */
  issueUntil: number;
  /** Epoch ms after which its vouchers are refused (0: no end). Gift-card law: at least five years after issueUntil. */
  acceptUntil: number;
}

export type VoucherRefusal =
  | "malformed"
  | "unknown-account"
  | "no-key"
  | "bad-voucher"
  | "voucher-spent"
  | "too-many"
  | "plan-paid-ahead"
  | "overage-needs-plan"
  | "overage-block-size"
  | "issue-off"
  | "forbidden"
  | "too-large"
  | "version-conflict"
  | "not-found"
  | "org-not-found"
  | "org-seats"
  | "org-seats-below-live"
  | "wrong-amount";

function refuse(status: number, code: VoucherRefusal, extra: Record<string, unknown> = {}): HandlerResponseWithHeaders {
  return { status, body: { error: code, code, ...extra }, headers: { "cache-control": "no-store" } };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The `VOUCHER_SIGNING_KEYS` secret: a JSON array of `{jwk, issueUntil?, acceptUntil?}` (an RSA private JWK, 2048 bits
 * or more; `scripts/voucher-key.mjs` makes one). Bad entries are skipped. Current key first.
 */
export function voucherSigningKeysFromEnv(raw: string | undefined): VoucherSigningKey[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: VoucherSigningKey[] = [];
  for (const e of arr) {
    if (!isObj(e) || !isObj(e.jwk)) continue;
    try {
      const sk = rsaPrivateKeyFromJwk(e.jwk);
      const pub = voucherKeyFromRsa(sk);
      if (!rsaFromVoucherKey(pub)) continue;
      const t = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
      out.push({ pub, sk, issueUntil: t(e.issueUntil), acceptUntil: t(e.acceptUntil) });
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface PaymentsConfigDeps {
  config: PaymentsConfig;
  keys: VoucherSigningKey[];
  /** The gym's free test issue is on (env `VOUCHER_TEST_ISSUE=1`; never in production). */
  testIssue: boolean;
  /** Which rails sell and the store product ids (voucherRails.ts railsSummary). */
  rails?: { rails: { stripe: boolean; apple: boolean; google: boolean }; products: { units: number; productId: string }[] };
  /** The private relay the apps send spends through (docs/outbound-proxy.md "Failure handling"). */
  ohttp?: unknown;
  now?: () => number;
}

/** `GET /api/payments/config` (public): the payment numbers, the voucher keys still accepted, the gym flag and the rails. */
export function handlePaymentsConfig(deps: PaymentsConfigDeps): HandlerResponseWithHeaders {
  const now = (deps.now ?? Date.now)();
  const keys = deps.keys
    .filter((k) => k.acceptUntil === 0 || now < k.acceptUntil)
    .map((k) => ({ ...k.pub, issueUntil: k.issueUntil, acceptUntil: k.acceptUntil, issuing: k.issueUntil === 0 || now < k.issueUntil }));
  return ok(
    { config: deps.config, keys, testIssue: deps.testIssue, ...(deps.rails ?? {}), ...(deps.ohttp !== undefined ? { ohttp: deps.ohttp } : {}) },
    { "cache-control": "public, max-age=300" },
  );
}

/** The config the Worker serves: the defaults with `PAYMENTS_CONFIG` overrides. */
export function paymentsConfigFromEnv(raw: string | undefined): PaymentsConfig {
  return mergePaymentsConfig(raw ?? null);
}

/**
 * Sign blinded requests: `{k, blinded: [base64...]}` → `{k, sigs: [base64...]}`. The route decides who may call it
 * (admin secret, or the gym's test issue with `testCap`). Nothing is stored.
 */
export function handleVoucherIssue(
  deps: { keys: VoucherSigningKey[]; config: PaymentsConfig; now?: () => number },
  body: unknown,
  testCap?: number,
): HandlerResponseWithHeaders {
  const now = (deps.now ?? Date.now)();
  if (!isObj(body) || typeof body.k !== "string" || !Array.isArray(body.blinded) || body.blinded.length === 0) return refuse(400, "malformed");
  const cap = Math.min(deps.config.maxPerRequest, testCap ?? Number.MAX_SAFE_INTEGER);
  if (body.blinded.length > cap) return refuse(400, "too-many", { max: cap });
  const key = deps.keys.find((k) => k.pub.keyId === body.k && (k.issueUntil === 0 || now < k.issueUntil));
  if (!key) return refuse(409, "no-key");
  const sigs: string[] = [];
  for (const b of body.blinded) {
    if (typeof b !== "string") return refuse(400, "malformed");
    try {
      sigs.push(signBlindedVoucher(key.sk, b));
    } catch {
      return refuse(400, "malformed");
    }
  }
  return ok({ k: key.pub.keyId, sigs }, { "cache-control": "no-store" });
}

export interface VoucherRedeemDeps {
  keys: VoucherSigningKey[];
  config: PaymentsConfig;
  store: BlindVoucherStorage;
  tiers: TierStorage;
  usernames: Pick<UsernameStorage, "get">;
  meter: MeterStorage;
  /** Orgs: a spend may name an org (`org`) instead of an account; Business seats or an overage block for its egress. */
  orgs?: OrgDeps;
  now?: () => number;
}

export type RedeemFor = PaidPlan | "overage";

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The new paid-until for `n` vouchers on `plan`, from the account's current tier record. */
export function planEndAfterSpend(
  cfg: PaymentsConfig,
  current: { plan: PaidPlan | null; paidUntil: number },
  plan: PaidPlan,
  n: number,
  now: number,
): number {
  const graceMs = cfg.graceHours * 3_600_000;
  const unit = planUnitMs(cfg, plan);
  let base = now;
  if (current.plan && current.paidUntil > 0 && current.paidUntil + graceMs >= now) {
    if (current.plan === plan) base = current.paidUntil;
    else if (current.paidUntil > now) base = now + Math.floor(((current.paidUntil - now) * unit) / planUnitMs(cfg, current.plan));
  }
  return base + n * unit;
}

/**
 * `POST /api/vouchers/redeem` (public, OHTTP-shaped): `{v: 1, username, for: "pro" | "pro-max" | "overage", vouchers}`.
 *
 * Plan time: every voucher that verifies and was not spent before buys one unit of the plan (`planUnitMs`); those
 * already spent are listed in `spent` and buy nothing, so a device whose wallet was out of date learns which to drop.
 * Refused without spending anything when the plan would end up more than `maxAheadDays` ahead. A different plan than
 * the current one converts the time left at the ratio of the two plans' unit lengths.
 *
 * Overage: exactly `overage.blockUnits` vouchers on a paid plan, all or nothing; adds `overage.blockGb` to this
 * month's egress allowance.
 */
export async function handleVoucherRedeem(deps: VoucherRedeemDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  if (isObj(body) && "org" in body) return handleOrgVoucherRedeem(deps, body);
  const now = (deps.now ?? Date.now)();
  const cfg = deps.config;
  if (!isObj(body) || body.v !== 1 || typeof body.username !== "string" || !Array.isArray(body.vouchers)) return refuse(400, "malformed");
  const what = body.for;
  if (!(isPaidPlan(what) || what === "overage")) return refuse(400, "malformed");
  const username = body.username.toLowerCase();
  if (!USERNAME.test(username)) return refuse(400, "malformed");
  if (body.vouchers.length === 0) return refuse(400, "malformed");
  if (body.vouchers.length > cfg.maxPerRequest) return refuse(400, "too-many", { max: cfg.maxPerRequest });

  const vouchers: Voucher[] = [];
  const seen = new Set<string>();
  for (const raw of body.vouchers) {
    const v = parseVoucher(raw);
    if (!v) return refuse(400, "malformed");
    const key = deps.keys.find((k) => k.pub.keyId === v.k && (k.acceptUntil === 0 || now < k.acceptUntil));
    if (!key || !verifyVoucher(key.pub, v)) return refuse(400, "bad-voucher", { nullifier: voucherNullifier(v) });
    const nf = voucherNullifier(v);
    if (seen.has(nf)) return refuse(400, "malformed");
    seen.add(nf);
    vouchers.push(v);
  }
  if (!(await deps.usernames.get(username))) return refuse(404, "unknown-account");

  const rec = await deps.tiers.get(username);
  const curPlan = rec ? planOfTier(rec.tier) : null;
  const current = { plan: curPlan, paidUntil: curPlan ? Math.floor(rec?.currentPeriodEnd ?? 0) : 0 };
  const graceMs = cfg.graceHours * 3_600_000;
  const active = current.plan !== null && current.paidUntil + graceMs >= now;

  if (what === "overage") {
    if (!active) return refuse(409, "overage-needs-plan");
    if (vouchers.length !== cfg.overage.blockUnits) return refuse(400, "overage-block-size", { units: cfg.overage.blockUnits });
  } else if (planEndAfterSpend(cfg, current, what, 0, now) - now > cfg.maxAheadDays * DAY_MS) {
    return refuse(409, "plan-paid-ahead", { paidUntil: current.paidUntil });
  }

  const items = vouchers.map((v) => ({ nullifier: voucherNullifier(v), keyId: v.k }));
  const won = await deps.store.spend(items, utcDay(now));
  const fresh = items.filter((_, i) => won[i]).map((i) => i.nullifier);
  const spent = items.filter((_, i) => !won[i]).map((i) => i.nullifier);

  if (what === "overage") {
    if (spent.length > 0) {
      await deps.store.unspend(fresh);
      return refuse(409, "voucher-spent", { spent });
    }
    await meterRecord({ meter: deps.meter, tiers: deps.tiers, now: () => now }, username, "egress-topup", cfg.overage.blockGb * GB);
    const topUpBytes = await egressTopUpBytes({ meter: deps.meter, tiers: deps.tiers, now: () => now }, username);
    return ok({ ok: true, for: what, credited: fresh.length, spent, topUpBytes }, { "cache-control": "no-store" });
  }

  if (fresh.length === 0) return refuse(409, "voucher-spent", { spent });
  const paidUntil = planEndAfterSpend(cfg, current, what, fresh.length, now);
  await grantTier({ tiers: deps.tiers, now: () => now }, { username, tier: PLAN_TIER[what], durationDays: 0, absolutePeriodEnd: paidUntil, allowPastEnd: true });
  return ok({ ok: true, for: what, credited: fresh.length, spent, plan: what, paidUntil }, { "cache-control": "no-store" });
}

/** Parse and verify every voucher of a spend (no store access): the vouchers, or a refusal. */
function verifiedVouchers(deps: Pick<VoucherRedeemDeps, "keys" | "config">, raw: unknown[], now: number): Voucher[] | HandlerResponseWithHeaders {
  if (raw.length === 0) return refuse(400, "malformed");
  if (raw.length > deps.config.maxPerRequest) return refuse(400, "too-many", { max: deps.config.maxPerRequest });
  const out: Voucher[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const v = parseVoucher(r);
    if (!v) return refuse(400, "malformed");
    const key = deps.keys.find((k) => k.pub.keyId === v.k && (k.acceptUntil === 0 || now < k.acceptUntil));
    if (!key || !verifyVoucher(key.pub, v)) return refuse(400, "bad-voucher", { nullifier: voucherNullifier(v) });
    const nf = voucherNullifier(v);
    if (seen.has(nf)) return refuse(400, "malformed");
    seen.add(nf);
    out.push(v);
  }
  return out;
}

/**
 * Spend exactly `units` blind vouchers for something `.com` sells outside plan time (a name change: nameChange.ts),
 * through the same nullifier store as `POST /api/vouchers/redeem`. All or nothing: a wrong count, a bad voucher or
 * one already spent spends none (the spent ones are listed, so the wallet can drop them). The caller puts them back
 * with {@link unspendVouchers} if what they paid for fails.
 */
export async function spendVouchersExactly(
  deps: Pick<VoucherRedeemDeps, "keys" | "config" | "store" | "now">,
  raw: unknown[],
  units: number,
): Promise<{ ok: true; nullifiers: string[] } | { ok: false; response: HandlerResponseWithHeaders }> {
  const now = (deps.now ?? Date.now)();
  if (raw.length !== units) return { ok: false, response: refuse(400, "wrong-amount", { units }) };
  const vouchers = verifiedVouchers(deps, raw, now);
  if (!Array.isArray(vouchers)) return { ok: false, response: vouchers };
  const items = vouchers.map((v) => ({ nullifier: voucherNullifier(v), keyId: v.k }));
  const won = await deps.store.spend(items, utcDay(now));
  const fresh = items.filter((_, i) => won[i]).map((i) => i.nullifier);
  const spent = items.filter((_, i) => !won[i]).map((i) => i.nullifier);
  if (spent.length > 0) {
    await deps.store.unspend(fresh);
    return { ok: false, response: refuse(409, "voucher-spent", { spent }) };
  }
  return { ok: true, nullifiers: fresh };
}

/** Put back vouchers {@link spendVouchersExactly} spent, when what they paid for failed. */
export async function unspendVouchers(store: Pick<BlindVoucherStorage, "unspend">, nullifiers: string[]): Promise<void> {
  if (nullifiers.length > 0) await store.unspend(nullifiers);
}

/**
 * The org form of `POST /api/vouchers/redeem` (docs/plans-and-backup-offer.md "As built"):
 * `{v: 1, org: <orgId>, for: "business", seats, vouchers}` buys Business time for `seats` paid seats (orgPlan.ts);
 * `{v: 1, org, for: "overage", vouchers}` buys one egress block for the org's pooled allowance. Same privacy as the
 * account form: no credential, nothing about the caller stored, reachable through the OHTTP relay.
 */
async function handleOrgVoucherRedeem(deps: VoucherRedeemDeps, body: Record<string, unknown>): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const cfg = deps.config;
  if (!deps.orgs) return refuse(404, "org-not-found");
  if (body.v !== 1 || typeof body.org !== "string" || !Array.isArray(body.vouchers) || "username" in body) return refuse(400, "malformed");
  const what = body.for;
  if (what !== "business" && what !== "overage") return refuse(400, "malformed");
  const vouchers = verifiedVouchers(deps, body.vouchers, now);
  if (!Array.isArray(vouchers)) return vouchers;
  const orgDeps: OrgDeps = { ...deps.orgs, payments: cfg, now: () => now };
  const check = await checkOrgSpend(orgDeps, body.org, what, body.seats, now);
  if (!check.ok) return refuse(check.status, check.code as VoucherRefusal, check.extra ?? {});
  if (what === "overage" && vouchers.length !== cfg.overage.blockUnits) return refuse(400, "overage-block-size", { units: cfg.overage.blockUnits });

  const items = vouchers.map((v) => ({ nullifier: voucherNullifier(v), keyId: v.k }));
  const won = await deps.store.spend(items, utcDay(now));
  const fresh = items.filter((_, i) => won[i]).map((i) => i.nullifier);
  const spent = items.filter((_, i) => !won[i]).map((i) => i.nullifier);
  if (what === "overage") {
    if (spent.length > 0) {
      await deps.store.unspend(fresh);
      return refuse(409, "voucher-spent", { spent });
    }
    const account = check.org.name;
    await meterRecord({ meter: deps.meter, tiers: deps.tiers, now: () => now }, account, "egress-topup", cfg.overage.blockGb * GB);
    const topUpBytes = await egressTopUpBytes({ meter: deps.meter, tiers: deps.tiers, now: () => now }, account);
    return ok({ ok: true, for: what, credited: fresh.length, spent, topUpBytes }, { "cache-control": "no-store" });
  }
  if (fresh.length === 0) return refuse(409, "voucher-spent", { spent });
  const seats = body.seats as number;
  const st = await creditOrgSeats(orgDeps, body.org, seats, fresh.length, now);
  if (!st) {
    await deps.store.unspend(fresh);
    return refuse(409, "version-conflict");
  }
  return ok({ ok: true, for: what, credited: fresh.length, spent, seats, paidUntil: st.paidUntil, status: st.status }, { "cache-control": "no-store" });
}

/**
 * `POST /api/vouchers/exchange` (public, OHTTP-shaped): `{v: 1, k, vouchers, blinded}` with as many blinded requests
 * as vouchers → `{k, sigs}`. Spends the vouchers and blind-signs fresh ones, all or nothing. An org wallet uses it
 * after its key rotates, so an admin who left can't spend vouchers they could read. Nothing is stored but the
 * nullifiers, as for any spend.
 */
export async function handleVoucherExchange(deps: Pick<VoucherRedeemDeps, "keys" | "config" | "store" | "now">, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  if (!isObj(body) || body.v !== 1 || typeof body.k !== "string" || !Array.isArray(body.vouchers) || !Array.isArray(body.blinded)) return refuse(400, "malformed");
  if (body.blinded.length !== body.vouchers.length) return refuse(400, "malformed");
  if (!body.blinded.every((b): b is string => typeof b === "string" && b.length > 0 && b.length <= 2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(b))) return refuse(400, "malformed");
  if (new Set(body.blinded).size !== body.blinded.length) return refuse(400, "malformed");
  const key = deps.keys.find((x) => x.pub.keyId === body.k && (x.issueUntil === 0 || now < x.issueUntil));
  if (!key) return refuse(409, "no-key");
  const vouchers = verifiedVouchers(deps, body.vouchers, now);
  if (!Array.isArray(vouchers)) return vouchers;
  const items = vouchers.map((v) => ({ nullifier: voucherNullifier(v), keyId: v.k }));
  const won = await deps.store.spend(items, utcDay(now));
  const fresh = items.filter((_, i) => won[i]).map((i) => i.nullifier);
  const spent = items.filter((_, i) => !won[i]).map((i) => i.nullifier);
  if (spent.length > 0) {
    await deps.store.unspend(fresh);
    return refuse(409, "voucher-spent", { spent });
  }
  const sigs: string[] = [];
  for (const b of body.blinded as string[]) {
    try {
      sigs.push(signBlindedVoucher(key.sk, b));
    } catch {
      await deps.store.unspend(fresh);
      return refuse(400, "malformed");
    }
  }
  return ok({ k: key.pub.keyId, sigs }, { "cache-control": "no-store" });
}

// ── the sealed wallet ──────────────────────────────────────────────────────

/** `GET /api/accounts/<u>/voucher-wallet`: the sealed blob (read token of a device of the account), or 404. */
export async function handleVoucherWalletGet(
  deps: { store: Pick<BlindVoucherStorage, "getWallet">; readTokens: AccountReadTokenDeps },
  username: string,
  authorization: string | null,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const read = await requireAccountRead(deps.readTokens, u, authorization, ACCOUNT_KEY_HOLDERS_ONLY);
  if (!read.ok) return read.response;
  const s = await deps.store.getWallet(u);
  if (!s) return { ...refuse(404, "not-found"), headers: { ...ACCOUNT_READ_HEADERS } };
  return { status: 200, body: JSON.parse(s.blob) as unknown, headers: { ...ACCOUNT_READ_HEADERS } };
}

/**
 * `PUT /api/accounts/<u>/voucher-wallet` `{version, nonce, ct}` from a device of the account (device headers):
 * version = stored + 1, else 409 `version-conflict` with the stored blob to merge. `.com` checks only the shape.
 */
export async function handleVoucherWalletPut(
  deps: {
    store: Pick<BlindVoucherStorage, "getWallet" | "putWallet">;
    directory: Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">;
    now?: () => number;
  },
  username: string,
  auth: DirectoryAuthorization | undefined,
  bodyText: string,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const u = username.toLowerCase();
  if (bodyText.length > VOUCHER_WALLET_MAX_BODY) return refuse(413, "too-large");
  const caller = await authorizeActiveDevice(deps.directory, auth, { accountId: u, method: "PUT", path: `/api/accounts/${u}/voucher-wallet` });
  if (!caller) return refuse(403, "forbidden");
  let s: unknown;
  try {
    s = JSON.parse(bodyText);
  } catch {
    return refuse(400, "malformed");
  }
  if (
    !isObj(s) ||
    Object.keys(s).length !== 3 ||
    !Number.isSafeInteger(s.version) ||
    (s.version as number) < 1 ||
    typeof s.nonce !== "string" ||
    !/^[0-9a-f]{24}$/.test(s.nonce) ||
    typeof s.ct !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(s.ct) ||
    s.ct.length % 4 !== 0
  ) {
    return refuse(400, "malformed");
  }
  const blob = JSON.stringify({ ct: s.ct, nonce: s.nonce, version: s.version });
  if (!(await deps.store.putWallet(u, s.version as number, blob, now))) {
    const cur = await deps.store.getWallet(u);
    return refuse(409, "version-conflict", { wallet: cur ? JSON.parse(cur.blob) : null });
  }
  return ok({ ok: true, version: s.version });
}
