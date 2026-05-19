import { describe, expect, it } from "vitest";
import {
  ed,
  signServiceGrant,
  signPodIdentityBinding,
  type ServiceGrant,
  type Bytes,
  type Keypair,
  type PodIdentityBinding,
} from "@flagship/protocol";
import {
  InMemoryAppGrantStore,
  memorySyncTransportPair,
  mintTestBinding,
  startSyncConnection,
  type AppGrantStore,
  type SyncRevocationLookup,
} from "../../src/sibling/syncConnection.js";

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const USER = "alice";
const HOME = "home.alice.flagship.services";
const OFFICE = "office.alice.flagship.services";

function mintGrant(args: {
  irk: Keypair;
  grantId?: string;
  serviceCanonical?: string;
  serverDomains: string[];
  serverIdentities: Bytes[];
  issuedAt?: number;
  expiresAt?: number;
}): { grant: ServiceGrant; signature: Bytes } {
  const issuedAt = args.issuedAt ?? Date.now();
  const expiresAt = args.expiresAt ?? issuedAt + 7 * 24 * 3600_000;
  const grant: ServiceGrant = {
    grantId: args.grantId ?? "550e8400-e29b-41d4-a716-446655440000",
    username: USER,
    serviceCanonical: args.serviceCanonical ?? "notes@abc123def456",
    serverDomains: args.serverDomains,
    serverIdentities: args.serverIdentities,
    routes: [{ url: args.serverDomains[0]!, scope: "canonical" }],
    issuedAt,
    expiresAt,
  };
  return { grant, signature: signServiceGrant(grant, args.irk) };
}

function setupPair(opts?: {
  storeA?: InMemoryAppGrantStore;
  storeB?: InMemoryAppGrantStore;
  revoked?: Set<string>;
  revokedNull?: boolean;
  bindingTamperedFor?: "A" | "B";
  now?: () => number;
}) {
  const irk = key();
  const aId = key();
  const bId = key();
  const a = mintTestBinding({
    irk,
    username: USER,
    podIdentityPubKey: aId.publicKey,
    serverDomain: HOME,
  });
  const b = mintTestBinding({
    irk,
    username: USER,
    podIdentityPubKey: bId.publicKey,
    serverDomain: OFFICE,
  });
  if (opts?.bindingTamperedFor === "A") {
    a.signature = ed.sign(new TextEncoder().encode("garbage"), aId.privateKey);
  } else if (opts?.bindingTamperedFor === "B") {
    b.signature = ed.sign(new TextEncoder().encode("garbage"), bId.privateKey);
  }
  const storeA = opts?.storeA ?? new InMemoryAppGrantStore();
  const storeB = opts?.storeB ?? new InMemoryAppGrantStore();
  const lookupIrk = async (u: string) => (u === USER ? irk.publicKey : null);
  const revocations: SyncRevocationLookup = async () => {
    if (opts?.revokedNull) return null;
    return opts?.revoked ?? new Set<string>();
  };
  const [ta, tb] = memorySyncTransportPair();
  return {
    irk,
    aId,
    bId,
    aBinding: a.binding as PodIdentityBinding,
    aBindingSig: a.signature,
    bBinding: b.binding as PodIdentityBinding,
    bBindingSig: b.signature,
    storeA,
    storeB,
    lookupIrk,
    revocations,
    ta,
    tb,
  };
}

describe("SyncConnection — auth + cert sync (#86)", () => {
  it("two honest peers complete mutual auth and exchange inventories", async () => {
    const s = setupPair();
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
    });
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
    });
    await Promise.all([connA.ready(), connB.ready()]);
    expect(connA.peerDomain()).toBe(OFFICE);
    expect(connB.peerDomain()).toBe(HOME);
    connA.close();
    connB.close();
  });

  it("rejects a peer whose IRK signature on the binding doesn't verify", async () => {
    const s = setupPair({ bindingTamperedFor: "B" });
    const reasonsA: string[] = [];
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
      onAuthFailure: ({ reason }) => reasonsA.push(reason),
    });
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig, // tampered
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
    });
    connB.ready().catch(() => {}); // we expect this to reject; swallow
    await expect(connA.ready()).rejects.toThrow();
    expect(reasonsA[0]).toMatch(/binding/i);
    connA.close();
    connB.close();
  });

  it("rejects a peer whose pod identity is on the revocation list", async () => {
    // The revocation set contains the peer's pod identity hex. Whichever
    // side's onHello runs first wins the race to authFail; the other
    // observes a `transport-closed` ready rejection. Both fences are
    // legitimate — we just need to assert that SOMEBODY caught the
    // revoked bit.
    const s = setupPair();
    const revokedAtA = new Set([bytesToHex(s.bId.publicKey)]);
    const revokedAtB = new Set([bytesToHex(s.aId.publicKey)]);
    const reasons: string[] = [];
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: async () => revokedAtA,
      store: s.storeA,
      inventoryIntervalMs: 0,
      onAuthFailure: ({ reason }) => reasons.push(`A:${reason}`),
    });
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: async () => revokedAtB,
      store: s.storeB,
      inventoryIntervalMs: 0,
      onAuthFailure: ({ reason }) => reasons.push(`B:${reason}`),
    });
    await Promise.all([
      connA.ready().catch(() => {}),
      connB.ready().catch(() => {}),
    ]);
    expect(reasons.join("|")).toMatch(/revoked/);
    connA.close();
    connB.close();
  });

  it("FAILS CLOSED when the revocation lookup returns null (fetch failed)", async () => {
    const s = setupPair({ revokedNull: true });
    const reasons: string[] = [];
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: async () => null,
      store: s.storeA,
      inventoryIntervalMs: 0,
      onAuthFailure: ({ reason }) => reasons.push(reason),
    });
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: async () => null,
      store: s.storeB,
      inventoryIntervalMs: 0,
    });
    connB.ready().catch(() => {}); // expected to reject; swallow
    await expect(connA.ready()).rejects.toThrow();
    expect(reasons.join("|")).toMatch(/revocation/);
    connA.close();
    connB.close();
  });

  it("rejects a peer whose hello declares a different username", async () => {
    const s = setupPair();
    // B presents a binding for a different username.
    const wrongIrk = key();
    const wrongBindingObj: PodIdentityBinding = {
      username: "mallory",
      podIdentityPubKey: s.bId.publicKey,
      serverDomain: OFFICE,
      registeredAt: 1_000,
    };
    const wrongBindingSig = signPodIdentityBinding(wrongBindingObj, wrongIrk);
    const reasons: string[] = [];
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
      onAuthFailure: ({ reason }) => reasons.push(`A:${reason}`),
    });
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: "mallory",
      myBinding: wrongBindingObj,
      myBindingSignature: wrongBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
      onAuthFailure: ({ reason }) => reasons.push(`B:${reason}`),
    });
    await Promise.all([
      connA.ready().catch(() => {}),
      connB.ready().catch(() => {}),
    ]);
    expect(reasons.join("|")).toMatch(/username/);
    connA.close();
    connB.close();
  });

  it("pushes a fresher cert when A has it and B doesn't", async () => {
    const s = setupPair();
    const baseT = Date.now();
    const g = mintGrant({
      irk: s.irk,
      serverDomains: [HOME, OFFICE],
      serverIdentities: [s.aId.publicKey, s.bId.publicKey],
      grantId: "g1",
      issuedAt: baseT,
      expiresAt: baseT + 7 * 24 * 3600_000,
    });
    s.storeA.put(g);
    const applied: Array<{ grantId: string }> = [];
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
      onPushApplied: (a) => applied.push({ grantId: a.grantId }),
    });
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
    });
    await Promise.all([connA.ready(), connB.ready()]);
    // Let the offer → pull → push cycle drain.
    await waitFor(() => s.storeB.byGrantId("g1") !== null, 500);
    expect(s.storeB.byGrantId("g1")).not.toBeNull();
    expect(applied).toEqual([{ grantId: "g1" }]);
    connA.close();
    connB.close();
  });

  it("fresher-cert-wins: an older push does NOT overwrite a newer local copy", async () => {
    const s = setupPair();
    const baseT = Date.now();
    const fresher = mintGrant({
      irk: s.irk,
      serverDomains: [HOME, OFFICE],
      serverIdentities: [s.aId.publicKey, s.bId.publicKey],
      grantId: "g2",
      issuedAt: baseT + 5_000,
      expiresAt: baseT + 5_000 + 7 * 24 * 3600_000,
    });
    const stale = mintGrant({
      irk: s.irk,
      serverDomains: [HOME, OFFICE],
      serverIdentities: [s.aId.publicKey, s.bId.publicKey],
      grantId: "g2",
      issuedAt: baseT + 2_000,
      expiresAt: baseT + 2_000 + 7 * 24 * 3600_000,
    });
    s.storeA.put(stale);
    s.storeB.put(fresher);
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
    });
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
    });
    await Promise.all([connA.ready(), connB.ready()]);
    // A should pull the fresher copy from B; B should NOT downgrade to A's stale copy.
    await waitFor(
      () => s.storeA.byGrantId("g2")?.grant.issuedAt === baseT + 5_000,
      500,
    );
    expect(s.storeA.byGrantId("g2")!.grant.issuedAt).toBe(baseT + 5_000);
    expect(s.storeB.byGrantId("g2")!.grant.issuedAt).toBe(baseT + 5_000);
    connA.close();
    connB.close();
  });

  it("drops a push whose IRK signature is forged", async () => {
    const s = setupPair();
    const other = key();
    const forged = mintGrant({
      irk: other, // wrong IRK!
      serverDomains: [HOME, OFFICE],
      serverIdentities: [s.aId.publicKey, s.bId.publicKey],
      grantId: "gforged",
    });
    s.storeA.put(forged);
    const applied: string[] = [];
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
      onPushApplied: ({ grantId }) => applied.push(grantId),
    });
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
    });
    await Promise.all([connA.ready(), connB.ready()]);
    await new Promise((r) => setTimeout(r, 80));
    expect(applied).toEqual([]);
    expect(s.storeB.byGrantId("gforged")).toBeNull();
    connA.close();
    connB.close();
  });

  it("drops a push that has already expired (defense against historical leaks)", async () => {
    const s = setupPair();
    const past = mintGrant({
      irk: s.irk,
      serverDomains: [HOME, OFFICE],
      serverIdentities: [s.aId.publicKey, s.bId.publicKey],
      grantId: "gpast",
      issuedAt: 1,
      expiresAt: 2, // way in the past relative to Date.now()
    });
    s.storeA.put(past);
    const applied: string[] = [];
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
      onPushApplied: ({ grantId }) => applied.push(grantId),
    });
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
    });
    await Promise.all([connA.ready(), connB.ready()]);
    await new Promise((r) => setTimeout(r, 80));
    expect(applied).toEqual([]);
    expect(s.storeB.byGrantId("gpast")).toBeNull();
    connA.close();
    connB.close();
  });

  it("sibling-removal: dropping a peer's connection does NOT trigger any re-issuance", async () => {
    // Two peers sync a grant; then we close one side and verify that
    // the local store on the other side STILL has the grant — nothing
    // got re-minted, nothing got blown away. The phone is the only
    // authority for issuance.
    const s = setupPair();
    const g = mintGrant({
      irk: s.irk,
      serverDomains: [HOME, OFFICE],
      serverIdentities: [s.aId.publicKey, s.bId.publicKey],
      grantId: "gkeep",
    });
    s.storeA.put(g);
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
    });
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
    });
    await Promise.all([connA.ready(), connB.ready()]);
    await waitFor(() => s.storeB.byGrantId("gkeep") !== null, 500);
    // Now A "removes" B from its sibling set by closing the connection.
    // No re-issuance, no store changes — we just stop syncing.
    connA.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.storeA.byGrantId("gkeep")!.grant.issuedAt).toBe(g.grant.issuedAt);
    expect(s.storeB.byGrantId("gkeep")!.grant.issuedAt).toBe(g.grant.issuedAt);
    connB.close();
  });

  it("explicit pushInventory() advertises latest state after the handshake", async () => {
    const s = setupPair();
    const connA = startSyncConnection({
      socket: s.ta,
      myServerDomain: HOME,
      myIdentity: s.aId,
      username: USER,
      myBinding: s.aBinding,
      myBindingSignature: s.aBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeA,
      inventoryIntervalMs: 0,
    });
    const applied: string[] = [];
    const connB = startSyncConnection({
      socket: s.tb,
      myServerDomain: OFFICE,
      myIdentity: s.bId,
      username: USER,
      myBinding: s.bBinding,
      myBindingSignature: s.bBindingSig,
      lookupIrk: s.lookupIrk,
      revocations: s.revocations,
      store: s.storeB,
      inventoryIntervalMs: 0,
      onPushApplied: ({ grantId }) => applied.push(grantId),
    });
    await Promise.all([connA.ready(), connB.ready()]);
    // Phone delivers a fresh grant to A — A calls pushInventory() so
    // B learns about it without waiting for the 5min tick.
    const g = mintGrant({
      irk: s.irk,
      serverDomains: [HOME, OFFICE],
      serverIdentities: [s.aId.publicKey, s.bId.publicKey],
      grantId: "gfresh",
    });
    s.storeA.put(g);
    connA.pushInventory();
    await waitFor(() => s.storeB.byGrantId("gfresh") !== null, 500);
    expect(applied).toEqual(["gfresh"]);
    connA.close();
    connB.close();
  });
});

describe("InMemoryAppGrantStore — fresher-cert-wins primitive", () => {
  it("rejects an older issuedAt for the same grantId", () => {
    const store = new InMemoryAppGrantStore();
    const irk = key();
    const podKey = key();
    const earlier = mintGrant({
      irk,
      serverDomains: [HOME],
      serverIdentities: [podKey.publicKey],
      grantId: "x",
      issuedAt: 100,
    });
    const later = mintGrant({
      irk,
      serverDomains: [HOME],
      serverIdentities: [podKey.publicKey],
      grantId: "x",
      issuedAt: 200,
    });
    expect(store.applyIfFresher(later)).toBe(true);
    expect(store.applyIfFresher(earlier)).toBe(false);
    expect(store.byGrantId("x")!.grant.issuedAt).toBe(200);
  });

  it("rejects an older grantId targeting the same serviceCanonical", () => {
    const store = new InMemoryAppGrantStore();
    const irk = key();
    const podKey = key();
    const newer = mintGrant({
      irk,
      serverDomains: [HOME],
      serverIdentities: [podKey.publicKey],
      grantId: "new",
      issuedAt: 500,
    });
    const olderDifferentId = mintGrant({
      irk,
      serverDomains: [HOME],
      serverIdentities: [podKey.publicKey],
      grantId: "old",
      issuedAt: 100,
    });
    expect(store.applyIfFresher(newer)).toBe(true);
    expect(store.applyIfFresher(olderDifferentId)).toBe(false);
  });

  it("accepts a fresher grantId rotation for the same serviceCanonical", () => {
    const store = new InMemoryAppGrantStore();
    const irk = key();
    const podKey = key();
    const oldId = mintGrant({
      irk,
      serverDomains: [HOME],
      serverIdentities: [podKey.publicKey],
      grantId: "old",
      issuedAt: 100,
    });
    const rotated = mintGrant({
      irk,
      serverDomains: [HOME],
      serverIdentities: [podKey.publicKey],
      grantId: "new",
      issuedAt: 500,
    });
    expect(store.applyIfFresher(oldId)).toBe(true);
    expect(store.applyIfFresher(rotated)).toBe(true);
    expect(store.byGrantId("new")!.grant.issuedAt).toBe(500);
  });
});

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
