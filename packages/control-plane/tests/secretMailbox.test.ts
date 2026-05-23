import { describe, expect, it } from "vitest";
import {
  buildAutoUnlockLeaseV2,
  buildSealedSecretResponse,
  ed,
  openAutoUnlockLeaseV2,
  openSealedSecretResponse,
  sealForEd25519Recipient,
  signAutoUnlockLeaseV2,
  signDeviceEndpointClaim,
  signLeaseRevocation,
  signSecretRequest,
  type DeviceEndpointClaim,
  type Keypair,
  type SecretPurpose,
  type SecretRequest,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleGetSecretRequests,
  handleGetSecretResponse,
  handleListBoxSealedLeases,
  handlePostBoxSealedLease,
  handlePostSecretRequest,
  handlePostSecretResponse,
  handleReleaseBoxSealedLease,
  handleRevokeBoxSealedLease,
} from "../src/secretMailbox.js";

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
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(opts.irk.publicKey),
    claimedAt: 1,
  });
  await s.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: bytesToHex(opts.stk.publicKey),
    registeredAt: 2,
  });
  return s;
}

function deps(storage: InMemoryStorage, extra?: { pushUserDevices?: (u: string, c: string, p?: Uint8Array) => Promise<void>; now?: () => number }) {
  return {
    servers: storage.servers,
    usernames: storage.usernames,
    secretMailbox: storage.secretMailbox,
    boxSealedLeases: storage.boxSealedLeases,
    ...(extra ?? {}),
  };
}

function postSecretRequestBody(opts: {
  stk: Keypair;
  purpose?: SecretPurpose;
  nonce?: Uint8Array;
  issuedAt?: number;
  deviceInfo?: unknown;
  serverDomain?: string;
}) {
  const nonce = opts.nonce ?? rand(32);
  const issuedAt = opts.issuedAt ?? Date.now();
  const serverDomain = opts.serverDomain ?? HOST;
  const req: SecretRequest = {
    serverDomain,
    stkPub: opts.stk.publicKey,
    purpose: opts.purpose ?? "unlock-key",
    nonce,
    issuedAt,
  };
  const sig = signSecretRequest(req, opts.stk);
  return {
    nonce,
    body: {
      request: {
        serverDomain,
        stkPub: bytesToHex(opts.stk.publicKey),
        purpose: req.purpose,
        nonce: bytesToHex(nonce),
        issuedAt,
      },
      signature: bytesToHex(sig),
      ...(opts.deviceInfo !== undefined ? { deviceInfo: opts.deviceInfo } : {}),
    },
  };
}

function mailboxAuth(irk: Keypair, opts?: { username?: string; phoneIrkPub?: Uint8Array; expiresAt?: number; issuedAt?: number }) {
  const issuedAt = opts?.issuedAt ?? Date.now();
  const expiresAt = opts?.expiresAt ?? issuedAt + 120_000;
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

// ──────────────────────────────────────────────────────────────────────
// secret-request: STK-signature gate
// ──────────────────────────────────────────────────────────────────────

describe("POST /secret-request — STK signature gate", () => {
  it("accepts an STK-signed request from the directory-bound box", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = postSecretRequestBody({ stk });
    const res = await handlePostSecretRequest(deps(storage), HOST, body);
    expect(res.status).toBe(200);
  });

  it("rejects a FOREIGN STK that doesn't match the registered server (403, I2)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const foreign = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = postSecretRequestBody({ stk: foreign });
    const res = await handlePostSecretRequest(deps(storage), HOST, body);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/does not match the registered server/);
  });

  it("rejects a request whose signature was made by a different key (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    // Claim the right stkPub but sign with the wrong key.
    const nonce = rand(32);
    const issuedAt = Date.now();
    const wrong = makeKey();
    const req: SecretRequest = { serverDomain: HOST, stkPub: stk.publicKey, purpose: "unlock-key", nonce, issuedAt };
    const sig = signSecretRequest(req, wrong);
    const res = await handlePostSecretRequest(deps(storage), HOST, {
      request: { serverDomain: HOST, stkPub: bytesToHex(stk.publicKey), purpose: "unlock-key", nonce: bytesToHex(nonce), issuedAt },
      signature: bytesToHex(sig),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a stale request outside the freshness window (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = postSecretRequestBody({ stk, issuedAt: Date.now() - 10 * 60_000 });
    const res = await handlePostSecretRequest(deps(storage), HOST, body);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/stale/);
  });

  it("rejects an unknown server (404)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = postSecretRequestBody({ stk, serverDomain: "ghost.alice.flagship.services" });
    const res = await handlePostSecretRequest(deps(storage), "ghost.alice.flagship.services", body);
    expect(res.status).toBe(404);
  });

  it("rejects host / serverDomain mismatch (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = postSecretRequestBody({ stk });
    const res = await handlePostSecretRequest(deps(storage), "other.alice.flagship.services", body);
    expect(res.status).toBe(403);
  });

  it("fires a push to the user's devices on a valid request", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    let pushed: { username: string; category: string } | null = null;
    const { body } = postSecretRequestBody({ stk });
    const res = await handlePostSecretRequest(
      deps(storage, {
        pushUserDevices: async (username, category) => {
          pushed = { username, category };
        },
      }),
      HOST,
      body,
    );
    expect(res.status).toBe(200);
    // The push closure is fire-and-forget (void); allow the microtask to run.
    await Promise.resolve();
    expect(pushed).not.toBeNull();
    expect(pushed!.username).toBe(USERNAME);
    expect(pushed!.category).toBe("secret-request");
  });
});

// ──────────────────────────────────────────────────────────────────────
// single-use nonce + TTL
// ──────────────────────────────────────────────────────────────────────

describe("mailbox — single-use nonce + TTL", () => {
  it("rejects a re-posted nonce (409 duplicate nonce)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const nonce = rand(32);
    const { body } = postSecretRequestBody({ stk, nonce });
    const r1 = await handlePostSecretRequest(deps(storage), HOST, body);
    expect(r1.status).toBe(200);
    // Re-sign a fresh request with the SAME nonce (a replay).
    const { body: body2 } = postSecretRequestBody({ stk, nonce });
    const r2 = await handlePostSecretRequest(deps(storage), HOST, body2);
    expect(r2.status).toBe(409);
    expect((r2.body as { error: string }).error).toBe("duplicate nonce");
  });

  it("a request past its TTL is not served to the phone and can't be answered", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    let clock = 1_000_000;
    const now = () => clock;
    const { nonce, body } = postSecretRequestBody({ stk, issuedAt: clock });
    const post = await handlePostSecretRequest(deps(storage, { now }), HOST, body);
    expect(post.status).toBe(200);

    // Advance past the 5-min TTL.
    clock += 6 * 60_000;
    const list = await handleGetSecretRequests(deps(storage, { now }), mailboxAuth(irk, { issuedAt: clock }));
    expect(list.status).toBe(200);
    expect((list.body as { requests: unknown[] }).requests).toHaveLength(0);

    // The phone can't answer an expired request.
    const sealed = bytesToHex(rand(64));
    const resp = await handlePostSecretResponse(deps(storage, { now }), {
      ...mailboxAuth(irk, { issuedAt: clock }),
      response: { serverDomain: HOST, requestNonceHex: bytesToHex(nonce), purpose: "unlock-key", sealed, issuedAt: clock },
    });
    expect(resp.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// phone mailbox-auth — only the user's IRK fetches
// ──────────────────────────────────────────────────────────────────────

describe("phone mailbox-auth", () => {
  it("the user's IRK can fetch its own pending requests", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = postSecretRequestBody({ stk, deviceInfo: { ip: "1.2.3.4", region: "eu", os: "alpine" } });
    await handlePostSecretRequest(deps(storage), HOST, body);
    const res = await handleGetSecretRequests(deps(storage), mailboxAuth(irk));
    expect(res.status).toBe(200);
    const reqs = (res.body as { requests: { serverDomain: string; deviceInfo: unknown }[] }).requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.serverDomain).toBe(HOST);
    expect(reqs[0]!.deviceInfo).toEqual({ ip: "1.2.3.4", region: "eu", os: "alpine" });
  });

  it("a DIFFERENT user's IRK cannot fetch the mailbox (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const attacker = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = postSecretRequestBody({ stk });
    await handlePostSecretRequest(deps(storage), HOST, body);
    // Attacker signs with their own IRK but claims alice's account.
    const res = await handleGetSecretRequests(deps(storage), mailboxAuth(attacker, { username: USERNAME, phoneIrkPub: attacker.publicKey }));
    expect(res.status).toBe(403);
  });

  it("rejects mailbox auth with a phoneIrkPub that isn't the account IRK (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    // Sign with the real IRK but claim a different phoneIrkPub.
    const fake = makeKey();
    const res = await handleGetSecretRequests(deps(storage), mailboxAuth(irk, { phoneIrkPub: fake.publicKey }));
    expect(res.status).toBe(403);
  });

  it("rejects an expired mailbox-auth claim (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    let clock = 1_000_000;
    const now = () => clock;
    const auth = mailboxAuth(irk, { issuedAt: clock, expiresAt: clock + 1000 });
    clock += 5000;
    const res = await handleGetSecretRequests(deps(storage, { now }), auth);
    expect(res.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────
// end-to-end relay + I1 (no plaintext on any path)
// ──────────────────────────────────────────────────────────────────────

describe("end-to-end relay (unlock-key) + I1", () => {
  it("box requests → phone seals → box consumes the SEALED reply, never plaintext", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });

    // 1. box posts the request
    const { nonce, body } = postSecretRequestBody({ stk });
    expect((await handlePostSecretRequest(deps(storage), HOST, body)).status).toBe(200);

    // 2. phone fetches it
    const listed = await handleGetSecretRequests(deps(storage), mailboxAuth(irk));
    const req = (listed.body as { requests: { requestNonceHex: string }[] }).requests[0]!;
    expect(req.requestNonceHex).toBe(bytesToHex(nonce));

    // 3. phone re-seals the LUKS key for the box STK + posts the reply
    const luksKey = rand(64);
    const sealedResp = buildSealedSecretResponse(luksKey, {
      serverDomain: HOST,
      stkPub: stk.publicKey,
      purpose: "unlock-key",
      nonce,
      issuedAt: Date.now(),
    });
    const postResp = await handlePostSecretResponse(deps(storage), {
      ...mailboxAuth(irk),
      response: {
        serverDomain: HOST,
        requestNonceHex: bytesToHex(nonce),
        purpose: "unlock-key",
        sealed: bytesToHex(sealedResp.sealed),
        issuedAt: sealedResp.issuedAt,
      },
    });
    expect(postResp.status).toBe(200);

    // 4. box polls + consumes → only the SEALED blob comes back
    const got = await handleGetSecretResponse(deps(storage), HOST, bytesToHex(nonce));
    expect(got.status).toBe(200);
    const gotBody = got.body as { sealed: string };
    // I1 — the wire reply carries no `unlockKey`/plaintext field.
    expect((got.body as Record<string, unknown>)["unlockKey"]).toBeUndefined();
    // The serialized response body never contains the plaintext key.
    expect(JSON.stringify(got.body)).not.toContain(bytesToHex(luksKey));

    // The box opens it with its STK private key + recovers the key.
    const recovered = openSealedSecretResponse(
      { serverDomain: HOST, requestNonceHex: bytesToHex(nonce), purpose: "unlock-key", sealed: hexToBytes(gotBody.sealed), issuedAt: 0 },
      { serverDomain: HOST, stkPub: stk.publicKey, purpose: "unlock-key", nonce, issuedAt: 0 },
      stk.privateKey,
    );
    expect(bytesToHex(recovered)).toBe(bytesToHex(luksKey));
  });

  it("the secret-response is single-use (consumed on delivery)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { nonce, body } = postSecretRequestBody({ stk });
    await handlePostSecretRequest(deps(storage), HOST, body);
    const sealedResp = buildSealedSecretResponse(rand(32), { serverDomain: HOST, stkPub: stk.publicKey, purpose: "unlock-key", nonce, issuedAt: Date.now() });
    await handlePostSecretResponse(deps(storage), {
      ...mailboxAuth(irk),
      response: { serverDomain: HOST, requestNonceHex: bytesToHex(nonce), purpose: "unlock-key", sealed: bytesToHex(sealedResp.sealed), issuedAt: sealedResp.issuedAt },
    });
    const first = await handleGetSecretResponse(deps(storage), HOST, bytesToHex(nonce));
    expect(first.status).toBe(200);
    const second = await handleGetSecretResponse(deps(storage), HOST, bytesToHex(nonce));
    expect(second.status).toBe(404);
  });

  it("a reply is write-once — a second device can't overwrite it (409)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { nonce, body } = postSecretRequestBody({ stk });
    await handlePostSecretRequest(deps(storage), HOST, body);
    const sealed = bytesToHex(buildSealedSecretResponse(rand(32), { serverDomain: HOST, stkPub: stk.publicKey, purpose: "unlock-key", nonce, issuedAt: Date.now() }).sealed);
    const auth = mailboxAuth(irk);
    const r1 = await handlePostSecretResponse(deps(storage), { ...auth, response: { serverDomain: HOST, requestNonceHex: bytesToHex(nonce), purpose: "unlock-key", sealed, issuedAt: Date.now() } });
    expect(r1.status).toBe(200);
    const r2 = await handlePostSecretResponse(deps(storage), { ...mailboxAuth(irk), response: { serverDomain: HOST, requestNonceHex: bytesToHex(nonce), purpose: "unlock-key", sealed, issuedAt: Date.now() } });
    expect(r2.status).toBe(409);
    expect((r2.body as { error: string }).error).toBe("already answered");
  });

  it("a phone can't answer another account's request (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    // Register a SECOND user + box so we have a foreign mailbox row.
    const bobIrk = makeKey();
    const bobStk = makeKey();
    await storage.usernames.put({ username: "bob", irkPubHex: bytesToHex(bobIrk.publicKey), claimedAt: 1 });
    const BOBHOST = "home.bob.flagship.services";
    await storage.servers.put({ serverDomain: BOBHOST, username: "bob", identityPubKeyHex: bytesToHex(bobStk.publicKey), registeredAt: 2 });
    const { nonce } = postSecretRequestBody({ stk: bobStk, serverDomain: BOBHOST });
    const bobReq = postSecretRequestBody({ stk: bobStk, nonce, serverDomain: BOBHOST });
    await handlePostSecretRequest(deps(storage), BOBHOST, bobReq.body);
    // Alice (valid auth for HER account) tries to answer bob's request.
    const sealed = bytesToHex(rand(48));
    const res = await handlePostSecretResponse(deps(storage), {
      ...mailboxAuth(irk),
      response: { serverDomain: BOBHOST, requestNonceHex: bytesToHex(nonce), purpose: "unlock-key", sealed, issuedAt: Date.now() },
    });
    expect(res.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────
// box-sealed lease (AutoUnlockLeaseV2) — I1 + I2 + maxUses + revoke
// ──────────────────────────────────────────────────────────────────────

function leaseDepositBody(opts: { irk: Keypair; stk: Keypair; luksKey?: Uint8Array; leaseId?: string; maxUses?: number; expiresAt?: number; issuedAt?: number; pinStkPub?: Uint8Array }) {
  const issuedAt = opts.issuedAt ?? Date.now();
  const expiresAt = opts.expiresAt ?? issuedAt + 30 * 86_400_000;
  const leaseId = opts.leaseId ?? bytesToHex(rand(8));
  const luksKey = opts.luksKey ?? rand(64);
  const lease = buildAutoUnlockLeaseV2({
    serverDomain: HOST,
    stkPub: opts.pinStkPub ?? opts.stk.publicKey,
    leaseId,
    luksKey,
    issuedAt,
    expiresAt,
    ...(opts.maxUses !== undefined ? { maxUses: opts.maxUses } : {}),
  });
  const sig = signAutoUnlockLeaseV2(lease, opts.irk);
  return {
    leaseId,
    luksKey,
    body: {
      lease: {
        serverDomain: HOST,
        stkPub: bytesToHex(lease.stkPub),
        leaseId,
        sealedKey: bytesToHex(lease.sealedKey),
        issuedAt,
        expiresAt,
        ...(opts.maxUses !== undefined ? { maxUses: opts.maxUses } : {}),
      },
      signature: bytesToHex(sig),
    },
  };
}

describe("box-sealed lease (AutoUnlockLeaseV2)", () => {
  it("stores an IRK-signed lease + releases the SEALED key (I1)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { luksKey, body } = leaseDepositBody({ irk, stk });
    const dep = await handlePostBoxSealedLease(deps(storage), HOST, body);
    expect(dep.status).toBe(200);

    const rel = await handleReleaseBoxSealedLease(deps(storage), HOST);
    expect(rel.status).toBe(200);
    const relBody = rel.body as { sealedKey: string; stkPub: string };
    // I1 — no plaintext key field, and the body never contains the key.
    expect((rel.body as Record<string, unknown>)["unlockKey"]).toBeUndefined();
    expect(JSON.stringify(rel.body)).not.toContain(bytesToHex(luksKey));
    // The box unseals with its STK private key.
    const recovered = openAutoUnlockLeaseV2(
      { serverDomain: HOST, stkPub: stk.publicKey, leaseId: "x", sealedKey: hexToBytes(relBody.sealedKey), issuedAt: 0, expiresAt: 0 },
      stk.privateKey,
    );
    expect(bytesToHex(recovered)).toBe(bytesToHex(luksKey));
  });

  it("I2 — rejects a lease whose pinned stkPub isn't the registered box (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const rogue = makeKey();
    const storage = await setup({ irk, stk });
    // The lease is validly IRK-signed but seals for a DIFFERENT (rogue) STK
    // and pins it — .com must refuse to retarget the seal.
    const { body } = leaseDepositBody({ irk, stk, pinStkPub: rogue.publicKey });
    const res = await handlePostBoxSealedLease(deps(storage), HOST, body);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/does not match the registered server/);
  });

  it("I2 — rejects a lease signed by a NON-IRK key (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const notIrk = makeKey();
    const storage = await setup({ irk, stk });
    // Sign the (correctly-pinned) lease with the wrong key.
    const { body } = leaseDepositBody({ irk: notIrk, stk });
    const res = await handlePostBoxSealedLease(deps(storage), HOST, body);
    expect(res.status).toBe(403);
  });

  it("enforces maxUses — exhausted after the cap", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = leaseDepositBody({ irk, stk, maxUses: 2 });
    await handlePostBoxSealedLease(deps(storage), HOST, body);
    expect((await handleReleaseBoxSealedLease(deps(storage), HOST)).status).toBe(200);
    expect((await handleReleaseBoxSealedLease(deps(storage), HOST)).status).toBe(200);
    // Third release → exhausted.
    expect((await handleReleaseBoxSealedLease(deps(storage), HOST)).status).toBe(404);
  });

  it("unbounded lease (no maxUses) survives many releases until expiry", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body } = leaseDepositBody({ irk, stk });
    await handlePostBoxSealedLease(deps(storage), HOST, body);
    for (let i = 0; i < 5; i++) {
      expect((await handleReleaseBoxSealedLease(deps(storage), HOST)).status).toBe(200);
    }
  });

  it("revocation (IRK-signed) drops the lease so a reboot can't release it", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { leaseId, body } = leaseDepositBody({ irk, stk });
    await handlePostBoxSealedLease(deps(storage), HOST, body);

    const issuedAt = Date.now();
    const revSig = signLeaseRevocation({ serverDomain: HOST, leaseId, issuedAt }, irk);
    const rev = await handleRevokeBoxSealedLease(deps(storage), HOST, leaseId, {
      request: { serverDomain: HOST, leaseId, issuedAt },
      signature: bytesToHex(revSig),
    });
    expect(rev.status).toBe(200);
    expect((rev.body as { removed: boolean }).removed).toBe(true);
    // No release after revoke.
    expect((await handleReleaseBoxSealedLease(deps(storage), HOST)).status).toBe(404);
  });

  it("revocation by a NON-IRK key is rejected (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const attacker = makeKey();
    const storage = await setup({ irk, stk });
    const { leaseId, body } = leaseDepositBody({ irk, stk });
    await handlePostBoxSealedLease(deps(storage), HOST, body);
    const issuedAt = Date.now();
    const revSig = signLeaseRevocation({ serverDomain: HOST, leaseId, issuedAt }, attacker);
    const rev = await handleRevokeBoxSealedLease(deps(storage), HOST, leaseId, {
      request: { serverDomain: HOST, leaseId, issuedAt },
      signature: bytesToHex(revSig),
    });
    expect(rev.status).toBe(403);
    // Still releasable (revoke failed).
    expect((await handleReleaseBoxSealedLease(deps(storage), HOST)).status).toBe(200);
  });

  it("lease list returns metadata only — never the sealed key (I1/I3)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { body, luksKey } = leaseDepositBody({ irk, stk, maxUses: 3 });
    await handlePostBoxSealedLease(deps(storage), HOST, body);
    const list = await handleListBoxSealedLeases(deps(storage), HOST);
    expect(list.status).toBe(200);
    const leases = (list.body as { leases: Record<string, unknown>[] }).leases;
    expect(leases).toHaveLength(1);
    expect(leases[0]!["sealedKey"]).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(bytesToHex(luksKey));
  });
});

// ──────────────────────────────────────────────────────────────────────
// I3 — `.com` cannot read or forge: a stored sealed reply is opaque,
// and a forged (non-phone) reply doesn't open under the box STK.
// ──────────────────────────────────────────────────────────────────────

describe("I3 — .com is gate/router/push only", () => {
  it("a reply forged by a relay (sealed for a key it controls) doesn't open under the box STK", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const { nonce, body } = postSecretRequestBody({ stk });
    await handlePostSecretRequest(deps(storage), HOST, body);

    // A malicious relay seals a value for ITS OWN key, not the box STK.
    const rogue = makeKey();
    const forged = sealForEd25519Recipient(rand(32), rogue.publicKey);
    // It can still write it via the phone path only if it forges the IRK
    // auth — which it can't. But suppose it bypasses auth at the storage
    // layer; the box's open MUST fail since it isn't sealed for the box.
    await storage.secretMailbox.putResponse(HOST, bytesToHex(nonce), bytesToHex(forged), Date.now(), Date.now());
    const got = await handleGetSecretResponse(deps(storage), HOST, bytesToHex(nonce));
    expect(got.status).toBe(200);
    const sealed = hexToBytes((got.body as { sealed: string }).sealed);
    expect(() =>
      openSealedSecretResponse(
        { serverDomain: HOST, requestNonceHex: bytesToHex(nonce), purpose: "unlock-key", sealed, issuedAt: 0 },
        { serverDomain: HOST, stkPub: stk.publicKey, purpose: "unlock-key", nonce, issuedAt: 0 },
        stk.privateKey,
      ),
    ).toThrow();
  });
});

// Local hex decoder for the test (mirrors the protocol's).
function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
