/**
 * The voucher rails through the Worker's routes on a real D1 schema (migration 0153): the config names the rails
 * that are on, a Stripe checkout and its paid issue round-trip, the used-payment row holds no account, and a signed
 * Stripe dispute webhook reaches the voucher handler (docs/payments-privacy-and-rails.md §11).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import { finalizeVoucher, newVoucherRequest, verifyVoucher, voucherOrderCommit } from "@flagship/protocol";
import { voucherSigningKeysFromEnv } from "@flagship/control-plane";

const ORIGIN = "https://flagshipserver.com";
const here = dirname(fileURLToPath(import.meta.url));
const jwk = JSON.parse(readFileSync(join(here, "../../../packages/protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8")).jwk;
const key = voucherSigningKeysFromEnv(JSON.stringify([{ jwk }]))[0]!.pub;

afterEach(() => vi.unstubAllGlobals());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("voucher rails routes", () => {
  it("config says which rails sell; paid issue refuses an off rail", async () => {
    const sqlite = createSqliteD1();
    try {
      const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, VOUCHER_SIGNING_KEYS: JSON.stringify([{ jwk }]), APPLE_IAP_ENVIRONMENTS: "Sandbox" };
      const cfg = (await (await tryControlPlane(new Request(`${ORIGIN}/api/payments/config`), env))!.json()) as Record<string, unknown>;
      expect(cfg.rails).toEqual({ stripe: false, apple: true, google: false });
      expect(cfg.products).toEqual([
        { units: 10, productId: "com.flagshipserver.app.vouchers.10" },
        { units: 30, productId: "com.flagshipserver.app.vouchers.30" },
        { units: 120, productId: "com.flagshipserver.app.vouchers.120" },
      ]);
      const reqs = Array.from({ length: 10 }, () => newVoucherRequest(key));
      const r = await tryControlPlane(post("/api/vouchers/paid-issue", { v: 1, rail: "google", proof: {}, k: key.keyId, blinded: reqs.map((q) => q.blinded) }), env);
      expect(r!.status).toBe(404);
      expect(await r!.json()).toMatchObject({ code: "rail-off" });
    } finally {
      sqlite.close();
    }
  });

  it("Stripe: checkout, paid issue, a row without an account, and a dispute through the shared webhook", async () => {
    const sqlite = createSqliteD1();
    try {
      const env: ControlPlaneEnv = {
        DB: sqlite as unknown as D1Database,
        VOUCHER_SIGNING_KEYS: JSON.stringify([{ jwk }]),
        STRIPE_SECRET_KEY: "rk_test_routes",
        STRIPE_WEBHOOK_SECRET: "whsec_routes",
      };
      const reqs = Array.from({ length: 10 }, () => newVoucherRequest(key));
      const blinded = reqs.map((q) => q.blinded);
      const commit = voucherOrderCommit(key.keyId, blinded);
      const sid = "cs_test_routes12345";
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ id: sid, url: `https://checkout.stripe.com/c/pay/${sid}` }));
        if (url.includes("payment_intent=")) return new Response(JSON.stringify({ data: [{ id: sid, metadata: { flagship_kind: "vouchers" } }] }));
        return new Response(
          JSON.stringify({
            id: sid,
            livemode: false,
            mode: "payment",
            status: "complete",
            payment_status: "paid",
            currency: "usd",
            amount_subtotal: 1000,
            metadata: { flagship_kind: "vouchers", flagship_units: "10", flagship_key: key.keyId, flagship_commit: commit },
          }),
        );
      });
      const co = await tryControlPlane(post("/api/vouchers/stripe/checkout", { v: 1, units: 10, k: key.keyId, commit }), env);
      expect(await co!.json()).toEqual({ url: `https://checkout.stripe.com/c/pay/${sid}`, sessionId: sid });

      const r = await tryControlPlane(post("/api/vouchers/paid-issue", { v: 1, rail: "stripe", proof: { sessionId: sid }, k: key.keyId, blinded }), env);
      expect(r!.status).toBe(200);
      const { sigs } = (await r!.json()) as { sigs: string[] };
      expect(reqs.every((q, i) => verifyVoucher(key, finalizeVoucher(key, q.pending, sigs[i]!)))).toBe(true);

      const rows = sqlite.raw.prepare("SELECT * FROM voucher_payments").all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(["blinded_hash", "day", "key_id", "payment_hash", "rail", "state", "units"]);
      expect(JSON.stringify(rows)).not.toContain(sid);

      const ev = JSON.stringify({ id: "evt_r", type: "charge.dispute.created", data: { object: { payment_intent: "pi_routes123456" } } });
      const t = Math.floor(Date.now() / 1000);
      const sig = `t=${t},v1=${createHmac("sha256", "whsec_routes").update(`${t}.${ev}`).digest("hex")}`;
      const wh = await tryControlPlane(post("/api/stripe/webhook", ev, { "stripe-signature": sig }), env);
      expect(await wh!.json()).toMatchObject({ action: "refunded" });
      expect((sqlite.raw.prepare("SELECT state FROM voucher_payments").get() as { state: string }).state).toBe("refunded");
    } finally {
      sqlite.close();
    }
  });
});
