import { describe, expect, it } from "vitest";
import {
  ed,
  openSealedFromEd25519Recipient,
  sealForEd25519Recipient,
  signDeviceEndpointClaim,
  signPhoneOrder,
  verifyPhoneOrder,
  type DeviceEndpointClaim,
  type Keypair,
  type PhoneOrder,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleConsumePairingDeposit,
  handleGetSecretRequests,
  handlePostPairingDeposit,
} from "../src/secretMailbox.js";

// Deposit-on-unlock pairing — the phone folds the paired-session pairing INTO
// the boot-unlock approval: it seals an owner-IRK-signed `add-paired-session`
// order FOR the box STK and deposits it; the box does ONE public consume-once
// read at startup. `.com` never sees the token (I1).

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
function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
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
  return { servers: storage.servers, usernames: storage.usernames, secretMailbox: storage.secretMailbox, boxSealedLeases: storage.boxSealedLeases };
}

function mailboxAuth(irk: Keypair, opts?: { username?: string; phoneIrkPub?: Uint8Array }) {
  const issuedAt = Date.now();
  const nonce = rand(32);
  const claim: DeviceEndpointClaim = {
    username: opts?.username ?? USERNAME,
    endpointLabel: "device",
    phoneIrkPub: opts?.phoneIrkPub ?? irk.publicKey,
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

/** Build the sealed `add-paired-session` envelope blob, sealed for the box STK. */
function sealedPairing(opts: { irk: Keypair; stk: Keypair; token?: string; label?: string }): {
  token: string;
  sealedHex: string;
} {
  const token = opts.token ?? bytesToHex(rand(32));
  const order: PhoneOrder = {
    type: "add-paired-session",
    serverId: HOST,
    token,
    label: opts.label ?? "Alice's iPhone",
    issuedAt: Date.now(),
  };
  const sig = signPhoneOrder(order, opts.irk);
  const envelope = JSON.stringify({
    request: { type: "add-paired-session", serverId: HOST, token, label: order.label, issuedAt: order.issuedAt },
    signature: bytesToHex(sig),
  });
  const sealed = sealForEd25519Recipient(new TextEncoder().encode(envelope), opts.stk.publicKey);
  return { token, sealedHex: bytesToHex(sealed) };
}

function depositBody(opts: { irk: Keypair; stk: Keypair; sealedHex: string; nonce?: Uint8Array; host?: string }) {
  return {
    ...mailboxAuth(opts.irk),
    deposit: {
      serverDomain: opts.host ?? HOST,
      requestNonceHex: bytesToHex(opts.nonce ?? rand(32)),
      stkPub: bytesToHex(opts.stk.publicKey),
      sealed: opts.sealedHex,
      issuedAt: Date.now(),
    },
  };
}

describe("pairing deposit — phone deposit (IRK mailbox-auth)", () => {
  it("accepts a deposit from the account's phone + stores the sealed blob", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { sealedHex } = sealedPairing({ irk, stk });
    const res = await handlePostPairingDeposit(deps(storage), HOST, depositBody({ irk, stk, sealedHex }));
    expect(res.status).toBe(200);
  });

  it("rejects an unauthenticated (no mailbox-auth) deposit", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { sealedHex } = sealedPairing({ irk, stk });
    const res = await handlePostPairingDeposit(deps(storage), HOST, {
      deposit: { serverDomain: HOST, requestNonceHex: bytesToHex(rand(32)), stkPub: bytesToHex(stk.publicKey), sealed: sealedHex, issuedAt: Date.now() },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a mailbox-auth signed by a DIFFERENT account's IRK (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const stranger = makeKey();
    const { sealedHex } = sealedPairing({ irk, stk });
    const body = {
      ...mailboxAuth(stranger), // wrong IRK, but claims `alice` as the username
      deposit: { serverDomain: HOST, requestNonceHex: bytesToHex(rand(32)), stkPub: bytesToHex(stk.publicKey), sealed: sealedHex, issuedAt: Date.now() },
    };
    const res = await handlePostPairingDeposit(deps(storage), HOST, body);
    expect(res.status).toBe(403);
  });

  it("rejects a stkPub that doesn't match the registered box (403, I2-style)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const foreign = makeKey();
    const storage = await setup({ irk, stk });
    const { sealedHex } = sealedPairing({ irk, stk: foreign });
    const res = await handlePostPairingDeposit(deps(storage), HOST, depositBody({ irk, stk: foreign, sealedHex }));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/does not match the registered server/);
  });

  it("a pairing deposit does NOT surface in the unlock-key mailbox listing (no lane leak)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { sealedHex } = sealedPairing({ irk, stk });
    await handlePostPairingDeposit(deps(storage), HOST, depositBody({ irk, stk, sealedHex }));
    const list = await handleGetSecretRequests(deps(storage), mailboxAuth(irk));
    expect(list.status).toBe(200);
    expect((list.body as { requests: unknown[] }).requests).toHaveLength(0);
  });

  it("accepts a CREATE-TIME deposit BEFORE the box has registered, then the box consumes it after first-boot register", async () => {
    const irk = makeKey();
    const stk = makeKey();
    // The owner's username is claimed, but there is NO server row yet — the box
    // hasn't booted or registered. This is the create-time deposit: the phone
    // pre-registers the pairing the moment it mints the recipe.
    const s = new InMemoryStorage();
    await s.usernames.put({ username: USERNAME, irkPubHex: bytesToHex(irk.publicKey), claimedAt: 1 });
    const { token, sealedHex } = sealedPairing({ irk, stk });
    const dep = await handlePostPairingDeposit(deps(s), HOST, depositBody({ irk, stk, sealedHex }));
    expect(dep.status).toBe(200);
    // First boot: the box registers, then consumes the pending pairing.
    await s.servers.put({ serverDomain: HOST, username: USERNAME, identityPubKeyHex: bytesToHex(stk.publicKey), registeredAt: 2 });
    const read = await handleConsumePairingDeposit(deps(s), HOST);
    expect(read.status).toBe(200);
    const opened = JSON.parse(
      new TextDecoder().decode(openSealedFromEd25519Recipient(hexToBytes((read.body as { sealed: string }).sealed), stk.privateKey)),
    ) as { request: PhoneOrder; signature: string };
    expect((opened.request as { token: string }).token).toBe(token);
    expect(verifyPhoneOrder(opened.request, hexToBytes(opened.signature), irk.publicKey)).toBe(true);
  });

  it("rejects a CREATE-TIME deposit for a fqdn NOT under the authed account (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const s = new InMemoryStorage();
    await s.usernames.put({ username: USERNAME, irkPubHex: bytesToHex(irk.publicKey), claimedAt: 1 });
    const { sealedHex } = sealedPairing({ irk, stk });
    // Same authed account (alice), but a fqdn under a DIFFERENT username.
    const foreignHost = "home.mallory.flagship.services";
    const res = await handlePostPairingDeposit(deps(s), foreignHost, depositBody({ irk, stk, sealedHex, host: foreignHost }));
    expect(res.status).toBe(403);
  });
});

describe("pairing deposit — box consume-once (public)", () => {
  it("returns the sealed blob to a public box read + opens to the signed order", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { token, sealedHex } = sealedPairing({ irk, stk });
    await handlePostPairingDeposit(deps(storage), HOST, depositBody({ irk, stk, sealedHex }));

    const res = await handleConsumePairingDeposit(deps(storage), HOST);
    expect(res.status).toBe(200);
    const body = res.body as { sealed: string; stkPub: string };
    expect(body.stkPub).toBe(bytesToHex(stk.publicKey));
    // The blob is opaque to `.com`; only the box's STK private key opens it
    // (proven here by re-deriving the order off the wire bytes).
    expect(body.sealed).toBe(sealedHex);
    // The exact round-trip the booting box performs (= the daemon's
    // consumePendingPairing): open the sealed blob with the STK private key, and
    // the add-paired-session order re-verifies under the owner IRK.
    const opened = JSON.parse(
      new TextDecoder().decode(openSealedFromEd25519Recipient(hexToBytes(body.sealed), stk.privateKey)),
    ) as { request: PhoneOrder; signature: string };
    expect(opened.request.type).toBe("add-paired-session");
    expect((opened.request as { token: string }).token).toBe(token);
    expect(verifyPhoneOrder(opened.request, hexToBytes(opened.signature), irk.publicKey)).toBe(true);
  });

  it("is consume-once: a second box read returns 404", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { sealedHex } = sealedPairing({ irk, stk });
    await handlePostPairingDeposit(deps(storage), HOST, depositBody({ irk, stk, sealedHex }));

    const first = await handleConsumePairingDeposit(deps(storage), HOST);
    expect(first.status).toBe(200);
    const second = await handleConsumePairingDeposit(deps(storage), HOST);
    expect(second.status).toBe(404);
  });

  it("returns 404 when no deposit is pending", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleConsumePairingDeposit(deps(storage), HOST);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown server", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleConsumePairingDeposit(deps(storage), "ghost.alice.flagship.services");
    expect(res.status).toBe(404);
  });
});
