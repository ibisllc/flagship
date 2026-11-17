// The $1 voucher and the voucher wallet in the webapp (apps/web/public/webapp/lib/vouchers.js) against
// packages/protocol/test-vectors/vouchers/vectors.json: byte for byte with the TypeScript reference.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as W from "../public/webapp/lib/vouchers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors/vouchers/vectors.json"), "utf8"));
const h = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

describe("webapp vouchers: shared vectors", () => {
  it("checks the key id against the numbers", () => {
    expect(W.voucherKeyId(V.key.nHex, V.key.eHex)).toBe(V.key.keyId);
    expect(W.rsaFromVoucherKey(V.key)).not.toBeNull();
    expect(W.rsaFromVoucherKey({ ...V.key, keyId: "0".repeat(16) })).toBeNull();
  });

  it("blinds and unblinds byte for byte", () => {
    for (const c of V.blind) {
      const req = W.newVoucherRequest(V.key, { nonce: h(c.nonceHex), prefix: h(c.prefixHex), salt: h(c.saltHex), r: BigInt("0x" + c.rHex) });
      expect(req.blinded).toBe(c.blinded);
      expect(req.pending.inv).toBe(c.invHex);
      const v = W.finalizeVoucher(V.key, req.pending, c.blindSig);
      expect(v).toEqual(c.voucher);
      expect(Buffer.from(W.voucherPrepared(v)).toString("hex")).toBe(c.preparedHex);
      expect(Buffer.from(W.voucherMessage(h(c.nonceHex))).toString("hex")).toBe(c.messageHex);
      expect(W.voucherNullifier(v)).toBe(c.nullifier);
      expect(W.verifyVoucher(V.key, v)).toBe(true);
    }
  });

  it("refuses tampered vouchers and a wrong blind signature", () => {
    for (const b of V.bad) expect(W.parseVoucher(b.voucher) === null || !W.verifyVoucher(V.key, b.voucher), b.why).toBe(true);
    const c = V.blind[0];
    const req = W.newVoucherRequest(V.key, { nonce: h(c.nonceHex), prefix: h(c.prefixHex) });
    expect(() => W.finalizeVoucher(V.key, req.pending, V.blind[1].blindSig)).toThrow();
  });

  it("seals, opens and merges the wallet as the reference", () => {
    const w = V.wallet;
    const key = W.deriveVoucherWalletKey({ seed: h(w.umkSeedHex) });
    expect(Buffer.from(key).toString("hex")).toBe(w.keyHex);
    expect(W.voucherWalletPlaintext(w.wallet)).toBe(w.plaintext);
    expect(W.sealVoucherWallet(key, w.version, w.wallet, h(w.nonceHex))).toEqual(w.sealed);
    expect(W.openVoucherWallet(key, w.sealed)).toEqual(W.normalizeVoucherWallet(w.wallet));
    expect(W.openVoucherWallet(key, { ...w.sealed, version: w.version + 1 })).toBeNull();
    expect(W.mergeVoucherWallets(V.merge.local, V.merge.remote)).toEqual(V.merge.merged);
    expect(W.mergeVoucherWallets(V.merge.remote, V.merge.local)).toEqual(V.merge.merged);
  });

  it("runs the trickle, the overage rule, the plan lead and the defaults", () => {
    for (const c of V.trickle) expect(W.trickleStep(c.input, c.rand), c.name).toEqual(c.out);
    for (const c of V.overage) expect(W.overageStep(c.input), c.name).toBe(c.out);
    for (const c of V.planAhead) expect(W.planAheadMs(W.DEFAULT_PAYMENTS_CONFIG, c.plan, c.paid, c.now), c.name).toBe(c.out);
    expect(W.DEFAULT_PAYMENTS_CONFIG).toEqual(V.defaultConfig);
    expect({ pro: W.planUnitMs(W.DEFAULT_PAYMENTS_CONFIG, "pro"), "pro-max": W.planUnitMs(W.DEFAULT_PAYMENTS_CONFIG, "pro-max") }).toEqual(V.unitMs);
  });
});

describe("webapp vouchers: wallet operations", () => {
  it("never resurrects a spent voucher and keeps bad config fields at their default", () => {
    let w = W.addVouchers(W.emptyVoucherWallet(10), V.blind.map((c: { voucher: unknown }) => c.voucher));
    const [first] = W.takeVouchers(w, 1);
    w = W.markVouchersSpent(w, [W.voucherNullifier(first)]);
    expect(W.addVouchers(w, [first]).vouchers).toHaveLength(2);
    const c = W.mergePaymentsConfig({ plans: { pro: { unitsPerMonth: 12 } }, packs: [30, 10], maxAheadDays: -4 });
    expect(c.plans.pro.unitsPerMonth).toBe(12);
    expect(c.packs).toEqual([10, 30]);
    expect(c.maxAheadDays).toBe(35);
    const r = W.cryptoRand();
    expect(r >= 0 && r < 1).toBe(true);
  });
});
