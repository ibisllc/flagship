// Regenerate test-vectors/org-plan/vectors.json:
//   npx tsx packages/protocol/tests/genOrgPlanVectors.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rsaPrivateKeyFromJwk } from "../src/blindRsa.js";
import { hex } from "../src/canonicalBase.js";
import { ed } from "../src/edSync.js";
import {
  orgAheadMs,
  orgEgressGb,
  orgPaidUntilAfterSpend,
  orgPlanState,
  orgTrialTerms,
  orgTrickleStep,
  type OrgPlanTerms,
} from "../src/orgPlan.js";
import {
  canonicalOrgWalletWrite,
  deriveOrgWalletKey,
  mergeOrgVoucherWallets,
  orgVoucherWalletPlaintext,
  orgWalletBlobSha256,
  orgWalletWriteFor,
  sealOrgVoucherWallet,
  type OrgVoucherWallet,
} from "../src/orgWallet.js";
import { DEFAULT_PAYMENTS_CONFIG, orgMonthlyUnits, orgSeatUnitMs } from "../src/paymentsConfig.js";
import { canonicalOrgPlanAttestation, signOrgPlanAttestation, type OrgPlanAttestationBody } from "../src/planAttestation.js";
import { signBlindedVoucher, voucherKeyFromRsa, voucherNullifier } from "../src/voucher.js";
import { batchRequests, batchVoucherRequest, finalizeBatchVouchers, splitVoucherFiles, voucherBatchKeyText, voucherFileId, voucherFileText } from "../src/voucherBatch.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../test-vectors/org-plan");
const fill = (b: number, n = 32) => new Uint8Array(n).fill(b);
const td = new TextDecoder();

const cfg = DEFAULT_PAYMENTS_CONFIG;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = 1_763_400_000_000;

// ── plan state, spends, the trickle ──────────────────────────────────────
const trial = orgTrialTerms(cfg, now - 10 * DAY);
const paid3: OrgPlanTerms = { ...trial, trialEndsAt: now - 40 * DAY, paidSeats: 3, paidUntil: now + 5 * DAY };
const stateCases: Array<{ name: string; terms: OrgPlanTerms; now: number }> = [
  { name: "trial", terms: trial, now },
  { name: "trial with 12 paid seats", terms: { ...trial, paidSeats: 12, paidUntil: trial.trialEndsAt + 10 * DAY }, now },
  { name: "trial ended, nothing paid", terms: trial, now: trial.trialEndsAt + 1 },
  { name: "paid", terms: paid3, now },
  { name: "inside the grace", terms: paid3, now: paid3.paidUntil + 71 * HOUR },
  { name: "past the grace", terms: paid3, now: paid3.paidUntil + 73 * HOUR },
];
const state = stateCases.map((c) => ({ ...c, out: orgPlanState(cfg, c.terms, c.now) }));

const spendCases: Array<{ name: string; terms: OrgPlanTerms; seats: number; n: number; now: number }> = [
  { name: "during the trial: paid time starts at its end", terms: trial, seats: 3, n: 1, now },
  { name: "same seats: continues", terms: paid3, seats: 3, n: 6, now },
  { name: "more seats: time left converts", terms: paid3, seats: 6, n: 0, now },
  { name: "fewer seats: time left converts", terms: { ...paid3, paidSeats: 6 }, seats: 3, n: 1, now },
  { name: "inside the grace: continues from the old end", terms: paid3, seats: 3, n: 1, now: paid3.paidUntil + DAY },
  { name: "past the grace: starts now", terms: paid3, seats: 3, n: 1, now: paid3.paidUntil + 4 * DAY },
  { name: "switch inside the grace starts fresh", terms: paid3, seats: 4, n: 1, now: paid3.paidUntil + DAY },
];
const spend = spendCases.map((c) => ({ ...c, out: orgPaidUntilAfterSpend(cfg, c.terms, c.seats, c.n, c.now), ahead: orgAheadMs(cfg, c.terms, c.seats, c.now) }));

const trickleCases = [
  { name: "trial well ahead: nothing", input: { now, enabled: true, balance: 100, terms: trial, seats: 3, nextSpendAt: 0 }, rand: 0.5 },
  { name: "trial nearly over: schedule", input: { now: trial.trialEndsAt - 5 * DAY, enabled: true, balance: 100, terms: trial, seats: 3, nextSpendAt: 0 }, rand: 0.5 },
  { name: "lapsed: catch up at once", input: { now, enabled: true, balance: 100, terms: { ...paid3, paidUntil: now - 10 * DAY }, seats: 3, nextSpendAt: 0 }, rand: 0.25 },
  { name: "ten seats lapsed: catch up limited by the request", input: { now, enabled: true, balance: 100, terms: { ...paid3, paidSeats: 10, paidUntil: now - 10 * DAY }, seats: 10, nextSpendAt: 0 }, rand: 0.25 },
  { name: "spend due", input: { now, enabled: true, balance: 100, terms: paid3, seats: 3, nextSpendAt: now - 1 }, rand: 0.9 },
  { name: "auto-pay off", input: { now, enabled: false, balance: 100, terms: paid3, seats: 3, nextSpendAt: now - 1 }, rand: 0.9 },
];
const trickle = trickleCases.map((c) => ({ ...c, out: orgTrickleStep(cfg, c.input, c.rand) }));
const egress = state.map((s) => ({ name: s.name, out: orgEgressGb(cfg, s.out) }));

// ── the attestation ──────────────────────────────────────────────────────
const caSeed = fill(0x5c);
const caKeypair = { privateKey: caSeed, publicKey: ed.getPublicKey(caSeed) };
const orgId = "0f".repeat(16);
const attBody: OrgPlanAttestationBody = {
  orgId,
  status: "paid",
  seatLimit: 3,
  paidSeats: 3,
  trialEndsAt: paid3.trialEndsAt,
  paidUntil: paid3.paidUntil,
  issuedAt: now,
  expiresAt: now + 26 * HOUR,
};
const attestation = {
  caSeedHex: hex(caSeed),
  caPubHex: hex(caKeypair.publicKey),
  body: attBody,
  canonical: td.decode(canonicalOrgPlanAttestation(attBody)),
  signed: signOrgPlanAttestation(attBody, caKeypair as never),
};

// ── vouchers for the wallet and the batch ────────────────────────────────
const keyFile = JSON.parse(readFileSync(join(here, "../test-vectors/vouchers/test-rsa-key.json"), "utf8")) as { jwk: Record<string, string> };
const sk = rsaPrivateKeyFromJwk(keyFile.jwk);
const key = voucherKeyFromRsa(sk);
const seed = fill(0x61);
const units = 3;
const reqs = [0, 1, 2].map((i) => batchVoucherRequest(key, seed, i));
const { blinded, commit } = batchRequests(key, seed, units);
const sigs = blinded.map((b) => signBlindedVoucher(sk, b));
const vouchers = finalizeBatchVouchers(key, seed, 0, sigs);
const batch = {
  seedHex: hex(seed),
  units,
  requests: reqs.map((r) => ({ ...r.pending, blinded: r.blinded })),
  commit,
  sigs,
  vouchers,
  keyFile: voucherBatchKeyText({ k: key.keyId, units, seed: hex(seed), session: "cs_test_a1B2c3D4e5F6g7H8" }),
};
const fileText = voucherFileText([vouchers[2]!, vouchers[0]!, vouchers[1]!]);
const voucherFile = { text: fileText, id: voucherFileId(fileText), split2: splitVoucherFiles(vouchers, 2) };

// ── the org wallet ───────────────────────────────────────────────────────
const ringKey = fill(0x77);
const walletKey = deriveOrgWalletKey(ringKey, orgId);
const wallet: OrgVoucherWallet = {
  v: 1,
  vouchers: [vouchers[1]!, vouchers[0]!],
  spent: [],
  settings: { seats: 3, autoPay: true, overageCapUnits: 10, updatedAt: 1_763_000_000_000 },
  overage: { period: "2026-11", units: 5 },
};
const nonce = fill(0x45, 12);
const plaintext = orgVoucherWalletPlaintext(wallet);
const sealed = sealOrgVoucherWallet(walletKey, orgId, 2, 7, wallet, nonce);
const write = orgWalletWriteFor(orgId, sealed, now);
const local: OrgVoucherWallet = { ...wallet, vouchers: [vouchers[0]!, vouchers[1]!], settings: { ...wallet.settings, updatedAt: 100 }, overage: { period: "2026-10", units: 10 } };
const remote: OrgVoucherWallet = {
  v: 1,
  vouchers: [vouchers[1]!, vouchers[2]!],
  spent: [voucherNullifier(vouchers[1]!)],
  settings: { seats: 5, autoPay: false, overageCapUnits: 20, updatedAt: 200 },
  overage: { period: "2026-11", units: 5 },
};

const out = {
  about:
    "Business plan for orgs: orgPlan.ts, orgWallet.ts, voucherBatch.ts, planAttestation.ts (org variant), paymentsConfig.ts business. Regenerate: npx tsx packages/protocol/tests/genOrgPlanVectors.ts. Keys here are for these vectors only (the RSA key is test-vectors/vouchers/test-rsa-key.json).",
  config: cfg,
  unitMs: { "3": orgSeatUnitMs(cfg, 3), "10": orgSeatUnitMs(cfg, 10) },
  monthlyUnits: { "3": orgMonthlyUnits(cfg, 3), "10": orgMonthlyUnits(cfg, 10) },
  state,
  spend,
  trickle,
  egress,
  attestation,
  key,
  batch,
  voucherFile,
  wallet: {
    orgId,
    ringKeyHex: hex(ringKey),
    keyHex: hex(walletKey),
    keyVersion: 2,
    version: 7,
    nonceHex: hex(nonce),
    wallet,
    plaintext,
    plaintextLength: plaintext.length,
    sealed,
    blobSha256: orgWalletBlobSha256(sealed),
    write,
    writeCanonical: td.decode(canonicalOrgWalletWrite(write)),
  },
  merge: { local, remote, merged: mergeOrgVoucherWallets(local, remote) },
};
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote", join(dir, "vectors.json"));
