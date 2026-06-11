import { describe, expect, it } from "vitest";
import {
  ed,
  signDaemonStatusReport,
  verifyDaemonStatusReport,
  type DaemonStatusReport,
} from "@flagship/protocol";
import {
  InMemoryStorage,
  type AuthCodeRecord,
  type ProvisionStatusStorage,
} from "@flagship/storage";
import {
  handleGetUserPods,
  handlePostDaemonStatus,
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

  it("a pod with no daemon_status row exposes signedStatus:null (additive field, never absent)", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse;
    expect(out.pods[0]).toHaveProperty("signedStatus", null);
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

// ── Cert-fingerprint pinning (A′ phase 4a) — verbatim signed report ───────

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const STK_PRIV = new Uint8Array(32).fill(7);
const STK_PUB_HEX = bytesToHex(ed.getPublicKey(STK_PRIV));

function report(over: Partial<DaemonStatusReport> = {}): DaemonStatusReport {
  return {
    serverDomain: "home1.harry.flagship.services",
    certSha256: "ab".repeat(32),
    certValidUntil: NOW + 30 * 86_400_000,
    certIssuer: "C=US, O=Let's Encrypt, CN=YR1",
    appsServed: ["home1.harry.flagship.services"],
    nonce: "00112233445566778899aabbccddeeff",
    issuedAt: NOW - 1_000,
    ...over,
  };
}

function signedBody(r: DaemonStatusReport) {
  return {
    request: r,
    signature: bytesToHex(
      signDaemonStatusReport(r, {
        privateKey: STK_PRIV,
        publicKey: ed.getPublicKey(STK_PRIV),
      }),
    ),
  };
}

async function withStkServer(storage: InMemoryStorage) {
  await storage.servers.put({
    serverDomain: "home1.harry.flagship.services",
    username: "harry",
    identityPubKeyHex: STK_PUB_HEX,
    registeredAt: NOW - 50_000,
  });
}

describe("POST /api/daemon-status — verbatim signed tuple persisted + relayed", () => {
  it("stores the exact signed tuple + signature; /pods relays them; the relayed report re-verifies under the STK", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const rep = report();
    const body = signedBody(rep);

    const post = await handlePostDaemonStatus(deps(storage), body);
    expect(post.status).toBe(200);

    const row = await storage.daemonStatus.get("home1.harry.flagship.services");
    expect(row?.signatureHex).toBe(body.signature);
    expect(JSON.parse(row!.reportJson!)).toEqual(rep);

    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & {
      pods: Array<{
        signedStatus: { report: DaemonStatusReport; signatureHex: string } | null;
        currentCert: { sha256: string | null } | null;
      }>;
    };
    const signed = out.pods[0]?.signedStatus;
    expect(signed).not.toBeNull();
    expect(signed?.signatureHex).toBe(body.signature);
    expect(signed?.report).toEqual(rep);
    // The end-to-end client check: rebuild canonical bytes from the RELAYED
    // report and verify under the locally-derived STK — .com's currentCert
    // summary is not trusted, the signed report is.
    const sigBytes = Uint8Array.from(
      signed!.signatureHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(
      verifyDaemonStatusReport(signed!.report, sigBytes, ed.getPublicKey(STK_PRIV)),
    ).toBe(true);
    // And the relayed report agrees with the (convenience-only) summary.
    expect(out.pods[0]?.currentCert?.sha256).toBe(rep.certSha256);
  });

  it("a report with null cert fields (liveness-only) round-trips and re-verifies", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const rep = report({
      certSha256: null,
      certValidUntil: null,
      certIssuer: null,
      appsServed: [],
    });
    const post = await handlePostDaemonStatus(deps(storage), signedBody(rep));
    expect(post.status).toBe(200);
    const row = await storage.daemonStatus.get("home1.harry.flagship.services");
    expect(JSON.parse(row!.reportJson!)).toEqual(rep);
  });

  it("absent optional fields are stored as the nulls the signature already covers", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    // Sign the normalized (null) tuple but POST with the optionals absent —
    // canonical bytes are identical, so the signature verifies, and the
    // STORED tuple is the explicit-null form every client rebuilds.
    const rep = report({
      certSha256: null,
      certValidUntil: null,
      certIssuer: null,
      appsServed: [],
    });
    const { signature } = signedBody(rep);
    const post = await handlePostDaemonStatus(deps(storage), {
      request: {
        serverDomain: rep.serverDomain,
        nonce: rep.nonce,
        issuedAt: rep.issuedAt,
      },
      signature,
    });
    expect(post.status).toBe(200);
    const row = await storage.daemonStatus.get("home1.harry.flagship.services");
    expect(JSON.parse(row!.reportJson!)).toEqual(rep);
  });

  it("rejects an invalid signature (403) and stores nothing", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const rep = report();
    const body = signedBody(rep);
    const tampered = { ...rep, certSha256: "cd".repeat(32) };
    const post = await handlePostDaemonStatus(deps(storage), {
      request: tampered,
      signature: body.signature,
    });
    expect(post.status).toBe(403);
    expect(
      await storage.daemonStatus.get("home1.harry.flagship.services"),
    ).toBeUndefined();
  });

  it("rejects a non-string-array appsServed as malformed", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const body = signedBody(report());
    const post = await handlePostDaemonStatus(deps(storage), {
      request: { ...body.request, appsServed: [1, 2] as unknown as string[] },
      signature: body.signature,
    });
    expect(post.status).toBe(400);
  });

  it("a corrupt stored reportJson degrades signedStatus to null and never fails /pods", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    await storage.daemonStatus.put({
      serverDomain: "home1.harry.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: NOW + 1_000,
      certIssuer: "x",
      servicesServedJson: "[]",
      lastReported: NOW - 1_000,
      reportJson: "{not json",
      signatureHex: "ee".repeat(64),
    });
    const r = await handleGetUserPods(deps(storage), "harry");
    expect(r.status).toBe(200);
    const out = r.body as PodsResponse & {
      pods: Array<{ signedStatus: unknown }>;
    };
    expect(out.pods[0]?.signedStatus).toBeNull();
  });

  it("legacy rows (no signed report) keep the currentCert summary and expose signedStatus:null", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    await storage.daemonStatus.put({
      serverDomain: "home1.harry.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: NOW + 1_000,
      certIssuer: "x",
      servicesServedJson: "[]",
      lastReported: NOW - 1_000,
    });
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & {
      pods: Array<{
        signedStatus: unknown;
        currentCert: { sha256: string | null } | null;
      }>;
    };
    expect(out.pods[0]?.currentCert?.sha256).toBe("ab".repeat(32));
    expect(out.pods[0]?.signedStatus).toBeNull();
  });
});
