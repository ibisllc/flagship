import { describe, expect, it } from "vitest";
import type { TierStorage, TierSubscriptionRecord, StripeEventStore } from "@flagship/storage";
import {
  verifyStripeSignature,
  tierForPrice,
  handleStripeWebhook,
  createCheckoutSession,
  handleCreateCheckout,
  type StripeConfig,
  type StripeDeps,
} from "../src/stripe.js";

const NOW = Date.UTC(2026, 5, 14); // 2026-06-14
const DAY = 24 * 60 * 60 * 1000;

function fakeTiers(): TierStorage & { rec?: TierSubscriptionRecord } {
  let rec: TierSubscriptionRecord | undefined;
  return {
    async get() {
      return rec;
    },
    async put(r) {
      rec = r;
    },
    get rec() {
      return rec;
    },
  } as TierStorage & { rec?: TierSubscriptionRecord };
}

function fakeEvents(): StripeEventStore & { seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    async claim(id) {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
  };
}

const CONFIG: StripeConfig = {
  webhookSecret: "whsec_test",
  secretKey: "sk_test",
  priceHobby: "price_hobby",
  priceMaker: "price_maker",
  successUrl: "https://flagshipserver.com/pro?ok=1",
  cancelUrl: "https://flagshipserver.com/pro",
};

function deps(config: StripeConfig = CONFIG, fetchImpl?: typeof fetch): StripeDeps & {
  tiers: ReturnType<typeof fakeTiers>;
  stripeEvents: ReturnType<typeof fakeEvents>;
} {
  return {
    tiers: fakeTiers(),
    stripeEvents: fakeEvents(),
    config,
    now: () => NOW,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

/** Build a valid Stripe-Signature header for `payload` at second `t`. */
async function signed(payload: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

describe("verifyStripeSignature", () => {
  const t = Math.floor(NOW / 1000);
  it("accepts a correctly signed payload within tolerance", async () => {
    const payload = '{"hello":"world"}';
    const header = await signed(payload, "whsec_test", t);
    expect(await verifyStripeSignature({ payload, header, secret: "whsec_test", now: NOW })).toBe(true);
  });
  it("rejects a tampered payload", async () => {
    const header = await signed('{"a":1}', "whsec_test", t);
    expect(await verifyStripeSignature({ payload: '{"a":2}', header, secret: "whsec_test", now: NOW })).toBe(false);
  });
  it("rejects the wrong secret", async () => {
    const payload = "x";
    const header = await signed(payload, "whsec_other", t);
    expect(await verifyStripeSignature({ payload, header, secret: "whsec_test", now: NOW })).toBe(false);
  });
  it("rejects an out-of-tolerance timestamp (replay)", async () => {
    const payload = "x";
    const old = t - 10_000;
    const header = await signed(payload, "whsec_test", old);
    expect(await verifyStripeSignature({ payload, header, secret: "whsec_test", now: NOW })).toBe(false);
  });
  it("rejects a header with no v1", async () => {
    expect(await verifyStripeSignature({ payload: "x", header: `t=${t}`, secret: "whsec_test", now: NOW })).toBe(false);
  });
});

describe("tierForPrice", () => {
  it("maps configured price ids to tiers, undefined otherwise", () => {
    expect(tierForPrice(CONFIG, "price_hobby")).toBe("hobby");
    expect(tierForPrice(CONFIG, "price_maker")).toBe("maker");
    expect(tierForPrice(CONFIG, "price_unknown")).toBeUndefined();
    expect(tierForPrice(CONFIG, undefined)).toBeUndefined();
  });
});

async function postEvent(d: StripeDeps, event: unknown) {
  const rawBody = JSON.stringify(event);
  const t = Math.floor(NOW / 1000);
  const signature = await signed(rawBody, "whsec_test", t);
  return handleStripeWebhook(d, { rawBody, signature });
}

describe("handleStripeWebhook", () => {
  it("503s when unconfigured, 400 on missing/invalid signature", async () => {
    const noSecret = deps({ ...CONFIG, webhookSecret: undefined });
    expect((await handleStripeWebhook(noSecret, { rawBody: "{}", signature: "t=1,v1=00" })).status).toBe(503);

    const d = deps();
    expect((await handleStripeWebhook(d, { rawBody: "{}", signature: null })).status).toBe(400);
    expect((await handleStripeWebhook(d, { rawBody: "{}", signature: "t=1,v1=deadbeef" })).status).toBe(400);
  });

  it("checkout.session.completed grants the tier + persists Stripe ids", async () => {
    const d = deps();
    const res = await postEvent(d, {
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "alice",
          metadata: { username: "alice", tier: "hobby" },
          customer: "cus_1",
          subscription: "sub_1",
        },
      },
    });
    expect(res.status).toBe(200);
    expect(d.tiers.rec).toMatchObject({
      username: "alice",
      tier: "hobby",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
    expect(d.tiers.rec!.currentPeriodEnd).toBeGreaterThan(NOW);
  });

  it("is idempotent — a redelivered event id does not re-grant", async () => {
    const d = deps();
    const event = {
      id: "evt_dup",
      type: "checkout.session.completed",
      data: { object: { metadata: { username: "bob", tier: "hobby" } } },
    };
    await postEvent(d, event);
    const firstEnd = d.tiers.rec!.currentPeriodEnd;
    const again = await postEvent(d, event);
    expect((again.body as { idempotent?: boolean }).idempotent).toBe(true);
    expect(d.tiers.rec!.currentPeriodEnd).toBe(firstEnd); // unchanged
  });

  it("invoice.paid pins the period to the invoice's authoritative end", async () => {
    const d = deps();
    const periodEndSec = Math.floor((NOW + 30 * DAY) / 1000);
    await postEvent(d, {
      id: "evt_inv",
      type: "invoice.paid",
      data: {
        object: {
          customer: "cus_9",
          subscription: "sub_9",
          subscription_details: { metadata: { username: "carol", tier: "maker" } },
          lines: { data: [{ price: { id: "price_maker" }, period: { end: periodEndSec } }] },
        },
      },
    });
    expect(d.tiers.rec).toMatchObject({ username: "carol", tier: "maker" });
    expect(d.tiers.rec!.currentPeriodEnd).toBe(periodEndSec * 1000);
  });

  it("customer.subscription.deleted downgrades to free", async () => {
    const d = deps();
    // Seed an active paid sub first.
    await d.tiers.put({ username: "dave", tier: "hobby", currentPeriodEnd: NOW + 10 * DAY, updatedAt: NOW });
    await postEvent(d, {
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: { metadata: { username: "dave" } } },
    });
    expect(d.tiers.rec).toMatchObject({ username: "dave", tier: "free" });
    expect(d.tiers.rec!.currentPeriodEnd).toBeUndefined();
  });

  it("an unattributable event is ACKed (200) but grants nothing", async () => {
    const d = deps();
    const res = await postEvent(d, {
      id: "evt_bad",
      type: "checkout.session.completed",
      data: { object: { metadata: {} } },
    });
    expect(res.status).toBe(200);
    expect((res.body as { ignored?: string }).ignored).toBeTruthy();
    expect(d.tiers.rec).toBeUndefined();
  });

  it("ignores unrelated event types", async () => {
    const d = deps();
    const res = await postEvent(d, { id: "evt_x", type: "charge.refunded", data: { object: {} } });
    expect(res.status).toBe(200);
    expect((res.body as { action?: string }).action).toBe("ignored");
  });
});

describe("createCheckoutSession", () => {
  it("posts a subscription session with username/tier metadata and returns the url", async () => {
    let captured: { url: string; init: any } | undefined;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/sess_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = deps(CONFIG, fetchImpl);
    const { url } = await createCheckoutSession(d, { username: "Alice", tier: "hobby" });
    expect(url).toBe("https://checkout.stripe.com/c/sess_1");
    expect(captured!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(captured!.init.headers.authorization).toBe("Bearer sk_test");
    const body = captured!.init.body as string;
    expect(body).toContain("line_items%5B0%5D%5Bprice%5D=price_hobby");
    expect(body).toContain("client_reference_id=alice");
    expect(body).toContain("subscription_data%5Bmetadata%5D%5Busername%5D=alice");
    expect(body).toContain("metadata%5Btier%5D=hobby");
  });

  it("throws on an unconfigured price / missing key", async () => {
    await expect(
      createCheckoutSession(deps({ ...CONFIG, secretKey: undefined }), { username: "a1c", tier: "hobby" }),
    ).rejects.toThrow(/not configured/);
    await expect(
      createCheckoutSession(deps({ ...CONFIG, priceHobby: undefined }), { username: "a1c", tier: "hobby" }),
    ).rejects.toThrow(/no Stripe price/);
  });

  it("handleCreateCheckout: 400 on bad input, 503 when no key, 200 with url", async () => {
    expect((await handleCreateCheckout(deps(), {})).status).toBe(400);
    expect((await handleCreateCheckout(deps({ ...CONFIG, secretKey: undefined }), { username: "alice", tier: "hobby" })).status).toBe(503);

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/x" }), { status: 200 })) as unknown as typeof fetch;
    const res = await handleCreateCheckout(deps(CONFIG, fetchImpl), { username: "alice", tier: "maker" });
    expect(res.status).toBe(200);
    expect((res.body as { url: string }).url).toContain("checkout.stripe.com");
  });
});
