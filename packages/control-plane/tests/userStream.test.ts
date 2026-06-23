import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  computePodInventoryCursor,
  handleUserStream,
  buildPodInventory,
  type PodInventory,
  type PodInventoryDeps,
  type UserStreamDeps,
} from "../src/index.js";

const NOW = 1_700_000_000_000;

function deps(storage: InMemoryStorage, over: Partial<PodInventoryDeps> = {}): PodInventoryDeps {
  return {
    daemonStatus: storage.daemonStatus,
    servers: storage.servers,
    routing: storage.routing,
    authCodes: storage.authCodes,
    provisionStatus: storage.provisionStatus,
    secretMailbox: storage.secretMailbox,
    now: () => NOW,
    ...over,
  };
}

async function seedServer(storage: InMemoryStorage, domain = "home1.harry.flagship.services") {
  await storage.servers.put({
    serverDomain: domain,
    username: "harry",
    identityPubKeyHex: "22".repeat(32),
    registeredAt: NOW - 50_000,
  });
}

// A minimal, hand-built inventory so the cursor tests are independent of the
// (separately-tested) builder. computePodInventoryCursor is pure over this.
function baseInventory(): PodInventory {
  return {
    username: "harry",
    pods: [
      {
        serverDomain: "home1.harry.flagship.services",
        identityPubKey: "22".repeat(32),
        registeredAt: NOW - 50_000,
        revokedAt: null,
        routingTarget: null,
        lastReported: NOW - 1000,
        currentCert: { sha256: "ab".repeat(32), validUntil: NOW + 90_000, issuer: "YR2" },
        signedStatus: null,
        appsServed: ["blog", "photos"],
        pendingRequests: [
          { id: "n1", type: "unlock-key", issuedAt: NOW - 500, expiresAt: NOW + 300_000 },
        ],
        state: "online",
      },
    ],
    pending: [
      {
        orderRef: "ff".repeat(32),
        serverName: "home2",
        fqdn: "home2.harry.flagship.services",
        phase: "installing",
        createdAt: NOW - 2000,
        state: "pending",
      },
    ],
    fetchedAt: NOW,
  };
}

// Deep clone so a mutation in one test can't leak into the base shape.
function clone(inv: PodInventory): PodInventory {
  return JSON.parse(JSON.stringify(inv)) as PodInventory;
}

describe("computePodInventoryCursor", () => {
  it("identical state → identical cursor", () => {
    expect(computePodInventoryCursor(baseInventory())).toBe(
      computePodInventoryCursor(baseInventory()),
    );
  });

  it("a fetchedAt-only difference → SAME cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.fetchedAt = a.fetchedAt + 123_456;
    expect(computePodInventoryCursor(b)).toBe(computePodInventoryCursor(a));
  });

  it("appsServed order-only difference → SAME cursor (deterministic sort)", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pods[0]!.appsServed = ["photos", "blog"]; // reversed
    expect(computePodInventoryCursor(b)).toBe(computePodInventoryCursor(a));
  });

  it("lastReported change → DIFFERENT cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pods[0]!.lastReported = NOW;
    expect(computePodInventoryCursor(b)).not.toBe(computePodInventoryCursor(a));
  });

  it("currentCert.sha256 change → DIFFERENT cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pods[0]!.currentCert!.sha256 = "cd".repeat(32);
    expect(computePodInventoryCursor(b)).not.toBe(computePodInventoryCursor(a));
  });

  it("appsServed membership change → DIFFERENT cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pods[0]!.appsServed = ["blog"];
    expect(computePodInventoryCursor(b)).not.toBe(computePodInventoryCursor(a));
  });

  it("a new pendingRequest → DIFFERENT cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pods[0]!.pendingRequests.push({
      id: "n2",
      type: "entitlement",
      issuedAt: NOW,
      expiresAt: NOW + 300_000,
    });
    expect(computePodInventoryCursor(b)).not.toBe(computePodInventoryCursor(a));
  });

  it("a pending order's phase change → DIFFERENT cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pending[0]!.phase = "live";
    expect(computePodInventoryCursor(b)).not.toBe(computePodInventoryCursor(a));
  });

  it("a new pod → DIFFERENT cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pods.push({ ...clone(a).pods[0]!, serverDomain: "home3.harry.flagship.services" });
    expect(computePodInventoryCursor(b)).not.toBe(computePodInventoryCursor(a));
  });

  it("a removed order → DIFFERENT cursor", () => {
    const a = baseInventory();
    const b = clone(a);
    b.pending = [];
    expect(computePodInventoryCursor(b)).not.toBe(computePodInventoryCursor(a));
  });
});

describe("handleUserStream", () => {
  it("no cursor → returns immediately with a cursor (matching /pods state)", async () => {
    const storage = new InMemoryStorage();
    await seedServer(storage);
    let slept = 0;
    const res = await handleUserStream(
      streamDeps(storage, { sleep: async () => { slept++; } }),
      "harry",
      null,
    );
    expect(res.status).toBe(200);
    const body = res.body as PodInventory & { cursor: string };
    expect(typeof body.cursor).toBe("string");
    expect(body.cursor.length).toBe(64);
    expect(slept).toBe(0); // never held
    // The cursor matches the underlying inventory's cursor.
    const inv = await buildPodInventory(deps(storage), "harry");
    expect(body.cursor).toBe(computePodInventoryCursor(inv));
    expect(body.pods.length).toBe(1);
  });

  it("stale cursor → returns immediately without holding", async () => {
    const storage = new InMemoryStorage();
    await seedServer(storage);
    let slept = 0;
    const res = await handleUserStream(
      streamDeps(storage, { sleep: async () => { slept++; } }),
      "harry",
      "00".repeat(32), // a cursor that can't match
    );
    expect(res.status).toBe(200);
    expect(slept).toBe(0);
  });

  it("matching cursor + state unchanged → holds N times then returns same cursor", async () => {
    const storage = new InMemoryStorage();
    await seedServer(storage);
    const inv = await buildPodInventory(deps(storage), "harry");
    const cursor = computePodInventoryCursor(inv);

    // Virtual clock advanced by the fake sleep: 5 checks of 2s under a 10s max.
    let vclock = NOW;
    let ticks = 0;
    const res = await handleUserStream(
      streamDeps(storage, {
        now: () => vclock,
        sleep: async (ms) => { vclock += ms; ticks++; },
        checkIntervalMs: 2_000,
        maxHoldMs: 10_000,
      }),
      "harry",
      cursor,
    );
    expect(res.status).toBe(200);
    const body = res.body as { cursor: string };
    expect(body.cursor).toBe(cursor); // unchanged
    expect(ticks).toBe(5); // 5 × 2s == 10s == maxHold; never errors on timeout
  });

  it("matching cursor + state mutated mid-hold → returns the NEW cursor promptly", async () => {
    const storage = new InMemoryStorage();
    await seedServer(storage);
    const inv0 = await buildPodInventory(deps(storage), "harry");
    const cursor0 = computePodInventoryCursor(inv0);

    let vclock = NOW;
    let ticks = 0;
    const res = await handleUserStream(
      streamDeps(storage, {
        now: () => vclock,
        sleep: async (ms) => {
          vclock += ms;
          ticks++;
          // On the 2nd tick, register a new outstanding order — the next
          // rebuild will see it and the cursor will differ.
          if (ticks === 2) {
            await storage.authCodes.put({
              serial: "serial-new",
              username: "harry",
              serverName: "home9",
              serverDomain: "home9.harry.flagship.services",
              delegatedPubKeyHex: "00".repeat(32),
              userPubKeyHex: "11".repeat(32),
              userSignatureHex: "00".repeat(64),
              issuedAt: NOW - 100,
              expiresAt: NOW + 3_600_000,
              status: "active",
              recordedAt: NOW - 100,
            });
          }
        },
        checkIntervalMs: 2_000,
        maxHoldMs: 60_000, // generous — proves we returned WELL before the ceiling
      }),
      "harry",
      cursor0,
    );
    expect(res.status).toBe(200);
    const body = res.body as PodInventory & { cursor: string };
    expect(body.cursor).not.toBe(cursor0); // changed
    expect(ticks).toBe(2); // returned on the tick the mutation landed, not at maxHold
    expect(body.pending.length).toBe(1);
  });
});

function streamDeps(storage: InMemoryStorage, over: Partial<UserStreamDeps> = {}): UserStreamDeps {
  return { ...deps(storage), ...over } as UserStreamDeps;
}
