// Regenerate test-vectors/vouchers/vectors.json:
//   npx tsx packages/protocol/tests/genVoucherVectors.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToInt, rsaPrivateKeyFromJwk } from "../src/blindRsa.js";
import { hex } from "../src/canonicalBase.js";
import { DEFAULT_PAYMENTS_CONFIG, planUnitMs } from "../src/paymentsConfig.js";
import {
  finalizeVoucher,
  newVoucherRequest,
  signBlindedVoucher,
  voucherKeyFromRsa,
  voucherMessage,
  voucherNullifier,
  voucherPrepared,
  type Voucher,
} from "../src/voucher.js";
import {
  deriveVoucherWalletKey,
  mergeVoucherWallets,
  overageStep,
  planAheadMs,
  sealVoucherWallet,
  trickleStep,
  voucherWalletPlaintext,
  type OverageInput,
  type TrickleInput,
  type VoucherWallet,
} from "../src/voucherWallet.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../test-vectors/vouchers");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const fill = (b: number, n = 32) => new Uint8Array(n).fill(b);

const keyFile = JSON.parse(readFileSync(join(dir, "test-rsa-key.json"), "utf8")) as { jwk: Record<string, string> };
const sk = rsaPrivateKeyFromJwk(keyFile.jwk);
const key = voucherKeyFromRsa(sk);

function rFor(seed: number): bigint {
  let out = new Uint8Array(0);
  for (let i = 0; out.length < 256; i++) {
    const h = sha512(new Uint8Array([seed, i]));
    const next = new Uint8Array(out.length + h.length);
    next.set(out);
    next.set(h, out.length);
    out = next;
  }
  return (bytesToInt(out.subarray(0, 256)) % (sk.n - 3n)) + 2n;
}

const blind = [1, 2, 3].map((i) => {
  const nonce = fill(0x10 + i);
  const prefix = fill(0x20 + i);
  const salt = fill(0x30 + i, 48);
  const r = rFor(i);
  const req = newVoucherRequest(key, { nonce, prefix, salt, r });
  const blindSig = signBlindedVoucher(sk, req.blinded);
  const voucher = finalizeVoucher(key, req.pending, blindSig);
  return {
    nonceHex: hex(nonce),
    prefixHex: hex(prefix),
    saltHex: hex(salt),
    rHex: r.toString(16),
    messageHex: hex(voucherMessage(nonce)),
    preparedHex: hex(voucherPrepared(voucher)),
    blinded: req.blinded,
    invHex: req.pending.inv,
    blindSig,
    voucher,
    nullifier: voucherNullifier(voucher),
  };
});

const v1 = blind[0]!.voucher;
const v2 = blind[1]!.voucher;
const v3 = blind[2]!.voucher;
const flipped = (s: string) => (s[5] === "A" ? s.slice(0, 5) + "B" + s.slice(6) : s.slice(0, 5) + "A" + s.slice(6));
const bad: Array<{ voucher: Voucher; why: string }> = [
  { voucher: { ...v1, s: flipped(v1.s) }, why: "signature changed" },
  { voucher: { ...v1, n: v2.n }, why: "another voucher's nonce" },
  { voucher: { ...v1, p: v2.p }, why: "another voucher's prefix" },
  { voucher: { ...v1, k: "0000000000000000" }, why: "unknown key id" },
];

const settings = { plan: "pro" as const, autoPay: true, overageCapUnits: 10, delayStart: false, startAt: 0, updatedAt: 1_763_000_000_000 };
const wallet: VoucherWallet = { v: 1, vouchers: [v2, v1], spent: [], settings, overage: { period: "2026-11", units: 5 } };
const umkSeedHex = "7a".repeat(32);
const walletKey = deriveVoucherWalletKey({ seed: fromHex(umkSeedHex) } as never);
const walletNonce = fill(0x44, 12);
const plaintext = voucherWalletPlaintext(wallet);
const sealed = sealVoucherWallet(walletKey, 3, wallet, walletNonce);

const local: VoucherWallet = { v: 1, vouchers: [v1, v2], spent: [], settings: { ...settings, updatedAt: 100 }, overage: { period: "2026-10", units: 10 } };
const remote: VoucherWallet = {
  v: 1,
  vouchers: [v2, v3],
  spent: [voucherNullifier(v2)],
  settings: { ...settings, plan: "pro-max", overageCapUnits: 20, updatedAt: 200 },
  overage: { period: "2026-11", units: 5 },
};
const merged = mergeVoucherWallets(local, remote);

const cfg = DEFAULT_PAYMENTS_CONFIG;
const DAY = 86_400_000;
const now = 1_763_400_000_000;
const unitPro = planUnitMs(cfg, "pro");
const base: TrickleInput = {
  now,
  enabled: true,
  balance: 30,
  aheadMs: 5 * DAY,
  startAt: 0,
  nextSpendAt: 0,
  unitMs: unitPro,
  lowWaterMs: cfg.trickle.lowWaterDays * DAY,
  highWaterMs: cfg.trickle.highWaterDays * DAY,
  maxPerRequest: cfg.maxPerRequest,
};
const trickleCases: Array<{ name: string; input: TrickleInput; rand: number }> = [
  { name: "off", input: { ...base, enabled: false }, rand: 0.5 },
  { name: "empty wallet", input: { ...base, balance: 0 }, rand: 0.5 },
  { name: "delayed start", input: { ...base, aheadMs: 0, startAt: now + 3_600_000, nextSpendAt: 7 }, rand: 0.5 },
  { name: "lapsed: catch up at once", input: { ...base, aheadMs: 0 }, rand: 0.25 },
  { name: "inside the grace: catch up the gap", input: { ...base, aheadMs: -DAY }, rand: 0.75 },
  { name: "pro max lapsed: two units", input: { ...base, aheadMs: 0, unitMs: planUnitMs(cfg, "pro-max") }, rand: 0.1 },
  { name: "catch up limited by balance", input: { ...base, aheadMs: -2 * DAY, balance: 1 }, rand: 0.3 },
  { name: "well ahead: nothing", input: { ...base, aheadMs: 12 * DAY, nextSpendAt: now - 1 }, rand: 0.5 },
  { name: "schedule the next spend", input: { ...base }, rand: 0.5 },
  { name: "spend due", input: { ...base, nextSpendAt: now - 1000 }, rand: 0.9 },
  { name: "not yet due", input: { ...base, nextSpendAt: now + 1000 }, rand: 0.9 },
];
const trickle = trickleCases.map((c) => ({ ...c, out: trickleStep(c.input, c.rand) }));

const GB = 1024 ** 3;
const ovBase: OverageInput = { paid: true, remainingBytes: 5 * GB, buyBelowBytes: cfg.overage.buyBelowGb * GB, capUnits: 10, spentUnits: 0, blockUnits: 5, balance: 20 };
const overage = [
  { name: "buy", input: ovBase },
  { name: "free plan never buys", input: { ...ovBase, paid: false } },
  { name: "plenty left", input: { ...ovBase, remainingBytes: 50 * GB } },
  { name: "cap reached", input: { ...ovBase, spentUnits: 10 } },
  { name: "second block fits the cap", input: { ...ovBase, spentUnits: 5 } },
  { name: "wallet too small", input: { ...ovBase, balance: 4 } },
].map((c) => ({ ...c, out: overageStep(c.input) }));

const aheadCases = [
  { name: "same plan", plan: "pro" as const, paid: { plan: "pro" as const, paidUntil: now + 4 * DAY } },
  { name: "inside the grace", plan: "pro" as const, paid: { plan: "pro" as const, paidUntil: now - DAY } },
  { name: "past the grace", plan: "pro" as const, paid: { plan: "pro" as const, paidUntil: now - 4 * DAY } },
  { name: "free", plan: "pro" as const, paid: { plan: null, paidUntil: 0 } },
  { name: "pro to pro max halves", plan: "pro-max" as const, paid: { plan: "pro" as const, paidUntil: now + 6 * DAY } },
  { name: "pro max to pro doubles", plan: "pro" as const, paid: { plan: "pro-max" as const, paidUntil: now + 3 * DAY } },
  { name: "switch inside the grace starts fresh", plan: "pro-max" as const, paid: { plan: "pro" as const, paidUntil: now - DAY } },
].map((c) => ({ ...c, now, out: planAheadMs(cfg, c.plan, c.paid, now) }));

const out = {
  about:
    "flagship/voucher/v1 + flagship/voucher-wallet/v1 (protocol voucher.ts, voucherWallet.ts, paymentsConfig.ts). Regenerate: npx tsx packages/protocol/tests/genVoucherVectors.ts. The private key in test-rsa-key.json is for these vectors only.",
  key,
  defaultConfig: cfg,
  unitMs: { pro: unitPro, "pro-max": planUnitMs(cfg, "pro-max") },
  blind,
  bad,
  wallet: { umkSeedHex, keyHex: hex(walletKey), version: 3, nonceHex: hex(walletNonce), wallet, plaintext, plaintextLength: plaintext.length, sealed },
  merge: { local, remote, merged },
  trickle,
  overage,
  planAhead: aheadCases,
};
writeFileSync(join(dir, "vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote", join(dir, "vectors.json"));
