import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceEndpointClaim,
  signSetLeader,
  SET_LEADER_NONE,
  type DeviceEndpointClaim,
  type Keypair,
  type SetLeaderVote,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleConsumeSetLeaderDeposit,
  handlePostSetLeaderDeposit,
} from "../src/secretMailbox.js";

// Owner preferred-server vote delivery (Phase 6). The phone signs an owner-IRK
// `set-leader` vote naming a preferred STK, ADDRESSED to a box domain, and
// deposits it; `.com` verifies the vote signature BEFORE storing; the box
// consumes-once + re-verifies under the owner IRK.

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

function voteBody(opts: {
  irk: Keypair;
  preferredStkPubHex: string;
  signWith?: Keypair;
}) {
  const vote: SetLeaderVote = {
    user: USERNAME,
    preferredStkPubHex: opts.preferredStkPubHex,
    issuedAt: Date.now(),
    nonce: bytesToHex(rand(16)),
  };
  const sig = signSetLeader(vote, opts.signWith ?? opts.irk);
  return {
    ...mailboxAuth(opts.irk),
    deposit: { serverDomain: HOST, requestNonceHex: bytesToHex(rand(32)) },
    vote: {
      user: vote.user,
      preferredStkPubHex: vote.preferredStkPubHex,
      issuedAt: vote.issuedAt,
      nonce: vote.nonce,
    },
    signature: bytesToHex(sig),
  };
}

describe("set-leader deposit — phone deposit (IRK mailbox-auth + signature verify)", () => {
  it("accepts a valid owner-IRK vote naming a preferred STK", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handlePostSetLeaderDeposit(
      deps(storage),
      HOST,
      voteBody({ irk, preferredStkPubHex: bytesToHex(stk.publicKey) }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts a 'none' vote (clears the preference)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handlePostSetLeaderDeposit(
      deps(storage),
      HOST,
      voteBody({ irk, preferredStkPubHex: SET_LEADER_NONE }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a vote whose set-leader signature is forged (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const stranger = makeKey();
    // Mailbox-auth is the account's IRK (passes auth), but the VOTE is signed by a
    // different key — the signature verify must catch it.
    const res = await handlePostSetLeaderDeposit(
      deps(storage),
      HOST,
      voteBody({ irk, preferredStkPubHex: bytesToHex(stk.publicKey), signWith: stranger }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/set-leader signature/);
  });

  it("rejects a vote bound to a different account user (403)", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const body = voteBody({ irk, preferredStkPubHex: bytesToHex(stk.publicKey) });
    body.vote.user = "mallory";
    const res = await handlePostSetLeaderDeposit(deps(storage), HOST, body);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated deposit", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const body = voteBody({ irk, preferredStkPubHex: bytesToHex(stk.publicKey) });
    const res = await handlePostSetLeaderDeposit(deps(storage), HOST, {
      deposit: body.deposit,
      vote: body.vote,
      signature: body.signature,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("set-leader deposit — box consume-once (public)", () => {
  it("returns the verified vote carrier to a box read", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostSetLeaderDeposit(
      deps(storage),
      HOST,
      voteBody({ irk, preferredStkPubHex: bytesToHex(stk.publicKey) }),
    );
    const res = await handleConsumeSetLeaderDeposit(deps(storage), HOST);
    expect(res.status).toBe(200);
    const body = res.body as { sealed: string };
    const json = JSON.parse(
      Buffer.from(body.sealed, "hex").toString("utf-8"),
    ) as { vote: { preferredStkPubHex: string }; signature: string };
    expect(json.vote.preferredStkPubHex).toBe(bytesToHex(stk.publicKey));
    expect(json.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("is consume-once: a second box read returns 404", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    await handlePostSetLeaderDeposit(
      deps(storage),
      HOST,
      voteBody({ irk, preferredStkPubHex: bytesToHex(stk.publicKey) }),
    );
    expect((await handleConsumeSetLeaderDeposit(deps(storage), HOST)).status).toBe(200);
    expect((await handleConsumeSetLeaderDeposit(deps(storage), HOST)).status).toBe(404);
  });

  it("returns 404 when no vote is pending", async () => {
    const irk = makeKey();
    const stk = makeKey();
    const storage = await setup({ irk, stk });
    const res = await handleConsumeSetLeaderDeposit(deps(storage), HOST);
    expect(res.status).toBe(404);
  });
});
