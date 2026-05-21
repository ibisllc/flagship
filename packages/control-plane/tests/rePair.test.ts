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
  RE_PAIR_SINGLE_GRACE_MS,
  RE_PAIR_QUARANTINE_MS,
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

/**
 * Default setup lands a 'multi'-device account so the historical
 * v1.1 24h-grace assertions stay intact under v1.2 Phase 2. The
 * single-device 7-day-grace path has its own dedicated tests below
 * (search for "single-device 7-day grace"). Callers that need the
 * 'single' default explicitly pass `accountType: 'single'`.
 */
async function setup(
  oldIrk: Keypair,
  opts: { accountType?: "single" | "multi" } = {},
): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(oldIrk.publicKey),
    claimedAt: 1,
    accountType: opts.accountType ?? "multi",
  });
  return s;
}

function initBody(args: {
  newIrk: Keypair;
  oldIrk: Keypair;
  issuedAt?: number;
  /** v1.2 — needed when the target account is multi-device. The
   *  default `setup` lands on 'multi', so initBody always supplies
   *  a structurally-valid proof unless the caller explicitly opts
   *  out via `{ totpProof: null }`. */
  totpProof?: { code: string; method: "totp" | "recovery" } | null;
  callerTokenId?: string;
}) {
  const issuedAt = args.issuedAt ?? Date.now();
  const sig = signRePairInitiate(
    { username: USERNAME, newIrkPub: args.newIrk.publicKey, oldIrkPub: args.oldIrk.publicKey, issuedAt },
    args.newIrk,
  );
  const proof =
    args.totpProof === null
      ? undefined
      : args.totpProof ?? { code: "123456", method: "totp" as const };
  return {
    request: {
      username: USERNAME,
      newIrkPub: bytesToHex(args.newIrk.publicKey),
      oldIrkPub: bytesToHex(args.oldIrk.publicKey),
      issuedAt,
    },
    signature: bytesToHex(sig),
    ...(proof ? { totpProof: proof } : {}),
    ...(args.callerTokenId ? { callerTokenId: args.callerTokenId } : {}),
  };
}

function objectBody(args: { signer: Keypair; newIrkPub: Uint8Array; issuedAt?: number }) {
  // Self-cancel: the NEW IRK (the recoverer's own key) signs the
  // RePairObject envelope. Pre-W1 the OLD IRK signed; that gave
  // device-thieves veto power. See docs/v1.2-security-cascade.md
  // "Recovery threat model".
  const issuedAt = args.issuedAt ?? Date.now();
  const sig = signRePairObject(
    { username: USERNAME, newIrkPub: args.newIrkPub, issuedAt },
    args.signer,
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
        // v1.2 — multi-device requires a structural totpProof; the
        // test asserts the SIGNATURE-verification path returns 403,
        // not the missing-proof 401, so we supply a valid-shape
        // proof here.
        totpProof: { code: "123456", method: "totp" as const },
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

  it("accepts an initiate when If-Match matches the current devices ETag", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    // Seed one device so the ETag isn't the empty-list ETag.
    await storage.pushTokens.put({
      tokenId: "deviceA",
      username: USERNAME,
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "iPhone",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const { handleGetUsersDevices } = await import("../src/usersDevices.js");
    const { headers } = await handleGetUsersDevices({ pushTokens: storage.pushTokens }, USERNAME);
    const goodEtag = headers!.etag!;
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs, pushTokens: storage.pushTokens },
      USERNAME,
      initBody({ newIrk, oldIrk }),
      goodEtag,
    );
    expect(res.status).toBe(200);
  });

  it("412s an initiate when If-Match is stale (race-loser)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    // Caller hands a fabricated ETag — must not match anything we'd compute.
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs, pushTokens: storage.pushTokens },
      USERNAME,
      initBody({ newIrk, oldIrk }),
      'W/"deadbeefdeadbeef"',
    );
    expect(res.status).toBe(412);
    expect((res.body as { error: string }).error).toMatch(/device list/i);
    // currentEtag surfaced so the client knows what to refetch.
    expect((res.body as { currentEtag: string }).currentEtag).toMatch(/^W\/"/);
  });

  it("ignores If-Match when pushTokens dep isn't wired (backwards-compat path)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleInitiateRePair(
      // Note: NO pushTokens in deps. Older callers that haven't
      // adopted the fence yet must still work.
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk, oldIrk }),
      'W/"whatever-this-isnt-checked"',
    );
    expect(res.status).toBe(200);
  });

  it("ignores If-Match when the client doesn't send it (backwards-compat)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs, pushTokens: storage.pushTokens },
      USERNAME,
      initBody({ newIrk, oldIrk }),
      // No fourth arg → ifMatch = undefined.
    );
    expect(res.status).toBe(200);
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

describe("re-pair object (self-cancel by NEW IRK)", () => {
  it("marks the row objected; subsequent complete returns 409", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    // Recoverer self-cancels: NEW IRK signs the object envelope.
    const objRes = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ signer: newIrk, newIrkPub: newIrk.publicKey }),
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
    // body claims a DIFFERENT newIrkPub than the pending row.
    const res = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ signer: otherIrk, newIrkPub: otherIrk.publicKey }),
    );
    expect(res.status).toBe(409);
  });

  it("rejects an OLD-IRK-signed object — the device-thief veto vector", async () => {
    // SECURITY REGRESSION: under the old (rejected) model, an
    // attacker who stole the legitimate owner's device could sign a
    // RePairObject with the OLD IRK and block the legitimate owner's
    // recovery from a fresh device. The new model requires the NEW
    // IRK to sign — a key the device-thief does NOT hold (the
    // legitimate owner generated it on their fresh recovery device).
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    // Attacker signs with the OLD IRK (stolen from the device) but
    // references the legitimate recoverer's NEW IRK pub.
    const res = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ signer: oldIrk, newIrkPub: newIrk.publicKey }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects when signed by an unrelated key (not the new IRK on the pending row)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const stranger = makeKey();
    // Signer is the STRANGER, but body's newIrkPub matches the
    // pending row — passes the newIrkPub-match check at line 557,
    // then fails the signature verification at line 588.
    const res = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ signer: stranger, newIrkPub: newIrk.publicKey }),
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
      objectBody({ signer: newIrk, newIrkPub: newIrk.publicKey }),
    );
    expect(res.status).toBe(404);
  });

  it("releases the recovery lock after veto — a new initiate is accepted", async () => {
    // Recovery-lock release regression: pending_re_pairs.username is the
    // PK. Before this fix, a veto stamped objected_at but left the row,
    // which meant the next initiate hit a PK collision and returned 409
    // "re-pair already pending" — permanently locking the cloud from any
    // future legitimate recovery. The handler now sweeps dead rows
    // (vetoed OR expired-without-complete) on the next initiate.
    const oldIrk = makeKey();
    const firstNew = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };

    // 1. First initiate succeeds.
    expect((await handleInitiateRePair(deps, USERNAME, initBody({ newIrk: firstNew, oldIrk }))).status).toBe(200);

    // 2. Recoverer self-cancels (NEW IRK signs) — row gets
    //    objected_at stamped but persists.
    const veto = await handleObjectRePair(
      deps,
      USERNAME,
      objectBody({ signer: firstNew, newIrkPub: firstNew.publicKey }),
    );
    expect(veto.status).toBe(200);

    // 3. New initiate from a DIFFERENT new-IRK must succeed.
    //    Lock released because the existing row is dead (vetoed).
    const secondNew = makeKey();
    const r = await handleInitiateRePair(deps, USERNAME, initBody({ newIrk: secondNew, oldIrk }));
    expect(r.status).toBe(200);
  });

  it("KEEPS the lock while a live dispute is in flight — a second initiate is 409", async () => {
    // The lock-release path must NOT release the lock during a live
    // dispute. Concurrent admin recoveries are rejected with 409 to
    // prevent two competing recoveries from racing inside the same
    // grace window. The legitimate owner's veto-from-existing-device
    // path is the resolution channel; nothing else.
    const oldIrk = makeKey();
    const firstNew = makeKey();
    const storage = await setup(oldIrk);
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    expect((await handleInitiateRePair(deps, USERNAME, initBody({ newIrk: firstNew, oldIrk }))).status).toBe(200);
    // Second concurrent initiate (different new-IRK) MUST be rejected.
    const secondNew = makeKey();
    const r = await handleInitiateRePair(deps, USERNAME, initBody({ newIrk: secondNew, oldIrk }));
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/already pending/i);
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
      objectBody({ signer: newIrk, newIrkPub: newIrk.publicKey }),
    );
    const res = await handleGetRePair(deps, USERNAME);
    expect(res.status).toBe(200);
    const body = res.body as { pending: { newIrkPub: string; objectedAt: number | null } };
    expect(body.pending.newIrkPub).toBe(bytesToHex(newIrk.publicKey));
    expect(body.pending.objectedAt).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────
// v1.2 Plan B Phase 2 — single-device 7-day grace + TOTP gate
// ───────────────────────────────────────────────────────────────────

describe("v1.2 Phase 2 — single-device 7-day grace", () => {
  it("stamps graceSeconds=604800 on a single-device account's pending row", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      // No totpProof — single-device doesn't require one.
      initBody({ newIrk, oldIrk, totpProof: null }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { graceMs: number; accountType: string; totpRequired: boolean };
    expect(body.graceMs).toBe(RE_PAIR_SINGLE_GRACE_MS);
    expect(body.accountType).toBe("single");
    expect(body.totpRequired).toBe(false);
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.graceSeconds).toBe(604_800);
    expect(row?.totpRequired).toBe(false);
    expect(row?.totpProofConsumed).toBe(false);
    // Bit 0 (T+0) stamped on initiate — the scheduler must not
    // re-fire the T+0 push on its first sweep.
    expect(row?.alertsFiredBitmap).toBe(1);
  });

  it("stamps graceSeconds=86400 + totpRequired=true on a multi-device account's pending row", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk, oldIrk, totpProof: { code: "654321", method: "totp" } }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { graceMs: number; accountType: string; totpRequired: boolean };
    expect(body.graceMs).toBe(RE_PAIR_GRACE_MS);
    expect(body.accountType).toBe("multi");
    expect(body.totpRequired).toBe(true);
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.graceSeconds).toBe(86_400);
    expect(row?.totpRequired).toBe(true);
    expect(row?.totpProofConsumed).toBe(true);
  });

  it("rejects a multi-device re-pair with NO totpProof (401)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk, oldIrk, totpProof: null }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/totpProof/i);
  });

  it("rejects a multi-device re-pair with an empty totpProof.code (401)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk, oldIrk, totpProof: { code: "", method: "totp" } }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a multi-device re-pair with a totpProof.method outside the allowed set", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        // method must be "totp" | "recovery"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        totpProof: { code: "123456", method: "sms" as any },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a recovery-code proof on multi-device", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs },
      USERNAME,
      initBody({ newIrk, oldIrk, totpProof: { code: "AAAA-BBBB-CC", method: "recovery" } }),
    );
    expect(res.status).toBe(200);
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.totpProofConsumed).toBe(true);
  });

  it("swaps the IRK after 7 days for a single-device account", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const deps = { usernames: storage.usernames, pendingRePairs: storage.pendingRePairs };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    // 24h is too early.
    const earlyRes = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 },
      USERNAME,
    );
    expect(earlyRes.status).toBe(425);
    // 7 days + 1s is enough.
    const lateRes = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000 },
      USERNAME,
    );
    expect(lateRes.status).toBe(200);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(newIrk.publicKey));
  });
});

describe("v1.2 Phase 2 — 14-day quarantine", () => {
  async function seedDevice(
    s: InMemoryStorage,
    args: { tokenId: string; quarantineUntil?: number },
  ): Promise<void> {
    await s.pushTokens.put({
      tokenId: args.tokenId,
      username: USERNAME,
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "device",
      registeredAt: 1,
      lastSeenAt: 1,
      quarantineUntil: args.quarantineUntil ?? 0,
    });
  }

  it("stamps quarantineUntil = now + 14d on every push_token after a re-pair completes", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    await seedDevice(storage, { tokenId: "devA" });
    await seedDevice(storage, { tokenId: "devB" });
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      pushTokens: storage.pushTokens,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME);
    expect(res.status).toBe(200);
    const after = await Promise.all([
      storage.pushTokens.get("devA"),
      storage.pushTokens.get("devB"),
    ]);
    for (const row of after) {
      expect(row?.quarantineUntil).toBe(finishAt + RE_PAIR_QUARANTINE_MS);
    }
  });

  it("response body returns quarantineUntil so the client UI can render the lift-time", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      pushTokens: storage.pushTokens,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME);
    expect((res.body as { quarantineUntil: number }).quarantineUntil).toBe(
      finishAt + RE_PAIR_QUARANTINE_MS,
    );
  });

  it("rejects a re-pair initiate when the callerTokenId is quarantined (403)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const future = Date.now() + RE_PAIR_QUARANTINE_MS;
    await seedDevice(storage, { tokenId: "freshDev", quarantineUntil: future });
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        pushTokens: storage.pushTokens,
      },
      USERNAME,
      initBody({ newIrk, oldIrk, callerTokenId: "freshDev" }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { reason: string }).reason).toBe("quarantine");
    expect((res.body as { until: string }).until).toBe(new Date(future).toISOString());
  });

  it("re-pair initiate from a non-quarantined existing device is allowed", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    // quarantineUntil = 0 (default) — already-trusted.
    await seedDevice(storage, { tokenId: "trustedDev", quarantineUntil: 0 });
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        pushTokens: storage.pushTokens,
      },
      USERNAME,
      initBody({ newIrk, oldIrk, callerTokenId: "trustedDev" }),
    );
    expect(res.status).toBe(200);
  });

  it("re-pair initiate WITHOUT callerTokenId (J.3 lost-device path) is not quarantine-gated", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    // No push tokens at all — the recovering device hasn't registered yet.
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        pushTokens: storage.pushTokens,
      },
      USERNAME,
      initBody({ newIrk, oldIrk }),
    );
    expect(res.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────
// v1.2 Plan B Phase 3 — real TOTP / recovery code verification on
// the re-pair multi-device path. Replaces the Phase 2 structural-
// only gate when `totpKekHex` is wired on the deps.
// ───────────────────────────────────────────────────────────────────

import {
  signTotpEnrollBegin,
  signTotpEnrollConfirm,
} from "@flagship/protocol";
import * as OTPAuth from "otpauth";
import {
  _resetTotpVerifyRateLimitForTests,
  handleTotpEnrollBegin,
  handleTotpEnrollConfirm,
} from "../src/totp.js";

const TEST_KEK_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function enrollMultiDevice(
  storage: InMemoryStorage,
  ownerIrk: Keypair,
  fixedNow: number,
): Promise<{ secretBase32: string; recoveryCodes: string[] }> {
  const begin = await handleTotpEnrollBegin(
    { usernames: storage.usernames, kekHex: TEST_KEK_HEX, now: () => fixedNow },
    USERNAME,
    {
      request: { username: USERNAME, issuedAt: fixedNow },
      signature: bytesToHex(
        signTotpEnrollBegin(
          { username: USERNAME, issuedAt: fixedNow },
          ownerIrk,
        ),
      ),
    },
  );
  const secretBase32 = (begin.body as { secret: string }).secret;
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const sample = totp.generate({ timestamp: fixedNow });
  const confirm = await handleTotpEnrollConfirm(
    {
      usernames: storage.usernames,
      kekHex: TEST_KEK_HEX,
      now: () => fixedNow,
      fastHash: true,
    },
    USERNAME,
    {
      request: { username: USERNAME, issuedAt: fixedNow },
      signature: bytesToHex(
        signTotpEnrollConfirm(
          { username: USERNAME, issuedAt: fixedNow },
          ownerIrk,
        ),
      ),
      code: sample,
    },
  );
  return {
    secretBase32,
    recoveryCodes: (confirm.body as { recoveryCodes: string[] }).recoveryCodes,
  };
}

function codeAt(secret: string, t: number): string {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.generate({ timestamp: t });
}

describe("v1.2 Phase 3 — real TOTP / recovery verification on re-pair", () => {
  it("accepts a valid TOTP proof on multi-device re-pair", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    const { secretBase32 } = await enrollMultiDevice(storage, oldIrk, fixedNow);
    const code = codeAt(secretBase32, fixedNow);
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        totpKekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code, method: "totp" },
      }),
    );
    expect(res.status).toBe(200);
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.totpProofConsumed).toBe(true);
  });

  it("accepts a valid recovery code on multi-device re-pair AND atomically consumes it", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    const { recoveryCodes } = await enrollMultiDevice(storage, oldIrk, fixedNow);
    const target = recoveryCodes[0] as string;

    const beforeRow = await storage.usernames.get(USERNAME);
    const beforeRows = JSON.parse(beforeRow!.recoveryCodesHashesJson!);
    expect(beforeRows).toHaveLength(10);

    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        totpKekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: target, method: "recovery" },
      }),
    );
    expect(res.status).toBe(200);
    // The matching recovery code is consumed.
    const afterRow = await storage.usernames.get(USERNAME);
    const afterRows = JSON.parse(afterRow!.recoveryCodesHashesJson!);
    expect(afterRows).toHaveLength(9);
  });

  it("rejects a totally invalid TOTP code (401) and increments the failed-counter", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    await enrollMultiDevice(storage, oldIrk, fixedNow);
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        totpKekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: "000000", method: "totp" },
      }),
    );
    expect(res.status).toBe(401);
    // No pending row.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
    // The remaining-attempts hint is surfaced for the UI.
    expect((res.body as { remainingAttempts: number }).remainingAttempts).toBe(4);
  });

  it("rejects an expired (>±1 period) TOTP code (401)", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    const { secretBase32 } = await enrollMultiDevice(storage, oldIrk, fixedNow);
    // Code generated 90s ago — outside the ±1 period window.
    const expired = codeAt(secretBase32, fixedNow - 90_000);
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        totpKekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: expired, method: "totp" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a replayed recovery code (consumed-once semantics)", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    const { recoveryCodes } = await enrollMultiDevice(storage, oldIrk, fixedNow);
    const target = recoveryCodes[0] as string;
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      totpKekHex: TEST_KEK_HEX,
      now: () => fixedNow,
    };
    // First use — consume.
    const first = await handleInitiateRePair(
      deps,
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: target, method: "recovery" },
      }),
    );
    expect(first.status).toBe(200);
    // Tidy up — drop the pending row so a second initiate would
    // otherwise be allowed by the "no concurrent" gate.
    await storage.pendingRePairs.delete(USERNAME);
    // Second use — code is gone, must 401.
    const second = await handleInitiateRePair(
      deps,
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: target, method: "recovery" },
      }),
    );
    expect(second.status).toBe(401);
  });

  it("triggers 429 after 5 failed verify attempts inside 15 min", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    await enrollMultiDevice(storage, oldIrk, fixedNow);
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      totpKekHex: TEST_KEK_HEX,
      now: () => fixedNow,
    };
    for (let i = 0; i < 5; i++) {
      const r = await handleInitiateRePair(
        deps,
        USERNAME,
        initBody({
          newIrk,
          oldIrk,
          issuedAt: fixedNow,
          totpProof: { code: "000000", method: "totp" },
        }),
      );
      expect(r.status).toBe(401);
    }
    const tripped = await handleInitiateRePair(
      deps,
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: "000000", method: "totp" },
      }),
    );
    expect(tripped.status).toBe(429);
  });

  it("structural-only fallback still works when totpKekHex isn't wired", async () => {
    // Deploy-safe: a deployment without FLAGSHIP_TOTP_KEK keeps the
    // Phase 2 behaviour — structural presence is enough to clear the
    // gate. Once the env var lands, the real-verify path kicks in.
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        // NOTE: no totpKekHex.
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        totpProof: { code: "000000", method: "totp" },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────
// v1.2 Plan B Phase 5 — audit + push fan-out on re-pair endpoints
// ───────────────────────────────────────────────────────────────────

describe("v1.2 Plan B Phase 5 — audit emissions on re-pair", () => {
  it("emits `recovery-code-consumed` on a successful recovery-code re-pair (with recoveryMethod='recovery-code')", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    const { recoveryCodes } = await enrollMultiDevice(storage, oldIrk, fixedNow);
    const target = recoveryCodes[0] as string;
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        auditEvents: storage.auditEvents,
        totpKekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: target, method: "recovery" },
      }),
    );
    expect(res.status).toBe(200);
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    const rc = events.find((e) => e.eventKind === "recovery-code-consumed");
    expect(rc).toBeDefined();
    expect(rc?.recoveryMethod).toBe("recovery-code");
    expect(rc?.accountTypeAtEvent).toBe("multi");
  });

  it("emits `device-replaced` + `device-added` on complete, with quarantineUntil + recoveryMethod", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    const { secretBase32 } = await enrollMultiDevice(storage, oldIrk, fixedNow);
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        auditEvents: storage.auditEvents,
        totpKekHex: TEST_KEK_HEX,
        now: () => fixedNow,
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: fixedNow,
        totpProof: { code: codeAt(secretBase32, fixedNow), method: "totp" },
      }),
    );
    expect(res.status).toBe(200);
    // Fast-forward past completesAt and complete the re-pair.
    const future = fixedNow + 25 * 3_600_000;
    const completion = await handleCompleteRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        auditEvents: storage.auditEvents,
        now: () => future,
      },
      USERNAME,
    );
    expect(completion.status).toBe(200);
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    const replaced = events.find((e) => e.eventKind === "device-replaced");
    const added = events.find((e) => e.eventKind === "device-added");
    expect(replaced).toBeDefined();
    expect(added).toBeDefined();
    // Both rows carry recoveryMethod='totp' (the proof method) and
    // device-added carries quarantineUntil = now() + RE_PAIR_QUARANTINE_MS.
    expect(replaced?.recoveryMethod).toBe("totp");
    expect(added?.recoveryMethod).toBe("totp");
    expect(added?.quarantineUntil).toBe(future + RE_PAIR_QUARANTINE_MS);
  });

  it("fires the T+0 push on a successful initiate via pushFanout", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    // Seed an existing trusted device so push fan-out has a target.
    await storage.pushTokens.put({
      tokenId: "oldDevice",
      username: USERNAME,
      platform: "apns",
      providerToken: "providerOld",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "Old iPhone",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const fires: Array<{ username: string; category: string; tokenIds: string[]; deepLink: string }> = [];
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        pushTokens: storage.pushTokens,
        pushFanout: async ({ username, targets, payload }) => {
          fires.push({
            username,
            category: payload.category,
            tokenIds: targets.map((t) => t.tokenId),
            deepLink: payload.deepLink,
          });
        },
      },
      USERNAME,
      initBody({ newIrk, oldIrk, totpProof: null }),
    );
    expect(res.status).toBe(200);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe("re-pair-initiated");
    expect(fires[0]!.tokenIds).toEqual(["oldDevice"]);
    expect(fires[0]!.deepLink).toMatch(/^flagship:\/\/account\/re-pair\?u=alice/);
  });

  it("fires the failed-TOTP-rate alert via pushFanout when the re-pair gate trips the limit", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const fixedNow = 1_700_000_000_000;
    await enrollMultiDevice(storage, oldIrk, fixedNow);
    await storage.pushTokens.put({
      tokenId: "trusted",
      username: USERNAME,
      platform: "apns",
      providerToken: "providerTrust",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "Trusted iPhone",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const fires: Array<{ category: string }> = [];
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      pushTokens: storage.pushTokens,
      auditEvents: storage.auditEvents,
      pushFanout: async ({ payload }: { payload: { category: string } }) => {
        fires.push({ category: payload.category });
      },
      totpKekHex: TEST_KEK_HEX,
      now: () => fixedNow,
    };
    for (let i = 0; i < 5; i++) {
      await handleInitiateRePair(
        deps,
        USERNAME,
        initBody({
          newIrk,
          oldIrk,
          issuedAt: fixedNow,
          totpProof: { code: "000000", method: "totp" },
        }),
      );
    }
    // At least one totp-failed-rate fire happened.
    const failedRate = fires.filter((f) => f.category === "totp-failed-rate");
    expect(failedRate.length).toBe(1);
    // Audit row was written.
    const events = await storage.auditEvents.list(USERNAME, 0, 10);
    expect(events.filter((e) => e.eventKind === "totp-failed-rate")).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────
// v2.1 (W6) — per-cloud recovery-wipe policy on /complete
// ───────────────────────────────────────────────────────────────────

import { signDeviceCapabilityGrant, type DeviceScope } from "@flagship/protocol";

describe("v2.1 (W6) — recovery-wipe policy", () => {
  it("defaults a freshly-claimed username to recoveryWipePolicy='graceful'", async () => {
    const oldIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const row = await storage.usernames.get(USERNAME);
    expect(row?.recoveryWipePolicy).toBe("graceful");
  });

  it("'strict' policy revokes every active DeviceCapabilityGrant on complete", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    // Flip the policy to 'strict' (corporate opt-in).
    const claimedRec = await storage.usernames.get(USERNAME);
    await storage.usernames.put({ ...claimedRec!, recoveryWipePolicy: "strict" });
    // Mint two existing grants under the OLD IRK (family devices).
    const devA = makeKey();
    const devB = makeKey();
    const grantA: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000001",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: devA.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    const grantB: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000002",
      username: USERNAME,
      deviceLabel: "laptop",
      devicePubKey: devB.publicKey,
      scopes: ["browse", "install-service"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    const sigA = signDeviceCapabilityGrant(grantA, oldIrk);
    const sigB = signDeviceCapabilityGrant(grantB, oldIrk);
    await storage.deviceCapabilityGrants.put({
      grantId: grantA.grantId,
      username: USERNAME,
      deviceLabel: grantA.deviceLabel,
      devicePubHex: bytesToHex(devA.publicKey),
      scopesJson: JSON.stringify(grantA.scopes),
      issuedAt: grantA.issuedAt,
      expiresAt: grantA.expiresAt,
      signatureHex: bytesToHex(sigA),
      revokedAt: null,
    });
    await storage.deviceCapabilityGrants.put({
      grantId: grantB.grantId,
      username: USERNAME,
      deviceLabel: grantB.deviceLabel,
      devicePubHex: bytesToHex(devB.publicKey),
      scopesJson: JSON.stringify(grantB.scopes),
      issuedAt: grantB.issuedAt,
      expiresAt: grantB.expiresAt,
      signatureHex: bytesToHex(sigB),
      revokedAt: null,
    });

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME);
    expect(res.status).toBe(200);
    const body = res.body as { recoveryWipePolicy: string; wipedGrantIds?: string[] };
    expect(body.recoveryWipePolicy).toBe("strict");
    expect(body.wipedGrantIds?.sort()).toEqual([grantA.grantId, grantB.grantId].sort());
    // Both grants are now revoked.
    const after = await storage.deviceCapabilityGrants.listForUser(USERNAME);
    for (const g of after) expect(g.revokedAt).not.toBeNull();
  });

  it("'graceful' policy with refreshedGrants swaps grants under the new IRK", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    // 'graceful' is the default — explicit assertion below confirms.
    const dev = makeKey();
    const oldGrant: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000010",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: dev.publicKey,
      scopes: ["browse", "install-service"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    const oldSig = signDeviceCapabilityGrant(oldGrant, oldIrk);
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceLabel: oldGrant.deviceLabel,
      devicePubHex: bytesToHex(dev.publicKey),
      scopesJson: JSON.stringify(oldGrant.scopes),
      issuedAt: oldGrant.issuedAt,
      expiresAt: oldGrant.expiresAt,
      signatureHex: bytesToHex(oldSig),
      revokedAt: null,
    });

    // Refreshed grant: same device, same label, same (or subset of)
    // scopes, signed by the NEW IRK.
    const refreshed: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000011",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: dev.publicKey,
      scopes: ["browse", "install-service"],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const newSig = signDeviceCapabilityGrant(refreshed, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      {
        refreshedGrants: [
          {
            grantId: refreshed.grantId,
            deviceLabel: refreshed.deviceLabel,
            devicePubKey: bytesToHex(refreshed.devicePubKey),
            scopes: refreshed.scopes,
            issuedAt: refreshed.issuedAt,
            expiresAt: refreshed.expiresAt,
            signature: bytesToHex(newSig),
          },
        ],
      },
    );
    expect(res.status).toBe(200);
    const body = res.body as { recoveryWipePolicy: string; refreshedGrantIds?: string[] };
    expect(body.recoveryWipePolicy).toBe("graceful");
    expect(body.refreshedGrantIds).toEqual([refreshed.grantId]);
    // Old grant revoked, new grant active.
    const oldAfter = await storage.deviceCapabilityGrants.get(oldGrant.grantId);
    expect(oldAfter?.revokedAt).not.toBeNull();
    const newAfter = await storage.deviceCapabilityGrants.get(refreshed.grantId);
    expect(newAfter?.revokedAt).toBeNull();
    // The new row's signature verifies under the NEW IRK pub (the
    // post-swap cloud root), proving requireDeviceScope's re-verify
    // path will accept it.
    expect(newAfter?.signatureHex).toBe(bytesToHex(newSig));
  });

  it("rejects a refreshedGrant with MORE scopes than the existing grant (no inflation)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const dev = makeKey();
    const oldGrant: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000020",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceLabel: oldGrant.deviceLabel,
      devicePubHex: bytesToHex(dev.publicKey),
      scopesJson: JSON.stringify(oldGrant.scopes),
      issuedAt: oldGrant.issuedAt,
      expiresAt: oldGrant.expiresAt,
      signatureHex: bytesToHex(signDeviceCapabilityGrant(oldGrant, oldIrk)),
      revokedAt: null,
    });

    // Refreshed asks for "browse" + "install-service" — escalation
    // attempt that must be rejected.
    const inflated: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000021",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: dev.publicKey,
      scopes: ["browse", "install-service"] as DeviceScope[],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const sig = signDeviceCapabilityGrant(inflated, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      {
        refreshedGrants: [
          {
            grantId: inflated.grantId,
            deviceLabel: inflated.deviceLabel,
            devicePubKey: bytesToHex(inflated.devicePubKey),
            scopes: inflated.scopes,
            issuedAt: inflated.issuedAt,
            expiresAt: inflated.expiresAt,
            signature: bytesToHex(sig),
          },
        ],
      },
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/inflate|scope/i);
    // CRITICAL: the IRK swap MUST NOT have happened — the cloud is
    // still on the old IRK so a partial-failure leaves the system in
    // a consistent state.
    const userAfter = await storage.usernames.get(USERNAME);
    expect(userAfter?.irkPubHex).toBe(bytesToHex(oldIrk.publicKey));
    // Pending row still there too.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeDefined();
  });

  it("rejects a refreshedGrant whose devicePubKey doesn't match any existing active grant", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    // No prior grants seeded — the recovering device tries to mint
    // one out of thin air through the re-sign path. Must be rejected.
    const unknownDev = makeKey();
    const phantom: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000030",
      username: USERNAME,
      deviceLabel: "ghost",
      devicePubKey: unknownDev.publicKey,
      scopes: ["browse"],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const sig = signDeviceCapabilityGrant(phantom, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      {
        refreshedGrants: [
          {
            grantId: phantom.grantId,
            deviceLabel: phantom.deviceLabel,
            devicePubKey: bytesToHex(phantom.devicePubKey),
            scopes: phantom.scopes,
            issuedAt: phantom.issuedAt,
            expiresAt: phantom.expiresAt,
            signature: bytesToHex(sig),
          },
        ],
      },
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/devicePubKey|existing/i);
  });

  it("'strict' policy IGNORES refreshedGrants in the body (no graceful fallthrough)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    // Corporate-style opt-in.
    const claimedRec = await storage.usernames.get(USERNAME);
    await storage.usernames.put({ ...claimedRec!, recoveryWipePolicy: "strict" });
    const dev = makeKey();
    const oldGrant: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000040",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceLabel: oldGrant.deviceLabel,
      devicePubHex: bytesToHex(dev.publicKey),
      scopesJson: JSON.stringify(oldGrant.scopes),
      issuedAt: oldGrant.issuedAt,
      expiresAt: oldGrant.expiresAt,
      signatureHex: bytesToHex(signDeviceCapabilityGrant(oldGrant, oldIrk)),
      revokedAt: null,
    });

    const refreshed: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000041",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const sig = signDeviceCapabilityGrant(refreshed, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      {
        refreshedGrants: [
          {
            grantId: refreshed.grantId,
            deviceLabel: refreshed.deviceLabel,
            devicePubKey: bytesToHex(refreshed.devicePubKey),
            scopes: refreshed.scopes,
            issuedAt: refreshed.issuedAt,
            expiresAt: refreshed.expiresAt,
            signature: bytesToHex(sig),
          },
        ],
      },
    );
    expect(res.status).toBe(200);
    const body = res.body as { recoveryWipePolicy: string; refreshedGrantIds?: string[] };
    expect(body.recoveryWipePolicy).toBe("strict");
    // The refreshed grant was NOT persisted — strict drops it.
    expect(body.refreshedGrantIds).toBeUndefined();
    expect(await storage.deviceCapabilityGrants.get(refreshed.grantId)).toBeUndefined();
    // The old grant got revoked.
    const oldAfter = await storage.deviceCapabilityGrants.get(oldGrant.grantId);
    expect(oldAfter?.revokedAt).not.toBeNull();
  });

  it("'graceful' policy with no refreshedGrants (body absent) is a no-op on grants — same as legacy", async () => {
    // Legacy clients (pre-W6) POST /complete with no body. They get a
    // 200 and the existing grants stay live (under the OLD IRK's sig,
    // so requireDeviceScope's re-verify will reject them; family
    // devices will see the rejection and prompt re-onboarding).
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const dev = makeKey();
    const oldGrant: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000050",
      username: USERNAME,
      deviceLabel: "ipad",
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceLabel: oldGrant.deviceLabel,
      devicePubHex: bytesToHex(dev.publicKey),
      scopesJson: JSON.stringify(oldGrant.scopes),
      issuedAt: oldGrant.issuedAt,
      expiresAt: oldGrant.expiresAt,
      signatureHex: bytesToHex(signDeviceCapabilityGrant(oldGrant, oldIrk)),
      revokedAt: null,
    });
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME);
    expect(res.status).toBe(200);
    const body = res.body as { recoveryWipePolicy: string };
    expect(body.recoveryWipePolicy).toBe("graceful");
    // Grant is untouched.
    const after = await storage.deviceCapabilityGrants.get(oldGrant.grantId);
    expect(after?.revokedAt).toBeNull();
  });
});
