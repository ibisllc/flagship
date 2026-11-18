// Invoiced voucher batches (docs/plans-and-backup-offer.md §6 and "As built"): a Stripe Checkout that collects the
// company's tax id and makes an invoice, naming only "Flagship vouchers" and the count; then the browser's whole
// blinded set is checked against the session's commitment and signed in chunks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENTS_CONFIG,
  batchRequests,
  finalizeBatchVouchers,
  verifyVoucher,
  voucherPaymentHash,
} from "@flagship/protocol";
import { InMemoryVoucherPaymentStorage } from "@flagship/storage";
import { voucherSigningKeysFromEnv } from "../src/blindVouchers.js";
import {
  BATCH_ISSUE_CHUNK,
  handleBatchIssue,
  handlePaidIssue,
  handleStripeBatchCheckout,
  handleStripeVoucherWebhook,
  isVoucherStripeEvent,
  stripeRailFromEnv,
  type VoucherRailsDeps,
} from "../src/voucherRails.js";
import { createHmac } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const keyFile = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: keyFile.jwk }]));
const key = keys[0]!.pub;
const cfg = DEFAULT_PAYMENTS_CONFIG;
const NOW = Date.UTC(2027, 0, 10, 12);
const SEED = new Uint8Array(32).fill(0x42);
const UNITS = 150;
const { blinded, commit } = batchRequests(key, SEED, UNITS);

let calls: { url: string; init?: RequestInit }[];
let session: Record<string, any>;
function deps(): VoucherRailsDeps & { payments: InMemoryVoucherPaymentStorage; webhookSecret: string } {
  return {
    keys,
    config: cfg,
    payments: new InMemoryVoucherPaymentStorage(),
    now: () => NOW,
    webhookSecret: "whsec_t",
    stripe: {
      ...stripeRailFromEnv({ STRIPE_SECRET_KEY: "rk_test_123", CONTROL_APEX: "gym.flagshipserver.com" })!,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === "POST") return new Response(JSON.stringify({ id: "cs_test_batch0001", url: "https://checkout.stripe.com/c/pay/cs_test_batch0001" }));
        if (url.includes("payment_intent=")) return new Response(JSON.stringify({ data: [{ id: "cs_test_batch0001", metadata: { flagship_kind: "voucher-batch" } }] }));
        return new Response(JSON.stringify(session));
      }) as typeof fetch,
    },
  };
}
const issue = (d: VoucherRailsDeps, from: number, set = blinded, sess = "cs_test_batch0001") => handleBatchIssue(d, { v: 1, session: sess, k: key.keyId, blinded: set, from });

beforeEach(() => {
  calls = [];
  session = {
    id: "cs_test_batch0001",
    livemode: false,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: UNITS * 100,
    metadata: { flagship_kind: "voucher-batch", flagship_units: String(UNITS), flagship_key: key.keyId, flagship_commit: commit },
  };
});

describe("invoiced batch checkout", () => {
  it("asks Stripe for an invoice and the company's tax id, and names nobody", async () => {
    const d = deps();
    const r = await handleStripeBatchCheckout(d, { v: 1, units: UNITS, k: key.keyId, commit });
    expect(r.body).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_batch0001", sessionId: "cs_test_batch0001" });
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(form.get("invoice_creation[enabled]")).toBe("true");
    expect(form.get("tax_id_collection[enabled]")).toBe("true");
    expect(form.get("billing_address_collection")).toBe("required");
    expect(form.get("customer_creation")).toBe("always");
    // Cards only: Checkout offers bank transfer only with an existing Customer (runbook: send_invoice by hand).
    expect(form.get("payment_method_types[0]")).toBe("card");
    expect([...form.keys()].some((k) => k.includes("customer_balance"))).toBe(false);
    expect(form.get("payment_intent_data[statement_descriptor_suffix]")).toBe("FLAGSHIP");
    expect(form.get("line_items[0][price_data][tax_behavior]")).toBe("inclusive");
    expect(form.get("line_items[0][price_data][product_data][tax_code]")).toBe("txcd_10000000");
    expect((calls[0]!.init!.headers as Record<string, string>)["stripe-version"]).toBe("2025-03-31.basil");
    expect(form.get("line_items[0][quantity]")).toBe(String(UNITS));
    expect(form.get("line_items[0][price_data][product_data][name]")).toBe("Flagship vouchers");
    expect(form.get("metadata[flagship_kind]")).toBe("voucher-batch");
    expect(form.get("metadata[flagship_commit]")).toBe(commit);
    expect(form.get("success_url")).toBe("https://webapp.gym.flagshipserver.com/?shop=batch&session_id={CHECKOUT_SESSION_ID}");
    expect([...form.keys()].some((k) => /username|org|seat|client_reference_id|customer_email/.test(k))).toBe(false);
    expect([...form.values()].some((v) => v.includes("acme"))).toBe(false);
  });

  it("refuses a batch under the minimum or over the maximum, and an unknown key", async () => {
    const d = deps();
    expect((await handleStripeBatchCheckout(d, { v: 1, units: 99, k: key.keyId, commit })).body).toMatchObject({ code: "malformed", min: 100 });
    expect((await handleStripeBatchCheckout(d, { v: 1, units: 5001, k: key.keyId, commit })).body).toMatchObject({ code: "malformed", max: 5000 });
    expect((await handleStripeBatchCheckout(d, { v: 1, units: UNITS, k: "0".repeat(16), commit })).body).toMatchObject({ code: "no-key" });
    expect((await handleStripeBatchCheckout({ ...d, stripe: undefined }, { v: 1, units: UNITS, k: key.keyId, commit })).body).toMatchObject({ code: "rail-off" });
  });
});

describe("batch issue", () => {
  it("signs the whole set in chunks, and the vouchers verify", async () => {
    const d = deps();
    const sigs: string[] = [];
    let from = 0;
    for (;;) {
      const r = await issue(d, from);
      expect(r.status).toBe(200);
      const b = r.body as { sigs: string[]; done: boolean; from: number };
      expect(b.from).toBe(from);
      expect(b.sigs.length).toBeLessThanOrEqual(BATCH_ISSUE_CHUNK);
      sigs.push(...b.sigs);
      from += b.sigs.length;
      if (b.done) break;
    }
    expect(sigs).toHaveLength(UNITS);
    const vouchers = finalizeBatchVouchers(key, SEED, 0, sigs);
    expect(vouchers.every((v) => verifyVoucher(key, v))).toBe(true);
    // Another computer with the same batch key gets the same signatures.
    expect(((await issue(d, 0)).body as { sigs: string[] }).sigs[0]).toBe(sigs[0]);
  });

  it("refuses another set, an unpaid session, a pack session and a wrong count", async () => {
    const d = deps();
    const other = batchRequests(key, new Uint8Array(32).fill(1), UNITS).blinded;
    expect((await issue(d, 0, other)).body).toMatchObject({ code: "payment-invalid" });
    expect((await issue(d, 0, blinded.slice(0, 120))).body).toMatchObject({ code: "wrong-count" });
    session.payment_status = "unpaid";
    expect((await issue(d, 0)).body).toMatchObject({ code: "payment-unpaid" });
    session.payment_status = "paid";
    session.metadata.flagship_kind = "vouchers";
    expect((await issue(d, 0)).body).toMatchObject({ code: "payment-invalid" });
    session.metadata.flagship_kind = "voucher-batch";
    expect((await issue(d, UNITS)).body).toMatchObject({ code: "malformed" });
    // A batch session can't be claimed as a pack through the paid issue either.
    expect((await handlePaidIssue(d, { v: 1, rail: "stripe", proof: { sessionId: "cs_test_batch0001" }, k: key.keyId, blinded: blinded.slice(0, 30) })).body).toMatchObject({ code: "payment-invalid" });
  });

  it("a refund marks the batch's payment and stops further signing", async () => {
    const d = deps();
    expect((await issue(d, 0)).status).toBe(200);
    const ev = JSON.stringify({ id: "evt_1", type: "charge.refunded", data: { object: { payment_intent: "pi_abcdefgh1234", refunded: true } } });
    const t = Math.floor(NOW / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", d.webhookSecret).update(`${t}.${ev}`).digest("hex")}`;
    expect((await handleStripeVoucherWebhook(d, { rawBody: ev, signature: sig })).body).toMatchObject({ action: "refunded" });
    expect(d.payments.rows.get(voucherPaymentHash("stripe", "cs_test_batch0001"))?.state).toBe("refunded");
    expect((await issue(d, BATCH_ISSUE_CHUNK)).body).toMatchObject({ code: "payment-refunded" });
    expect(isVoucherStripeEvent({ type: "checkout.session.completed", data: { object: { metadata: { flagship_kind: "voucher-batch" } } } })).toBe(true);
  });
});
