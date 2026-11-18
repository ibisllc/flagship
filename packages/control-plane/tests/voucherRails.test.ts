// The voucher rails (docs/payments-privacy-and-rails.md §11): Stripe Checkout, Apple's signed transactions and the
// Play Developer API each prove a payment, and `.com` signs exactly the units bought, once per payment, keeping only
// a hash of the payment id. Apple fixtures: tests/fixtures/apple-iap (a test root, an intermediate with Apple's WWDR
// marker and a P-256 leaf with the App Store marker, made with openssl from ext.cnf; the leaf key signs test JWS).
import { createHmac, generateKeyPairSync, createPrivateKey, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENTS_CONFIG,
  finalizeVoucher,
  newVoucherRequest,
  verifyVoucher,
  voucherOrderCommit,
  voucherPaymentHash,
  type PaymentsConfig,
} from "@flagship/protocol";
import { InMemoryVoucherPaymentStorage } from "@flagship/storage";
import { handlePaymentsConfig, voucherSigningKeysFromEnv } from "../src/blindVouchers.js";
import { APPLE_ROOT_CA_G3_SHA256, verifyAppleSignedJws } from "../src/appleJws.js";
import { clearGoogleTokenCache, googlePlayApi, googleServiceAccountFromEnv, type GooglePlayApi, type PlayProductPurchase } from "../src/googlePlay.js";
import {
  appleRailFromEnv,
  handleAppleNotification,
  handlePaidIssue,
  handleStripeVoucherCheckout,
  handleStripeVoucherWebhook,
  isVoucherStripeEvent,
  railsSummary,
  stripeRailFromEnv,
  type VoucherRailsDeps,
} from "../src/voucherRails.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => readFileSync(join(here, "fixtures/apple-iap", f), "utf8").replace(/\s+/g, "");
const keyFile = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: keyFile.jwk }]));
const key = keys[0]!.pub;
const cfg: PaymentsConfig = DEFAULT_PAYMENTS_CONFIG;
const NOW = Date.UTC(2027, 0, 10, 12);

const sha256Hex = async (b: Uint8Array) => Buffer.from(await webcrypto.subtle.digest("SHA-256", b)).toString("hex");
const TEST_ROOT = await sha256Hex(Buffer.from(fx("root.der.b64"), "base64"));
const leafKey = await webcrypto.subtle.importKey(
  "pkcs8",
  createPrivateKey(readFileSync(join(here, "fixtures/apple-iap/leaf.pk8.pem"))).export({ type: "pkcs8", format: "der" }),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

async function appleJws(payload: object, opts: { leaf?: string; chain?: string[] } = {}): Promise<string> {
  const x5c = opts.chain ?? [fx(opts.leaf ?? "leaf.der.b64"), fx("mid.der.b64"), fx("root.der.b64")];
  const h = b64url(JSON.stringify({ alg: "ES256", x5c }));
  const p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, leafKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const appleTxn = (over: Record<string, unknown> = {}) => ({
  transactionId: "2000000812345678",
  originalTransactionId: "2000000812345678",
  bundleId: "com.flagshipserver.app",
  productId: "com.flagshipserver.app.vouchers.10",
  type: "Consumable",
  quantity: 1,
  environment: "Production",
  purchaseDate: NOW - 60_000,
  signedDate: NOW - 50_000,
  ...over,
});

function requests(n: number) {
  return Array.from({ length: n }, () => newVoucherRequest(key));
}

function baseDeps(over: Partial<VoucherRailsDeps> = {}): VoucherRailsDeps & { payments: InMemoryVoucherPaymentStorage } {
  return {
    keys,
    config: cfg,
    payments: new InMemoryVoucherPaymentStorage(),
    apple: { bundleId: "com.flagshipserver.app", environments: ["Production"], rootFingerprints: [TEST_ROOT] },
    now: () => NOW,
    ...over,
  } as VoucherRailsDeps & { payments: InMemoryVoucherPaymentStorage };
}

const issue = (d: VoucherRailsDeps, rail: string, proof: object, blinded: string[]) => handlePaidIssue(d, { v: 1, rail, proof, k: key.keyId, blinded });

describe("Apple's signed transaction", () => {
  it("verifies a chain to the pinned root and reads the payload", async () => {
    const t = await verifyAppleSignedJws(await appleJws(appleTxn()), { now: NOW, rootFingerprints: [TEST_ROOT] });
    expect(t?.transactionId).toBe("2000000812345678");
  });
  it("pins Apple Root CA - G3 by default, so a test chain fails", async () => {
    expect(APPLE_ROOT_CA_G3_SHA256).toBe("63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179");
    expect(await verifyAppleSignedJws(await appleJws(appleTxn()), { now: NOW })).toBeNull();
  });
  it("refuses a leaf without the App Store marker, a tampered payload, an expired chain and a short chain", async () => {
    const o = { now: NOW, rootFingerprints: [TEST_ROOT] };
    expect(await verifyAppleSignedJws(await appleJws(appleTxn(), { leaf: "leaf-nomarker.der.b64" }), o)).toBeNull();
    const [h, , s] = (await appleJws(appleTxn())).split(".");
    expect(await verifyAppleSignedJws(`${h}.${b64url(JSON.stringify(appleTxn({ productId: "com.flagshipserver.app.vouchers.120" })))}.${s}`, o)).toBeNull();
    expect(await verifyAppleSignedJws(await appleJws(appleTxn()), { ...o, now: Date.UTC(2040, 0, 1) })).toBeNull();
    expect(await verifyAppleSignedJws(await appleJws(appleTxn(), { chain: [fx("leaf.der.b64"), fx("root.der.b64")] }), o)).toBeNull();
    expect(await verifyAppleSignedJws("not.a.jws", o)).toBeNull();
  });
});

describe("paid issue: Apple", () => {
  it("signs the units bought, once per transaction, and keeps only a hash", async () => {
    const d = baseDeps();
    const reqs = requests(10);
    const jws = await appleJws(appleTxn());
    const r = await issue(d, "apple", { jws }, reqs.map((q) => q.blinded));
    expect(r.status).toBe(200);
    const body = r.body as { sigs: string[]; units: number; k: string };
    expect(body.units).toBe(10);
    const vouchers = reqs.map((q, i) => finalizeVoucher(key, q.pending, body.sigs[i]!));
    expect(vouchers.every((v) => verifyVoucher(key, v))).toBe(true);
    const rows = [...d.payments.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paymentHash: voucherPaymentHash("apple", "2000000812345678"), rail: "apple", units: 10, state: "signed", day: "2027-01-10" });
    expect(JSON.stringify(rows)).not.toContain("2000000812345678");

    // A retry with the same set gets the same signatures; another set is refused.
    const again = await issue(d, "apple", { jws }, reqs.map((q) => q.blinded));
    expect((again.body as { sigs: string[] }).sigs).toEqual(body.sigs);
    const other = await issue(d, "apple", { jws }, requests(10).map((q) => q.blinded));
    expect(other.status).toBe(409);
    expect((other.body as { code: string }).code).toBe("payment-used");
  });

  it("multiplies by the store quantity and insists on the exact count", async () => {
    const d = baseDeps();
    const jws = await appleJws(appleTxn({ quantity: 3, productId: "com.flagshipserver.app.vouchers.30", transactionId: "2000000899" }));
    const short = await issue(d, "apple", { jws }, requests(30).map((q) => q.blinded));
    expect(short.status).toBe(409);
    expect(short.body).toMatchObject({ code: "wrong-count", units: 90 });
    expect(d.payments.rows.size).toBe(0);
    expect((await issue(d, "apple", { jws }, requests(90).map((q) => q.blinded))).status).toBe(200);
  });

  it("refuses another app, a non-consumable, an unknown product, the sandbox in production and a revoked purchase", async () => {
    const d = baseDeps();
    const b = requests(10).map((q) => q.blinded);
    for (const over of [{ bundleId: "com.example.other" }, { type: "Non-Consumable" }, { productId: "com.flagshipserver.app.vouchers.11" }, { environment: "Sandbox" }]) {
      const r = await issue(d, "apple", { jws: await appleJws(appleTxn(over)) }, b);
      expect((r.body as { code: string }).code).toBe("payment-invalid");
    }
    const revoked = await issue(d, "apple", { jws: await appleJws(appleTxn({ revocationDate: NOW - 1000 })) }, b);
    expect(revoked.status).toBe(409);
    expect((revoked.body as { code: string }).code).toBe("payment-refunded");
    expect([...d.payments.rows.values()][0]?.state).toBe("refunded");
    // The gym takes the sandbox.
    const gym = baseDeps({ apple: { bundleId: "com.flagshipserver.app", environments: ["Sandbox"], rootFingerprints: [TEST_ROOT] } });
    expect((await issue(gym, "apple", { jws: await appleJws(appleTxn({ environment: "Sandbox" })) }, b)).status).toBe(200);
  });

  it("refuses when the rail is off, an unknown key, junk and too many", async () => {
    const d = baseDeps({ apple: undefined });
    const b = requests(10).map((q) => q.blinded);
    expect((await issue(d, "apple", { jws: "x" }, b)).body).toMatchObject({ code: "rail-off" });
    expect((await handlePaidIssue(baseDeps(), { v: 1, rail: "apple", proof: { jws: "x" }, k: "0000000000000000", blinded: b })).body).toMatchObject({ code: "no-key" });
    expect((await handlePaidIssue(baseDeps(), { v: 1, rail: "paypal", proof: {}, k: key.keyId, blinded: b })).body).toMatchObject({ code: "malformed" });
    expect((await handlePaidIssue(baseDeps(), { v: 1, rail: "apple", proof: {}, k: key.keyId, blinded: [b[0], b[0]] })).body).toMatchObject({ code: "malformed" });
    expect((await handlePaidIssue(baseDeps(), { v: 1, rail: "apple", proof: {}, k: key.keyId, blinded: Array(201).fill("AAAA") })).body).toMatchObject({ code: "too-many" });
  });

  it("a REFUND notification marks the payment so it is never signed for", async () => {
    const d = baseDeps();
    const signedTransactionInfo = await appleJws(appleTxn({ transactionId: "2000000777" }));
    const note = await appleJws({ notificationType: "REFUND", data: { bundleId: "com.flagshipserver.app", signedTransactionInfo } });
    expect((await handleAppleNotification(d, { signedPayload: note })).status).toBe(200);
    expect(d.payments.rows.get(voucherPaymentHash("apple", "2000000777"))?.state).toBe("refunded");
    const r = await issue(d, "apple", { jws: signedTransactionInfo }, requests(10).map((q) => q.blinded));
    expect((r.body as { code: string }).code).toBe("payment-refunded");
    expect((await handleAppleNotification(d, { signedPayload: "junk" })).status).toBe(400);
    const test = await appleJws({ notificationType: "TEST", data: { bundleId: "com.flagshipserver.app" } });
    expect((await handleAppleNotification(d, { signedPayload: test })).body).toMatchObject({ action: "ignored" });
  });

  it("reads its environments from env", () => {
    expect(appleRailFromEnv({})).toBeUndefined();
    expect(appleRailFromEnv({ APPLE_IAP_ENVIRONMENTS: "Sandbox, Production" })).toEqual({ bundleId: "com.flagshipserver.app", environments: ["Sandbox", "Production"] });
    expect(appleRailFromEnv({ APPLE_IAP_ENVIRONMENTS: "Xcode" })).toBeUndefined();
  });
});

describe("paid issue: Google", () => {
  const TOKEN = "opaque-token-abcdefghijklmnop.AO-J1Oz";
  function fakeApi(p: PlayProductPurchase | null | "throw") {
    const acks: string[] = [];
    const api: GooglePlayApi = {
      async getProductPurchase() {
        if (p === "throw") throw new Error("down");
        return p;
      },
      async acknowledge(_id, tok) {
        acks.push(tok);
      },
    };
    return { api, acks };
  }
  const gdeps = (p: PlayProductPurchase | null | "throw", allowTest = false) => {
    const f = fakeApi(p);
    return { d: baseDeps({ google: { packageName: "com.flagshipserver.app", allowTest, api: f.api } }), acks: f.acks };
  };
  const proof = { productId: "com.flagshipserver.app.vouchers.30", purchaseToken: TOKEN };

  it("signs a purchased product and acknowledges it", async () => {
    const { d, acks } = gdeps({ purchaseState: 0, consumptionState: 0, quantity: 1, orderId: "GPA.1234" });
    const r = await issue(d, "google", proof, requests(30).map((q) => q.blinded));
    expect(r.status).toBe(200);
    expect(acks).toEqual([TOKEN]);
    expect(d.payments.rows.get(voucherPaymentHash("google", TOKEN))?.units).toBe(30);
  });

  it("waits for a pending purchase, refuses a cancelled one, test purchases in production and obfuscated ids", async () => {
    const b = requests(30).map((q) => q.blinded);
    expect((await issue(gdeps({ purchaseState: 2 }).d, "google", proof, b)).body).toMatchObject({ code: "payment-unpaid" });
    expect((await issue(gdeps({ purchaseState: 1 }).d, "google", proof, b)).body).toMatchObject({ code: "payment-refunded" });
    expect((await issue(gdeps({ purchaseState: 0, purchaseType: 0 }).d, "google", proof, b)).body).toMatchObject({ code: "payment-invalid" });
    expect((await issue(gdeps({ purchaseState: 0, purchaseType: 0 }, true).d, "google", proof, b)).status).toBe(200);
    expect((await issue(gdeps({ purchaseState: 0, obfuscatedExternalAccountId: "x" }).d, "google", proof, b)).body).toMatchObject({ code: "payment-invalid" });
    expect((await issue(gdeps(null).d, "google", proof, b)).body).toMatchObject({ code: "payment-invalid" });
    expect((await issue(gdeps("throw").d, "google", proof, b)).body).toMatchObject({ code: "rail-unreachable" });
    expect((await issue(gdeps({ purchaseState: 0 }).d, "google", { ...proof, productId: "other" }, b)).body).toMatchObject({ code: "payment-invalid" });
  });

  it("the API client signs a service-account assertion and reads the purchase", async () => {
    clearGoogleTokenCache();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = googleServiceAccountFromEnv(
      JSON.stringify({ client_email: "rail@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.example/token" }),
    )!;
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://oauth2.example/token") {
        const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        const [h, c, s] = assertion.split(".");
        const ok = await webcrypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          await webcrypto.subtle.importKey("spki", publicKey.export({ type: "spki", format: "der" }), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
          Buffer.from(s!, "base64url"),
          new TextEncoder().encode(`${h}.${c}`),
        );
        expect(ok).toBe(true);
        expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ scope: "https://www.googleapis.com/auth/androidpublisher", aud: "https://oauth2.example/token" });
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3599 }));
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ya29.test");
      if (url.endsWith(":acknowledge")) return new Response("{}");
      return new Response(JSON.stringify({ purchaseState: 0, quantity: 1 }));
    }) as typeof fetch;
    const api = googlePlayApi({ account: sa, packageName: "com.flagshipserver.app", fetch: f, now: () => NOW });
    expect(await api.getProductPurchase("com.flagshipserver.app.vouchers.10", TOKEN)).toEqual({ purchaseState: 0, quantity: 1 });
    await api.acknowledge("com.flagshipserver.app.vouchers.10", TOKEN);
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    expect(calls[1]!.url).toBe(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.flagshipserver.app/purchases/products/com.flagshipserver.app.vouchers.10/tokens/${encodeURIComponent(TOKEN)}`,
    );
  });
});

describe("Stripe", () => {
  const SECRET = "whsec_test_secret";
  let calls: { url: string; init?: RequestInit }[];
  let session: Record<string, unknown>;
  let reqs: ReturnType<typeof requests>;
  const stripeDeps = () =>
    baseDeps({
      stripe: {
        ...stripeRailFromEnv({ STRIPE_SECRET_KEY: "rk_test_123", CONTROL_APEX: "gym.flagshipserver.com" })!,
        fetch: (async (url: string, init?: RequestInit) => {
          calls.push({ url, init });
          if (init?.method === "POST") return new Response(JSON.stringify({ id: "cs_test_abcdefgh123", url: "https://checkout.stripe.com/c/pay/cs_test_abcdefgh123" }));
          if (url.includes("payment_intent=")) return new Response(JSON.stringify({ data: [{ id: "cs_test_abcdefgh123", metadata: { flagship_kind: "vouchers" } }] }));
          if (url.endsWith("cs_test_missing00")) return new Response("{}", { status: 404 });
          return new Response(JSON.stringify(session));
        }) as typeof fetch,
      },
    });
  beforeEach(() => {
    calls = [];
    reqs = requests(30);
    session = {
      id: "cs_test_abcdefgh123",
      livemode: false,
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      currency: "usd",
      amount_subtotal: 3000,
      amount_total: 3000,
      metadata: { flagship_kind: "vouchers", flagship_units: "30", flagship_key: key.keyId, flagship_commit: voucherOrderCommit(key.keyId, reqs.map((q) => q.blinded)) },
    };
  });

  it("creates a Checkout Session that names the pack and the commitment, and nobody", async () => {
    const d = stripeDeps();
    const commit = voucherOrderCommit(key.keyId, reqs.map((q) => q.blinded));
    const r = await handleStripeVoucherCheckout(d, { v: 1, units: 30, k: key.keyId, commit });
    expect(r.body).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_abcdefgh123", sessionId: "cs_test_abcdefgh123" });
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(form.get("mode")).toBe("payment");
    expect(form.get("automatic_tax[enabled]")).toBe("true");
    expect(form.get("line_items[0][quantity]")).toBe("30");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("100");
    expect(form.get("line_items[0][price_data][tax_behavior]")).toBe("inclusive");
    expect(form.get("metadata[flagship_commit]")).toBe(commit);
    expect(form.get("success_url")).toBe("https://webapp.gym.flagshipserver.com/?shop=stripe&session_id={CHECKOUT_SESSION_ID}");
    expect([...form.keys()].some((k) => /username|client_reference_id|customer_email/.test(k))).toBe(false);
    expect((calls[0]!.init!.headers as Record<string, string>)["idempotency-key"]).toBe(`flagship-vouchers-${commit}`);
    expect((await handleStripeVoucherCheckout(d, { v: 1, units: 7, k: key.keyId, commit })).body).toMatchObject({ code: "malformed" });
    expect((await handleStripeVoucherCheckout(baseDeps(), { v: 1, units: 30, k: key.keyId, commit })).body).toMatchObject({ code: "rail-off" });
  });

  it("signs for a paid session whose commitment matches", async () => {
    const d = stripeDeps();
    const r = await issue(d, "stripe", { sessionId: "cs_test_abcdefgh123" }, reqs.map((q) => q.blinded));
    expect(r.status).toBe(200);
    expect((r.body as { units: number }).units).toBe(30);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_abcdefgh123");
  });

  it("refuses another set (a leaked session id is useless), an unpaid session, live/test mixups and a wrong amount", async () => {
    const d = stripeDeps();
    expect((await issue(d, "stripe", { sessionId: "cs_test_abcdefgh123" }, requests(30).map((q) => q.blinded))).body).toMatchObject({ code: "payment-invalid" });
    const b = reqs.map((q) => q.blinded);
    session.payment_status = "unpaid";
    expect((await issue(d, "stripe", { sessionId: "cs_test_abcdefgh123" }, b)).body).toMatchObject({ code: "payment-unpaid" });
    session.payment_status = "paid";
    session.livemode = true;
    expect((await issue(d, "stripe", { sessionId: "cs_test_abcdefgh123" }, b)).body).toMatchObject({ code: "payment-invalid" });
    session.livemode = false;
    session.amount_subtotal = 100;
    expect((await issue(d, "stripe", { sessionId: "cs_test_abcdefgh123" }, b)).body).toMatchObject({ code: "payment-invalid" });
    expect((await issue(d, "stripe", { sessionId: "cs_test_missing00" }, b)).body).toMatchObject({ code: "payment-invalid" });
    expect((await issue(d, "stripe", { sessionId: "pi_nope" }, b)).body).toMatchObject({ code: "malformed" });
  });

  it("a refund or dispute marks the payment, and only signed webhooks count", async () => {
    const d = { ...stripeDeps(), webhookSecret: SECRET };
    const sign = (body: string) => {
      const t = Math.floor(NOW / 1000);
      return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
    };
    const ev = JSON.stringify({ id: "evt_1", type: "charge.dispute.created", data: { object: { payment_intent: "pi_abcdefgh1234" } } });
    expect(isVoucherStripeEvent(JSON.parse(ev))).toBe(true);
    expect((await handleStripeVoucherWebhook(d, { rawBody: ev, signature: "t=1,v1=00" })).status).toBe(400);
    expect((await handleStripeVoucherWebhook(d, { rawBody: ev, signature: sign(ev) })).body).toMatchObject({ action: "refunded" });
    expect(d.payments.rows.get(voucherPaymentHash("stripe", "cs_test_abcdefgh123"))?.state).toBe("refunded");
    const r = await issue(d, "stripe", { sessionId: "cs_test_abcdefgh123" }, reqs.map((q) => q.blinded));
    expect((r.body as { code: string }).code).toBe("payment-refunded");
    const partial = JSON.stringify({ id: "evt_2", type: "charge.refunded", data: { object: { payment_intent: "pi_abcdefgh1234", refunded: false, amount_refunded: 0 } } });
    expect((await handleStripeVoucherWebhook(d, { rawBody: partial, signature: sign(partial) })).body).toMatchObject({ action: "ignored" });
    expect(isVoucherStripeEvent({ type: "checkout.session.completed", data: { object: { metadata: { flagship_kind: "vouchers" } } } })).toBe(true);
    expect(isVoucherStripeEvent({ type: "checkout.session.completed", data: { object: { metadata: { kind: "app" } } } })).toBe(false);
  });

  it("prices include tax (a $10 pack charges $10), with one tax code, a statement suffix and a pinned API version", async () => {
    const env = stripeRailFromEnv({ STRIPE_SECRET_KEY: "rk_test_123" })!;
    expect(env.taxBehavior).toBe("inclusive");
    expect(env.taxCode).toBe("txcd_10000000");
    expect(stripeRailFromEnv({ STRIPE_SECRET_KEY: "rk_test_123", STRIPE_TAX_CODE: "nope" })!.taxCode).toBe("txcd_10000000");
    const d = stripeDeps();
    const commit = voucherOrderCommit(key.keyId, reqs.map((q) => q.blinded));
    await handleStripeVoucherCheckout(d, { v: 1, units: 10, k: key.keyId, commit });
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("100");
    expect(form.get("line_items[0][quantity]")).toBe("10");
    expect(form.get("line_items[0][price_data][tax_behavior]")).toBe("inclusive");
    expect(form.get("line_items[0][price_data][product_data][tax_code]")).toBe("txcd_10000000");
    expect(form.get("automatic_tax[enabled]")).toBe("true");
    expect(form.get("payment_intent_data[statement_descriptor_suffix]")).toBe("FLAGSHIP");
    // Cards, wallets and the Dashboard's other instant methods stay on for packs; only batches are cards only.
    expect(form.get("payment_method_types[0]")).toBeNull();
    expect((calls[0]!.init!.headers as Record<string, string>)["stripe-version"]).toBe("2025-03-31.basil");
    // A paid inclusive-tax session: the tax sits inside the $30 (total_details), so subtotal = total = units × $1.
    session.total_details = { amount_discount: 0, amount_shipping: 0, amount_tax: 248 };
    session.automatic_tax = { enabled: true, liability: null, provider: "stripe", status: "complete" };
    const r = await issue(d, "stripe", { sessionId: "cs_test_abcdefgh123" }, reqs.map((q) => q.blinded));
    expect(r.status).toBe(200);
    expect((calls.at(-1)!.init!.headers as Record<string, string>)["stripe-version"]).toBe("2025-03-31.basil");
  });

  it("reads 2025-03-31.basil snapshot events: a full refund, a partial refund and a dispute", async () => {
    const d = { ...stripeDeps(), webhookSecret: SECRET };
    const sign = (body: string) => {
      const t = Math.floor(NOW / 1000);
      return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
    };
    const charge = (over: Record<string, unknown>) => ({
      id: "ch_3QxYzAbCdEfGh1230",
      object: "charge",
      amount: 3000,
      amount_captured: 3000,
      amount_refunded: 0,
      balance_transaction: "txn_3QxYzAbCdEfGh1230",
      billing_details: { address: { city: null, country: "US", line1: null, line2: null, postal_code: "78701", state: null }, email: null, name: null, phone: null, tax_id: null },
      captured: true,
      created: Math.floor(NOW / 1000) - 3600,
      currency: "usd",
      customer: null,
      disputed: false,
      livemode: false,
      metadata: { flagship_kind: "vouchers" },
      outcome: { network_status: "approved_by_network", reason: null, risk_level: "normal", seller_message: "Payment complete.", type: "authorized" },
      paid: true,
      payment_intent: "pi_3QxYzAbCdEfGh1230",
      payment_method: "pm_1QxYzAbCdEfGh1230",
      payment_method_details: { card: { brand: "visa", last4: "4242" }, type: "card" },
      refunded: false,
      refunds: { object: "list", data: [], has_more: false, total_count: 0, url: "/v1/charges/ch_3QxYzAbCdEfGh1230/refunds" },
      statement_descriptor_suffix: "FLAGSHIP",
      status: "succeeded",
      ...over,
    });
    const event = (type: string, object: object, previous?: object) =>
      JSON.stringify({
        id: "evt_3QxYzAbCdEfGh1230",
        object: "event",
        api_version: "2025-03-31.basil",
        created: Math.floor(NOW / 1000),
        data: { object, ...(previous ? { previous_attributes: previous } : {}) },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type,
      });

    const partial = event("charge.refunded", charge({ amount_refunded: 1000 }), { amount_refunded: 0 });
    expect((await handleStripeVoucherWebhook(d, { rawBody: partial, signature: sign(partial) })).body).toMatchObject({ action: "refunded" });
    expect(calls.at(-1)!.url).toBe("https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_3QxYzAbCdEfGh1230&limit=1");
    expect((calls.at(-1)!.init!.headers as Record<string, string>)["stripe-version"]).toBe("2025-03-31.basil");
    expect(d.payments.rows.get(voucherPaymentHash("stripe", "cs_test_abcdefgh123"))?.state).toBe("refunded");

    const full = event("charge.refunded", charge({ amount_refunded: 3000, refunded: true }), { amount_refunded: 0, refunded: false });
    expect((await handleStripeVoucherWebhook(d, { rawBody: full, signature: sign(full) })).body).toMatchObject({ action: "refunded" });

    const dispute = event("charge.dispute.created", {
      id: "du_1QxYzAbCdEfGh1230",
      object: "dispute",
      amount: 3000,
      balance_transactions: [],
      charge: "ch_3QxYzAbCdEfGh1230",
      created: Math.floor(NOW / 1000),
      currency: "usd",
      enhanced_eligibility_types: [],
      evidence_details: { due_by: Math.floor(NOW / 1000) + 7 * 86400, has_evidence: false, past_due: false, submission_count: 0 },
      is_charge_refundable: true,
      livemode: false,
      metadata: {},
      payment_intent: "pi_3QxYzAbCdEfGh1230",
      payment_method_details: { card: { brand: "visa", case_type: "chargeback", network_reason_code: "10.4" }, type: "card" },
      reason: "fraudulent",
      status: "needs_response",
    });
    expect((await handleStripeVoucherWebhook(d, { rawBody: dispute, signature: sign(dispute) })).body).toMatchObject({ action: "refunded" });

    // A charge outside Checkout (no PaymentIntent) and an untouched charge are ignored.
    const noPi = event("charge.refunded", charge({ payment_intent: null, refunded: true, amount_refunded: 3000 }));
    expect((await handleStripeVoucherWebhook(d, { rawBody: noPi, signature: sign(noPi) })).body).toMatchObject({ action: "ignored" });
    const none = event("charge.refunded", charge({}));
    expect((await handleStripeVoucherWebhook(d, { rawBody: none, signature: sign(none) })).body).toMatchObject({ action: "ignored" });
  });

  it("reads live or test from the key and refuses anything else", () => {
    expect(stripeRailFromEnv({})).toBeUndefined();
    expect(stripeRailFromEnv({ STRIPE_SECRET_KEY: "pk_live_x" })).toBeUndefined();
    expect(stripeRailFromEnv({ STRIPE_SECRET_KEY: "rk_live_x" })?.livemode).toBe(true);
    expect(stripeRailFromEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_TAX_BEHAVIOR: "exclusive" })?.taxBehavior).toBe("exclusive");
  });
});

describe("payments config", () => {
  it("names the rails that sell and a product id per pack", () => {
    const d = baseDeps({ google: undefined, stripe: undefined });
    const r = handlePaymentsConfig({ config: cfg, keys, testIssue: false, rails: railsSummary(d), now: () => NOW });
    expect(r.body).toMatchObject({
      rails: { stripe: false, apple: true, google: false },
      products: [
        { units: 10, productId: "com.flagshipserver.app.vouchers.10" },
        { units: 30, productId: "com.flagshipserver.app.vouchers.30" },
        { units: 120, productId: "com.flagshipserver.app.vouchers.120" },
      ],
    });
  });
});
