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
