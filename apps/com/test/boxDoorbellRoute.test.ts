/**
 * POST /api/daemon-status answers with the box doorbell (packages/control-plane
 * boxDoorbell.ts): the lanes with something waiting for this box and a digest of
 * the lists it polls. Over the real route and the production D1 adapter.
 */
import { describe, expect, it } from "vitest";
import { tryControlPlane } from "../src/controlPlaneRoutes.js";
import { buildWorld, daemonStatusRequest } from "../../../scripts/cpuHarness.js";

async function beat(w: Awaited<ReturnType<typeof buildWorld>>) {
  const res = await tryControlPlane(daemonStatusRequest(w), w.env);
  expect(res!.status).toBe(200);
  return (await res!.json()) as { ok: boolean; serverOrder: unknown; doorbell?: { v: number; lanes: string[]; stamps: Record<string, string> } };
}

describe("daemon-status reply", () => {
  it("carries a doorbell: empty lanes and two digests", async () => {
    const w = await buildWorld();
    try {
      const body = await beat(w);
      expect(body.ok).toBe(true);
      expect(body.doorbell?.v).toBe(1);
      expect(body.doorbell?.lanes).toEqual([]);
      expect(Object.keys(body.doorbell!.stamps).sort()).toEqual(["aliases", "rotations"]);
    } finally {
      w.close();
    }
  });

  it("rings the lane of a waiting deposit and changes the alias digest when the list moves", async () => {
    const w = await buildWorld();
    try {
      const before = (await beat(w)).doorbell!;
      const server = w.servers[0]!;
      await w.seed.secretMailbox.putUpdateDeposit({
        serverDomain: server.domain,
        username: "plucky-avocet",
        requestNonceHex: "ab".repeat(32),
        stkPubHex: "11".repeat(32),
        sealedHex: "cd".repeat(8),
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 600_000,
      });
      await w.seed.userServiceAliases.upsert({ username: "plucky-avocet", serviceId: "blog", displayLabel: "blog", createdAt: 1, updatedAt: 1 });
      const after = (await beat(w)).doorbell!;
      expect(after.lanes).toEqual(["update"]);
      expect(after.stamps.aliases).not.toBe(before.stamps.aliases);
      expect(after.stamps.rotations).toBe(before.stamps.rotations);
    } finally {
      w.close();
    }
  });

  it("another box of the account does not ring this one's lane", async () => {
    const w = await buildWorld();
    try {
      await w.seed.secretMailbox.putUpdateDeposit({
        serverDomain: w.servers[1]!.domain,
        username: "plucky-avocet",
        requestNonceHex: "ab".repeat(32),
        stkPubHex: "11".repeat(32),
        sealedHex: "cd".repeat(8),
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 600_000,
      });
      expect((await beat(w)).doorbell!.lanes).toEqual([]);
    } finally {
      w.close();
    }
  });
});
