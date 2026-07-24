import { describe, expect, it } from "vitest";
import { verifyUpdateOrder, type UpdateOrder } from "@flagship/protocol";
import { InMemoryStorage, type DemoUserRecord } from "@flagship/storage";
import { deriveDemoAdminRoot } from "../src/demoIdentity.js";
import { handleOrderDemoUpdate } from "../src/demoUsers.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

const USERNAME = "update-drill";
const FQDN = "home.update-drill.flagship.services";
const KEK = new Uint8Array(32).fill(9);
const STK = "cd".repeat(32);
const FROM = "1".repeat(40);
const TARGET = "2".repeat(40);

function demoRow(patch: Partial<DemoUserRecord> = {}): DemoUserRecord {
  return {
    username: USERNAME,
    idempotencyKey: "demo-test",
    snapshotId: "snapshot-1",
    isoR2Key: null,
    ttlIdleMinutes: 30,
    region: "fsn1",
    size: "cpx11",
    activeServerId: "154819930",
    activeServerIp: "192.0.2.9",
    image: "debian-12",
    activeServerFqdn: FQDN,
    lastActivityAt: 10,
    state: "ready",
    createdAt: 1,
    provisionPhase: "live",
    provisionPhaseAt: 9,
    provisionLastError: null,
    ...patch,
  };
}

async function setup(patch: Partial<DemoUserRecord> = {}): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.demoUsers.insert(demoRow(patch));
  await s.servers.put({
    serverDomain: FQDN,
    username: USERNAME,
    identityPubKeyHex: STK,
    registeredAt: 2,
  });
  return s;
}

function deps(s: InMemoryStorage, now = 1000) {
  return {
    storage: s.demoUsers,
    servers: s.servers,
    secretMailbox: s.secretMailbox,
    demoIrkKek: KEK,
    now: () => now,
  };
}

describe("handleOrderDemoUpdate", () => {
  it("signs an UpdateOrder with the demo admin root and deposits the carrier the box will consume", async () => {
    const s = await setup();
    const res = await handleOrderDemoUpdate(deps(s), "UPDATE-DRILL", {
      targetCommit: TARGET.toUpperCase(),
      fromCommit: FROM,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      serverDomain: string;
      order: UpdateOrder;
      signerAdminRootPubHex: string;
    };
    expect(body.ok).toBe(true);
    expect(body.serverDomain).toBe(FQDN);
    expect(body.order.targetCommit).toBe(TARGET); // normalized to lowercase
    expect(body.order.fromCommit).toBe(FROM);

    // The deposited carrier is exactly what the box GETs, and its signature
    // verifies under the DEMO ADMIN ROOT (the key the box pins) — proving the
    // order carries real admin authority, not a stand-in.
    const admin = deriveDemoAdminRoot(KEK, USERNAME);
    expect(body.signerAdminRootPubHex).toBe(bytesToHex(admin.publicKey));

    const row = await s.secretMailbox.consumeUpdateDeposit(FQDN, 2000);
    expect(row).toBeTruthy();
    const carrier = JSON.parse(new TextDecoder().decode(hexToBytes(row!.sealedHex))) as {
      order: UpdateOrder;
      signature: string;
    };
    expect(carrier.order).toEqual(body.order);
    expect(
      verifyUpdateOrder(carrier.order, hexToBytes(carrier.signature), admin.publicKey),
    ).toBe(true);
    // A DIFFERENT account's admin root must NOT verify it (per-account scoping).
    const stranger = deriveDemoAdminRoot(KEK, "someone-else");
    expect(
      verifyUpdateOrder(carrier.order, hexToBytes(carrier.signature), stranger.publicKey),
    ).toBe(false);
  });

  it("rejects a non-ready demo, an unknown user, bad shas, and a no-op", async () => {
    const provisioning = await setup({ state: "provisioning" });
    expect((await handleOrderDemoUpdate(deps(provisioning), USERNAME, {
      targetCommit: TARGET, fromCommit: FROM,
    })).status).toBe(409);

    const ready = await setup();
    expect((await handleOrderDemoUpdate(deps(ready), "nobody", {
      targetCommit: TARGET, fromCommit: FROM,
    })).status).toBe(404);
    expect((await handleOrderDemoUpdate(deps(ready), USERNAME, {
      targetCommit: "nothex", fromCommit: FROM,
    })).status).toBe(400);
    expect((await handleOrderDemoUpdate(deps(ready), USERNAME, {
      targetCommit: TARGET, fromCommit: TARGET,
    })).status).toBe(400);
  });

  it("rejects when the demo server is not registered", async () => {
    const s = new InMemoryStorage();
    await s.demoUsers.insert(demoRow());
    // No servers.put → not registered.
    expect((await handleOrderDemoUpdate(deps(s), USERNAME, {
      targetCommit: TARGET, fromCommit: FROM,
    })).status).toBe(409);
  });
});
