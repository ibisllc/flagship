/**
 * Graceful server-replacement decommission handlers (docs/server-replacement-
 * graceful-decommission.md). Mirrors the self-delete/secret-mailbox handler test
 * set: deposit happy-path, the deposit's three rejections (forged order sig,
 * wrong-domain order, bad mailbox-auth), the revoke-tolerant box-fetch, the
 * chain-fetch, the epoch/ack mutations, and a deposit→box-fetch→chain round trip.
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceEndpointClaim,
  signServerDecommission,
  type DeviceEndpointClaim,
  type Keypair,
  type ServerDecommission,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetDecommission,
  handleGetEvictionChain,
  handlePostAckNew,
  handlePostAckOld,
  handlePostDecommission,
  handlePostEpochComplete,
  type ServerDecommissionDeps,
} from "../src/serverDecommission.js";

const HOST = "home.alice.flagship.services";
const USERNAME = "alice";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function rand(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function setup(opts: { irk: Keypair; stk: Keypair }): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: USERNAME, irkPubHex: bytesToHex(opts.irk.publicKey), claimedAt: 1 });
  await s.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: bytesToHex(opts.stk.publicKey),
    registeredAt: 2,
  });
  return s;
}

function deps(storage: InMemoryStorage, now?: () => number): ServerDecommissionDeps {
  return {
    servers: storage.servers,
    usernames: storage.usernames,
    serverEvictions: storage.serverEvictions,
    mailbox: {
      servers: storage.servers,
      usernames: storage.usernames,
      secretMailbox: storage.secretMailbox,
      boxSealedLeases: storage.boxSealedLeases,
    },
    ...(now ? { now } : {}),
  };
}

function mailboxAuth(irk: Keypair, opts?: { username?: string; phoneIrkPub?: Uint8Array }) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 120_000;
  const nonce = rand(32);
  const claim: DeviceEndpointClaim = {
    username: opts?.username ?? USERNAME,
    endpointLabel: "phone",
    phoneIrkPub: opts?.phoneIrkPub ?? irk.publicKey,
    issuedAt,
    expiresAt,
    nonce,
  };
  const sig = signDeviceEndpointClaim(claim, irk);
  return {
    auth: {
      username: claim.username,
      endpointLabel: claim.endpointLabel,
      phoneIrkPub: bytesToHex(claim.phoneIrkPub),
      issuedAt,
      expiresAt,
      nonce: bytesToHex(nonce),
    },
    authSignature: bytesToHex(sig),
  };
}

/** Build a deposit body: a valid mailbox-auth + an owner-IRK-signed order. */
function depositBody(opts: {
  irk: Keypair;
  retiredStk: Keypair;
  podCanonical?: string;
  signWith?: Keypair; // sign the ORDER with this key (default = the owner IRK)
  auth?: ReturnType<typeof mailboxAuth>;
}) {
  const order: ServerDecommission = {
    podCanonical: opts.podCanonical ?? HOST,
    retiredStkPubHex: bytesToHex(opts.retiredStk.publicKey),
    finalBackup: true,
    diskDisposition: "wipe-after-handoff",
    backupEpoch: 7,
    nonce: bytesToHex(rand(32)),
    issuedAt: Date.now(),
  };
  const sig = signServerDecommission(order, opts.signWith ?? opts.irk);
  return {
    ...(opts.auth ?? mailboxAuth(opts.irk)),
    order,
    signature: bytesToHex(sig),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Deposit
// ──────────────────────────────────────────────────────────────────────

describe("POST /decommission — deposit", () => {
  it("records the eviction on the happy path", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handlePostDecommission(deps(storage), HOST, depositBody({ irk, retiredStk: retired }));
    expect(res.status).toBe(200);

    const row = await storage.serverEvictions.getEviction(HOST, bytesToHex(retired.publicKey));
    expect(row).toBeDefined();
    expect(row?.retiredStkPubHex).toBe(bytesToHex(retired.publicKey));
    expect(JSON.parse(row!.orderJson).diskDisposition).toBe("wipe-after-handoff");
    expect(row?.oldAckedAt).toBeNull();
    expect(row?.newAckedAt).toBeNull();
    expect(row?.epochCompleteAt).toBeNull();
  });

  it("rejects a FORGED order signature (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const attacker = makeKey();
    const storage = await setup({ irk, stk });
    // Order signed by someone other than the owner IRK — mailbox-auth is still valid.
    const res = await handlePostDecommission(
      deps(storage),
      HOST,
      depositBody({ irk, retiredStk: retired, signWith: attacker }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/invalid signature/);
    expect(await storage.serverEvictions.getEviction(HOST, bytesToHex(retired.publicKey))).toBeUndefined();
  });

  it("rejects a WRONG-DOMAIN order (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });
    // The order's podCanonical names a different pod than the deposit URL.
    const body = depositBody({ irk, retiredStk: retired, podCanonical: "other.alice.flagship.services" });
    const res = await handlePostDecommission(deps(storage), HOST, body);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/podCanonical does not match/);
  });

  it("rejects bad mailbox-auth (403) — wrong IRK signs the auth", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const wrongIrk = makeKey();
    const storage = await setup({ irk, stk });
    // Auth claims alice's IRK but is SIGNED by a different key ⇒ auth verify fails.
    const auth = mailboxAuth(wrongIrk, { phoneIrkPub: irk.publicKey });
    const body = depositBody({ irk, retiredStk: retired, auth });
    const res = await handlePostDecommission(deps(storage), HOST, body);
    expect(res.status).toBe(403);
    expect(await storage.serverEvictions.getEviction(HOST, bytesToHex(retired.publicKey))).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Box fetch (revoke-tolerant)
// ──────────────────────────────────────────────────────────────────────

describe("GET /decommission?stk= — box fetches its own order", () => {
  it("returns the deposited order", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostDecommission(deps(storage), HOST, depositBody({ irk, retiredStk: retired }));

    const res = await handleGetDecommission(deps(storage), HOST, bytesToHex(retired.publicKey));
    expect(res.status).toBe(200);
    const b = res.body as { orderJson: string; orderSignatureHex: string };
    expect(JSON.parse(b.orderJson).podCanonical).toBe(HOST);
    expect(b.orderSignatureHex).toMatch(/^[0-9a-f]{128}$/);
  });

  it("is REVOKE-TOLERANT — still serves after the server is revoked", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostDecommission(deps(storage), HOST, depositBody({ irk, retiredStk: retired }));
    await storage.servers.revoke(HOST, "server-revoked", Date.now());

    const res = await handleGetDecommission(deps(storage), HOST, bytesToHex(retired.publicKey));
    expect(res.status).toBe(200);
  });

  it("404 when no order exists for that stk", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleGetDecommission(deps(storage), HOST, "ab".repeat(32));
    expect(res.status).toBe(404);
  });

  it("400 on a malformed stk", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    expect((await handleGetDecommission(deps(storage), HOST, null)).status).toBe(400);
    expect((await handleGetDecommission(deps(storage), HOST, "xyz")).status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Chain fetch
// ──────────────────────────────────────────────────────────────────────

describe("GET /eviction-chain — successor fetches the full chain", () => {
  it("returns the chain ordered by issuedAt", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retiredA = makeKey();
    const retiredB = makeKey();
    const storage = await setup({ irk, stk });

    // Two evictions with explicit increasing issuedAt.
    const a = depositBody({ irk, retiredStk: retiredA });
    a.order.issuedAt = 1000;
    a.signature = bytesToHex(signServerDecommission(a.order, irk));
    const b = depositBody({ irk, retiredStk: retiredB });
    b.order.issuedAt = 2000;
    b.signature = bytesToHex(signServerDecommission(b.order, irk));
    // Deposit B first, then A — listEvictions must order by issuedAt regardless.
    await handlePostDecommission(deps(storage), HOST, b);
    await handlePostDecommission(deps(storage), HOST, a);

    const res = await handleGetEvictionChain(deps(storage), HOST);
    expect(res.status).toBe(200);
    const evictions = (res.body as { evictions: { orderJson: string; epochCompleteAt: number | null }[] }).evictions;
    expect(evictions.length).toBe(2);
    expect(JSON.parse(evictions[0]!.orderJson).issuedAt).toBe(1000);
    expect(JSON.parse(evictions[1]!.orderJson).issuedAt).toBe(2000);
    expect(evictions[0]!.epochCompleteAt).toBeNull();
  });

  it("returns an empty chain for an unknown pod", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleGetEvictionChain(deps(storage), "nope.alice.flagship.services");
    expect(res.status).toBe(200);
    expect((res.body as { evictions: unknown[] }).evictions).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Epoch-complete + acks
// ──────────────────────────────────────────────────────────────────────

describe("epoch-complete + acks mutate the row", () => {
  it("epoch-complete stamps epochCompleteAt (the §9 barrier)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostDecommission(deps(storage), HOST, depositBody({ irk, retiredStk: retired }));

    const res = await handlePostEpochComplete(
      deps(storage, () => 9999),
      HOST,
      { stk: bytesToHex(retired.publicKey) },
    );
    expect(res.status).toBe(200);
    const row = await storage.serverEvictions.getEviction(HOST, bytesToHex(retired.publicKey));
    expect(row?.epochCompleteAt).toBe(9999);
  });

  it("epoch-complete 404s when no order exists", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handlePostEpochComplete(deps(storage), HOST, { stk: "cc".repeat(32) });
    expect(res.status).toBe(404);
  });

  it("ack-old stamps oldAckedAt", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostDecommission(deps(storage), HOST, depositBody({ irk, retiredStk: retired }));

    const res = await handlePostAckOld(deps(storage, () => 5555), HOST, { stk: bytesToHex(retired.publicKey) });
    expect(res.status).toBe(200);
    const row = await storage.serverEvictions.getEviction(HOST, bytesToHex(retired.publicKey));
    expect(row?.oldAckedAt).toBe(5555);
  });

  it("ack-new stamps newAckedAt across the whole pod chain", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostDecommission(deps(storage), HOST, depositBody({ irk, retiredStk: retired }));

    const res = await handlePostAckNew(deps(storage, () => 7777), HOST);
    expect(res.status).toBe(200);
    expect((res.body as { marked: number }).marked).toBe(1);
    const row = await storage.serverEvictions.getEviction(HOST, bytesToHex(retired.publicKey));
    expect(row?.newAckedAt).toBe(7777);
  });

  it("ack-old / epoch-complete reject a malformed stk (400)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    expect((await handlePostAckOld(deps(storage), HOST, { stk: "xyz" })).status).toBe(400);
    expect((await handlePostEpochComplete(deps(storage), HOST, {})).status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Round trip
// ──────────────────────────────────────────────────────────────────────

describe("deposit → box-fetch → chain-fetch round trip", () => {
  it("the order the owner deposits is what the box and successor read", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const retired = makeKey();
    const storage = await setup({ irk, stk });

    const body = depositBody({ irk, retiredStk: retired });
    const expectedJson = JSON.stringify(body.order);
    expect((await handlePostDecommission(deps(storage), HOST, body)).status).toBe(200);

    // Box reads its own order.
    const boxRes = await handleGetDecommission(deps(storage), HOST, bytesToHex(retired.publicKey));
    expect(boxRes.status).toBe(200);
    expect((boxRes.body as { orderJson: string }).orderJson).toBe(expectedJson);

    // Successor reads the chain.
    const chainRes = await handleGetEvictionChain(deps(storage), HOST);
    const evictions = (chainRes.body as { evictions: { orderJson: string }[] }).evictions;
    expect(evictions.length).toBe(1);
    expect(evictions[0]!.orderJson).toBe(expectedJson);
  });
});
