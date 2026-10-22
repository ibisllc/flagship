// Stripe checkout + webhook → tier (#11) — the "convenient lane".
//
// The privacy-first lanes (cash/Monero → admin grant #8; prepaid voucher #9)
// stay the recommended paths; this is the one-click card lane the `/pro` page
// offers with an explicit "your card network will know you paid Flagship"
// caveat. Both lanes converge on grantTier — the single entitlement writer.
//
// Two surfaces:
//   • createCheckoutSession — server→Stripe API call that mints a hosted
//     Checkout URL, stamping the username + tier into the session AND the
//     subscription metadata so the webhook can attribute later payments.
//   • handleStripeWebhook — Stripe→us. Verifies the signature, idempotently
//     claims the event id (Stripe redelivers), and maps the event to a grant:
//       checkout.session.completed  → initial grant (+ persist Stripe ids)
//       invoice.paid                → renew to the invoice's period end
//       customer.subscription.deleted → downgrade to free
//
// Everything is env-gated: with no STRIPE_* config the surfaces 503, so the
// feature ships dark until the owner sets the keys (task #12).

import type { TierName, StripeEventStore, AppPurchaseStorage, AppSalesStorage, MarketplaceStorage } from "@flagship/storage";
import { grantTier, type TierGrantDeps } from "./tierGrant.js";
import { grantAppPurchase } from "./appPurchase.js";

/** Days granted on the initial checkout, before the first invoice.paid pins the
 *  real subscription period. A hair over a month so a slightly-late first
 *  invoice webhook never lapses a brand-new subscriber. */
const INITIAL_GRANT_DAYS = 33;

export interface StripeConfig {
  /** `whsec_…` — verifies inbound webhooks. Absent ⇒ webhook 503s. */
  webhookSecret?: string;
  /** `sk_…` — authorizes outbound Checkout-session creation. Absent ⇒ checkout 503s. */
  secretKey?: string;
  /** Stripe price ids that map to each paid tier. */
  priceHobby?: string;
  priceMaker?: string;
  /** Where Stripe returns the buyer after pay / cancel. */
  successUrl?: string;
  cancelUrl?: string;
}

export interface StripeDeps extends TierGrantDeps {
  stripeEvents: StripeEventStore;
  config: StripeConfig;
  /** Paid-app stores (#14). Present ⇒ the webhook handles app-purchase
   *  checkouts + /api/stripe/app-checkout works. Absent ⇒ subscription-only. */
  purchases?: AppPurchaseStorage;
  marketplace?: MarketplaceStorage;
  /** Payout ledger (#15). Present ⇒ a completed paid checkout also writes an
   *  app_sales row (gross/cut/net). */
  sales?: AppSalesStorage;
  /** Platform cut in bps for the sale split (default DEFAULT_MARKETPLACE_CUT_BPS). */
  cutBps?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface StripeHttpResult {
  status: number;
  body: unknown;
}

// ── signature verification ────────────────────────────────────────────

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse a `Stripe-Signature` header into its `t` (unix seconds) + every `v1`. */
function parseSignatureHeader(header: string): { t?: number; v1: string[] } {
  const v1: string[] = [];
  let t: number | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  return { t, v1 };
}

/** Verify a Stripe webhook signature (the same scheme as `stripe.webhooks.
 *  constructEvent`): HMAC-SHA256 over `${t}.${payload}`, matched against any
 *  `v1` in the header, within `toleranceSec` of `now`. */
export async function verifyStripeSignature(opts: {
  payload: string;
  header: string;
  secret: string;
  now: number;
  toleranceSec?: number;
}): Promise<boolean> {
  const { t, v1 } = parseSignatureHeader(opts.header);
  if (t === undefined || !Number.isFinite(t) || v1.length === 0) return false;
  const tolerance = opts.toleranceSec ?? 300;
  if (Math.abs(Math.floor(opts.now / 1000) - t) > tolerance) return false;
  const expected = await hmacSha256Hex(opts.secret, `${t}.${opts.payload}`);
  return v1.some((sig) => constantTimeEqualHex(sig, expected));
}

// ── price ↔ tier ─────────────────────────────────────────────────────

export function tierForPrice(config: StripeConfig, priceId: string | undefined): TierName | undefined {
  if (!priceId) return undefined;
  if (config.priceHobby && priceId === config.priceHobby) return "hobby";
  if (config.priceMaker && priceId === config.priceMaker) return "maker";
  return undefined;
}

function priceForTier(config: StripeConfig, tier: TierName): string | undefined {
  if (tier === "hobby") return config.priceHobby;
  if (tier === "maker") return config.priceMaker;
  return undefined;
}

// ── event attribution helpers ────────────────────────────────────────

function nowMs(deps: StripeDeps): number {
  return deps.now ? deps.now() : Date.now();
}

const USERNAME_RE = /^[a-z0-9]{3,30}$/;

/** Best-effort dig of the username out of an event object's various metadata
 *  slots (we stamp it into session + subscription metadata at checkout). */
function usernameFrom(obj: any): string | undefined {
  const candidates = [
    obj?.client_reference_id,
    obj?.metadata?.username,
    obj?.subscription_details?.metadata?.username,
    obj?.lines?.data?.[0]?.metadata?.username,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && USERNAME_RE.test(c.toLowerCase())) return c.toLowerCase();
  }
  return undefined;
}

function tierFromObject(deps: StripeDeps, obj: any): TierName | undefined {
  const metaTier = obj?.metadata?.tier ?? obj?.subscription_details?.metadata?.tier;
  if (metaTier === "hobby" || metaTier === "maker") return metaTier;
  // Fall back to the line-item price id (present on invoices).
  return tierForPrice(deps.config, obj?.lines?.data?.[0]?.price?.id);
}

// ── webhook ──────────────────────────────────────────────────────────

/** `POST /api/stripe/webhook` — Stripe → us. `rawBody` MUST be the exact bytes
 *  Stripe signed (no re-serialization). Returns 200 to ACK (so Stripe stops
 *  retrying) on success AND on a duplicate; 400 on a bad signature; 503 when
 *  unconfigured. */
export async function handleStripeWebhook(
  deps: StripeDeps,
  opts: { rawBody: string; signature: string | null },
): Promise<StripeHttpResult> {
  const secret = deps.config.webhookSecret;
  if (!secret) return { status: 503, body: { error: "stripe not configured" } };
  if (!opts.signature) return { status: 400, body: { error: "missing signature" } };

  const ok = await verifyStripeSignature({
    payload: opts.rawBody,
    header: opts.signature,
    secret,
    now: nowMs(deps),
  });
  if (!ok) return { status: 400, body: { error: "invalid signature" } };

  let event: any;
  try {
    event = JSON.parse(opts.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }
  const eventId = event?.id;
  const eventType = event?.type;
  if (typeof eventId !== "string" || typeof eventType !== "string") {
    return { status: 400, body: { error: "malformed event" } };
  }

  // Idempotency: only the first delivery of this event id proceeds.
  const claimed = await deps.stripeEvents.claim(eventId, eventType, nowMs(deps));
  if (!claimed) return { status: 200, body: { ok: true, idempotent: true } };

  try {
    const handled = await applyEvent(deps, eventType, event?.data?.object, eventId);
    return { status: 200, body: { ok: true, ...handled } };
  } catch (e) {
    // We've already claimed the event id; a thrown handler means a genuine
    // problem (e.g. couldn't attribute a username). Surface 200 so Stripe
    // doesn't hammer a retry we'll never satisfy — the audit row remains.
    return { status: 200, body: { ok: true, ignored: (e as Error).message } };
  }
}

async function applyEvent(
  deps: StripeDeps,
  type: string,
  obj: any,
  eventId: string,
): Promise<{ action: string; username?: string; tier?: TierName }> {
  if (type === "checkout.session.completed") {
    // An app purchase (mode=payment) is tagged kind="app" in metadata.
    if (obj?.metadata?.kind === "app") {
      if (!deps.purchases || !deps.marketplace) throw new Error("app purchases not configured");
      const username = usernameFrom(obj);
      const creator = String(obj?.metadata?.creator ?? "").toLowerCase();
      const slug = String(obj?.metadata?.slug ?? "").toLowerCase();
      if (!username || !creator || !slug) throw new Error("app checkout missing username/creator/slug metadata");
      const res = await grantAppPurchase(
        {
          purchases: deps.purchases,
          marketplace: deps.marketplace,
          ...(deps.sales ? { sales: deps.sales } : {}),
          ...(deps.cutBps !== undefined ? { cutBps: deps.cutBps } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
        {
          username,
          creator,
          slug,
          source: "stripe",
          ref: typeof obj?.id === "string" ? obj.id : undefined,
          // Key the payout on the stripe EVENT id (stable across the
          // session-id churn) so a redelivery can't double-count.
          stripeEventId: eventId,
        },
      );
      return { action: res.granted ? "purchased" : "already-owned", username };
    }
    const username = usernameFrom(obj);
    const tier = tierFromObject(deps, obj);
    if (!username || !tier) throw new Error("checkout missing username/tier metadata");
    await grantTier(deps, {
      username,
      tier,
      durationDays: INITIAL_GRANT_DAYS,
      ...(typeof obj?.customer === "string" ? { stripeCustomerId: obj.customer } : {}),
      ...(typeof obj?.subscription === "string" ? { stripeSubscriptionId: obj.subscription } : {}),
    });
    return { action: "granted", username, tier };
  }

  if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
    const username = usernameFrom(obj);
    const tier = tierFromObject(deps, obj);
    if (!username || !tier) throw new Error("invoice missing username/tier metadata");
    // Pin the entitlement to the invoice's authoritative period end (unix s → ms).
    const periodEndSec = obj?.lines?.data?.[0]?.period?.end;
    const absolutePeriodEnd =
      typeof periodEndSec === "number" && Number.isFinite(periodEndSec) ? periodEndSec * 1000 : undefined;
    await grantTier(deps, {
      username,
      tier,
      durationDays: INITIAL_GRANT_DAYS,
      ...(absolutePeriodEnd !== undefined ? { absolutePeriodEnd } : {}),
      ...(typeof obj?.customer === "string" ? { stripeCustomerId: obj.customer } : {}),
      ...(typeof obj?.subscription === "string" ? { stripeSubscriptionId: obj.subscription } : {}),
    });
    return { action: "renewed", username, tier };
  }

  if (type === "customer.subscription.deleted") {
    const username = usernameFrom(obj);
    if (!username) throw new Error("subscription.deleted missing username metadata");
    await grantTier(deps, { username, tier: "free", durationDays: 0 });
    return { action: "downgraded", username, tier: "free" };
  }

  return { action: "ignored" };
}

// ── checkout-session creation ────────────────────────────────────────

/** Create a Stripe-hosted Checkout session for `username` on `tier`. Returns
 *  the redirect URL. Server-side (uses the secret key); the username + tier are
 *  stamped into the session AND subscription metadata so the webhook can
 *  attribute every later invoice back to the account. */
export async function createCheckoutSession(
  deps: StripeDeps,
  args: { username: string; tier: TierName },
): Promise<{ url: string }> {
  const { config } = deps;
  if (!config.secretKey) throw new Error("stripe checkout not configured");
  if (!config.successUrl || !config.cancelUrl) throw new Error("stripe redirect urls not configured");
  const username = String(args.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error("invalid username");
  if (args.tier !== "hobby" && args.tier !== "maker") throw new Error("tier must be hobby or maker");
  const price = priceForTier(config, args.tier);
  if (!price) throw new Error(`no Stripe price configured for tier ${args.tier}`);

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", price);
  form.set("line_items[0][quantity]", "1");
  form.set("client_reference_id", username);
  form.set("metadata[username]", username);
  form.set("metadata[tier]", args.tier);
  form.set("subscription_data[metadata][username]", username);
  form.set("subscription_data[metadata][tier]", args.tier);
  form.set("success_url", config.successUrl);
  form.set("cancel_url", config.cancelUrl);

  const doFetch = deps.fetch ?? fetch;
  const resp = await doFetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `stripe error ${resp.status}`);
  if (typeof json?.url !== "string") throw new Error("stripe returned no checkout url");
  return { url: json.url };
}

// ── app-purchase checkout (#14) ──────────────────────────────────────

/** Create a Stripe-hosted Checkout session to BUY a paid marketplace app
 *  (mode=payment, one-time). Prices inline from the listing's priceUsdCents
 *  (no per-app Stripe Price object needed — apps are curated). Stamps
 *  kind=app + username + creator + slug so the webhook grants the purchase. */
export async function createAppCheckoutSession(
  deps: StripeDeps,
  args: { username: string; creator: string; slug: string },
): Promise<{ url: string }> {
  const { config } = deps;
  if (!config.secretKey) throw new Error("stripe checkout not configured");
  if (!config.successUrl || !config.cancelUrl) throw new Error("stripe redirect urls not configured");
  if (!deps.marketplace) throw new Error("marketplace not configured");
  const username = String(args.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error("invalid username");
  const creator = String(args.creator ?? "").trim().toLowerCase();
  const slug = String(args.slug ?? "").trim().toLowerCase();
  if (!creator || !slug) throw new Error("creator and slug are required");

  const listing = await deps.marketplace.get(creator, slug);
  if (!listing || listing.status !== "listed") throw new Error("listing not found");
  const cents = listing.priceUsdCents ?? 0;
  if (cents <= 0) throw new Error("this app is free — no purchase needed");

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(Math.floor(cents)));
  form.set("line_items[0][price_data][product_data][name]", `${listing.name} (${creator}/${slug})`);
  form.set("line_items[0][quantity]", "1");
  form.set("client_reference_id", username);
  form.set("metadata[kind]", "app");
  form.set("metadata[username]", username);
  form.set("metadata[creator]", creator);
  form.set("metadata[slug]", slug);
  // Propagate to the PaymentIntent too, so a charge-level event can attribute.
  form.set("payment_intent_data[metadata][kind]", "app");
  form.set("payment_intent_data[metadata][username]", username);
  form.set("payment_intent_data[metadata][creator]", creator);
  form.set("payment_intent_data[metadata][slug]", slug);
  form.set("success_url", config.successUrl);
  form.set("cancel_url", config.cancelUrl);

  const doFetch = deps.fetch ?? fetch;
  const resp = await doFetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error?.message || `stripe error ${resp.status}`);
  if (typeof json?.url !== "string") throw new Error("stripe returned no checkout url");
  return { url: json.url };
}

/** `POST /api/stripe/app-checkout` — PUBLIC. Body `{ username, creator, slug }`.
 *  Returns the hosted Checkout URL to buy the app. */
export async function handleCreateAppCheckout(deps: StripeDeps, body: unknown): Promise<StripeHttpResult> {
  const b = (body ?? {}) as { username?: unknown; creator?: unknown; slug?: unknown };
  if (typeof b.username !== "string" || typeof b.creator !== "string" || typeof b.slug !== "string") {
    return { status: 400, body: { error: "username, creator and slug are required" } };
  }
  if (!deps.config.secretKey) return { status: 503, body: { error: "card checkout not available" } };
  try {
    const { url } = await createAppCheckoutSession(deps, { username: b.username, creator: b.creator, slug: b.slug });
    return { status: 200, body: { ok: true, url } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}

/** `POST /api/stripe/checkout` — PUBLIC. Body `{ username, tier }`. Returns the
 *  hosted Checkout URL to redirect to. */
export async function handleCreateCheckout(deps: StripeDeps, body: unknown): Promise<StripeHttpResult> {
  const b = (body ?? {}) as { username?: unknown; tier?: unknown };
  if (typeof b.username !== "string" || typeof b.tier !== "string") {
    return { status: 400, body: { error: "username and tier are required" } };
  }
  if (!deps.config.secretKey) return { status: 503, body: { error: "card checkout not available" } };
  try {
    const { url } = await createCheckoutSession(deps, { username: b.username, tier: b.tier as TierName });
    return { status: 200, body: { ok: true, url } };
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } };
  }
}
