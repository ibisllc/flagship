import { describe, expect, it } from "vitest";
import {
  InMemoryMeterStore,
  meterReport,
  type MeterCatalog,
  type MeterDeps,
  type MeterStore,
} from "../src/index.js";

type Plan = "basic" | "pro";
type Resource = "bandwidth" | "tokens";

const NOW = Date.UTC(2026, 9, 13, 15, 30);
const ID = "0123456789abcdef0123456789abcdef";

const CATALOG: MeterCatalog<Resource, Plan> = {
  bandwidth: {
    unit: "bytes",
    period: "month",
    plans: { basic: { allowance: 100, over: "throttle" }, pro: { allowance: 1000, over: "allow" } },
  },
  tokens: {
    unit: "tokens",
    period: "day",
    plans: { basic: { allowance: 10, over: "stop" }, pro: { allowance: 50, over: "stop" } },
  },
};

function deps(store: MeterStore = new InMemoryMeterStore(), now = () => NOW): MeterDeps<Resource, Plan> {
  return { catalog: CATALOG, store, planOf: async (a) => (a === "pro" ? "pro" : "basic"), now };
}

describe("meterReport", () => {
  it("records every item and judges each account", async () => {
    const d = deps();
    const r = await meterReport(d, {
      batchId: ID,
      items: [
        { account: "ann", resource: "bandwidth", amount: 60 },
        { account: "bo", resource: "bandwidth", amount: 120 },
        { account: "ann", resource: "tokens", amount: 4 },
      ],
    });
    expect(r.duplicate).toBe(false);
    expect(r.verdicts.map((v) => [v.account, v.resource, v.used, v.action])).toEqual([
      ["ann", "bandwidth", 60, "allow"],
      ["bo", "bandwidth", 120, "throttle"],
      ["ann", "tokens", 4, "allow"],
    ]);
    expect(r.verdicts[2]!.period).toBe("2026-10-13");
  });

  it("sums items for the same account and resource into one verdict", async () => {
    const r = await meterReport(deps(), {
      batchId: ID,
      items: [
        { account: "ann", resource: "bandwidth", amount: 30 },
        { account: "ann", resource: "bandwidth", amount: 40.7 },
      ],
    });
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0]!.used).toBe(70);
  });

  it("a retried batch is counted once and still answers with current totals", async () => {
    const d = deps();
    const report = { batchId: ID, items: [{ account: "ann", resource: "bandwidth" as const, amount: 60 }] };
    await meterReport(d, report);
    const again = await meterReport(d, report);
    expect(again.duplicate).toBe(true);
    expect(again.verdicts[0]!.used).toBe(60);
    expect((await d.store.get("ann", "bandwidth", "2026-10"))?.amount).toBe(60);
  });

  it("forgets a batch id after keepMs", async () => {
    let now = NOW;
    const d = deps(new InMemoryMeterStore(), () => now);
    const report = { batchId: ID, items: [{ account: "ann", resource: "bandwidth" as const, amount: 1 }] };
    await meterReport(d, report, { keepMs: 1000 });
    now += 1001;
    expect((await meterReport(d, report, { keepMs: 1000 })).duplicate).toBe(false);
  });

  it("a report without a batch id is counted every time (the pre-batch-id wire)", async () => {
    const d = deps();
    const report = { items: [{ account: "ann", resource: "bandwidth" as const, amount: 10 }] };
    await meterReport(d, report);
    const r = await meterReport(d, report);
    expect(r.duplicate).toBe(false);
    expect(r.verdicts[0]!.used).toBe(20);
  });

  it("refuses a malformed batch id, a bad amount, an unknown resource, or a store without addBatch", async () => {
    const one = [{ account: "ann", resource: "bandwidth" as const, amount: 1 }];
    await expect(meterReport(deps(), { batchId: "short", items: one })).rejects.toThrow(RangeError);
    await expect(meterReport(deps(), { batchId: `${ID}!`, items: one })).rejects.toThrow(RangeError);
    await expect(
      meterReport(deps(), { items: [{ account: "ann", resource: "bandwidth", amount: -1 }] }),
    ).rejects.toThrow(RangeError);
    await expect(
      meterReport(deps(), { items: [{ account: "ann", resource: "nope" as Resource, amount: 1 }] }),
    ).rejects.toThrow(/unknown metered resource/);
    const plain = new InMemoryMeterStore();
    const noBatch: MeterStore = { add: plain.add.bind(plain), get: plain.get.bind(plain) };
    await expect(meterReport(deps(noBatch), { batchId: ID, items: one })).rejects.toThrow(/addBatch/);
    expect(await meterReport(deps(noBatch), { items: one })).toMatchObject({ duplicate: false });
  });

  it("looks plans up once per batch through plansOf, falling back to planOf", async () => {
    const asked: string[][] = [];
    const single: string[] = [];
    const d: MeterDeps<Resource, Plan> = {
      ...deps(),
      planOf: async (a) => {
        single.push(a);
        return "basic";
      },
      plansOf: async (accounts) => {
        asked.push(accounts);
        return new Map([["pro", "pro" as const]]);
      },
    };
    const r = await meterReport(d, {
      batchId: ID,
      items: [
        { account: "pro", resource: "bandwidth", amount: 500 },
        { account: "ann", resource: "bandwidth", amount: 1 },
        { account: "pro", resource: "tokens", amount: 1 },
      ],
    });
    expect(asked).toEqual([["pro", "ann"]]);
    expect(single).toEqual(["ann"]);
    expect(r.verdicts.map((v) => v.plan)).toEqual(["pro", "basic", "pro"]);
  });
});
