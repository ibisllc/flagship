import { describe, expect, it } from "vitest";
import {
  ed,
  signRePairInitiate,
  signRePairObject,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleCompleteRePair,
  handleGetRePair,
  handleInitiateRePair,
  handleObjectRePair,
  RE_PAIR_GRACE_MS,
} from "../src/rePair.js";

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

async function setup(oldIrk: Keypair): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(oldIrk.publicKey),
    claimedAt: 1,
  });
  return s;
}

function initBody(args: { newIrk: Keypair; oldIrk: Keypair; issuedAt?: number }) {
  const issuedAt = args.issuedAt ?? Date.now();
  const sig = signRePairInitiate(
    { username: USERNAME, newIrkPub: args.newIrk.publicKey, oldIrkPub: args.oldIrk.publicKey, issuedAt },
    args.newIrk,
  );
  return {
    request: {
      username: USERNAME,
      newIrkPub: bytesToHex(args.newIrk.publicKey),
      oldIrkPub: bytesToHex(args.oldIrk.publicKey),
      issuedAt,
    },
    signature: bytesToHex(sig),
  };
}

function objectBody(args: { oldIrk: Keypair; newIrkPub: Uint8Array; issuedAt?: number }) {
  const issuedAt = args.issuedAt ?? Date.now();
  const sig = signRePairObject(
    { username: USERNAME, newIrkPub: args.newIrkPub, issuedAt },
    args.oldIrk,
  );
  return {
    request: { username: USERNAME, newIrkPub: bytesToHex(args.newIrkPub), issuedAt },
    signature: bytesToHex(sig),
  };
}

describe("re-pair initiate", () => {
  it("accepts a NEW-IRK-signed initiate referencing the registered old IRK", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk, oldIrk }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    const stored = await storage.pendingRePairs.get(USERNAME);
    expect(stored?.newIrkPubHex).toBe(bytesToHex(newIrk.publicKey));
    expect(stored?.oldIrkPubHex).toBe(bytesToHex(oldIrk.publicKey));
  });

  it("rejects when the body's oldIrkPub doesn't match the registered IRK (snapshot defense)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const wrongOld = makeKey();
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk, oldIrk: wrongOld }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects when the signature is by anyone other than the new IRK", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    // Forge a signature with the old IRK over the new IRK's claim.
    const issuedAt = Date.now();
    const forgedSig = signRePairInitiate(
      { username: USERNAME, newIrkPub: newIrk.publicKey, oldIrkPub: oldIrk.publicKey, issuedAt },
      oldIrk,
    );
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      {
        request: {
          username: USERNAME,
          newIrkPub: bytesToHex(newIrk.publicKey),
          oldIrkPub: bytesToHex(oldIrk.publicKey),
          issuedAt,
        },
        signature: bytesToHex(forgedSig),
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects when newIrkPub equals the current registered IRK (no-op defense)", async () => {
    const oldIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk: oldIrk, oldIrk }),
    );
    expect(res.status).toBe(400);
  });

  it("409s on a second initiate while one is pending", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    expect((await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }))).status).toBe(200);
    const second = makeKey();
    expect(
      (await handleInitiateRePair(deps, USERNAME, initBody({ newIrk: second, oldIrk }))).status,
    ).toBe(409);
  });

  it("404s on an unknown username", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      "ghost",
      {
        request: {
          username: "ghost",
          newIrkPub: bytesToHex(newIrk.publicKey),
          oldIrkPub: bytesToHex(oldIrk.publicKey),
          issuedAt: Date.now(),
        },
        signature: "00",
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("re-pair object (cancel) by old IRK", () => {
  it("marks the row objected; subsequent complete returns 409", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const objRes = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ oldIrk, newIrkPub: newIrk.publicKey }),
    );
    expect(objRes.status).toBe(200);
    // Even past the grace, complete now refuses.
    const completeRes = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 },
      USERNAME,
    );
    expect(completeRes.status).toBe(409);
    expect((completeRes.body as { error: string }).error).toMatch(/objected/);
  });

  it("rejects when the body's newIrkPub doesn't match the pending row (replay defense)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const otherIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const res = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ oldIrk, newIrkPub: otherIrk.publicKey }),
    );
    expect(res.status).toBe(409);
  });

  it("rejects when signed by anything other than the registered old IRK", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const otherIrk = makeKey();
    const res = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ oldIrk: otherIrk, newIrkPub: newIrk.publicKey }),
    );
    expect(res.status).toBe(403);
  });

  it("404s when there's no pending row to object to", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleObjectRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      objectBody({ oldIrk, newIrkPub: newIrk.publicKey }),
    );
    expect(res.status).toBe(404);
  });
});

describe("re-pair complete (atomic IRK swap after grace)", () => {
  it("425s while still in the grace window", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const res = await handleCompleteRePair(deps, USERNAME);
    expect(res.status).toBe(425);
    expect((res.body as { secondsRemaining: number }).secondsRemaining).toBeGreaterThan(0);
  });

  it("swaps the username's IRK once the grace expires (no objection)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const res = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 },
      USERNAME,
    );
    expect(res.status).toBe(200);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(newIrk.publicKey));
    // Pending row deleted on success.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });

  it("404s when nothing is pending", async () => {
    const oldIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleCompleteRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
    );
    expect(res.status).toBe(404);
  });

  it("two concurrent completes after grace: one succeeds, one 409s (SQL CAS in action)", async () => {
    // The CAS guarantee on usernames.swapIrkPub is what stops two
    // simultaneous rotations from both committing. The first
    // complete wins; the second sees `swapIrkPub` return false
    // (current IRK no longer matches expectedOld), returns 409,
    // and tidies up the pending row.
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const completeDeps = { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 };

    const [a, b] = await Promise.all([
      handleCompleteRePair(completeDeps, USERNAME),
      handleCompleteRePair(completeDeps, USERNAME),
    ]);
    const statuses = [a.status, b.status].sort();
    // One of {200, 409|404} — InMemory's atomic swap means the
    // loser either sees 404 (row already deleted by the winner's
    // tidy-up) or 409 (current IRK no longer matches). Both are
    // acceptable as long as exactly one swap committed.
    expect(statuses[0]).toBe(200);
    expect(statuses[1] === 404 || statuses[1] === 409).toBe(true);
  });

  it("409s when the username's IRK has rotated since the pending row was filed", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    // Simulate a concurrent rotation that already moved the IRK away.
    const concurrent = makeKey();
    await storage.usernames.swapIrkPub(
      USERNAME,
      bytesToHex(oldIrk.publicKey),
      bytesToHex(concurrent.publicKey),
      Date.now(),
    );
    const res = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 },
      USERNAME,
    );
    expect(res.status).toBe(409);
    // Pending row also cleaned up so nothing dangles.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });
});

describe("re-pair GET (status read)", () => {
  it("returns pending=null when no row exists", async () => {
    const oldIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleGetRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
    );
    expect(res.status).toBe(200);
    expect((res.body as { pending: null | unknown }).pending).toBeNull();
  });

  it("returns the pending row's metadata + objection state", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ oldIrk, newIrkPub: newIrk.publicKey }),
    );
    const res = await handleGetRePair(deps, USERNAME);
    expect(res.status).toBe(200);
    const body = res.body as { pending: { newIrkPub: string; objectedAt: number | null } };
    expect(body.pending.newIrkPub).toBe(bytesToHex(newIrk.publicKey));
    expect(body.pending.objectedAt).toBeGreaterThan(0);
  });
});
