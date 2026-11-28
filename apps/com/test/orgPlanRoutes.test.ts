/**
 * The Business plan through the Worker's routes on a real D1 schema (migrations 0141 and 0156): a new org is on the
 * trial, an org spend through `/api/vouchers/redeem` pays for seats, the org plan and its CA-signed attestation are
 * served, the org wallet stores only an org admin's write, and the new voucher routes have rate budgets and go through
 * the OHTTP relay where they must (docs/plans-and-backup-offer.md "As built").
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { tryControlPlane, type ControlPlaneEnv } from "../src/controlPlaneRoutes.js";
import { endpointFor } from "../src/rateLimit.js";
import type { D1Database } from "@flagship/storage";
import { createSqliteD1 } from "../../../packages/storage/tests/support/sqliteD1.js";
import {
  canonicalOrgWalletWrite,
  emptyOrgVoucherWallet,
  finalizeVoucher,
  newVoucherRequest,
  orgSeatUnitMs,
  orgWalletWriteFor,
  parseOrgPlanAttestation,
  sealOrgVoucherWallet,
  signOrgApproval,
  signOrgReadTokenRequest,
  DEFAULT_PAYMENTS_CONFIG,
} from "@flagship/protocol";
import { voucherSigningKeysFromEnv } from "@flagship/control-plane";

const ORIGIN = "https://flagshipserver.com";
const here = dirname(fileURLToPath(import.meta.url));
const jwk = JSON.parse(readFileSync(join(here, "../../../packages/protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8")).jwk;
const vkey = voucherSigningKeysFromEnv(JSON.stringify([{ jwk }]))[0]!.pub;
const V = JSON.parse(readFileSync(join(here, "../../../packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const resolveRefs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(resolveRefs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x)]));
};
const chain = resolveRefs(V.chains[0]);
const ORG = V.orgId as string;
const T0 = chain.entries[1].record.issuedAt + 3_600_000;
const DAY = 86_400_000;
const A = V.keys["A founder"];
const aSecret = Uint8Array.from(Buffer.from(A.edSeedHex + A.mldsaSeedHex, "hex"));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const req = (method: string, path: string, body?: unknown, token?: string) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const call = async (env: ControlPlaneEnv, method: string, path: string, body?: unknown, token?: string) => {
  const r = (await tryControlPlane(req(method, path, body, token), env))!;
  return { status: r.status, body: (await r.json()) as any };
};
/** The founder's org read token (every org GET but the plan takes one). */
let nonce = 0;
async function founderToken(env: ControlPlaneEnv): Promise<string> {
  const request = { orgId: ORG, subject: `seat:${A.seatId}`, pubHex: A.binding.ed25519PubHex, issuedAt: Date.now(), nonceHex: (++nonce).toString(16).padStart(32, "0") };
  const r = await call(env, "POST", `/api/orgs/${ORG}/read-token`, { request, signature: signOrgReadTokenRequest(request, (m) => ed25519.sign(m, Buffer.from(A.edSeedHex, "hex"))) });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

describe("Business routes", () => {
  it("trial, an org spend, the plan, the attestation and the org wallet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const sqlite = createSqliteD1();
    try {
      const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, VOUCHER_SIGNING_KEYS: JSON.stringify([{ jwk }]), VOUCHER_TEST_ISSUE: "1", ACCOUNT_READ_TOKEN_SECRET: "k".repeat(64) };
      expect((await call(env, "POST", "/api/orgs", { name: "acme", entry: chain.entries[0] })).status).toBe(200);
      expect((await call(env, "POST", `/api/orgs/${ORG}/authority`, { entry: chain.entries[1] })).status).toBe(200);

      const plan = await call(env, "GET", `/api/orgs/${ORG}/plan`);
      expect(plan.body).toMatchObject({ status: "trial", seatLimit: 10, trialEndsAt: T0 + 30 * DAY, liveSeats: 0 });

      const reqs = Array.from({ length: 3 }, () => newVoucherRequest(vkey));
      const issued = await call(env, "POST", "/api/vouchers/test-issue", { k: vkey.keyId, blinded: reqs.map((q) => q.blinded) });
      const vouchers = reqs.map((q, i) => finalizeVoucher(vkey, q.pending, issued.body.sigs[i]));
      const spent = await call(env, "POST", "/api/vouchers/redeem", { v: 1, org: ORG, for: "business", seats: 3, vouchers });
      expect(spent.body).toMatchObject({ ok: true, credited: 3, seats: 3, paidUntil: T0 + 30 * DAY + 3 * orgSeatUnitMs(DEFAULT_PAYMENTS_CONFIG, 3) });
      expect((await call(env, "GET", `/api/orgs/${ORG}/plan`)).body).toMatchObject({ status: "trial", paidSeats: 3 });
      // The org's spend left no account anywhere: the nullifier table has the voucher and the day only.
      const row = sqlite.raw.prepare("SELECT * FROM voucher_nullifiers LIMIT 1").get() as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual(["key_id", "nullifier", "spent_day"]);

      const att = parseOrgPlanAttestation((await call(env, "GET", `/api/orgs/${ORG}/plan-attestation`, undefined, await founderToken(env))).body);
      expect(att).toMatchObject({ orgId: ORG, status: "trial", paidSeats: 3 });

      expect((await call(env, "GET", `/api/orgs/${ORG}/voucher-wallet`, undefined, await founderToken(env))).status).toBe(404);
      const blob = sealOrgVoucherWallet(new Uint8Array(32).fill(5), ORG, 1, 1, emptyOrgVoucherWallet(3, 10));
      const write = orgWalletWriteFor(ORG, blob, T0);
      const approval = signOrgApproval({ orgId: ORG, oarVersion: 1, order: canonicalOrgWalletWrite(write), seatId: A.seatId, adminKeyId: A.keyId, issuedAt: T0, notAfter: T0 + DAY }, aSecret);
      const put = await call(env, "PUT", `/api/orgs/${ORG}/voucher-wallet`, { blob, write, approvals: [approval] });
      expect(put.body).toMatchObject({ ok: true, version: 1 });
      expect((await call(env, "GET", `/api/orgs/${ORG}/voucher-wallet`, undefined, await founderToken(env))).body).toEqual(blob);
      expect((await call(env, "PUT", `/api/orgs/${ORG}/voucher-wallet`, { blob, write, approvals: [approval] })).status).toBe(409);

      vi.setSystemTime(T0 + 30 * DAY + 3 * orgSeatUnitMs(DEFAULT_PAYMENTS_CONFIG, 3) + 4 * DAY);
      expect((await call(env, "GET", `/api/orgs/${ORG}/plan`)).body).toMatchObject({ status: "lapsed" });
    } finally {
      sqlite.close();
    }
  });

  it("the new voucher routes have their own rate budgets", () => {
    expect(endpointFor("POST", "/api/vouchers/exchange")).toBe("vouchers-exchange");
    expect(endpointFor("POST", "/api/vouchers/stripe/batch-checkout")).toBe("vouchers-batch-checkout");
    expect(endpointFor("POST", "/api/vouchers/batch-issue")).toBe("vouchers-batch-issue");
    expect(endpointFor("PUT", `/api/orgs/${ORG}/voucher-wallet`)).toBe("org-write");
    expect(endpointFor("GET", `/api/orgs/${ORG}/plan`)).toBe("org-read");
  });

  it("the batch routes answer rail-off without Stripe", async () => {
    const sqlite = createSqliteD1();
    try {
      const env: ControlPlaneEnv = { DB: sqlite as unknown as D1Database, VOUCHER_SIGNING_KEYS: JSON.stringify([{ jwk }]) };
      expect((await call(env, "POST", "/api/vouchers/stripe/batch-checkout", { v: 1, units: 100, k: vkey.keyId, commit: "0".repeat(64) })).body).toMatchObject({ code: "rail-off" });
      expect((await call(env, "POST", "/api/vouchers/batch-issue", { v: 1, session: "cs_test_x1234567", k: vkey.keyId, blinded: ["AA=="], from: 0 })).body).toMatchObject({ code: "rail-off" });
    } finally {
      sqlite.close();
    }
  });
});
