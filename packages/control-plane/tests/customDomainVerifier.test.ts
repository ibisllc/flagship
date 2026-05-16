import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  cnameTargetsStub,
  userStub,
  runCustomDomainVerificationPass,
  GIVEUP_MS,
  REVERIFY_INTERVAL_MS,
  type VerifierDeps,
} from "../src/customDomainVerifier.js";

const USER = "harry";
const APP = "harry-game1";
const FQDN = "shop.example.com";
const POD = "home.harry.flagship.services";

function harness(opts: {
  cname?: string[];
  now: number;
}) {
  const s = new InMemoryStorage();
  const pushed: Array<{ op: string; fqdn: string; pod?: string }> = [];
  const deps: VerifierDeps = {
    customDomainOrders: s.customDomainOrders,
    servers: s.servers,
    resolveCname: async () => opts.cname ?? [],
    pushRedirection: async (op, fqdn, podCanonical) => {
      pushed.push({ op, fqdn, pod: podCanonical });
    },
    now: () => opts.now,
  };
  return { s, deps, pushed };
}

async function seedPod(s: InMemoryStorage, revoked = false) {
  await s.servers.put({
    serverDomain: POD,
    username: USER,
    identityPubKeyHex: "11".repeat(32),
    registeredAt: 1,
    ...(revoked ? { revokedAt: 2 } : {}),
  });
}

async function pendingOrder(s: InMemoryStorage, createdAt: number) {
  await s.customDomainOrders.upsert({
    appId: APP, userId: USER, fqdn: FQDN, status: "pending",
    lastChanged: createdAt, failCount: 0, createdAt, updatedAt: createdAt,
  });
}

describe("cnameTargetsStub / userStub", () => {
  it("stub is <user>.flagship.services; match is exact within the chain", () => {
    expect(userStub("Harry")).toBe("harry.flagship.services");
    expect(cnameTargetsStub(["harry.flagship.services"], "harry")).toBe(true);
    expect(cnameTargetsStub(["x.cdn.net", "harry.flagship.services"], "harry")).toBe(true);
    expect(cnameTargetsStub(["mallory.flagship.services"], "harry")).toBe(false);
    expect(cnameTargetsStub([], "harry")).toBe(false);
  });
});

describe("runCustomDomainVerificationPass — pending", () => {
  it("CNAME ok + live pod → active, podCanonical stored, pushes add", async () => {
    const { s, deps, pushed } = harness({ cname: [userStub(USER)], now: 1_000 });
    await seedPod(s);
    await pendingOrder(s, 1_000);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r.activated).toBe(1);
    const row = await s.customDomainOrders.get(USER, APP);
    expect(row).toMatchObject({ status: "active", podCanonical: POD, failCount: 0 });
    expect(pushed).toEqual([{ op: "add", fqdn: FQDN, pod: POD }]);
  });

  it("CNAME ok but NO live pod → stays pending, no push", async () => {
    const { s, deps, pushed } = harness({ cname: [userStub(USER)], now: 1_000 });
    await seedPod(s, /* revoked */ true);
    await pendingOrder(s, 1_000);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r.stillPending).toBe(1);
    expect((await s.customDomainOrders.get(USER, APP))?.status).toBe("pending");
    expect(pushed).toEqual([]);
  });

  it("CNAME wrong, within grace → stays pending, failCount bumps", async () => {
    const { s, deps } = harness({ cname: ["mallory.flagship.services"], now: 5_000 });
    await seedPod(s);
    await pendingOrder(s, 5_000);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r.stillPending).toBe(1);
    const row = await s.customDomainOrders.get(USER, APP);
    expect(row?.status).toBe("pending");
    expect(row?.failCount).toBe(1);
  });

  it("CNAME wrong, past 24h give-up → failed + delete push", async () => {
    const created = 1_000_000;
    const { s, deps, pushed } = harness({ cname: [], now: created + GIVEUP_MS + 1 });
    await seedPod(s);
    await pendingOrder(s, created);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r.failed).toBe(1);
    expect((await s.customDomainOrders.get(USER, APP))?.status).toBe("failed");
    expect(pushed).toEqual([{ op: "delete", fqdn: FQDN, pod: undefined }]);
  });
});

describe("runCustomDomainVerificationPass — active #82 sweep", () => {
  async function activeOrder(s: InMemoryStorage, updatedAt: number, failCount = 0) {
    await s.customDomainOrders.upsert({
      appId: APP, userId: USER, fqdn: FQDN, status: "active", podCanonical: POD,
      lastChanged: updatedAt, failCount, createdAt: 1, updatedAt,
    });
  }

  it("not due (< 12h since updatedAt) → skipped", async () => {
    const { s, deps } = harness({ cname: [], now: 100 + REVERIFY_INTERVAL_MS - 1 });
    await seedPod(s);
    await activeOrder(s, 100);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r).toMatchObject({ reverified: 0, invalidated: 0 });
    expect((await s.customDomainOrders.get(USER, APP))?.status).toBe("active");
  });

  it("due + CNAME ok → reverified, failCount self-heals to 0", async () => {
    const { s, deps } = harness({ cname: [userStub(USER)], now: 100 + REVERIFY_INTERVAL_MS });
    await seedPod(s);
    await activeOrder(s, 100, /* failCount */ 2);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r.reverified).toBe(1);
    expect((await s.customDomainOrders.get(USER, APP))?.failCount).toBe(0);
  });

  it("due + CNAME broken: bumps failCount; invalidates on the 3rd → failed + delete", async () => {
    // failCount already 2; this due-fail makes it 3 → invalidate.
    const { s, deps, pushed } = harness({ cname: [], now: 100 + REVERIFY_INTERVAL_MS });
    await seedPod(s);
    await activeOrder(s, 100, /* failCount */ 2);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r.invalidated).toBe(1);
    expect((await s.customDomainOrders.get(USER, APP))?.status).toBe("failed");
    expect(pushed).toEqual([{ op: "delete", fqdn: FQDN, pod: undefined }]);
  });

  it("due + CNAME broken but only 1st/2nd fail → stays active (not yet invalidated)", async () => {
    const { s, deps, pushed } = harness({ cname: [], now: 100 + REVERIFY_INTERVAL_MS });
    await seedPod(s);
    await activeOrder(s, 100, /* failCount */ 0);
    const r = await runCustomDomainVerificationPass(deps);
    expect(r.invalidated).toBe(0);
    const row = await s.customDomainOrders.get(USER, APP);
    expect(row?.status).toBe("active");
    expect(row?.failCount).toBe(1);
    expect(pushed).toEqual([]);
  });
});
