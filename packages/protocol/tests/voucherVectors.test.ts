import { constants, createPublicKey, verify as nodeVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rsaPrivateKeyFromJwk } from "../src/blindRsa.js";
import { hex } from "../src/canonicalBase.js";
import { DEFAULT_PAYMENTS_CONFIG, mergePaymentsConfig, planUnitMs } from "../src/paymentsConfig.js";
import {
  finalizeVoucher,
  newVoucherRequest,
  parseVoucher,
  rsaFromVoucherKey,
  signBlindedVoucher,
  verifyVoucher,
  voucherKeyFromRsa,
  voucherNullifier,
  voucherPrepared,
} from "../src/voucher.js";
import {
  addVouchers,
  deriveVoucherWalletKey,
  emptyVoucherWallet,
  markVouchersSpent,
  mergeVoucherWallets,
  openVoucherWallet,
  overageStep,
  planAheadMs,
  sealVoucherWallet,
  takeVouchers,
  trickleStep,
  voucherWalletPlaintext,
} from "../src/voucherWallet.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/vouchers");
const V = JSON.parse(readFileSync(join(dir, "vectors.json"), "utf8"));
const keyFile = JSON.parse(readFileSync(join(dir, "test-rsa-key.json"), "utf8"));
const sk = rsaPrivateKeyFromJwk(keyFile.jwk);
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b: string) => parseInt(b, 16)));

describe("vouchers: shared vectors", () => {
  it("derives the key id from the published numbers", () => {
    expect(voucherKeyFromRsa(sk)).toEqual(V.key);
    expect(rsaFromVoucherKey(V.key)).not.toBeNull();
    expect(rsaFromVoucherKey({ ...V.key, keyId: "0".repeat(16) })).toBeNull();
  });

  it("blinds, signs and unblinds byte for byte", () => {
    for (const c of V.blind) {
      const req = newVoucherRequest(V.key, { nonce: fromHex(c.nonceHex), prefix: fromHex(c.prefixHex), salt: fromHex(c.saltHex), r: BigInt("0x" + c.rHex) });
      expect(req.blinded).toBe(c.blinded);
      expect(req.pending.inv).toBe(c.invHex);
      expect(signBlindedVoucher(sk, c.blinded)).toBe(c.blindSig);
      const v = finalizeVoucher(V.key, req.pending, c.blindSig);
      expect(v).toEqual(c.voucher);
      expect(hex(voucherPrepared(v))).toBe(c.preparedHex);
      expect(voucherNullifier(v)).toBe(c.nullifier);
      expect(verifyVoucher(V.key, v)).toBe(true);
    }
  });

  it("is an ordinary RSASSA-PSS (SHA-384, 48-byte salt) signature", () => {
    const pub = createPublicKey({ key: { kty: "RSA", n: keyFile.jwk.n, e: keyFile.jwk.e }, format: "jwk" });
    for (const c of V.blind) {
      const ok = nodeVerify("sha384", fromHex(c.preparedHex), { key: pub, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, Buffer.from(c.voucher.s, "base64"));
      expect(ok).toBe(true);
    }
  });

  it("refuses tampered vouchers", () => {
    for (const b of V.bad) expect(parseVoucher(b.voucher) === null || !verifyVoucher(V.key, b.voucher), b.why).toBe(true);
  });

  it("refuses a wrong blind signature at finalize", () => {
    const c = V.blind[0];
    const req = newVoucherRequest(V.key, { nonce: fromHex(c.nonceHex), prefix: fromHex(c.prefixHex) });
    expect(() => finalizeVoucher(V.key, req.pending, V.blind[1].blindSig)).toThrow();
  });

  it("seals the wallet byte for byte, padded to its bucket", () => {
    const w = V.wallet;
    const key = deriveVoucherWalletKey({ seed: fromHex(w.umkSeedHex) } as never);
    expect(hex(key)).toBe(w.keyHex);
    expect(voucherWalletPlaintext(w.wallet)).toBe(w.plaintext);
    expect(w.plaintext.length % 4096).toBe(0);
    expect(sealVoucherWallet(key, w.version, w.wallet, fromHex(w.nonceHex))).toEqual(w.sealed);
    const opened = openVoucherWallet(key, w.sealed);
    expect(opened?.vouchers.map((v) => v.n)).toEqual([...w.wallet.vouchers].map((v: { n: string }) => v.n).sort());
    expect(openVoucherWallet(key, { ...w.sealed, version: w.version + 1 })).toBeNull();
  });

  it("merges two wallets", () => {
    expect(mergeVoucherWallets(V.merge.local, V.merge.remote)).toEqual(V.merge.merged);
    expect(mergeVoucherWallets(V.merge.remote, V.merge.local)).toEqual(V.merge.merged);
  });

  it("runs the trickle, the overage rule and the plan lead", () => {
    for (const c of V.trickle) expect(trickleStep(c.input, c.rand), c.name).toEqual(c.out);
    for (const c of V.overage) expect(overageStep(c.input), c.name).toBe(c.out);
    for (const c of V.planAhead) expect(planAheadMs(DEFAULT_PAYMENTS_CONFIG, c.plan, c.paid, c.now), c.name).toBe(c.out);
    expect(V.unitMs).toEqual({ pro: planUnitMs(DEFAULT_PAYMENTS_CONFIG, "pro"), "pro-max": planUnitMs(DEFAULT_PAYMENTS_CONFIG, "pro-max") });
    expect(V.defaultConfig).toEqual(DEFAULT_PAYMENTS_CONFIG);
  });
});

describe("vouchers: wallet operations and config", () => {
  it("takes, spends and never resurrects a spent voucher", () => {
    let w = addVouchers(emptyVoucherWallet(10), V.blind.map((c: { voucher: unknown }) => c.voucher));
    expect(w.vouchers).toHaveLength(3);
    const [first] = takeVouchers(w, 1);
    w = markVouchersSpent(w, [voucherNullifier(first!)]);
    expect(w.vouchers).toHaveLength(2);
    w = addVouchers(w, [first!]);
    expect(w.vouchers).toHaveLength(2);
  });

  it("keeps valid overrides and drops bad ones", () => {
    const c = mergePaymentsConfig(JSON.stringify({ plans: { pro: { unitsPerMonth: 12 } }, graceHours: -1, packs: [30, 10] }));
    expect(c.plans.pro.unitsPerMonth).toBe(12);
    expect(c.plans["pro-max"].unitsPerMonth).toBe(20);
    expect(c.graceHours).toBe(DEFAULT_PAYMENTS_CONFIG.graceHours);
    expect(c.packs).toEqual([10, 30]);
    expect(mergePaymentsConfig("not json")).toEqual(DEFAULT_PAYMENTS_CONFIG);
  });
});
