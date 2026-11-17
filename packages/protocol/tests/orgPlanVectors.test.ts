import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "../src/webEnvelope.js";
import { DEFAULT_PAYMENTS_CONFIG, isOrgSeatCount, mergePaymentsConfig, orgMonthlyUnits, orgSeatUnitMs } from "../src/paymentsConfig.js";
import { orgAheadMs, orgEgressGb, orgPaidUntilAfterSpend, orgPlanState, orgTrickleStep } from "../src/orgPlan.js";
import {
  canonicalOrgWalletWrite,
  deriveOrgWalletKey,
  emptyOrgVoucherWallet,
  mergeOrgVoucherWallets,
  openOrgVoucherWallet,
  orgVoucherWalletPlaintext,
  orgWalletBlobSha256,
  sealOrgVoucherWallet,
} from "../src/orgWallet.js";
import {
  canonicalOrgPlanAttestation,
  parseOrgPlanAttestation,
  signOrgPlanAttestation,
  verifyCaSignedOrgPlanAttestation,
} from "../src/planAttestation.js";
import { verifyVoucher } from "../src/voucher.js";
import {
  batchRequests,
  batchVoucherRequest,
  finalizeBatchVouchers,
  parseVoucherBatchKey,
  parseVoucherFile,
  splitVoucherFiles,
  voucherFileId,
  voucherFileText,
} from "../src/voucherBatch.js";
import { ed } from "../src/edSync.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "../test-vectors/org-plan/vectors.json"), "utf8"));
const td = new TextDecoder();
const cfg = DEFAULT_PAYMENTS_CONFIG;

describe("org plan vectors", () => {
  it("config and unit lengths", () => {
    expect(V.config).toEqual(cfg);
    expect(orgSeatUnitMs(cfg, 3)).toBe(V.unitMs["3"]);
    expect(orgSeatUnitMs(cfg, 10)).toBe(V.unitMs["10"]);
    expect(orgMonthlyUnits(cfg, 3)).toBe(18);
  });
  it("plan state, spends, ahead, trickle, egress", () => {
    for (const c of V.state) expect(orgPlanState(cfg, c.terms, c.now), c.name).toEqual(c.out);
    for (const c of V.spend) {
      expect(orgPaidUntilAfterSpend(cfg, c.terms, c.seats, c.n, c.now), c.name).toBe(c.out);
      expect(orgAheadMs(cfg, c.terms, c.seats, c.now), c.name).toBe(c.ahead);
    }
    for (const c of V.trickle) expect(orgTrickleStep(cfg, c.input, c.rand), c.name).toEqual(c.out);
    V.state.forEach((s: any, i: number) => expect(orgEgressGb(cfg, s.out)).toBe(V.egress[i].out));
  });
  it("attestation bytes and signature", () => {
    expect(td.decode(canonicalOrgPlanAttestation(V.attestation.body))).toBe(V.attestation.canonical);
    const kp = { privateKey: hexToBytes(V.attestation.caSeedHex), publicKey: hexToBytes(V.attestation.caPubHex) };
    expect(signOrgPlanAttestation(V.attestation.body, kp as never)).toEqual(V.attestation.signed);
    const parsed = parseOrgPlanAttestation(V.attestation.signed)!;
    expect(parsed).toEqual(V.attestation.signed);
    expect(ed.verify(hexToBytes(parsed.signatures[0]!.sig), canonicalOrgPlanAttestation(parsed), hexToBytes(parsed.signedBy))).toBe(true);
    expect(parseOrgPlanAttestation({ ...V.attestation.signed, status: "free" })).toBeNull();
    expect(parseOrgPlanAttestation({ ...V.attestation.signed, orgId: "ab" })).toBeNull();
  });
  it("fails closed without a CA chain", () => {
    expect(verifyCaSignedOrgPlanAttestation(V.attestation.signed, null, V.attestation.body.issuedAt + 1).ok).toBe(false);
  });
  it("batch requests, commit and vouchers", () => {
    const seed = hexToBytes(V.batch.seedHex);
    V.batch.requests.forEach((r: any, i: number) => {
      const got = batchVoucherRequest(V.key, seed, i);
      expect({ ...got.pending, blinded: got.blinded }).toEqual(r);
    });
    expect(batchRequests(V.key, seed, V.batch.units).commit).toBe(V.batch.commit);
    const vs = finalizeBatchVouchers(V.key, seed, 0, V.batch.sigs);
    expect(vs).toEqual(V.batch.vouchers);
    for (const v of vs) expect(verifyVoucher(V.key, v)).toBe(true);
    expect(parseVoucherBatchKey(V.batch.keyFile)?.units).toBe(3);
    expect(parseVoucherBatchKey(V.batch.keyFile.replace('"v":1', '"v":2'))).toBeNull();
  });
  it("voucher files", () => {
    expect(voucherFileText(V.batch.vouchers)).toBe(V.voucherFile.text);
    expect(voucherFileId(V.voucherFile.text)).toBe(V.voucherFile.id);
    expect(splitVoucherFiles(V.batch.vouchers, 2)).toEqual(V.voucherFile.split2);
    expect(parseVoucherFile(V.voucherFile.text)).toHaveLength(3);
    expect(parseVoucherFile('{"kind":"flagship-vouchers","v":1,"vouchers":[]}')).toBeNull();
    expect(parseVoucherFile('{"kind":"other","v":1,"vouchers":[]}')).toBeNull();
  });
  it("wallet seal, open, write, merge", () => {
    const w = V.wallet;
    const key = deriveOrgWalletKey(hexToBytes(w.ringKeyHex), w.orgId);
    expect(Buffer.from(key).toString("hex")).toBe(w.keyHex);
    expect(orgVoucherWalletPlaintext(w.wallet)).toBe(w.plaintext);
    expect(sealOrgVoucherWallet(key, w.orgId, w.keyVersion, w.version, w.wallet, hexToBytes(w.nonceHex))).toEqual(w.sealed);
    expect(openOrgVoucherWallet(key, w.orgId, w.sealed)).toEqual(mergeOrgVoucherWallets(w.wallet, w.wallet));
    expect(openOrgVoucherWallet(key, "1f".repeat(16), w.sealed)).toBeNull();
    expect(openOrgVoucherWallet(key, w.orgId, { ...w.sealed, version: w.version + 1 })).toBeNull();
    expect(openOrgVoucherWallet(key, w.orgId, { ...w.sealed, keyVersion: 3 })).toBeNull();
    expect(orgWalletBlobSha256(w.sealed)).toBe(w.blobSha256);
    expect(td.decode(canonicalOrgWalletWrite(w.write))).toBe(w.writeCanonical);
    expect(mergeOrgVoucherWallets(V.merge.local, V.merge.remote)).toEqual(V.merge.merged);
  });
});

describe("org plan rules", () => {
  it("seat counts and config overrides", () => {
    expect(isOrgSeatCount(cfg, 2)).toBe(false);
    expect(isOrgSeatCount(cfg, 3)).toBe(true);
    expect(isOrgSeatCount(cfg, 3.5)).toBe(false);
    const c = mergePaymentsConfig({ business: { unitsPerSeatMonth: 8, minSeats: 5, trialDays: 14 } });
    expect(c.business).toMatchObject({ unitsPerSeatMonth: 8, minSeats: 5, trialDays: 14, trialSeats: 10 });
    expect(mergePaymentsConfig({ business: { minSeats: 50, maxSeats: 10 } }).business).toEqual(cfg.business);
    expect(mergePaymentsConfig({ business: { unitsPerSeatMonth: -1 } }).business.unitsPerSeatMonth).toBe(6);
  });
  it("a seat-count change keeps the value of the time left", () => {
    const now = 1_000_000_000_000;
    const t = { trialEndsAt: now - 1, trialSeats: 10, paidSeats: 3, paidUntil: now + 6 * 86_400_000 };
    const at6 = orgPaidUntilAfterSpend(cfg, t, 6, 0, now);
    expect(at6 - now).toBe(3 * 86_400_000);
  });
  it("an empty wallet seals and opens", () => {
    const key = new Uint8Array(32).fill(1);
    const w = emptyOrgVoucherWallet(3, 10);
    const s = sealOrgVoucherWallet(key, "ab".repeat(16), 1, 1, w);
    expect(openOrgVoucherWallet(key, "ab".repeat(16), s)).toEqual(w);
  });
});
