// The org's Business plan in the webapp (lib/orgPlan.js, views/orgPlan.js; docs/plans-and-backup-offer.md "As built"):
// the shared org-plan vectors through the bundled protocol (vendor/flagship-org), then an org admin's browser against
// the real `.com` handlers in process: the first `wallet` key ring, an empty wallet, voucher files in, the org trickle
// paying for seats, voucher files out for staff, a company's invoiced batch, and an exchange after a key rotation.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { finalizeVoucher, newVoucherRequest, orgKemKeyPair, deriveOrgSeatKemSeed, signOrgSeatKem, type Voucher } from "@flagship/protocol";
import { InMemoryBlindVoucherStorage, InMemoryMeterStorage, InMemoryOrgStorage, InMemoryStorage, InMemoryTierStorage, InMemoryVoucherPaymentStorage } from "@flagship/storage";
import { handleOrgAuthorityAppend, handleOrgAuthorityGet, handleOrgCeremonies, handleOrgCreate, handleOrgSeatsGet } from "../../../packages/control-plane/src/orgs.js";
import { handleOrgKeyRingPost, handleOrgKeysGet, handleOrgSeatKem, handleOrgServersList, type OrgServerDeps } from "../../../packages/control-plane/src/orgServers.js";
import { handleOrgPlanGet, handleOrgWalletGet, handleOrgWalletPut } from "../../../packages/control-plane/src/orgPlan.js";
import { handlePaymentsConfig, handleVoucherExchange, handleVoucherIssue, handleVoucherRedeem, voucherSigningKeysFromEnv } from "../../../packages/control-plane/src/blindVouchers.js";
import { handleBatchIssue, handleStripeBatchCheckout, stripeRailFromEnv } from "../../../packages/control-plane/src/voucherRails.js";
import { DEFAULT_PAYMENTS_CONFIG } from "@flagship/protocol";
import { DATABASES, makeIndexedDBShim, makeLocalStorage } from "./support/idbShim";

/* eslint-disable @typescript-eslint/no-explicit-any */
const here = (p: string) => resolve(__dirname, p);
const P = JSON.parse(readFileSync(here("../../../packages/protocol/test-vectors/org-plan/vectors.json"), "utf8"));
const V = JSON.parse(readFileSync(here("../../../packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const refs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(refs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
};
const chain = refs(V.chains[0]);
const ORG = V.orgId as string;
const NOW = chain.entries[1].record.issuedAt + 3_600_000;
const UMK = new Uint8Array(32).fill(0x42);
const A = V.keys["A founder"];
const aSeeds = Uint8Array.from(Buffer.from(A.edSeedHex + A.mldsaSeedHex, "hex"));
const cfg = DEFAULT_PAYMENTS_CONFIG;
const jwk = JSON.parse(readFileSync(here("../../../packages/protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8")).jwk;
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk }]));
const vkey = keys[0]!.pub;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

let org: any, op: any, kc: any, mw: any, view: any;

function mint(n: number): Voucher[] {
  const reqs = Array.from({ length: n }, () => newVoucherRequest(vkey));
  const r = handleVoucherIssue({ keys, config: cfg }, { k: vkey.keyId, blinded: reqs.map((q) => q.blinded) });
  return reqs.map((q, i) => finalizeVoucher(vkey, q.pending, (r.body as any).sigs[i]));
}

describe("org plan vectors through the bundled protocol", () => {
  beforeAll(async () => {
    org = await import("../public/webapp/vendor/flagship-org/org.js");
  });
  it("state, spends, trickle, wallet, batch and voucher files", () => {
    expect(org.DEFAULT_PAYMENTS_CONFIG).toEqual(P.config);
    for (const c of P.state) expect(org.orgPlanState(P.config, c.terms, c.now)).toEqual(c.out);
    for (const c of P.spend) expect(org.orgPaidUntilAfterSpend(P.config, c.terms, c.seats, c.n, c.now)).toBe(c.out);
    for (const c of P.trickle) expect(org.orgTrickleStep(P.config, c.input, c.rand)).toEqual(c.out);
    const w = P.wallet;
    const key = org.deriveOrgWalletKey(unhex(w.ringKeyHex), w.orgId);
    expect(hex(key)).toBe(w.keyHex);
    expect(org.sealOrgVoucherWallet(key, w.orgId, w.keyVersion, w.version, w.wallet, unhex(w.nonceHex))).toEqual(w.sealed);
    expect(new TextDecoder().decode(org.canonicalOrgWalletWrite(w.write))).toBe(w.writeCanonical);
    expect(org.mergeOrgVoucherWallets(P.merge.local, P.merge.remote)).toEqual(P.merge.merged);
    expect(new TextDecoder().decode(org.canonicalOrgPlanAttestation(P.attestation.body))).toBe(P.attestation.canonical);
    expect(org.batchRequests(P.key, unhex(P.batch.seedHex), P.batch.units).commit).toBe(P.batch.commit);
    expect(org.voucherFileText(P.batch.vouchers)).toBe(P.voucherFile.text);
    expect(org.splitVoucherFiles(P.batch.vouchers, 2)).toEqual(P.voucherFile.split2);
  });
});

describe("the org's Plan in the webapp", () => {
  beforeAll(async () => {
    mw = await import("../public/webapp/lib/mldsaWasm.js");
    mw.setMldsaWasmBytesForTests(new Uint8Array(readFileSync(here("../public/webapp/vendor/mldsa-wasm/mldsa65.wasm"))));
    org = await import("../public/webapp/vendor/flagship-org/org.js");
    op = await import("../public/webapp/lib/orgPlan.js");
    kc = await import("../public/webapp/lib/keyCustody.js");
    view = await import("../public/webapp/views/orgPlan.js");
  });
  beforeEach(() => {
    DATABASES.clear();
    (globalThis as any).indexedDB = makeIndexedDBShim();
    (globalThis as any).localStorage = makeLocalStorage();
  });
  afterEach(() => kc.setCustodyAuthenticatorForTests(null));

  async function world(opts: { bank?: boolean } = {}) {
    const clock = { now: NOW };
    const store = new InMemoryOrgStorage();
    const base = new InMemoryStorage();
    const d: OrgServerDeps = { orgs: store, usernames: base.usernames, servers: base.servers, payments: cfg, now: () => clock.now } as OrgServerDeps;
    expect((await handleOrgCreate(d, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
    expect((await handleOrgAuthorityAppend(d, ORG, { entry: chain.entries[1] })).status).toBe(200);
    // A's seat announces its X-Wing key (from this browser's account key), signed with its admin key.
    const kem = orgKemKeyPair(deriveOrgSeatKemSeed(UMK, ORG));
    const st = { orgId: ORG, seatId: A.seatId, kemKeyId: kem.kemKeyId, issuedAt: NOW };
    expect((await handleOrgSeatKem(d, ORG, { statement: st, kemPubHex: hex(kem.kemPub), signature: signOrgSeatKem(st, aSeeds) })).status).toBe(200);
    const wallets = new InMemoryBlindVoucherStorage();
    const payments = new InMemoryVoucherPaymentStorage();
    const redeem = { keys, config: cfg, store: wallets, tiers: new InMemoryTierStorage(), usernames: { async get() { return undefined; } }, meter: new InMemoryMeterStorage(), orgs: d, now: () => clock.now };
    let session: any = null;
    const stripe = {
      ...stripeRailFromEnv({ STRIPE_SECRET_KEY: "rk_test_web", ...(opts.bank ? { STRIPE_BANK_TRANSFER: "1" } : {}) })!,
      fetch: (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.endsWith("/v1/customers")) return new Response(JSON.stringify({ id: "cus_WebBatch0001" }));
        if (init?.method === "POST") {
          const form = new URLSearchParams(String(init.body));
          const bank = form.get("payment_method_types[0]") === "customer_balance";
          session = { id: "cs_test_webbatch01", livemode: false, mode: "payment", status: "complete", payment_status: bank ? "unpaid" : "paid", currency: "usd", amount_subtotal: Number(form.get("line_items[0][quantity]")) * 100, metadata: { flagship_kind: "voucher-batch", flagship_units: form.get("metadata[flagship_units]"), flagship_key: form.get("metadata[flagship_key]"), flagship_commit: form.get("metadata[flagship_commit]") } };
          if (bank) Object.assign(session, { payment_method_types: ["customer_balance"], payment_intent: "pi_WebBatch0001", pi: { id: "pi_WebBatch0001", status: "requires_action", amount: session.amount_subtotal, amount_received: 0 } });
          return new Response(JSON.stringify({ id: session.id, url: "https://checkout.stripe.com/c/pay/cs_test_webbatch01" }));
        }
        if (url.includes("/v1/payment_intents/")) return new Response(JSON.stringify(session.pi));
        return new Response(JSON.stringify(session));
      }) as typeof fetch,
    };
    const rails = { keys, config: cfg, payments, stripe, now: () => clock.now };
    const fetchImpl = async (url: string, init: any = {}) => {
      const path = new URL(url).pathname;
      const raw = init.body ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)) : undefined;
      const body = raw ? JSON.parse(raw) : undefined;
      let r: any;
      let x: RegExpMatchArray | null;
      if (path === "/api/payments/config") r = handlePaymentsConfig({ config: cfg, keys, testIssue: false, rails: { rails: { stripe: true, stripeBank: !!opts.bank, apple: false, google: false }, products: [] } });
      else if (path === "/api/vouchers/redeem") r = await handleVoucherRedeem(redeem, body);
      else if (path === "/api/vouchers/exchange") r = await handleVoucherExchange(redeem, body);
      else if (path === "/api/vouchers/stripe/batch-checkout") r = await handleStripeBatchCheckout(rails, body);
      else if (path === "/api/vouchers/batch-issue") r = await handleBatchIssue(rails, body);
      else if ((x = path.match(/^\/api\/orgs\/([0-9a-f]+)\/(authority|seats|ceremonies|keys|servers|plan|voucher-wallet)$/))) {
        const sub = x[2];
        if (sub === "authority") r = await handleOrgAuthorityGet(d, ORG);
        else if (sub === "seats") r = await handleOrgSeatsGet(d, ORG);
        else if (sub === "ceremonies") r = await handleOrgCeremonies(d, ORG);
        else if (sub === "keys") r = init.method === "POST" ? await handleOrgKeyRingPost(d, ORG, body) : await handleOrgKeysGet(d, ORG);
        else if (sub === "servers") r = await handleOrgServersList(d, ORG);
        else if (sub === "plan") r = await handleOrgPlanGet(d, ORG);
        else r = init.method === "PUT" ? await handleOrgWalletPut({ ...d, wallets }, ORG, raw!) : await handleOrgWalletGet({ ...d, wallets }, ORG);
      } else throw new Error(`unrouted ${path}`);
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    const deps = { fetch: fetchImpl, apex: "https://flagshipserver.com", now: () => clock.now, store: globalThis.localStorage, rand: () => 0.5, ohttp: null };
    // A's seat admin key in this browser's custody, as a browser-custody admin seat holds it.
    const fake = { create: async ({ salt }: any) => ({ credentialId: "a", prf: new Uint8Array(await crypto.subtle.digest("SHA-256", salt)) }), get: async ({ salt }: any) => ({ prf: new Uint8Array(await crypto.subtle.digest("SHA-256", salt)) }) };
    kc.setCustodyAuthenticatorForTests(fake);
    const { activeProfileId } = await import("../public/webapp/keystore.js");
    await kc.sealUnderPasskey({ recordKey: `flagship.orgSeatAdmin.v1.${activeProfileId()}.${ORG}.${A.seatId}`, label: "org-seat-admin", plain: aSeeds.slice(), umk: UMK });
    const seat = { orgId: ORG, seatId: A.seatId, genesisHash: V.genesisHash, adminBinding: A.binding };
    const os = await import("../public/webapp/lib/orgSeat.js");
    const snap = await os.orgSnapshot(os.orgApi(deps), ORG, V.genesisHash, NOW);
    return { clock, d, seat, snap, deps, wallets, session: () => session };
  }

  it("makes the wallet key, imports voucher files, pays seats by the trickle and saves staff files", async () => {
    const w = await world();
    const plan0 = await op.loadOrgPlan(ORG, w.deps);
    expect(plan0).toMatchObject({ status: "trial", seatLimit: 10 });
    expect(view.orgPlanStatusText(plan0, NOW)).toContain("30");

    const keysA = await op.walletKeys(w.seat, w.snap, { umk: UMK, create: true, now: NOW, deps: w.deps });
    expect(keysA.newest).toBe(1);
    expect(keysA.keys.map((k: any) => k.version)).toEqual([1]);
    const empty = await op.openOrgWallet(w.seat, cfg, keysA, w.deps);
    expect(empty).toMatchObject({ version: 0, wallet: { vouchers: [], settings: { seats: 3 } } });

    const file = org.voucherFileText(mint(20));
    await expect(op.importVoucherFiles(w.seat, w.snap, cfg, keysA, [{ name: "x.json", text: "{}" }], { umk: UMK, now: NOW, deps: w.deps })).rejects.toMatchObject({ code: "voucher-file-bad" });
    const imported = await op.importVoucherFiles(w.seat, w.snap, cfg, keysA, [{ name: "a.json", text: file }], { umk: UMK, now: NOW, deps: w.deps });
    expect(imported.added).toBe(20);
    expect(op.orgBalance(cfg, imported.wallet.wallet)).toEqual({ vouchers: 20, months: 1, seats: 3 });

    // Ten days before the trial ends the trickle schedules a spend; once due, it pays one voucher for the seats.
    w.clock.now = plan0.trialEndsAt - 5 * 86_400_000;
    const plan1 = await op.loadOrgPlan(ORG, w.deps);
    const t1 = await op.orgSpendTick(w.seat, w.snap, { umk: UMK, plan: plan1, cfg, keys: keysA, deps: w.deps });
    expect(t1.spent).toBe(0);
    w.clock.now += 3 * 86_400_000;
    const t2 = await op.orgSpendTick(w.seat, w.snap, { umk: UMK, plan: plan1, cfg, keys: keysA, deps: w.deps });
    expect(t2.spent).toBe(1);
    expect(t2.wallet.wallet.vouchers).toHaveLength(19);
    expect(await op.loadOrgPlan(ORG, w.deps)).toMatchObject({ paidSeats: 3 });

    const files = op.voucherFilesOf(t2.wallet.wallet.vouchers.slice(0, 10), 4);
    expect(files.map((f: any) => org.parseVoucherFile(f.text).length)).toEqual([4, 4, 2]);
    expect(files[0].name).toMatch(/^flagship-vouchers-1-[0-9a-f]{8}\.json$/);
  });

  it("buys an invoiced batch and finishes it from the batch key file", async () => {
    const w = await world();
    const r = await op.buyBatch(100, w.deps);
    expect(r.url).toMatch(/^https:\/\/checkout\.stripe\.com/);
    const key = org.parseVoucherBatchKey(r.keyFile.text);
    expect(key).toMatchObject({ units: 100, session: "cs_test_webbatch01" });
    await expect(op.buyBatch(99, w.deps)).rejects.toMatchObject({ code: "batch-size" });
    // Another browser: only the key file.
    (globalThis as any).localStorage = makeLocalStorage();
    expect(op.pendingBatches()).toEqual([]);
    op.addBatchKey(r.keyFile.text);
    const vouchers = await op.finishBatch(op.pendingBatches()[0], w.deps);
    expect(vouchers).toHaveLength(100);
    expect(vouchers.every((v: Voucher) => org.verifyVoucher(vkey, v))).toBe(true);
    op.forgetBatch(key.session);
    expect(op.pendingBatches()).toEqual([]);
  });

  it("pays a batch by bank transfer: unpaid until the whole transfer arrives, then the same vouchers as a card batch", async () => {
    const off = await world();
    await expect(op.buyBatch(100, { ...off.deps, method: "bank" })).rejects.toMatchObject({ code: "bank-off" });
    const w = await world({ bank: true });
    const r = await op.buyBatch(100, { ...w.deps, method: "bank" });
    expect(org.parseVoucherBatchKey(r.keyFile.text)).toMatchObject({ units: 100, session: "cs_test_webbatch01" });
    const b = op.pendingBatches()[0];
    expect(await op.finishBatch(b, w.deps)).toBeNull();
    w.session().pi = { ...w.session().pi, amount_received: 40 * 100 };
    expect(await op.finishBatch(b, w.deps)).toBeNull();
    Object.assign(w.session(), { payment_status: "paid", pi: { ...w.session().pi, status: "succeeded", amount_received: 100 * 100 } });
    const vouchers = await op.finishBatch(b, w.deps);
    expect(vouchers).toHaveLength(100);
    expect(vouchers.every((v: Voucher) => org.verifyVoucher(vkey, v))).toBe(true);
    w.session().status = "expired";
    await expect(op.finishBatch(b, w.deps)).rejects.toMatchObject({ code: "payment-void" });
    expect(view.orgPlanErrorText({ code: "payment-void" })).toBe("That batch can no longer be paid. Start a new batch.");
    expect(view.orgPlanErrorText({ code: "bank-off" })).toBe("Bank transfer isn't available right now. Pay by card instead.");
    const src = readFileSync(here("../public/webapp/views/orgPlan.js"), "utf8");
    expect(src).toContain("${pc.rails?.stripeBank ? `<button class=\"secondary\" data-org-batch-bank>");
  });

  it("exchanges every voucher after the wallet key rotates", async () => {
    const w = await world();
    const keys1 = await op.walletKeys(w.seat, w.snap, { umk: UMK, create: true, now: NOW, deps: w.deps });
    const saved = await op.importVoucherFiles(w.seat, w.snap, cfg, keys1, [{ name: "a.json", text: org.voucherFileText(mint(5)) }], { umk: UMK, now: NOW, deps: w.deps });
    const old = saved.wallet.wallet.vouchers;
    // Pretend a newer `wallet` version exists (an admin left): the browser holds the same key under version 2.
    const keys2 = { keys: [...keys1.keys, { version: 2, key: keys1.keys[0].key }], newest: 2 };
    const out = await op.refreshAfterRotation(w.seat, w.snap, cfg, keys2, { umk: UMK, now: NOW, deps: w.deps });
    expect(out.moved).toBe(5);
    expect(out.wallet.keyVersion).toBe(2);
    const fresh = out.wallet.wallet.vouchers;
    expect(fresh.some((v: Voucher) => old.some((o: Voucher) => o.n === v.n))).toBe(false);
    expect(await w.wallets.isSpent(org.voucherNullifier(old[0]))).toBe(true);
  });

  it("with no card rail the batch button is off and the sentence says why", () => {
    const src = readFileSync(here("../public/webapp/views/orgPlan.js"), "utf8");
    expect(src).toContain('<button data-org-batch-buy ${pc.rails?.stripe ? "" : "disabled"}>');
    expect(src).toContain('${pc.rails?.stripe ? "" : `<p class="note" data-org-batch-rail-off>${escapeHtml(tr("Card payments aren\'t available right now."))}</p>`}');
    expect(view.orgPlanErrorText({ code: "rail-off" })).toBe("Card payments aren't available right now.");
  });

  it("says lapsed, trial and paid plainly", () => {
    expect(view.orgPlanStatusText({ status: "lapsed" })).toBe("Business has lapsed");
    expect(view.orgPlanStatusText({ status: "trial", trialEndsAt: NOW + 86_400_000 }, NOW)).toBe("Business, trial: 1 day left");
    expect(view.orgPlanErrorText({ code: "org-plan-lapsed" })).toContain("lapsed");
    expect(view.orgPlanErrorText({ code: "batch-size", min: 100, max: 5000 })).toBe("A batch is 100 to 5000 vouchers.");
  });
});
