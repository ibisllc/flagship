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
  | "not-found";

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
  now?: () => number;
}

/** `GET /api/payments/config` (public): the payment numbers, the voucher keys still accepted, and the gym flag. */
export function handlePaymentsConfig(deps: PaymentsConfigDeps): HandlerResponseWithHeaders {
  const now = (deps.now ?? Date.now)();
  const keys = deps.keys
    .filter((k) => k.acceptUntil === 0 || now < k.acceptUntil)
    .map((k) => ({ ...k.pub, issueUntil: k.issueUntil, acceptUntil: k.acceptUntil, issuing: k.issueUntil === 0 || now < k.issueUntil }));
  return ok({ config: deps.config, keys, testIssue: deps.testIssue }, { "cache-control": "public, max-age=300" });
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
