import { describe, expect, it } from "vitest";
import {
  InMemoryStorage,
  type AuthCodeRecord,
  type ProvisionStatusStorage,
} from "@flagship/storage";
import { handleGetUserPods, type PodInventoryDeps } from "../src/podInventory.js";

const NOW = 1_700_000_000_000;

function authCode(
  serial: string,
  serverName: string,
  overrides: Partial<AuthCodeRecord> = {},
): AuthCodeRecord {
  return {
    serial,
    username: "harry",
    serverName,
    serverDomain: `${serverName}.harry.flagship.services`,
    delegatedPubKeyHex: "00".repeat(32),
    userPubKeyHex: "11".repeat(32),
    userSignatureHex: "00".repeat(64),
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 3_600_000,
    status: "active",
    recordedAt: NOW - 10_000,
    ...overrides,
  };
}

function deps(
  storage: InMemoryStorage,
  over: Partial<PodInventoryDeps> = {},
): PodInventoryDeps {
  return {
    daemonStatus: storage.daemonStatus,
    servers: storage.servers,
    routing: storage.routing,
    authCodes: storage.authCodes,
    provisionStatus: storage.provisionStatus,
    now: () => NOW,
    ...over,
  };
}

interface PodsResponse {
  username: string;
  pods: Array<{ serverDomain: string; state: string }>;
  pending: Array<{
    serial: string;
    serverName: string;
    fqdn: string;
    phase: string | null;
    state: string;
  }>;
  fetchedAt: number;
}

async function withServer(storage: InMemoryStorage) {
  await storage.servers.put({
    serverDomain: "home1.harry.flagship.services",
    username: "harry",
    identityPubKeyHex: "22".repeat(32),
    registeredAt: NOW - 50_000,
  });
}

describe("GET /api/users/:u/pods (merged registered + pending)", () => {
  it("returns registered servers tagged online AND active orders tagged pending in one fetch", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    await storage.authCodes.put(authCode("PENDING01", "home2"));

    const r = await handleGetUserPods(deps(storage), "harry");
    expect(r.status).toBe(200);
    const out = r.body as PodsResponse;

    expect(out.pods).toHaveLength(1);
    expect(out.pods[0]?.serverDomain).toBe("home1.harry.flagship.services");
    expect(out.pods[0]?.state).toBe("online");

    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]?.serial).toBe("PENDING01");
    expect(out.pending[0]?.fqdn).toBe("home2.harry.flagship.services");
    expect(out.pending[0]?.state).toBe("pending");
    expect(out.pending[0]?.phase).toBeNull();
  });

  it("keeps the registered pods array backward-compatible when there are no orders", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse;
    expect(out.pods).toHaveLength(1);
    expect(out.pending).toEqual([]);
  });

  it("joins the latest provisioning phase by serial", async () => {
    const storage = new InMemoryStorage();
    await storage.authCodes.put(authCode("PENDING01", "home2"));
    await storage.provisionStatus.putProvisionStatus("PENDING01", {
      phase: "registering",
      ts: NOW - 5_000,
    });
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse;
    expect(out.pending[0]?.phase).toBe("registering");
  });

  it("a thrown getProvisionStatus yields phase:null and does NOT drop the order or fail the list", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    await storage.authCodes.put(authCode("PENDING01", "home2"));
    const throwingProvision: ProvisionStatusStorage = {
      putProvisionStatus: storage.provisionStatus.putProvisionStatus.bind(
        storage.provisionStatus,
      ),
      async getProvisionStatus() {
        throw new Error("provision_status table missing");
      },
    };
    const r = await handleGetUserPods(
      deps(storage, { provisionStatus: throwingProvision }),
      "harry",
    );
    expect(r.status).toBe(200);
    const out = r.body as PodsResponse;
    // List is intact: registered server AND the order survive; phase degrades.
    expect(out.pods).toHaveLength(1);
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]?.serial).toBe("PENDING01");
    expect(out.pending[0]?.phase).toBeNull();
  });

  it("filters pending to active, unexpired orders (excludes used / revoked / expired)", async () => {
    const storage = new InMemoryStorage();
    await storage.authCodes.put(authCode("LIVE00001", "live"));
    await storage.authCodes.put(
      authCode("USED00001", "used", { status: "used", usedAt: NOW - 1_000 }),
    );
    await storage.authCodes.put(
      authCode("REVK00001", "revoked", { status: "revoked", revokedAt: NOW - 1_000 }),
    );
    await storage.authCodes.put(authCode("EXPD00001", "expired", { expiresAt: NOW - 1 }));

    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse;
    expect(out.pending.map((p) => p.serial)).toEqual(["LIVE00001"]);
  });

  it("stays UNAUTHENTICATED — no signature / IRK required to read the merged list", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    await storage.authCodes.put(authCode("PENDING01", "home2"));
    // Called with only a path username, no body, no signer.
    const r = await handleGetUserPods(deps(storage), "harry");
    expect(r.status).toBe(200);
  });

  it("omits pending when no authCodes storage is wired (legacy callers)", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const r = await handleGetUserPods(
      deps(storage, { authCodes: undefined }),
      "harry",
    );
    const out = r.body as PodsResponse;
    expect(out.pods).toHaveLength(1);
    expect(out.pending).toEqual([]);
  });
});
