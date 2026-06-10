import { describe, expect, it } from "vitest";
import {
  InMemoryStorage,
  type AuthCodeRecord,
  type ProvisionStatusStorage,
} from "@flagship/storage";
import {
  handleGetUserPods,
  orderRefForSerial,
  type PodInventoryDeps,
} from "../src/podInventory.js";

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
  pods: Array<{
    serverDomain: string;
    state: string;
    lastReported: number | null;
    currentCert: { sha256: string | null } | null;
  }>;
  pending: Array<{
    orderRef: string;
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
    expect(out.pending[0]?.orderRef).toBe(orderRefForSerial("PENDING01"));
    expect(out.pending[0]?.fqdn).toBe("home2.harry.flagship.services");
    expect(out.pending[0]?.state).toBe("pending");
    expect(out.pending[0]?.phase).toBeNull();
  });

  it("NEVER exposes the raw auth-code serial anywhere in the unauthenticated response", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    await storage.authCodes.put(authCode("SECRETSER", "home2"));
    await storage.provisionStatus.putProvisionStatus("SECRETSER", {
      phase: "installing",
      ts: NOW - 5_000,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    expect(r.status).toBe(200);
    // The serial is a write capability (fake provision phases via
    // /api/order/<serial>/status + /api/install-events/<serial>) — the
    // whole body must not contain it, only the opaque sha256 orderRef.
    expect(JSON.stringify(r.body)).not.toContain("SECRETSER");
    const out = r.body as PodsResponse;
    expect(out.pending[0]?.orderRef).toBe(orderRefForSerial("SECRETSER"));
    expect((out.pending[0] as Record<string, unknown>).serial).toBeUndefined();
  });

  it("orderRef is the canonical-bytes sha256 (deterministic, client-recomputable)", () => {
    // Pinned vector — iOS/Android/webapp compute the SAME hex locally from
    // the serial they stored at order creation, to reconcile against /pods.
    expect(orderRefForSerial("HOME2SER")).toBe(
      "e0970cb9bd5fd0967cdc259ec8ca1619d1a98c44abc8eadd3fc8d4c2e6fb6442",
    );
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
    expect(out.pending[0]?.orderRef).toBe(orderRefForSerial("PENDING01"));
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
    expect(out.pending.map((p) => p.orderRef)).toEqual([
      orderRefForSerial("LIVE00001"),
    ]);
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

describe("GET /api/users/:u/pods — liveness bridge (no daemon_status row)", () => {
  it("a registered server with no daemon_status but provision_status 'live' is reported online (lastReported populated)", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage); // home1, registered, but NO daemon_status row
    // The registered server's auth-code is `used`; join domain → serial.
    await storage.authCodes.put(
      authCode("LIVESER01", "home1", { status: "used", usedAt: NOW - 40_000 }),
    );
    await storage.provisionStatus.putProvisionStatus("LIVESER01", {
      phase: "live",
      ts: NOW - 30_000,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    expect(r.status).toBe(200);
    const out = r.body as PodsResponse;
    expect(out.pods).toHaveLength(1);
    // Bridge set lastReported to the provision-status updatedAt → cameOnline.
    expect(out.pods[0]?.lastReported).toBe(NOW - 30_000);
    // The bridge sets liveness only — cert details stay null without daemon_status.
    expect(out.pods[0]?.currentCert).toBeNull();
  });

  it("a registered server with NO daemon_status and NO live provision_status stays lastReported:null (still 'never came online')", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    await storage.authCodes.put(
      authCode("MIDSER001", "home1", { status: "used", usedAt: NOW - 40_000 }),
    );
    await storage.provisionStatus.putProvisionStatus("MIDSER001", {
      phase: "installing",
      ts: NOW - 30_000,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse;
    expect(out.pods).toHaveLength(1);
    expect(out.pods[0]?.lastReported).toBeNull();
  });

  it("a registered server with NO auth-code at all stays lastReported:null", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse;
    expect(out.pods[0]?.lastReported).toBeNull();
  });

  it("a server WITH daemon_status is unchanged and does NOT consult provision_status (no bridge lookup)", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    await storage.daemonStatus.put({
      serverDomain: "home1.harry.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: NOW + 30 * 86_400_000,
      certIssuer: "Let's Encrypt",
      servicesServedJson: JSON.stringify(["home1.harry.flagship.services"]),
      lastReported: NOW - 1_000,
    });
    await storage.authCodes.put(
      authCode("HASSER001", "home1", { status: "used", usedAt: NOW - 40_000 }),
    );
    // A provision_status row that, if consulted, would NOT change the answer —
    // but the bridge must not even look (guarded `if (!status ...)`).
    let provisionConsulted = false;
    const spyProvision: ProvisionStatusStorage = {
      putProvisionStatus: storage.provisionStatus.putProvisionStatus.bind(
        storage.provisionStatus,
      ),
      async getProvisionStatus(serial) {
        provisionConsulted = true;
        return storage.provisionStatus.getProvisionStatus(serial);
      },
    };

    const r = await handleGetUserPods(
      deps(storage, { provisionStatus: spyProvision }),
      "harry",
    );
    const out = r.body as PodsResponse;
    expect(out.pods[0]?.lastReported).toBe(NOW - 1_000);
    expect(out.pods[0]?.currentCert?.sha256).toBe("ab".repeat(32));
    expect(provisionConsulted).toBe(false);
  });

  it("a bridge lookup failure NEVER drops the server or fails the list", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage); // no daemon_status → bridge runs
    const throwingProvision: ProvisionStatusStorage = {
      putProvisionStatus: storage.provisionStatus.putProvisionStatus.bind(
        storage.provisionStatus,
      ),
      async getProvisionStatus() {
        throw new Error("provision_status table missing");
      },
    };
    await storage.authCodes.put(
      authCode("THROWSER1", "home1", { status: "used", usedAt: NOW - 40_000 }),
    );

    const r = await handleGetUserPods(
      deps(storage, { provisionStatus: throwingProvision }),
      "harry",
    );
    expect(r.status).toBe(200);
    const out = r.body as PodsResponse;
    expect(out.pods).toHaveLength(1);
    expect(out.pods[0]?.lastReported).toBeNull();
  });
});
