import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planBuild, type BuildSpec } from "../src/buildPlan.js";
import { materializePlan } from "../src/imageBuilder.js";

const baseSpec: BuildSpec = {
  userId: "u1",
  newServerId: "srv-1",
  irkPublicKey: new Uint8Array(32).fill(1),
  bakPublicKey: new Uint8Array(32).fill(2),
  swkProvisioningTokenHash: new Uint8Array(32).fill(3),
  wifi: { ssid: "Home", psk: "secret123" },
  shareRatio: 0.5,
  totalDiskGb: 100,
  issuedAt: 1_700_000_000_000,
};

describe("materializePlan", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "flagship-build-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes build-plan.json and a rootfs tree", async () => {
    const plan = planBuild(baseSpec);
    const artifacts = await materializePlan(plan, tmp);

    const planJson = JSON.parse(await readFile(artifacts.planJsonPath, "utf8"));
    expect(planJson.spec.newServerId).toBe("srv-1");
    expect(planJson.spec.userId).toBe("u1");
    expect(planJson.spec.irkPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(planJson.partitions.length).toBeGreaterThanOrEqual(2);

    // configFiles + 4 NixOS files (flake, configuration, containers, hardware).
    expect(artifacts.configFilePaths.length).toBe(plan.configFiles.length + 4);
    for (const p of artifacts.configFilePaths) {
      const s = await stat(p);
      expect(s.isFile()).toBe(true);
    }
  });

  it("respects file modes for sensitive configs (server.json is 0600)", async () => {
    const plan = planBuild(baseSpec);
    const artifacts = await materializePlan(plan, tmp);
    const serverJson = artifacts.configFilePaths.find((p) => p.endsWith("server.json"))!;
    const s = await stat(serverJson);
    // mask off type bits
    expect(s.mode & 0o777).toBe(0o600);
  });
});
