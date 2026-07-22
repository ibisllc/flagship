import { describe, expect, it, vi } from "vitest";
import { verifyPhoneOrder } from "@flagship/protocol";
import { InMemoryDemoUsersStorage, type DemoUserRecord } from "@flagship/storage";
import { deriveDemoUserIrk } from "../src/demoIdentity.js";
import { handlePairDemoUser } from "../src/demoUsers.js";
import { hexToBytes } from "../src/hex.js";

const USERNAME = "openai-build";
const FQDN = "home.openai-build.flagship.services";
const TOKEN = "ab".repeat(32);
const KEK = new Uint8Array(32).fill(7);

function demoRow(patch: Partial<DemoUserRecord> = {}): DemoUserRecord {
  return {
    username: USERNAME,
    idempotencyKey: "demo-test",
    snapshotId: "snapshot-1",
    isoR2Key: null,
    ttlIdleMinutes: 30,
    region: "fsn1",
    size: "cx22",
    activeServerId: "123",
    activeServerIp: "192.0.2.1",
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

async function setup(patch: Partial<DemoUserRecord> = {}) {
  const storage = new InMemoryDemoUsersStorage();
  await storage.insert(demoRow(patch));
  return storage;
}

describe("demo browser pairing", () => {
  it("signs and forwards an add-paired-session order, then touches activity", async () => {
    const storage = await setup();
    const postOrder = vi.fn().mockResolvedValue({ status: 204 });

    const response = await handlePairDemoUser(
      { storage, demoIrkKek: KEK, postOrder, now: () => 1234 },
      "OPENAI-BUILD",
      { token: TOKEN.toUpperCase() },
    );

    expect(response).toEqual({
      status: 200,
      body: { ok: true, fqdn: FQDN },
      headers: { "cache-control": "private, no-store" },
    });
    expect(postOrder).toHaveBeenCalledTimes(1);
    const [fqdn, envelope] = postOrder.mock.calls[0]!;
    expect(fqdn).toBe(FQDN);
    expect(envelope.request).toEqual({
      type: "add-paired-session",
      serverId: FQDN,
      token: TOKEN,
      issuedAt: 1234,
    });
    const owner = deriveDemoUserIrk(KEK, USERNAME);
    expect(
      verifyPhoneOrder(
        envelope.request,
        hexToBytes(envelope.signature),
        owner.publicKey,
      ),
    ).toBe(true);
    expect((await storage.get(USERNAME))?.lastActivityAt).toBe(1234);
  });

  it("rejects malformed tokens without contacting the box", async () => {
    const storage = await setup();
    const postOrder = vi.fn();
    const response = await handlePairDemoUser(
      { storage, demoIrkKek: KEK, postOrder },
      USERNAME,
      { token: "too-short" },
    );
    expect(response.status).toBe(400);
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("does not pair an unknown or non-ready demo", async () => {
    const storage = await setup({ state: "provisioning" });
    const postOrder = vi.fn();
    expect((await handlePairDemoUser(
      { storage, demoIrkKek: KEK, postOrder },
      "missing-demo",
      { token: TOKEN },
    )).status).toBe(404);
    expect((await handlePairDemoUser(
      { storage, demoIrkKek: KEK, postOrder },
      USERNAME,
      { token: TOKEN },
    )).status).toBe(409);
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("maps box rejection and network failure to 502", async () => {
    const storage = await setup();
    expect((await handlePairDemoUser(
      { storage, demoIrkKek: KEK, postOrder: async () => ({ status: 403 }) },
      USERNAME,
      { token: TOKEN },
    )).status).toBe(502);
    expect((await handlePairDemoUser(
      { storage, demoIrkKek: KEK, postOrder: async () => { throw new Error("offline"); } },
      USERNAME,
      { token: TOKEN },
    )).status).toBe(502);
  });
});
