import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceEndpointClaim,
  signUpdateOrder,
  type DeviceEndpointClaim,
  type Keypair,
  type UpdateOrder,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleConsumeUpdateDeposit,
  handlePostUpdateDeposit,
} from "../src/secretMailbox.js";

// Admin-authorized in-place server-update order delivery
// (docs/server-update-mechanism.md). The phone deposits an admin-signed UpdateOrder
// naming THIS box; `.com` authorizes the deposit through the Slice-D admin gate
// (with an admin master root pinned, the bare membership IRK CANNOT authorize) and
// verifies the order signature BEFORE storing; the box consumes-once + re-verifies
// under its pinned admin root.

const HOST = "home.alice.flagship.services";
const USERNAME = "alice";
const TARGET = "9f2c1ab3de4567890abcdef1234567890abcdef1";
const FROM = "1234567890abcdef1234567890abcdef12345678";

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

async function setup(opts: {
  irk: Keypair;
  stk: Keypair;
  adminRoot?: Keypair;
}): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(opts.irk.publicKey),
    claimedAt: 1,
    ...(opts.adminRoot ? { adminRootPubHex: bytesToHex(opts.adminRoot.publicKey) } : {}),
  });
  await s.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: bytesToHex(opts.stk.publicKey),
    registeredAt: 2,
  });
  return s;
}

function deps(storage: InMemoryStorage) {
  return {
    servers: storage.servers,
    usernames: storage.usernames,
    secretMailbox: storage.secretMailbox,
    boxSealedLeases: storage.boxSealedLeases,
    grants: storage.deviceCapabilityGrants,
  };
}

// Mailbox-auth is always the account's REGISTERED membership IRK (proves an account
// device is presenting). The sensitive-op authorization of the ORDER is separate.
function mailboxAuth(irk: Keypair) {
  const issuedAt = Date.now();
  const nonce = rand(32);
  const claim: DeviceEndpointClaim = {
    username: USERNAME,
    endpointLabel: "device",
    phoneIrkPub: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 120_000,
    nonce,
  };
  const sig = signDeviceEndpointClaim(claim, irk);
  return {
    auth: {
      username: claim.username,
      endpointLabel: claim.endpointLabel,
      phoneIrkPub: bytesToHex(claim.phoneIrkPub),
      issuedAt,
      expiresAt: claim.expiresAt,
      nonce: bytesToHex(nonce),
    },
    authSignature: bytesToHex(sig),
  };
}

function orderBody(opts: {
  irk: Keypair;
  signWith: Keypair;
  serverDomain?: string;
  targetCommit?: string;
}) {
  const order: UpdateOrder = {
    serverDomain: opts.serverDomain ?? HOST,
    targetCommit: opts.targetCommit ?? TARGET,
    fromCommit: FROM,
    nonce: bytesToHex(rand(16)),
    issuedAt: Date.now(),
  };
  const sig = signUpdateOrder(order, opts.signWith);
  return {
    ...mailboxAuth(opts.irk),
    deposit: { serverDomain: HOST, requestNonceHex: bytesToHex(rand(32)) },
    order,
    signature: bytesToHex(sig),
  };
}

describe("update deposit — phone deposit (mailbox-auth + admin-authority gate)", () => {
  it("GATE CLOSED (no admin root): accepts an owner-IRK-signed order", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handlePostUpdateDeposit(
      deps(storage),
      HOST,
      orderBody({ irk, signWith: irk }),
    );
    expect(res.status).toBe(200);
  });

  it("GATE OPEN (admin root pinned): accepts an order signed by the admin master root", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const adminRoot = makeKey();
    const storage = await setup({ irk, stk, adminRoot });
    const res = await handlePostUpdateDeposit(
      deps(storage),
      HOST,
      orderBody({ irk, signWith: adminRoot }),
    );
    expect(res.status).toBe(200);
  });

  it("GATE OPEN: REJECTS an order signed by the membership IRK only (Slice-D transition rule)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const adminRoot = makeKey();
    const storage = await setup({ irk, stk, adminRoot });
    // Mailbox-auth passes (it IS the account IRK), but the ORDER is not admin-signed.
    const res = await handlePostUpdateDeposit(
      deps(storage),
      HOST,
      orderBody({ irk, signWith: irk }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/master-admin authority/);
  });

  it("rejects an order whose signature is forged by a non-admin stranger (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const stranger = makeKey();
    const res = await handlePostUpdateDeposit(
      deps(storage),
      HOST,
      orderBody({ irk, signWith: stranger }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects an order whose serverDomain names a different box (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handlePostUpdateDeposit(
      deps(storage),
      HOST,
      orderBody({ irk, signWith: irk, serverDomain: "other.alice.flagship.services" }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated deposit", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const body = orderBody({ irk, signWith: irk });
    const res = await handlePostUpdateDeposit(deps(storage), HOST, {
      deposit: body.deposit,
      order: body.order,
      signature: body.signature,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("update deposit — box consume-once (public)", () => {
  it("returns the admin-signed order carrier to a box read", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostUpdateDeposit(deps(storage), HOST, orderBody({ irk, signWith: irk }));
    const res = await handleConsumeUpdateDeposit(deps(storage), HOST);
    expect(res.status).toBe(200);
    const body = res.body as { sealed: string };
    const json = JSON.parse(Buffer.from(body.sealed, "hex").toString("utf-8")) as {
      order: { serverDomain: string; targetCommit: string; fromCommit: string };
      signature: string;
    };
    expect(json.order.serverDomain).toBe(HOST);
    expect(json.order.targetCommit).toBe(TARGET);
    expect(json.order.fromCommit).toBe(FROM);
    expect(json.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("is consume-once: a second box read returns 404", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostUpdateDeposit(deps(storage), HOST, orderBody({ irk, signWith: irk }));
    expect((await handleConsumeUpdateDeposit(deps(storage), HOST)).status).toBe(200);
    expect((await handleConsumeUpdateDeposit(deps(storage), HOST)).status).toBe(404);
  });

  it("returns 404 when no order is pending", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleConsumeUpdateDeposit(deps(storage), HOST);
    expect(res.status).toBe(404);
  });
});
