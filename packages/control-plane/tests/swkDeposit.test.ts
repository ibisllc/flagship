import { describe, expect, it } from "vitest";
import {
  buildSwkDelivery,
  carrierHexToSwkDelivery,
  ed,
  openAndVerifySwkDelivery,
  signDeviceEndpointClaim,
  swkDeliveryToCarrierHex,
  type DeviceEndpointClaim,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleConsumeSwkDeposit,
  handleGetSecretRequests,
  handlePostSwkDeposit,
} from "../src/secretMailbox.js";

// Secret-free-recipe SWK delivery — the phone seals the SWK to the box's OWN
// identity (the registered STK) and IRK-signs the wrapper, then deposits it; the
// box consumes-once on first boot and unseals the SWK with its identity key.
// `.com` holds ciphertext only (I1/I3).

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

function deps(storage: InMemoryStorage) {
  return {
    servers: storage.servers,
    usernames: storage.usernames,
    secretMailbox: storage.secretMailbox,
    boxSealedLeases: storage.boxSealedLeases,
  };
}

function mailboxAuth(irk: Keypair, opts?: { username?: string }) {
  const issuedAt = Date.now();
  const nonce = rand(32);
  const claim: DeviceEndpointClaim = {
    username: opts?.username ?? USERNAME,
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

/** Build the SWK-delivery carrier (sealed for the box identity = the STK). */
function swkCarrier(opts: { irk: Keypair; stk: Keypair; swk?: Uint8Array }): {
  swk: Uint8Array;
  carrierHex: string;
} {
  const swk = opts.swk ?? rand(32);
  const { delivery, signature } = buildSwkDelivery({
    serverDomain: HOST,
    swk,
    boxIdentityPub: opts.stk.publicKey,
    irk: opts.irk,
    issuedAt: Date.now(),
  });
  return { swk, carrierHex: swkDeliveryToCarrierHex(delivery, signature) };
}

function depositBody(opts: {
  irk: Keypair;
  stk: Keypair;
  carrierHex: string;
  nonce?: Uint8Array;
  host?: string;
}) {
  return {
    ...mailboxAuth(opts.irk),
    deposit: {
      serverDomain: opts.host ?? HOST,
      requestNonceHex: bytesToHex(opts.nonce ?? rand(32)),
      stkPub: bytesToHex(opts.stk.publicKey),
      sealed: opts.carrierHex,
      issuedAt: Date.now(),
    },
  };
}

describe("swk deposit — phone deposit (IRK mailbox-auth)", () => {
  it("accepts a deposit from the account's phone + stores the carrier", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { carrierHex } = swkCarrier({ irk, stk });
    const res = await handlePostSwkDeposit(deps(storage), HOST, depositBody({ irk, stk, carrierHex }));
    expect(res.status).toBe(200);
  });

  it("rejects an unauthenticated deposit", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { carrierHex } = swkCarrier({ irk, stk });
    const res = await handlePostSwkDeposit(deps(storage), HOST, {
      deposit: {
        serverDomain: HOST,
        requestNonceHex: bytesToHex(rand(32)),
        stkPub: bytesToHex(stk.publicKey),
        sealed: carrierHex,
        issuedAt: Date.now(),
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a mailbox-auth signed by a DIFFERENT account's IRK (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const stranger = makeKey();
    const { carrierHex } = swkCarrier({ irk, stk });
    const body = {
      ...mailboxAuth(stranger),
      deposit: {
        serverDomain: HOST,
        requestNonceHex: bytesToHex(rand(32)),
        stkPub: bytesToHex(stk.publicKey),
        sealed: carrierHex,
        issuedAt: Date.now(),
      },
    };
    const res = await handlePostSwkDeposit(deps(storage), HOST, body);
    expect(res.status).toBe(403);
  });

  it("rejects a stkPub that doesn't match the registered box (403, I2)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const foreign = makeKey();
    const storage = await setup({ irk, stk });
    const { carrierHex } = swkCarrier({ irk, stk: foreign });
    const res = await handlePostSwkDeposit(deps(storage), HOST, depositBody({ irk, stk: foreign, carrierHex }));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/does not match the registered server/);
  });

  it("rejects an unregistered server (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const s = new InMemoryStorage();
    await s.usernames.put({ username: USERNAME, irkPubHex: bytesToHex(irk.publicKey), claimedAt: 1 });
    const { carrierHex } = swkCarrier({ irk, stk });
    const res = await handlePostSwkDeposit(deps(s), HOST, depositBody({ irk, stk, carrierHex }));
    expect(res.status).toBe(403);
  });

  it("an swk deposit does NOT surface in the unlock-key mailbox listing (no lane leak)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { carrierHex } = swkCarrier({ irk, stk });
    await handlePostSwkDeposit(deps(storage), HOST, depositBody({ irk, stk, carrierHex }));
    const list = await handleGetSecretRequests(deps(storage), mailboxAuth(irk));
    expect(list.status).toBe(200);
    expect((list.body as { requests: unknown[] }).requests).toHaveLength(0);
  });
});

describe("swk deposit — box consume-once (public)", () => {
  it("returns the carrier to a public box read + opens to the exact SWK", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { swk, carrierHex } = swkCarrier({ irk, stk });
    await handlePostSwkDeposit(deps(storage), HOST, depositBody({ irk, stk, carrierHex }));

    const res = await handleConsumeSwkDeposit(deps(storage), HOST);
    expect(res.status).toBe(200);
    const body = res.body as { sealed: string; stkPub: string };
    expect(body.stkPub).toBe(bytesToHex(stk.publicKey));
    expect(body.sealed).toBe(carrierHex);
    // The exact round-trip the booting box performs: parse the carrier, verify
    // the owner-IRK signature, and unseal the SWK with the box identity key.
    const parsed = carrierHexToSwkDelivery(body.sealed);
    expect(parsed).not.toBeNull();
    const opened = openAndVerifySwkDelivery({
      delivery: parsed!.delivery,
      signature: parsed!.signature,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: stk.privateKey,
      serverDomain: HOST,
    });
    expect(opened).not.toBeNull();
    expect(bytesToHex(opened!)).toBe(bytesToHex(swk));
  });

  it("is consume-once: a second box read returns 404", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { carrierHex } = swkCarrier({ irk, stk });
    await handlePostSwkDeposit(deps(storage), HOST, depositBody({ irk, stk, carrierHex }));

    const first = await handleConsumeSwkDeposit(deps(storage), HOST);
    expect(first.status).toBe(200);
    const second = await handleConsumeSwkDeposit(deps(storage), HOST);
    expect(second.status).toBe(404);
  });

  it("returns 404 when no deposit is pending", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleConsumeSwkDeposit(deps(storage), HOST);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown server", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleConsumeSwkDeposit(deps(storage), "ghost.alice.flagship.services");
    expect(res.status).toBe(404);
  });
});
