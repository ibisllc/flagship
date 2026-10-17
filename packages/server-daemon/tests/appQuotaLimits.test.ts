/**
 * The arithmetic of per-app disk limits (appQuota/limits.ts): the host-disk
 * brake, image sizes, reserved blocks, when a folder counts as full, and the
 * Postgres write stages.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_IMAGE_BYTES,
  filesFull,
  filesRecovered,
  imageTarget,
  needsEffective,
  nextBrake,
  nextPgStage,
  pgHysteresis,
  pgSlack,
  ballastTarget,
  shouldGrow,
  splitStores,
  type PgReading,
} from "../src/appQuota/limits.js";
import { withQuotaUsage } from "../src/appQuota/usage.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const disk = (usedPct: number) => ({ totalBytes: 100 * GiB, availBytes: (100 - usedPct) * GiB });

describe("the host-disk brake", () => {
  it("comes on at 90 %, goes read-only at 95 %, and lifts only under 88 %", () => {
    expect(nextBrake("off", disk(80))).toBe("off");
    expect(nextBrake("off", disk(90))).toBe("on");
    expect(nextBrake("on", disk(89))).toBe("on");
    expect(nextBrake("on", disk(87))).toBe("off");
    expect(nextBrake("off", disk(96))).toBe("hard");
    expect(nextBrake("hard", disk(92))).toBe("on");
    expect(nextBrake("hard", disk(89))).toBe("on");
    expect(nextBrake("hard", disk(50))).toBe("off");
  });

  it("reads an empty disk as off", () => {
    expect(nextBrake("on", { totalBytes: 0, availBytes: 0 })).toBe("off");
  });
});

describe("files images", () => {
  it("are the budget, floored at 64 MiB, or 90 % of the disk with no limit", () => {
    expect(imageTarget(2 * GiB, 100 * GiB)).toBe(2 * GiB);
    expect(imageTarget(1, 100 * GiB)).toBe(MIN_IMAGE_BYTES);
    expect(imageTarget(null, 100 * GiB)).toBe(90 * GiB);
    expect(imageTarget(null, 0)).toBe(MIN_IMAGE_BYTES);
    expect(imageTarget(1.5 * MiB, 0)).toBe(MIN_IMAGE_BYTES);
    expect(imageTarget(100 * MiB + 1, 0)).toBe(101 * MiB);
  });

  it("grow only by a real step", () => {
    expect(shouldGrow(2 * GiB, 2 * GiB + 10 * MiB)).toBe(false);
    expect(shouldGrow(2 * GiB, 2 * GiB + 200 * MiB)).toBe(true);
    expect(shouldGrow(100 * GiB, 103 * GiB)).toBe(false);
    expect(shouldGrow(100 * GiB, 106 * GiB)).toBe(true);
    expect(shouldGrow(2 * GiB, 1 * GiB)).toBe(false);
  });

  it("ballast takes what is above the limit, or everything free under the brake", () => {
    const fs = { capacityBytes: 1000 * MiB, ballastBytes: 100 * MiB, availBytes: 600 * MiB };
    expect(ballastTarget({ ...fs, limitBytes: null, freeze: false })).toBe(0);
    expect(ballastTarget({ ...fs, limitBytes: 800 * MiB, freeze: false })).toBe(200 * MiB);
    expect(ballastTarget({ ...fs, limitBytes: 5000 * MiB, freeze: false })).toBe(0);
    expect(ballastTarget({ ...fs, limitBytes: 0, freeze: false })).toBe(1000 * MiB);
    expect(ballastTarget({ ...fs, limitBytes: 800 * MiB, freeze: true })).toBe(700 * MiB);
    expect(ballastTarget({ ...fs, limitBytes: 1000 * MiB - 5000, freeze: false })).toBe(4096);
  });

  it("count as full under 1 MiB (or 0.5 %) left, and have room again at 2 %", () => {
    expect(filesFull(512 * 1024, 100 * MiB)).toBe(true);
    expect(filesFull(2 * MiB, 100 * MiB)).toBe(false);
    expect(filesFull(4 * MiB, 1000 * MiB)).toBe(true);
    expect(filesRecovered(3 * MiB, 100 * MiB)).toBe(false);
    expect(filesRecovered(4 * MiB, 100 * MiB)).toBe(true);
    expect(filesRecovered(19 * MiB, 1000 * MiB)).toBe(false);
    expect(filesRecovered(20 * MiB, 1000 * MiB)).toBe(true);
  });
});

describe("database stages", () => {
  const base: PgReading = {
    stage: "open",
    rawBytes: 0,
    effectiveBytes: 0,
    limitBytes: 100 * MiB,
    brake: "off",
    blockedAtBytes: null,
  };

  it("block at the limit and stay open under it", () => {
    expect(nextPgStage({ ...base, rawBytes: 99 * MiB, effectiveBytes: 99 * MiB })).toBe("open");
    expect(nextPgStage({ ...base, rawBytes: 100 * MiB, effectiveBytes: 100 * MiB })).toBe("blocked");
  });

  it("count reusable room: a full file with free space inside isn't over", () => {
    expect(nextPgStage({ ...base, rawBytes: 120 * MiB, effectiveBytes: 80 * MiB })).toBe("open");
  });

  it("give writes back only below the limit less the hysteresis", () => {
    const blocked = { ...base, stage: "blocked" as const, blockedAtBytes: 100 * MiB };
    expect(nextPgStage({ ...blocked, rawBytes: 100 * MiB, effectiveBytes: 99.5 * MiB })).toBe("blocked");
    expect(nextPgStage({ ...blocked, rawBytes: 100 * MiB, effectiveBytes: 98 * MiB })).toBe("open");
  });

  it("stop a database that keeps growing while blocked, until it's back under", () => {
    const blocked = { ...base, stage: "blocked" as const, blockedAtBytes: 100 * MiB };
    expect(nextPgStage({ ...blocked, rawBytes: 150 * MiB, effectiveBytes: 150 * MiB })).toBe("blocked");
    expect(nextPgStage({ ...blocked, rawBytes: 170 * MiB, effectiveBytes: 170 * MiB })).toBe("stopped");
    const stopped = { ...blocked, stage: "stopped" as const };
    expect(nextPgStage({ ...stopped, rawBytes: 170 * MiB, effectiveBytes: 99.5 * MiB })).toBe("stopped");
    expect(nextPgStage({ ...stopped, rawBytes: 170 * MiB, effectiveBytes: 90 * MiB })).toBe("open");
  });

  it("block every database under the brake, whatever its limit, and reopen when it lifts", () => {
    expect(nextPgStage({ ...base, limitBytes: null, brake: "on", rawBytes: MiB, effectiveBytes: MiB })).toBe("blocked");
    expect(
      nextPgStage({ ...base, stage: "blocked", limitBytes: null, brake: "on", rawBytes: MiB, effectiveBytes: MiB, blockedAtBytes: MiB }),
    ).toBe("blocked");
    expect(
      nextPgStage({ ...base, stage: "blocked", limitBytes: null, brake: "off", rawBytes: MiB, effectiveBytes: MiB, blockedAtBytes: MiB }),
    ).toBe("open");
  });

  it("only measure free space near the limit", () => {
    expect(needsEffective("open", 99 * MiB, 100 * MiB)).toBe(false);
    expect(needsEffective("open", 100 * MiB, 100 * MiB)).toBe(true);
    expect(needsEffective("blocked", 99.5 * MiB, 100 * MiB)).toBe(true);
    expect(needsEffective("blocked", 50 * MiB, 100 * MiB)).toBe(false);
    expect(needsEffective("open", 500 * MiB, null)).toBe(false);
  });

  it("have a floor on hysteresis and slack", () => {
    expect(pgHysteresis(10 * MiB)).toBe(MiB);
    expect(pgHysteresis(10 * GiB)).toBe(Math.floor(10 * GiB * 0.01));
    expect(pgSlack(null)).toBe(64 * MiB);
    expect(pgSlack(10 * GiB)).toBe(GiB);
  });
});

describe("splitting an app's room between its stores", () => {
  const base = { filesBudget: 0, postgresBudget: 0, filesUsed: 0, postgresUsed: 0, hasFiles: true, hasPostgres: true };
  it("follows what each holds, but gives each store at least a quarter of the growth", () => {
    expect(splitStores({ ...base, filesBudget: 0, postgresBudget: 110, postgresUsed: 10 })).toEqual({ filesBytes: 25, postgresBytes: 85 });
    expect(splitStores({ ...base, filesBudget: 150, postgresBudget: 50, filesUsed: 50, postgresUsed: 50 })).toEqual({ filesBytes: 100, postgresBytes: 100 });
    expect(splitStores({ ...base, filesBudget: 1000, postgresBudget: 0, filesUsed: 900, postgresUsed: 0 })).toEqual({ filesBytes: 900 + 75, postgresBytes: 25 });
    expect(splitStores({ ...base, filesBudget: 10, postgresBudget: 10 })).toEqual({ filesBytes: 10, postgresBytes: 10 });
  });
  it("gives a store the app doesn't have nothing, and never less than what's held", () => {
    expect(splitStores({ ...base, hasFiles: false, filesBudget: 40, postgresBudget: 60, postgresUsed: 20 })).toEqual({ filesBytes: 0, postgresBytes: 100 });
    expect(splitStores({ ...base, hasPostgres: false, filesBudget: 60, postgresBudget: 40, filesUsed: 20 })).toEqual({ filesBytes: 100, postgresBytes: 0 });
    expect(splitStores({ ...base, filesBudget: 10, postgresBudget: 10, filesUsed: 30, postgresUsed: 30 })).toEqual({ filesBytes: 30, postgresBytes: 30 });
  });
});

describe("the backup cap's sizes", () => {
  it("take the quota manager's readings where it has them", () => {
    const perApp = new Map([
      ["a-one", { postgresBytes: 10, filesBytes: 100, treeBytes: 5, totalBytes: 120 }],
      ["a-two", { postgresBytes: 20, filesBytes: 0, treeBytes: 5, totalBytes: 30 }],
    ]);
    const out = withQuotaUsage(perApp, new Map([["a-one", { filesBytes: 140, postgresBytes: null }]]))!;
    expect(out.get("a-one")).toEqual({ postgresBytes: 10, filesBytes: 140, treeBytes: 5, totalBytes: 160 });
    expect(out.get("a-two")).toEqual(perApp.get("a-two"));
    expect(withQuotaUsage(null, new Map())).toBeNull();
  });
});
