// The rails that sell blind-signed vouchers (docs/payments-privacy-and-rails.md §11): Stripe Checkout on the web,
// Apple in-app purchase and Google Play Billing. Each proves a payment; `.com` then signs exactly as many blinded
// requests as the payment bought and keeps only a hash of the payment id (voucher_payments, D1 0153).
//
// Privacy rules this file keeps:
// - Nothing here takes or stores an account, an address or a device: the issue call carries a proof of payment and
//   blinded requests, nothing else, and the Stripe session carries no username, customer or client reference.
// - A store or card refund cannot reach vouchers already signed (we can't tell which they are). A payment known to be
//   refunded is never signed for.
import {
  isLowerHex,
  signBlindedVoucher,
  voucherBlindedSetHash,
  voucherOrderCommit,
  voucherPackProductId,
  voucherPackUnits,
  voucherPaymentHash,
  type PaymentsConfig,
  type VoucherRail,
} from "@flagship/protocol";
import type { VoucherPaymentStorage } from "@flagship/storage";
import { verifyAppleSignedJws } from "./appleJws.js";
import type { VoucherSigningKey } from "./blindVouchers.js";
import type { GooglePlayApi } from "./googlePlay.js";
import { verifyStripeSignature } from "./stripe.js";
import { ok, type HandlerResponseWithHeaders } from "./types.js";

/** Most blinded requests one paid issue may carry (the largest pack × a store quantity). */
export const PAID_ISSUE_MAX = 200;
const NO_STORE = { "cache-control": "no-store" } as const;

export type RailRefusal =
  | "malformed"
  | "too-many"
  | "rail-off"
  | "no-key"
  | "payment-invalid"
  | "payment-unpaid"
  | "payment-refunded"
  | "payment-used"
  | "wrong-count"
  | "rail-unreachable";

function refuse(status: number, code: RailRefusal, extra: Record<string, unknown> = {}): HandlerResponseWithHeaders {
  return { status, body: { error: code, code, ...extra }, headers: { ...NO_STORE } };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface StripeRail {
  secretKey: string;
  /** Live keys (`sk_live_` / `rk_live_`) accept only live sessions; test keys only test ones. */
  livemode: boolean;
  successUrl: string;
  /** Where an invoiced batch's Checkout returns (the web shop's batch page). */
  batchSuccessUrl?: string;
  cancelUrl: string;
  taxBehavior: "inclusive" | "exclusive";
  taxCode: string;
  fetch?: typeof fetch;
}

export interface AppleRail {
  bundleId: string;
  /** Accepted `environment` values: `Production` in production, `Sandbox` in the gym. */
  environments: readonly string[];
  /** Tests only: their own root instead of Apple Root CA - G3. */
  rootFingerprints?: readonly string[];
}

export interface GoogleRail {
  packageName: string;
  /** Licence testers' purchases (`purchaseType` 0): the gym only. */
  allowTest: boolean;
  api: GooglePlayApi;
}

export interface VoucherRailsDeps {
  keys: VoucherSigningKey[];
  config: PaymentsConfig;
  payments: VoucherPaymentStorage;
  stripe?: StripeRail;
  apple?: AppleRail;
  google?: GoogleRail;
  now?: () => number;
}

/** What `GET /api/payments/config` adds: which rails sell, and the store product id of each pack. */
export function railsSummary(deps: Pick<VoucherRailsDeps, "stripe" | "apple" | "google" | "config">) {
  return {
    rails: { stripe: !!deps.stripe, apple: !!deps.apple, google: !!deps.google },
    products: deps.config.packs.map((units) => ({ units, productId: voucherPackProductId(units) })),
  };
}

export function stripeRailFromEnv(env: {
  STRIPE_SECRET_KEY?: string;
  STRIPE_VOUCHER_SUCCESS_URL?: string;
  STRIPE_VOUCHER_CANCEL_URL?: string;
  STRIPE_BATCH_SUCCESS_URL?: string;
  STRIPE_TAX_BEHAVIOR?: string;
  STRIPE_TAX_CODE?: string;
  CONTROL_APEX?: string;
}): StripeRail | undefined {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !/^(sk|rk)_(live|test)_/.test(key)) return undefined;
  const apex = env.CONTROL_APEX || "flagshipserver.com";
  return {
    secretKey: key,
    livemode: /^(sk|rk)_live_/.test(key),
    successUrl: env.STRIPE_VOUCHER_SUCCESS_URL || `https://webapp.${apex}/?shop=stripe&session_id={CHECKOUT_SESSION_ID}`,
    batchSuccessUrl: env.STRIPE_BATCH_SUCCESS_URL || `https://webapp.${apex}/?shop=batch&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: env.STRIPE_VOUCHER_CANCEL_URL || `https://webapp.${apex}/?shop=cancel`,
    taxBehavior: env.STRIPE_TAX_BEHAVIOR === "exclusive" ? "exclusive" : "inclusive",
    taxCode: env.STRIPE_TAX_CODE && /^txcd_\d{8}$/.test(env.STRIPE_TAX_CODE) ? env.STRIPE_TAX_CODE : "txcd_10000000",
  };
}

export function appleRailFromEnv(env: { APPLE_BUNDLE_ID?: string; APPLE_IAP_ENVIRONMENTS?: string }): AppleRail | undefined {
  if (!env.APPLE_IAP_ENVIRONMENTS) return undefined;
  const environments = env.APPLE_IAP_ENVIRONMENTS.split(",")
    .map((s) => s.trim())
    .filter((s) => s === "Production" || s === "Sandbox");
  if (environments.length === 0) return undefined;
  return { bundleId: env.APPLE_BUNDLE_ID || "com.flagshipserver.app", environments };
}

// ── proofs of payment ─────────────────────────────────────────────────

type Proof = { ok: true; paymentId: string; units: number } | { ok: false; res: HandlerResponseWithHeaders };
const bad = (res: HandlerResponseWithHeaders): Proof => ({ ok: false, res });

async function stripeGet(rail: StripeRail, path: string): Promise<{ status: number; json: any }> {
  const f = rail.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const r = await f(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${rail.secretKey}` } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function stripeProof(deps: VoucherRailsDeps, rail: StripeRail, proof: Record<string, unknown>, k: string, blinded: string[]): Promise<Proof> {
  const id = proof.sessionId;
  if (typeof id !== "string" || !/^cs_(live|test)_[A-Za-z0-9]{8,200}$/.test(id)) return bad(refuse(400, "malformed"));
  let r: { status: number; json: any };
  try {
    r = await stripeGet(rail, `checkout/sessions/${encodeURIComponent(id)}`);
  } catch {
    return bad(refuse(502, "rail-unreachable"));
  }
  if (r.status === 404) return bad(refuse(400, "payment-invalid"));
  if (r.status !== 200 || !isObj(r.json)) return bad(refuse(502, "rail-unreachable"));
  const s = r.json;
  const md = isObj(s.metadata) ? s.metadata : {};
  const n = typeof md.flagship_units === "string" && /^[1-9][0-9]{0,4}$/.test(md.flagship_units) ? Number(md.flagship_units) : NaN;
  const units = deps.config.packs.includes(n) ? n : null;
  if (
    md.flagship_kind !== "vouchers" ||
    units === null ||
    md.flagship_key !== k ||
    md.flagship_commit !== voucherOrderCommit(k, blinded) ||
    s.livemode !== rail.livemode ||
    s.mode !== "payment" ||
    String(s.currency).toLowerCase() !== "usd" ||
    s.amount_subtotal !== units * deps.config.unitUsd * 100
  ) {
    return bad(refuse(400, "payment-invalid"));
  }
  if (s.status !== "complete" || s.payment_status !== "paid") return bad(refuse(402, "payment-unpaid"));
  return { ok: true, paymentId: id, units };
}

async function appleProof(deps: VoucherRailsDeps, rail: AppleRail, proof: Record<string, unknown>, now: number): Promise<Proof> {
  if (typeof proof.jws !== "string") return bad(refuse(400, "malformed"));
  const t = await verifyAppleSignedJws(proof.jws, { now, ...(rail.rootFingerprints ? { rootFingerprints: rail.rootFingerprints } : {}) });
  if (!t) return bad(refuse(400, "payment-invalid"));
  const pack = voucherPackUnits(t.productId, deps.config.packs);
  const qty = t.quantity === undefined ? 1 : t.quantity;
  if (
    t.bundleId !== rail.bundleId ||
    t.type !== "Consumable" ||
    pack === null ||
    typeof t.environment !== "string" ||
    !rail.environments.includes(t.environment) ||
    typeof t.transactionId !== "string" ||
    !/^[0-9]{1,30}$/.test(t.transactionId) ||
    typeof qty !== "number" ||
    !Number.isSafeInteger(qty) ||
    qty < 1
  ) {
    return bad(refuse(400, "payment-invalid"));
  }
  if (t.revocationDate !== undefined && t.revocationDate !== null) {
    await deps.payments.markRefunded(voucherPaymentHash("apple", t.transactionId), "apple", utcDay(now));
    return bad(refuse(409, "payment-refunded"));
  }
  return { ok: true, paymentId: t.transactionId, units: pack * qty };
}

async function googleProof(deps: VoucherRailsDeps, rail: GoogleRail, proof: Record<string, unknown>, now: number): Promise<Proof> {
  const { productId, purchaseToken } = proof;
  if (typeof purchaseToken !== "string" || !/^[A-Za-z0-9._\-:]{10,4096}$/.test(purchaseToken)) return bad(refuse(400, "malformed"));
  const pack = voucherPackUnits(productId, deps.config.packs);
  if (pack === null || typeof productId !== "string") return bad(refuse(400, "payment-invalid"));
  let p;
  try {
    p = await rail.api.getProductPurchase(productId, purchaseToken);
  } catch {
    return bad(refuse(502, "rail-unreachable"));
  }
  if (!p) return bad(refuse(400, "payment-invalid"));
  if (p.obfuscatedExternalAccountId || p.obfuscatedExternalProfileId) return bad(refuse(400, "payment-invalid"));
  if (p.purchaseType === 0 && !rail.allowTest) return bad(refuse(400, "payment-invalid"));
  if (p.purchaseType !== undefined && p.purchaseType !== 0 && p.purchaseType !== 1) return bad(refuse(400, "payment-invalid"));
  if (p.purchaseState === 2) return bad(refuse(402, "payment-unpaid"));
  if (p.purchaseState === 1) {
    await deps.payments.markRefunded(voucherPaymentHash("google", purchaseToken), "google", utcDay(now));
    return bad(refuse(409, "payment-refunded"));
  }
  if (p.purchaseState !== 0 && p.purchaseState !== undefined) return bad(refuse(400, "payment-invalid"));
  const qty = p.quantity ?? 1;
  if (!Number.isSafeInteger(qty) || qty < 1) return bad(refuse(400, "payment-invalid"));
  return { ok: true, paymentId: purchaseToken, units: pack * qty };
}

// ── the issue call ────────────────────────────────────────────────────

/**
 * `POST /api/vouchers/paid-issue` (public, no credential): `{v: 1, rail, proof, k, blinded}` → `{k, sigs, units}`.
 * Signs only when the proof checks, `blinded.length` equals the units bought, and the payment wasn't used for
 * another set (a retry with the same set gets the same signatures: RSA blind signing is deterministic).
 */
export async function handlePaidIssue(deps: VoucherRailsDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  if (!isObj(body) || body.v !== 1 || typeof body.k !== "string" || !isObj(body.proof) || !Array.isArray(body.blinded) || body.blinded.length === 0) {
    return refuse(400, "malformed");
  }
  const rail = body.rail as VoucherRail;
  if (rail !== "stripe" && rail !== "apple" && rail !== "google") return refuse(400, "malformed");
  if (body.blinded.length > PAID_ISSUE_MAX) return refuse(400, "too-many", { max: PAID_ISSUE_MAX });
  if (!body.blinded.every((b): b is string => typeof b === "string" && b.length > 0 && b.length <= 2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(b))) {
    return refuse(400, "malformed");
  }
  const blinded = body.blinded as string[];
  if (new Set(blinded).size !== blinded.length) return refuse(400, "malformed");
  const k = body.k;
  const key = deps.keys.find((x) => x.pub.keyId === k && (x.issueUntil === 0 || now < x.issueUntil));
  if (!key) return refuse(409, "no-key");

  let proof: Proof;
  if (rail === "stripe") proof = deps.stripe ? await stripeProof(deps, deps.stripe, body.proof, k, blinded) : bad(refuse(404, "rail-off"));
  else if (rail === "apple") proof = deps.apple ? await appleProof(deps, deps.apple, body.proof, now) : bad(refuse(404, "rail-off"));
  else proof = deps.google ? await googleProof(deps, deps.google, body.proof, now) : bad(refuse(404, "rail-off"));
  if (!proof.ok) return proof.res;
  if (blinded.length !== proof.units) return refuse(409, "wrong-count", { units: proof.units });

  const paymentHash = voucherPaymentHash(rail, proof.paymentId);
  const blindedHash = voucherBlindedSetHash(k, blinded);
  const row = await deps.payments.claim({ paymentHash, rail, units: proof.units, keyId: k, blindedHash, day: utcDay(now), state: "signed" });
  if (row.state === "refunded") return refuse(409, "payment-refunded");
  if (row.blindedHash !== blindedHash || row.keyId !== k) return refuse(409, "payment-used");

  const sigs: string[] = [];
  for (const b of blinded) {
    try {
      sigs.push(signBlindedVoucher(key.sk, b));
    } catch {
      return refuse(400, "malformed");
    }
  }
  if (rail === "google" && deps.google && typeof body.proof.productId === "string") {
    try {
      await deps.google.api.acknowledge(body.proof.productId, proof.paymentId);
    } catch {
      /* the phone consumes it too; a missed acknowledge only matters if the phone never does */
    }
  }
  return ok({ k: key.pub.keyId, sigs, units: proof.units }, { ...NO_STORE });
}

// ── Stripe Checkout ───────────────────────────────────────────────────

/**
 * `POST /api/vouchers/stripe/checkout` (public): `{v: 1, units, k, commit}` → `{url, sessionId}`. The session carries
 * the pack, the key and the commitment to the blinded requests, and nothing about who is buying.
 */
export async function handleStripeVoucherCheckout(deps: VoucherRailsDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const rail = deps.stripe;
  if (!rail) return refuse(404, "rail-off");
  if (!isObj(body) || body.v !== 1 || typeof body.k !== "string" || typeof body.commit !== "string" || !isLowerHex(body.commit, 32)) {
    return refuse(400, "malformed");
  }
  const units = typeof body.units === "number" && deps.config.packs.includes(body.units) ? body.units : null;
  if (units === null) return refuse(400, "malformed");
  const key = deps.keys.find((x) => x.pub.keyId === body.k && (x.issueUntil === 0 || now < x.issueUntil));
  if (!key) return refuse(409, "no-key");

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(deps.config.unitUsd * 100));
  form.set("line_items[0][price_data][tax_behavior]", rail.taxBehavior);
  // "Flagship" is the product's name in every language (a keep-term); Stripe shows the quantity in the buyer's.
  form.set("line_items[0][price_data][product_data][name]", "Flagship");
  form.set("line_items[0][price_data][product_data][tax_code]", rail.taxCode);
  form.set("line_items[0][quantity]", String(units));
  form.set("automatic_tax[enabled]", "true");
  form.set("billing_address_collection", "auto");
  form.set("customer_creation", "if_required");
  form.set("submit_type", "pay");
  form.set("locale", "auto");
  form.set("metadata[flagship_kind]", "vouchers");
  form.set("metadata[flagship_units]", String(units));
  form.set("metadata[flagship_key]", key.pub.keyId);
  form.set("metadata[flagship_commit]", body.commit);
  form.set("payment_intent_data[metadata][flagship_kind]", "vouchers");
  form.set("success_url", rail.successUrl);
  form.set("cancel_url", rail.cancelUrl);

  const f = rail.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let resp: Response;
  try {
    resp = await f("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rail.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // One session per order even if the buy button is pressed twice.
        "idempotency-key": `flagship-vouchers-${body.commit}`,
      },
      body: form.toString(),
    });
  } catch {
    return refuse(502, "rail-unreachable");
  }
  const json: any = await resp.json().catch(() => null);
  if (!resp.ok || typeof json?.url !== "string" || typeof json?.id !== "string") return refuse(502, "rail-unreachable");
  return ok({ url: json.url, sessionId: json.id }, { ...NO_STORE });
}

// ── Invoiced batches (docs/plans-and-backup-offer.md §6 and "As built") ──

/** Most signatures one batch-issue call returns (the browser asks again from `from + sigs.length`). */
export const BATCH_ISSUE_CHUNK = 100;

/**
 * `POST /api/vouchers/stripe/batch-checkout` (public): `{v: 1, units, k, commit}` → `{url, sessionId}`. A company's
 * invoiced voucher batch: at least `business.batchMinUnits`, at most `business.batchMaxUnits`. Stripe collects the
 * company's name, address and tax id and issues an invoice that reads "Flagship vouchers" × units. The session and
 * the invoice name no org, account or seat; the metadata carries the count, the key and the commitment to the
 * blinded requests (voucherBatch.ts), exactly as a pack does.
 */
export async function handleStripeBatchCheckout(deps: VoucherRailsDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const rail = deps.stripe;
  if (!rail) return refuse(404, "rail-off");
  if (!isObj(body) || body.v !== 1 || typeof body.k !== "string" || typeof body.commit !== "string" || !isLowerHex(body.commit, 32)) {
    return refuse(400, "malformed");
  }
  const b = deps.config.business;
  const units = typeof body.units === "number" && Number.isSafeInteger(body.units) && body.units >= b.batchMinUnits && body.units <= b.batchMaxUnits ? body.units : null;
  if (units === null) return refuse(400, "malformed", { min: b.batchMinUnits, max: b.batchMaxUnits });
  const key = deps.keys.find((x) => x.pub.keyId === body.k && (x.issueUntil === 0 || now < x.issueUntil));
  if (!key) return refuse(409, "no-key");

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(deps.config.unitUsd * 100));
  form.set("line_items[0][price_data][tax_behavior]", rail.taxBehavior);
  // A keep-term in every language; the invoice adds the quantity. Never an org, account or seat.
  form.set("line_items[0][price_data][product_data][name]", "Flagship vouchers");
  form.set("line_items[0][price_data][product_data][tax_code]", rail.taxCode);
  form.set("line_items[0][quantity]", String(units));
  form.set("automatic_tax[enabled]", "true");
  form.set("billing_address_collection", "required");
  form.set("tax_id_collection[enabled]", "true");
  form.set("customer_creation", "always");
  form.set("invoice_creation[enabled]", "true");
  form.set("invoice_creation[invoice_data][description]", "Flagship vouchers");
  form.set("invoice_creation[invoice_data][metadata][flagship_kind]", "voucher-batch");
  form.set("submit_type", "pay");
  form.set("locale", "auto");
  form.set("metadata[flagship_kind]", "voucher-batch");
  form.set("metadata[flagship_units]", String(units));
  form.set("metadata[flagship_key]", key.pub.keyId);
  form.set("metadata[flagship_commit]", body.commit);
  form.set("payment_intent_data[metadata][flagship_kind]", "voucher-batch");
  form.set("success_url", rail.batchSuccessUrl ?? rail.successUrl);
  form.set("cancel_url", rail.cancelUrl);

  const f = rail.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let resp: Response;
  try {
    resp = await f("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rail.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `flagship-voucher-batch-${body.commit}`,
      },
      body: form.toString(),
    });
  } catch {
    return refuse(502, "rail-unreachable");
  }
  const json: any = await resp.json().catch(() => null);
  if (!resp.ok || typeof json?.url !== "string" || typeof json?.id !== "string") return refuse(502, "rail-unreachable");
  return ok({ url: json.url, sessionId: json.id }, { ...NO_STORE });
}

/**
 * `POST /api/vouchers/batch-issue` (public, no credential): `{v: 1, session, k, blinded, from}` → `{k, from, sigs,
 * units, done}`. `blinded` is the whole batch, in order (it must match the session's commitment); the answer signs
 * up to BATCH_ISSUE_CHUNK of them from `from`, so a large batch never blocks one request. Every call re-checks the
 * paid session; a retry or a call from another computer gets the same signatures (blind signing is deterministic),
 * and a session's payment can never be claimed for another set.
 */
export async function handleBatchIssue(deps: VoucherRailsDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const rail = deps.stripe;
  if (!rail) return refuse(404, "rail-off");
  if (!isObj(body) || body.v !== 1 || typeof body.k !== "string" || typeof body.session !== "string" || !Array.isArray(body.blinded)) return refuse(400, "malformed");
  const from = body.from;
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0 || from >= body.blinded.length) return refuse(400, "malformed");
  if (body.blinded.length > deps.config.business.batchMaxUnits) return refuse(400, "too-many", { max: deps.config.business.batchMaxUnits });
  if (!body.blinded.every((b): b is string => typeof b === "string" && b.length > 0 && b.length <= 2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(b))) return refuse(400, "malformed");
  const blinded = body.blinded as string[];
  if (new Set(blinded).size !== blinded.length) return refuse(400, "malformed");
  const id = body.session;
  if (!/^cs_(live|test)_[A-Za-z0-9]{8,200}$/.test(id)) return refuse(400, "malformed");
  const key = deps.keys.find((x) => x.pub.keyId === body.k && (x.issueUntil === 0 || now < x.issueUntil));
  if (!key) return refuse(409, "no-key");

  let r: { status: number; json: any };
  try {
    r = await stripeGet(rail, `checkout/sessions/${encodeURIComponent(id)}`);
  } catch {
    return refuse(502, "rail-unreachable");
  }
  if (r.status === 404) return refuse(400, "payment-invalid");
  if (r.status !== 200 || !isObj(r.json)) return refuse(502, "rail-unreachable");
  const s = r.json;
  const md = isObj(s.metadata) ? s.metadata : {};
  const units = typeof md.flagship_units === "string" && /^[1-9][0-9]{0,5}$/.test(md.flagship_units) ? Number(md.flagship_units) : NaN;
  const b = deps.config.business;
  if (
    md.flagship_kind !== "voucher-batch" ||
    !(units >= b.batchMinUnits && units <= b.batchMaxUnits) ||
    md.flagship_key !== body.k ||
    s.livemode !== rail.livemode ||
    s.mode !== "payment" ||
    String(s.currency).toLowerCase() !== "usd" ||
    s.amount_subtotal !== units * deps.config.unitUsd * 100
  ) {
    return refuse(400, "payment-invalid");
  }
  if (blinded.length !== units) return refuse(409, "wrong-count", { units });
  if (md.flagship_commit !== voucherOrderCommit(body.k, blinded)) return refuse(400, "payment-invalid");
  if (s.status !== "complete" || s.payment_status !== "paid") return refuse(402, "payment-unpaid");

  const paymentHash = voucherPaymentHash("stripe", id);
  const blindedHash = voucherBlindedSetHash(body.k, blinded);
  const row = await deps.payments.claim({ paymentHash, rail: "stripe", units, keyId: body.k, blindedHash, day: utcDay(now), state: "signed" });
  if (row.state === "refunded") return refuse(409, "payment-refunded");
  if (row.blindedHash !== blindedHash || row.keyId !== body.k) return refuse(409, "payment-used");

  const end = Math.min(blinded.length, from + BATCH_ISSUE_CHUNK);
  const sigs: string[] = [];
  for (let i = from; i < end; i++) {
    try {
      sigs.push(signBlindedVoucher(key.sk, blinded[i]!));
    } catch {
      return refuse(400, "malformed");
    }
  }
  return ok({ k: key.pub.keyId, from, sigs, units, done: end === blinded.length }, { ...NO_STORE });
}

/** Stripe events the voucher rail answers itself; every other event goes to the older handler (stripe.ts). */
export const STRIPE_VOUCHER_EVENTS = new Set(["charge.refunded", "charge.dispute.created"]);

/** True when a verified Stripe event belongs to the voucher rail (its refunds and disputes, its own sessions). */
export function isVoucherStripeEvent(event: any): boolean {
  if (!event || typeof event.type !== "string") return false;
  if (STRIPE_VOUCHER_EVENTS.has(event.type)) return true;
  const kind = event?.data?.object?.metadata?.flagship_kind;
  return event.type.startsWith("checkout.session.") && (kind === "vouchers" || kind === "voucher-batch");
}

/**
 * The voucher half of `POST /api/stripe/webhook`. `rawBody` and `signature` exactly as received. A refund or a
 * dispute marks the voucher payment `refunded` (it can't reach vouchers already signed; it stops a later signing).
 * Completed sessions need nothing: the phone or browser asks for its signatures with the session id.
 */
export async function handleStripeVoucherWebhook(
  deps: VoucherRailsDeps & { webhookSecret?: string },
  opts: { rawBody: string; signature: string | null },
): Promise<{ status: number; body: unknown }> {
  const now = (deps.now ?? Date.now)();
  if (!deps.webhookSecret || !deps.stripe) return { status: 503, body: { error: "stripe not configured" } };
  if (!opts.signature || !(await verifyStripeSignature({ payload: opts.rawBody, header: opts.signature, secret: deps.webhookSecret, now }))) {
    return { status: 400, body: { error: "invalid signature" } };
  }
  let event: any;
  try {
    event = JSON.parse(opts.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }
  if (!STRIPE_VOUCHER_EVENTS.has(event?.type)) return { status: 200, body: { ok: true, action: "ignored" } };
  const obj = event?.data?.object;
  if (event.type === "charge.refunded" && !(obj?.refunded === true || (typeof obj?.amount_refunded === "number" && obj.amount_refunded > 0))) {
    return { status: 200, body: { ok: true, action: "ignored" } };
  }
  const pi = typeof obj?.payment_intent === "string" ? obj.payment_intent : null;
  if (!pi || !/^pi_[A-Za-z0-9]{8,200}$/.test(pi)) return { status: 200, body: { ok: true, action: "ignored" } };
  let r: { status: number; json: any };
  try {
    r = await stripeGet(deps.stripe, `checkout/sessions?payment_intent=${encodeURIComponent(pi)}&limit=1`);
  } catch {
    return { status: 502, body: { error: "stripe unreachable" } }; // Stripe retries
  }
  if (r.status !== 200) return { status: 502, body: { error: "stripe unreachable" } };
  const session = r.json?.data?.[0];
  const sessionKind = session?.metadata?.flagship_kind;
  if ((sessionKind !== "vouchers" && sessionKind !== "voucher-batch") || typeof session?.id !== "string") return { status: 200, body: { ok: true, action: "ignored" } };
  await deps.payments.markRefunded(voucherPaymentHash("stripe", session.id), "stripe", utcDay(now));
  return { status: 200, body: { ok: true, action: "refunded" } };
}

// ── App Store Server Notifications V2 ─────────────────────────────────

/**
 * `POST /api/vouchers/apple/notifications` `{signedPayload}`: Apple tells us about a refund (`REFUND`) or a revoked
 * purchase (`REVOKE`); the payment is marked refunded so it is never signed for. Answers 200 to every notification
 * that verifies (Apple retries anything else).
 */
export async function handleAppleNotification(deps: VoucherRailsDeps, body: unknown): Promise<{ status: number; body: unknown }> {
  const now = (deps.now ?? Date.now)();
  const rail = deps.apple;
  if (!rail) return { status: 404, body: { error: "rail-off", code: "rail-off" } };
  if (!isObj(body)) return { status: 400, body: { error: "malformed" } };
  const opts = { now, ...(rail.rootFingerprints ? { rootFingerprints: rail.rootFingerprints } : {}) };
  const n = await verifyAppleSignedJws(body.signedPayload, opts);
  if (!n) return { status: 400, body: { error: "invalid signature" } };
  const data = isObj(n.data) ? n.data : {};
  if (data.bundleId !== undefined && data.bundleId !== rail.bundleId) return { status: 200, body: { ok: true, action: "ignored" } };
  if (n.notificationType !== "REFUND" && n.notificationType !== "REVOKE") return { status: 200, body: { ok: true, action: "ignored" } };
  const t = await verifyAppleSignedJws(data.signedTransactionInfo, opts);
  if (!t || typeof t.transactionId !== "string" || voucherPackUnits(t.productId, deps.config.packs) === null) {
    return { status: 200, body: { ok: true, action: "ignored" } };
  }
  await deps.payments.markRefunded(voucherPaymentHash("apple", t.transactionId), "apple", utcDay(now));
  return { status: 200, body: { ok: true, action: "refunded" } };
}
