// The Business plan at .com (docs/plans-and-backup-offer.md "As built"): the org trial, seat spends from the org
// wallet, the gating of a lapsed org, the CA-signed org plan attestation, the sealed org wallet, the voucher exchange,
// and the org's pooled egress.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENTS_CONFIG,
  canonicalOrgPlanAttestation,
  canonicalOrgSeatInvite,
  canonicalOrgWalletWrite,
  emptyOrgVoucherWallet,
  finalizeVoucher,
  newVoucherRequest,
  orgSeatRolesHash,
  orgSeatUnitMs,
  orgSha256Hex,
  orgWalletWriteFor,
  parseOrgPlanAttestation,
  sealOrgVoucherWallet,
  signOrgApproval,
  type OrgSeatRole,
  type Voucher,
  deriveOrgInviteKeys,
} from "@flagship/protocol";
import { InMemoryBlindVoucherStorage, InMemoryMeterStorage, InMemoryOrgStorage, InMemoryStorage, InMemoryTierStorage } from "@flagship/storage";
import { ed } from "../../protocol/src/edSync.js";
import { handleVoucherExchange, handleVoucherIssue, handleVoucherRedeem, voucherSigningKeysFromEnv, type VoucherRedeemDeps } from "../src/blindVouchers.js";
import { meterRecord } from "../src/meter.js";
import { isOhttpTargetAllowed } from "../src/ohttpGateway.js";
import { handleOrgPlanAttestation, handleOrgPlanGet, handleOrgWalletGet, handleOrgWalletPut, orgEgressBytesFor, orgPlanGate } from "../src/orgPlan.js";
import { handleOrgAuthorityAppend, handleOrgCreate, handleOrgInviteCreate, type OrgDeps } from "../src/orgs.js";

// The invite key a fixed link key derives (test-vectors/org-invite-key).
const IK = deriveOrgInviteKeys(new Uint8Array(32).fill(0x33));
const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/org-authority/vectors.json"), "utf8"));
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
const DAY = 86_400_000;
const GB = 1024 ** 3;
const cfg = DEFAULT_PAYMENTS_CONFIG;
const T0 = chain.entries[1].record.issuedAt + 3_600_000;
const key = (name: string) => {
  const k = V.keys[name];
  return { ...k, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};
const A = key("A founder");
const MM = key("M member");

const voucherKeyFile = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../protocol/test-vectors/vouchers/test-rsa-key.json"), "utf8"));
const keys = voucherSigningKeysFromEnv(JSON.stringify([{ jwk: voucherKeyFile.jwk }]));
const vkey = keys[0]!.pub;
function mint(n: number): Voucher[] {
  const reqs = Array.from({ length: n }, () => newVoucherRequest(vkey));
  const r = handleVoucherIssue({ keys, config: cfg }, { k: vkey.keyId, blinded: reqs.map((q) => q.blinded) });
  const sigs = (r.body as { sigs: string[] }).sigs;
  return reqs.map((q, i) => finalizeVoucher(vkey, q.pending, sigs[i]!));
}

interface World {
  clock: { now: number };
  od: OrgDeps & { store: InMemoryOrgStorage };
  rd: VoucherRedeemDeps;
  wallets: InMemoryBlindVoucherStorage;
}
async function world(): Promise<World> {
  const clock = { now: T0 };
  const store = new InMemoryOrgStorage();
  const od = { store, orgs: store, usernames: new InMemoryStorage().usernames, payments: cfg, now: () => clock.now };
  expect((await handleOrgCreate(od, { name: "acme", entry: chain.entries[0] })).status).toBe(200);
  clock.now = T0;
  expect((await handleOrgAuthorityAppend(od, ORG, { entry: chain.entries[1] })).status).toBe(200);
  const wallets = new InMemoryBlindVoucherStorage();
  const rd: VoucherRedeemDeps = {
    keys,
    config: cfg,
    store: wallets,
    tiers: new InMemoryTierStorage(),
    usernames: { async get() { return undefined; } },
    meter: new InMemoryMeterStorage(),
    orgs: od,
    now: () => clock.now,
  };
  return { clock, od, rd, wallets };
}
const approve = (k: typeof A, order: Uint8Array, oarVersion: number, at: number) =>
  signOrgApproval({ orgId: ORG, oarVersion, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt: at, notAfter: at + DAY }, k.secret);
const spend = (w: World, vouchers: Voucher[], seats: unknown = 3, what = "business") => handleVoucherRedeem(w.rd, { v: 1, org: ORG, for: what, seats, vouchers });
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;
const inviteFor = (seatId: string, now: number) => {
  const roles: OrgSeatRole[] = [{ role: "member" }];
  const invite = { orgId: ORG, seatId, labelSha256: orgSha256Hex(Buffer.from("aa", "hex")), rolesHash: orgSeatRolesHash(roles), oarVersion: 1, issuedAt: now, expiresAt: now + DAY, inviteKeyPub: IK.inviteKeyPub };
  return { invite, roles, approvals: [approve(A, canonicalOrgSeatInvite(invite), 1, now)], sealedLabelHex: "aa", offerHex: "01" };
};

describe("org trial and plan", () => {
  it("a new org gets the trial's seats for the trial's days", async () => {
    const w = await world();
    const p = (await handleOrgPlanGet(w.od, ORG)).body as Record<string, any>;
    expect(p).toMatchObject({ plan: "business", status: "trial", seatLimit: 10, paidSeats: 0, paidUntil: 0 });
    expect(p.trialEndsAt).toBe(T0 + 30 * DAY);
    expect(p.price).toMatchObject({ unitsPerSeatMonth: 6, minSeats: 3 });
    expect((await handleOrgPlanGet(w.od, "ab".repeat(16))).status).toBe(404);
  });

  it("a spend during the trial starts paid time at the trial's end", async () => {
    const w = await world();
    const r = await spend(w, mint(2));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ for: "business", credited: 2, seats: 3, status: "trial", paidUntil: T0 + 30 * DAY + 2 * orgSeatUnitMs(cfg, 3) });
    const again = await spend(w, mint(1));
    expect((again.body as { paidUntil: number }).paidUntil).toBe(T0 + 30 * DAY + 3 * orgSeatUnitMs(cfg, 3));
  });

  it("refuses a seat count under the minimum or under the live seats, an unknown org and a spend too far ahead", async () => {
    const w = await world();
    expect(code(await spend(w, mint(1), 2))).toBe("org-seats");
    expect(code(await spend(w, mint(1), 3.5))).toBe("org-seats");
    expect(code(await handleVoucherRedeem(w.rd, { v: 1, org: "ab".repeat(16), for: "business", seats: 3, vouchers: mint(1) }))).toBe("org-not-found");
    await w.od.store.setPlan(ORG, { planTier: "business", seatLimit: 10, paidUntil: T0 + 36 * DAY, paidSeats: 3, trialEndsAt: T0 - DAY });
    expect(code(await spend(w, mint(1)))).toBe("plan-paid-ahead");
    const v = mint(1);
    expect(code(await spend(w, v))).toBe("plan-paid-ahead");
    // Nothing was spent by a refusal: the same voucher still pays once the lead shrinks.
    w.clock.now = T0 + 10 * DAY;
    expect((await spend(w, v)).status).toBe(200);
  });

  it("a voucher pays once, for an account or an org", async () => {
    const w = await world();
    const v = mint(1);
    expect((await spend(w, v)).status).toBe(200);
    expect(code(await spend(w, v))).toBe("voucher-spent");
  });

  it("a lapsed org adds no seat but stays readable; paying for seats lifts it", async () => {
    const w = await world();
    w.clock.now = T0 + 31 * DAY;
    expect(((await handleOrgPlanGet(w.od, ORG)).body as { status: string }).status).toBe("lapsed");
    const inv = await handleOrgInviteCreate(w.od, ORG, inviteFor(MM.seatId, w.clock.now));
    expect(code(inv)).toBe("org-plan-lapsed");
    expect(code(await spend(w, mint(5), 3, "overage"))).toBe("overage-needs-plan");
    const paid = await spend(w, mint(3));
    expect(paid.body).toMatchObject({ status: "paid", paidUntil: w.clock.now + 3 * orgSeatUnitMs(cfg, 3) });
    expect((await handleOrgInviteCreate(w.od, ORG, inviteFor(MM.seatId, w.clock.now))).status).toBe(200);
  });

  it("the gate allows the essentials on every state", async () => {
    const org = { orgId: ORG, name: "acme", genesisHash: "", planTier: "business", seatLimit: 10, paidUntil: null, createdAt: 0, trialEndsAt: 1000, paidSeats: 0 };
    expect(orgPlanGate(cfg, org, 500, "new-seat", 9)).toBeNull();
    expect(orgPlanGate(cfg, org, 500, "new-seat", 10)).toBe("org-seat-limit");
    for (const a of ["new-seat", "raise-role", "add-server", "add-admin", "start-connector"] as const) expect(orgPlanGate(cfg, org, 2000, a)).toBe("org-plan-lapsed");
  });

  it("the org's overage block tops up its pooled egress", async () => {
    const w = await world();
    const r = await spend(w, mint(5), undefined, "overage");
    expect(r.body).toMatchObject({ for: "overage", credited: 5, topUpBytes: 100 * GB });
    const egress = orgEgressBytesFor(w.od.store, cfg);
    expect(await egress("acme", w.clock.now)).toBe(1000 * GB);
    expect(await egress("nobody", w.clock.now)).toBeNull();
    const v = await meterRecord({ meter: w.rd.meter, tiers: w.rd.tiers, orgEgressBytes: egress, now: () => w.clock.now }, "acme", "egress", 900 * GB);
    expect(v).toMatchObject({ over: false, allowance: 1100 * GB, action: "allow" });
    const over = await meterRecord({ meter: w.rd.meter, tiers: w.rd.tiers, orgEgressBytes: egress, now: () => w.clock.now }, "acme", "egress", 300 * GB);
    expect(over).toMatchObject({ over: true, action: "throttle" });
    w.clock.now = T0 + 40 * DAY;
    expect(await egress("acme", w.clock.now)).toBeNull();
  });
});

describe("org plan attestation", () => {
  it("is CA-signed over the org's state", async () => {
    const w = await world();
    const ca = { keypair: { privateKey: new Uint8Array(32).fill(9), publicKey: ed.getPublicKey(new Uint8Array(32).fill(9)) } };
    const r = await handleOrgPlanAttestation({ ...w.od, ca: ca as never }, ORG);
    const a = parseOrgPlanAttestation(r.body)!;
    expect(a).toMatchObject({ orgId: ORG, status: "trial", seatLimit: 10, paidSeats: 0 });
    expect(ed.verify(Buffer.from(a.signatures[0]!.sig, "hex"), canonicalOrgPlanAttestation(a), ca.keypair.publicKey)).toBe(true);
    expect((await handleOrgPlanAttestation({ ...w.od, ca: ca as never }, "ab".repeat(16))).status).toBe(404);
  });
});

describe("the org voucher wallet", () => {
  const sealed = (version: number) => sealOrgVoucherWallet(new Uint8Array(32).fill(3), ORG, 1, version, emptyOrgVoucherWallet(3, 10));
  const put = (w: World, version: number, signer = A, mutate: (b: any) => void = () => {}) => {
    const blob = sealed(version);
    const write = orgWalletWriteFor(ORG, blob, w.clock.now);
    const body: any = { blob, write, approvals: [approve(signer, canonicalOrgWalletWrite(write), 1, w.clock.now)] };
    mutate(body);
    return handleOrgWalletPut({ ...w.od, wallets: w.wallets }, ORG, JSON.stringify(body));
  };

  it("stores a write one org admin approved, compare-and-set on version", async () => {
    const w = await world();
    expect((await handleOrgWalletGet({ ...w.od, wallets: w.wallets }, ORG)).status).toBe(404);
    expect((await put(w, 1)).status).toBe(200);
    const got = await handleOrgWalletGet({ ...w.od, wallets: w.wallets }, ORG);
    expect(got.body).toMatchObject({ version: 1, keyVersion: 1 });
    const conflict = await put(w, 1);
    expect(conflict.status).toBe(409);
    expect((conflict.body as { wallet: { version: number } }).wallet.version).toBe(1);
    expect((await put(w, 2)).status).toBe(200);
  });

  it("refuses a write that is not an org admin's, or doesn't describe the blob", async () => {
    const w = await world();
    expect(code(await put(w, 1, MM))).toMatch(/^org-/);
    expect((await put(w, 1, A, (b) => (b.write.blobSha256 = "0".repeat(64)))).status).toBe(400);
    expect((await put(w, 1, A, (b) => (b.approvals = []))).status).toBe(403);
    expect((await put(w, 1, A, (b) => (b.blob.extra = 1))).status).toBe(400);
  });
});

describe("voucher exchange", () => {
  it("spends old vouchers for as many fresh blind signatures, all or nothing", async () => {
    const w = await world();
    const old = mint(2);
    const reqs = [newVoucherRequest(vkey), newVoucherRequest(vkey)];
    const r = await handleVoucherExchange(w.rd, { v: 1, k: vkey.keyId, vouchers: old, blinded: reqs.map((q) => q.blinded) });
    expect(r.status).toBe(200);
    const fresh = reqs.map((q, i) => finalizeVoucher(vkey, q.pending, (r.body as { sigs: string[] }).sigs[i]!));
    expect(code(await spend(w, [old[0]!]))).toBe("voucher-spent");
    const mixed = [mint(1)[0]!, old[1]!];
    const again = await handleVoucherExchange(w.rd, { v: 1, k: vkey.keyId, vouchers: mixed, blinded: [newVoucherRequest(vkey).blinded, newVoucherRequest(vkey).blinded] });
    expect(code(again)).toBe("voucher-spent");
    // The unspent one of the refused pair still pays.
    expect((await spend(w, [mixed[0]!])).status).toBe(200);
    expect((await spend(w, fresh)).status).toBe(200);
    expect(code(await handleVoucherExchange(w.rd, { v: 1, k: vkey.keyId, vouchers: mint(1), blinded: [] }))).toBe("malformed");
  });

  it("goes through the OHTTP relay like a spend", () => {
    expect(isOhttpTargetAllowed("POST", "flagshipserver.com", "/api/vouchers/exchange", "flagshipserver.com", "boot.flagshipserver.com")).toBe(true);
  });
});
