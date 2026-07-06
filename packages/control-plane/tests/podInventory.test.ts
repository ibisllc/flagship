import { describe, expect, it } from "vitest";
import {
  ed,
  signDaemonStatusReport,
  signBoxTrustStatusReport,
  verifyDaemonStatusReport,
  verifyBoxTrustStatusReport,
  type BoxTrustStatusReport,
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
  FRESHNESS_WINDOW_MS,
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
    secretMailbox: storage.secretMailbox,
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
    liveness: "live" | "unreachable" | "never";
    lastSeenMsAgo: number | null;
    registeredAt: number;
    currentCert: { sha256: string | null } | null;
    pendingRequests: Array<{
      id: string;
      type: string;
      issuedAt: number;
      expiresAt: number;
    }>;
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

describe("pendingRequests unlock lane (cheap, non-biometric boot-unlock-waiting signal)", () => {
  const hasUnlock = (pod: PodsResponse["pods"][number]) =>
    pod.pendingRequests.some((r) => r.type === "unlock-key");
  function unlockRequest(serverDomain: string, expiresAt: number) {
    return {
      serverDomain,
      username: "harry",
      requestNonceHex: "ab".repeat(32),
      stkPubHex: "22".repeat(32),
      purpose: "unlock-key" as const,
      requestIssuedAt: NOW - 1_000,
      requestSignatureHex: "cd".repeat(64),
      deviceInfoJson: null,
      postedAt: NOW - 1_000,
      expiresAt,
      lastPushAt: 0,
      responseSealedHex: null,
      responseIssuedAt: null,
      respondedAt: null,
      consumedAt: null,
    };
  }

  it("flags a box with a LIVE unlock-key request so a locked box isn't 'never came online'", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const put = await storage.secretMailbox.putRequest(
      unlockRequest("home1.harry.flagship.services", NOW + 60_000),
    );
    expect(put.ok).toBe(true);

    const r = await handleGetUserPods(deps(storage), "harry");
    expect(hasUnlock((r.body as PodsResponse).pods[0]!)).toBe(true);
  });

  it("does NOT flag a box with no pending unlock request", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const r = await handleGetUserPods(deps(storage), "harry");
    expect(hasUnlock((r.body as PodsResponse).pods[0]!)).toBe(false);
  });

  it("does NOT flag when secretMailbox is unwired (degrades to empty, never throws)", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const r = await handleGetUserPods(deps(storage, { secretMailbox: undefined }), "harry");
    expect(r.status).toBe(200);
    expect((r.body as PodsResponse).pods[0]?.pendingRequests).toEqual([]);
  });
});

describe("pendingRequests digest (Box Request Inbox detection tier)", () => {
  function req(
    serverDomain: string,
    purpose: "unlock-key" | "entitlement",
    nonceHex: string,
    expiresAt: number,
  ) {
    return {
      serverDomain,
      username: "harry",
      requestNonceHex: nonceHex,
      stkPubHex: "22".repeat(32),
      purpose,
      requestIssuedAt: NOW - 1_000,
      requestSignatureHex: "cd".repeat(64),
      deviceInfoJson: null,
      postedAt: NOW - 1_000,
      expiresAt,
      lastPushAt: 0,
      responseSealedHex: null,
      responseIssuedAt: null,
      respondedAt: null,
      consumedAt: null,
    };
  }

  it("surfaces every live request typed — both lanes in one digest, no booleans", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const dom = "home1.harry.flagship.services";
    expect((await storage.secretMailbox.putRequest(req(dom, "unlock-key", "aa".repeat(32), NOW + 60_000))).ok).toBe(true);
    expect((await storage.secretMailbox.putRequest(req(dom, "entitlement", "bb".repeat(32), NOW + 60_000))).ok).toBe(true);

    const pod = (await handleGetUserPods(deps(storage), "harry") as { body: PodsResponse }).body.pods[0]!;

    expect(pod.pendingRequests).toHaveLength(2);
    const byType = Object.fromEntries(pod.pendingRequests.map((r) => [r.type, r]));
    expect(byType["unlock-key"]?.id).toBe("aa".repeat(32));
    expect(byType["entitlement"]?.id).toBe("bb".repeat(32));
    expect(byType["unlock-key"]?.expiresAt).toBe(NOW + 60_000);
    // The two lanes are types in the ONE digest — no separate booleans.
    expect(byType["unlock-key"]).toBeDefined();
    expect(byType["entitlement"]).toBeDefined();
    expect(pod).not.toHaveProperty("awaitingUnlock");
    expect(pod).not.toHaveProperty("awaitingEntitlement");
  });

  it("is empty for a box with nothing pending", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const pod = (await handleGetUserPods(deps(storage), "harry") as { body: PodsResponse }).body.pods[0]!;
    expect(pod.pendingRequests).toEqual([]);
  });
});

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

// ── Per-service leads relay (Phase 6 Part 3) ─────────────────────────────────

describe("POST /api/daemon-status — leadsServices relay on /pods", () => {
  it("relays the UNSIGNED leadsServices the daemon reports; signed report still re-verifies", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const rep = report();
    const body = signedBody(rep);

    const post = await handlePostDaemonStatus(deps(storage), {
      ...body,
      leadsServices: ["blog", "wiki"],
    });
    expect(post.status).toBe(200);

    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & {
      pods: Array<{
        leadsServices: string[];
        signedStatus: { report: DaemonStatusReport; signatureHex: string } | null;
      }>;
    };
    expect(out.pods[0]?.leadsServices).toEqual(["blog", "wiki"]);
    // The signature still covers only the canonical fields — leadsServices is not
    // part of the canonical bytes, so the relayed report re-verifies under the STK.
    const signed = out.pods[0]!.signedStatus!;
    const sigBytes = Uint8Array.from(
      signed.signatureHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(verifyDaemonStatusReport(signed.report, sigBytes, ed.getPublicKey(STK_PRIV))).toBe(true);
  });

  it("absent leadsServices ⇒ a tolerant empty array on /pods (additive)", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const post = await handlePostDaemonStatus(deps(storage), signedBody(report()));
    expect(post.status).toBe(200);
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & { pods: Array<{ leadsServices: string[] }> };
    expect(out.pods[0]?.leadsServices).toEqual([]);
  });
});

describe("POST /api/daemon-status — box-trust-status (per-box relay verdict) relay on /pods", () => {
  function btsReport(over: Partial<BoxTrustStatusReport> = {}): BoxTrustStatusReport {
    return {
      serverDomain: "home1.harry.flagship.services",
      relayVerdict: "untrusted",
      lockedDown: false,
      failingCertHash: "ab".repeat(32),
      coveringExceptionCertHash: null,
      nonce: "00112233445566778899aabbccddeeff",
      issuedAt: NOW - 1_000,
      ...over,
    };
  }
  function signedTrustStatus(r: BoxTrustStatusReport) {
    return {
      report: r,
      signatureHex: bytesToHex(
        signBoxTrustStatusReport(r, {
          privateKey: STK_PRIV,
          publicKey: ed.getPublicKey(STK_PRIV),
        }),
      ),
    };
  }

  it("verifies + relays the box's own signed verdict verbatim; it re-verifies under the STK", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const rep = report();
    const bts = btsReport();

    const post = await handlePostDaemonStatus(deps(storage), {
      ...signedBody(rep),
      trustStatus: signedTrustStatus(bts),
    });
    expect(post.status).toBe(200);

    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & {
      pods: Array<{
        trustStatus: { report: BoxTrustStatusReport; signatureHex: string } | null;
      }>;
    };
    const ts = out.pods[0]!.trustStatus!;
    expect(ts).not.toBeNull();
    expect(ts.report).toEqual(bts);
    // The end-to-end client re-verification against the locally-derived STK.
    const sigBytes = Uint8Array.from(
      ts.signatureHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(
      verifyBoxTrustStatusReport(ts.report, sigBytes, ed.getPublicKey(STK_PRIV)),
    ).toBe(true);
    // The daemon-status signature still re-verifies (sibling didn't corrupt it).
    // (covered above) — here just assert the trust sibling didn't leak in.
    expect((ts.report as unknown as { leadsServices?: unknown }).leadsServices).toBeUndefined();
  });

  it("DROPS a box-trust-status with a bad signature but still accepts the heartbeat", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const bts = btsReport();
    const good = signedTrustStatus(bts);
    const post = await handlePostDaemonStatus(deps(storage), {
      ...signedBody(report()),
      trustStatus: { report: bts, signatureHex: good.signatureHex.replace(/^../, "ff") },
    });
    expect(post.status).toBe(200); // heartbeat still lands
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & {
      pods: Array<{ trustStatus: unknown }>;
    };
    expect(out.pods[0]?.trustStatus).toBeNull();
  });

  it("DROPS a box-trust-status whose serverDomain mismatches the box", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const bts = btsReport({ serverDomain: "evil.harry.flagship.services" });
    const post = await handlePostDaemonStatus(deps(storage), {
      ...signedBody(report()),
      trustStatus: signedTrustStatus(bts),
    });
    expect(post.status).toBe(200);
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & { pods: Array<{ trustStatus: unknown }> };
    expect(out.pods[0]?.trustStatus).toBeNull();
  });

  it("absent trustStatus ⇒ null on /pods (additive; old daemon)", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    await handlePostDaemonStatus(deps(storage), signedBody(report()));
    const r = await handleGetUserPods(deps(storage), "harry");
    const out = r.body as PodsResponse & { pods: Array<{ trustStatus: unknown }> };
    expect(out.pods[0]?.trustStatus).toBeNull();
  });
});

// ── Per-pod liveness fields: liveness + lastSeenMsAgo ────────────────────────

describe("GET /api/users/:u/pods — liveness fields (liveness + lastSeenMsAgo)", () => {
  it("fresh real heartbeat → liveness:'live' with a non-null lastSeenMsAgo < FRESHNESS_WINDOW_MS", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const age = 60_000; // 1 min — well within the 15-min window
    await storage.daemonStatus.put({
      serverDomain: "home1.harry.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: NOW + 30 * 86_400_000,
      certIssuer: "Let's Encrypt",
      servicesServedJson: "[]",
      lastReported: NOW - age,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    const pod = (r.body as PodsResponse).pods[0]!;
    expect(pod.liveness).toBe("live");
    expect(pod.lastSeenMsAgo).toBe(age);
    expect(pod.lastSeenMsAgo).toBeLessThan(FRESHNESS_WINDOW_MS);
  });

  it("real heartbeat older than FRESHNESS_WINDOW_MS → liveness:'unreachable' with a sensible lastSeenMsAgo", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const age = FRESHNESS_WINDOW_MS + 60_000; // 1 min past the window
    await storage.daemonStatus.put({
      serverDomain: "home1.harry.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: NOW + 30 * 86_400_000,
      certIssuer: "Let's Encrypt",
      servicesServedJson: "[]",
      lastReported: NOW - age,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    const pod = (r.body as PodsResponse).pods[0]!;
    expect(pod.liveness).toBe("unreachable");
    expect(pod.lastSeenMsAgo).toBe(age);
    expect(pod.lastSeenMsAgo).toBeGreaterThan(FRESHNESS_WINDOW_MS);
  });

  it("no daemon_status row and no bridge → liveness:'never', lastSeenMsAgo:null", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage); // registered, no daemon_status, no authCodes

    const r = await handleGetUserPods(deps(storage, { authCodes: undefined }), "harry");
    const pod = (r.body as PodsResponse).pods[0]!;
    expect(pod.liveness).toBe("never");
    expect(pod.lastSeenMsAgo).toBeNull();
  });

  it("provision-bridged box (no daemon_status row, provision_status 'live') → liveness:'never' even after > FRESHNESS_WINDOW_MS", async () => {
    // This is the critical bridge-caveat test: the provision-status 'live'
    // timestamp is STATIC (set once). A naive freshness check would wrongly
    // flip it to 'unreachable' after 15 min. The bridge must be classified
    // as 'never' (awaiting first real heartbeat), not 'unreachable'.
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    // The bridge timestamp is far in the past — well beyond the window.
    const bridgeAge = FRESHNESS_WINDOW_MS + 60 * 60_000; // 1 hour past the window
    await storage.authCodes.put(
      authCode("BRIDGESER", "home1", { status: "used", usedAt: NOW - bridgeAge - 1_000 }),
    );
    await storage.provisionStatus.putProvisionStatus("BRIDGESER", {
      phase: "live",
      ts: NOW - bridgeAge,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    const pod = (r.body as PodsResponse).pods[0]!;
    // lastReported is set (for wire compat with existing clients) but liveness
    // must be 'never', not 'unreachable', because the timestamp is from the bridge.
    expect(pod.lastReported).not.toBeNull();
    expect(pod.liveness).toBe("never");
    expect(pod.lastSeenMsAgo).toBeNull();
  });

  it("real heartbeat right at the freshness boundary (age === FRESHNESS_WINDOW_MS - 1) → 'live'", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const age = FRESHNESS_WINDOW_MS - 1;
    await storage.daemonStatus.put({
      serverDomain: "home1.harry.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: NOW + 30 * 86_400_000,
      certIssuer: "Let's Encrypt",
      servicesServedJson: "[]",
      lastReported: NOW - age,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    const pod = (r.body as PodsResponse).pods[0]!;
    expect(pod.liveness).toBe("live");
  });

  it("real heartbeat right at the freshness boundary (age === FRESHNESS_WINDOW_MS) → 'unreachable'", async () => {
    const storage = new InMemoryStorage();
    await withStkServer(storage);
    const age = FRESHNESS_WINDOW_MS;
    await storage.daemonStatus.put({
      serverDomain: "home1.harry.flagship.services",
      certSha256: "ab".repeat(32),
      certValidUntil: NOW + 30 * 86_400_000,
      certIssuer: "Let's Encrypt",
      servicesServedJson: "[]",
      lastReported: NOW - age,
    });

    const r = await handleGetUserPods(deps(storage), "harry");
    const pod = (r.body as PodsResponse).pods[0]!;
    expect(pod.liveness).toBe("unreachable");
  });
});

// ── Deterministic oldest-first pod ordering ───────────────────────────────────

describe("GET /api/users/:u/pods — deterministic oldest-first order", () => {
  it("returns pods sorted by registeredAt ASC regardless of storage insertion order", async () => {
    const storage = new InMemoryStorage();
    // Insert newest first to exercise the sort — storage may not order by registeredAt.
    await storage.servers.put({
      serverDomain: "newest.harry.flagship.services",
      username: "harry",
      identityPubKeyHex: "33".repeat(32),
      registeredAt: NOW - 1_000, // newest
    });
    await storage.servers.put({
      serverDomain: "middle.harry.flagship.services",
      username: "harry",
      identityPubKeyHex: "44".repeat(32),
      registeredAt: NOW - 30_000, // middle
    });
    await storage.servers.put({
      serverDomain: "oldest.harry.flagship.services",
      username: "harry",
      identityPubKeyHex: "55".repeat(32),
      registeredAt: NOW - 60_000, // oldest
    });

    const r = await handleGetUserPods(deps(storage, { authCodes: undefined }), "harry");
    const out = r.body as PodsResponse;
    expect(out.pods).toHaveLength(3);
    expect(out.pods[0]!.serverDomain).toBe("oldest.harry.flagship.services");
    expect(out.pods[1]!.serverDomain).toBe("middle.harry.flagship.services");
    expect(out.pods[2]!.serverDomain).toBe("newest.harry.flagship.services");
    // Confirm registeredAt is monotonically increasing.
    expect(out.pods[0]!.registeredAt).toBeLessThan(out.pods[1]!.registeredAt);
    expect(out.pods[1]!.registeredAt).toBeLessThan(out.pods[2]!.registeredAt);
  });

  it("single pod is stable (no sort errors)", async () => {
    const storage = new InMemoryStorage();
    await withServer(storage);
    const r = await handleGetUserPods(deps(storage, { authCodes: undefined }), "harry");
    expect((r.body as PodsResponse).pods).toHaveLength(1);
  });

  it("empty pod list is stable", async () => {
    const storage = new InMemoryStorage();
    const r = await handleGetUserPods(deps(storage, { authCodes: undefined }), "harry");
    expect((r.body as PodsResponse).pods).toEqual([]);
  });
});
