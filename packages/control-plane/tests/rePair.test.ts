import { describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import {
  ed,
  signRePairComplete,
  signRePairInitiate,
  signRePairObject,
  signTotpEnrollBegin,
  signTotpEnrollConfirm,
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
import { computeDevicesEtag } from "../src/deviceDirectoryEtag.js";
import {
  _resetTotpVerifyRateLimitForTests,
  handleTotpEnrollBegin,
  handleTotpEnrollConfirm,
} from "../src/totp.js";
import { mintRecoveryProof, RECOVERY_PROOF_TTL_MS } from "../src/recoveryProof.js";

const USERNAME = "alice";

const TEST_KEK_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** `FLAGSHIP_RECOVERY_PROOF_SECRET` stand-in. */
const TEST_PROOF_SECRET = "test-recovery-proof-secret-0123456789";
/** SHA-256 of the account's recovery fetchToken, as the escrow row stores it. */
const TEST_FETCH_TOKEN_HASH = "ab".repeat(32);

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
 * Recovery is credential-only, so EVERY account this suite builds has a
 * credential — that is the realistic state, and an account without one
 * can no longer be recovered at all (its own tests assert the refusal).
 *
 * Default setup lands a 'multi'-device account so the historical v1.1
 * 24h-grace assertions stay intact; multi enrolls a real TOTP secret
 * (the proof is verified for real, there is no structural fallback).
 * Single-device accounts enroll the cloud-recovery escrow row instead,
 * which is what `recoveryProof` is checked against.
 *
 * The enrolled TOTP secret + a freshly minted recovery proof are
 * recorded against the storage instance so the shared `initBody` can
 * default to a VALID credential without every call site threading it.
 * Tests that drive a fixed clock mint their own proof with
 * {@link proofAt}.
 */
const enrolled = new WeakMap<
  InMemoryStorage,
  { secretBase32?: string; recoveryCodes?: string[]; recoveryProofToken?: string }
>();
let currentStorage: InMemoryStorage | null = null;

async function setup(
  oldIrk: Keypair,
  opts: { accountType?: "single" | "multi"; credential?: "default" | "none" } = {},
): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  const accountType = opts.accountType ?? "multi";
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(oldIrk.publicKey),
    claimedAt: 1,
    accountType,
  });
  currentStorage = s;
  enrolled.set(s, {});
  if (opts.credential === "none") return s;
  if (accountType === "multi") {
    const { secretBase32, recoveryCodes } = await enrollMultiDevice(s, oldIrk, Date.now());
    enrolled.set(s, { secretBase32, recoveryCodes });
  } else {
    await enrollCloudRecovery(s);
    enrolled.set(s, { recoveryProofToken: await proofAt(Date.now()) });
  }
  return s;
}

/** Land the cloud-recovery escrow row (the single-device credential). */
async function enrollCloudRecovery(s: InMemoryStorage): Promise<void> {
  await s.webauthnRecovery.upsert({
    username: USERNAME,
    credentialIdHex: "aa".repeat(16),
    wrappedUmkB64: "AAAA",
    fetchTokenHashHex: TEST_FETCH_TOKEN_HASH,
    updatedAt: 1,
  });
}

/** One of the account's real, unspent recovery codes. */
function aRecoveryCode(storage: InMemoryStorage, index = 0): string {
  const code = enrolled.get(storage)?.recoveryCodes?.[index];
  if (!code) throw new Error("no recovery codes enrolled for this storage");
  return code;
}

/** Mint the proof the gated wrapped-UMK fetch would hand a recoverer. */
async function proofAt(now: number): Promise<string> {
  const { token } = await mintRecoveryProof(
    { username: USERNAME, fetchTokenHashHex: TEST_FETCH_TOKEN_HASH },
    TEST_PROOF_SECRET,
    { now },
  );
  return token;
}

/**
 * The production dep bundle: the recovery-escrow store + proof secret
 * (without which initiate fails CLOSED) and the TOTP KEK (without which
 * a code cannot be verified, so that path fails closed too).
 */
function depsFor(
  storage: InMemoryStorage,
  extra: Record<string, unknown> = {},
): Parameters<typeof handleInitiateRePair>[0] {
  return {
    usernames: storage.usernames,
    pendingRePairs: storage.pendingRePairs,
    webauthnRecovery: storage.webauthnRecovery,
    recoveryProofSecret: TEST_PROOF_SECRET,
    totpKekHex: TEST_KEK_HEX,
    ...extra,
  } as Parameters<typeof handleInitiateRePair>[0];
}

function initBody(args: {
  newIrk: Keypair;
  oldIrk: Keypair;
  issuedAt?: number;
  /** A real TOTP / recovery code. Defaults to a LIVE code off the
   *  account's enrolled secret (multi); `null` opts out entirely so a
   *  test can assert the missing-credential 401. */
  totpProof?: { code: string; method: "totp" | "recovery" } | null;
  /** The gated-fetch recovery-session token (single-device). Defaults
   *  to the one minted in `setup`; `null` opts out. */
  recoveryProof?: string | null;
  callerTokenId?: string;
}) {
  const issuedAt = args.issuedAt ?? Date.now();
  const sig = signRePairInitiate(
    { username: USERNAME, newIrkPub: args.newIrk.publicKey, oldIrkPub: args.oldIrk.publicKey, issuedAt },
    args.newIrk,
  );
  const state = currentStorage ? enrolled.get(currentStorage) : undefined;
  const proof =
    args.totpProof === null
      ? undefined
      : (args.totpProof ??
        (state?.secretBase32
          ? { code: codeAt(state.secretBase32, issuedAt), method: "totp" as const }
          : undefined));
  const recoveryProof =
    args.recoveryProof === null
      ? undefined
      : (args.recoveryProof ?? (proof ? undefined : state?.recoveryProofToken));
  return {
    request: {
      username: USERNAME,
      newIrkPub: bytesToHex(args.newIrk.publicKey),
      oldIrkPub: bytesToHex(args.oldIrk.publicKey),
      issuedAt,
    },
    signature: bytesToHex(sig),
    ...(proof ? { totpProof: proof } : {}),
    ...(recoveryProof ? { recoveryProof: { token: recoveryProof } } : {}),
    ...(args.callerTokenId ? { callerTokenId: args.callerTokenId } : {}),
  };
}

/** A `RePairComplete` envelope signed by the NEW IRK — `/complete`
 *  refuses an unsigned call, so every finalization carries one. */
function completeBody(args: {
  newIrk: Keypair;
  issuedAt?: number;
  /** Deps whose injected `now` the envelope should be stamped against —
   *  /complete enforces envelope freshness like every other handler, so
   *  a fast-forwarded clock needs a matching issuedAt. */
  deps?: { now?: () => number };
  refreshedGrants?: unknown[];
}) {
  const issuedAt = args.issuedAt ?? args.deps?.now?.() ?? Date.now();
  const sig = signRePairComplete(
    { username: USERNAME, newIrkPub: args.newIrk.publicKey, issuedAt },
    args.newIrk,
  );
  return {
    request: {
      username: USERNAME,
      newIrkPub: bytesToHex(args.newIrk.publicKey),
      issuedAt,
    },
    signature: bytesToHex(sig),
    ...(args.refreshedGrants ? { refreshedGrants: args.refreshedGrants } : {}),
  } as Parameters<typeof handleCompleteRePair>[2];
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
      depsFor(storage),
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
      depsFor(storage),
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
      depsFor(storage),
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
      depsFor(storage),
      USERNAME,
      initBody({ newIrk: oldIrk, oldIrk }),
    );
    expect(res.status).toBe(400);
  });

  it("409s on a second initiate while one is pending", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = depsFor(storage);
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
      deviceId: "00112233445566778899aabbccddeeff",
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const goodEtag = await computeDevicesEtag([{
      deviceId: "00112233445566778899aabbccddeeff",
      platform: "apns",
      addedAt: 1,
    }]);
    const res = await handleInitiateRePair(
      depsFor(storage, { pushTokens: storage.pushTokens }),
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
      depsFor(storage, { pushTokens: storage.pushTokens }),
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
      depsFor(storage),
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
      depsFor(storage, { pushTokens: storage.pushTokens }),
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
      depsFor(storage),
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
    const deps = depsFor(storage);
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
      completeBody({ newIrk, issuedAt: Date.now() + RE_PAIR_GRACE_MS + 1_000 }),
    );
    expect(completeRes.status).toBe(409);
    expect((completeRes.body as { error: string }).error).toMatch(/objected/);
  });

  it("rejects when the body's newIrkPub doesn't match the pending row (replay defense)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const otherIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = depsFor(storage);
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
    const deps = depsFor(storage);
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
    const deps = depsFor(storage);
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
      depsFor(storage),
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
    const deps = depsFor(storage);

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
    const deps = depsFor(storage);
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
    const deps = depsFor(storage);
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const res = await handleCompleteRePair(deps, USERNAME, completeBody({ newIrk, deps: deps }));
    expect(res.status).toBe(425);
    expect((res.body as { secondsRemaining: number }).secondsRemaining).toBeGreaterThan(0);
  });

  it("swaps the username's IRK once the grace expires (no objection)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = depsFor(storage);
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const res = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 },
      USERNAME,
      completeBody({ newIrk, issuedAt: Date.now() + RE_PAIR_GRACE_MS + 1_000 }),
    );
    expect(res.status).toBe(200);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(newIrk.publicKey));
    // Pending row deleted on success.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });

  it("404s when nothing is pending", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const res = await handleCompleteRePair(
      depsFor(storage),
      USERNAME,
      completeBody({ newIrk }),
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
    const deps = depsFor(storage);
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk }));
    const completeDeps = { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 };

    const [a, b] = await Promise.all([
      handleCompleteRePair(completeDeps, USERNAME, completeBody({ newIrk, deps: completeDeps })),
      handleCompleteRePair(completeDeps, USERNAME, completeBody({ newIrk, deps: completeDeps })),
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
    const deps = depsFor(storage);
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
      completeBody({ newIrk, issuedAt: Date.now() + RE_PAIR_GRACE_MS + 1_000 }),
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
      depsFor(storage),
      USERNAME,
    );
    expect(res.status).toBe(200);
    expect((res.body as { pending: null | unknown }).pending).toBeNull();
  });

  it("returns the pending row's metadata + objection state", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk);
    const deps = depsFor(storage);
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
// Recovery Phase B — single-device 3-day grace + TOTP gate
// ───────────────────────────────────────────────────────────────────

describe("Recovery Phase B — single-device 3-day grace", () => {
  it("stamps graceSeconds=259200 on a single-device account's pending row", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const res = await handleInitiateRePair(
      depsFor(storage),
      USERNAME,
      // No TOTP on a single-device account — the cloud-recovery proof
      // minted by the gated wrapped-UMK fetch is its credential.
      initBody({ newIrk, oldIrk, totpProof: null }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      graceMs: number;
      accountType: string;
      totpRequired: boolean;
      credentialUsed: string;
    };
    expect(body.graceMs).toBe(RE_PAIR_SINGLE_GRACE_MS);
    expect(body.accountType).toBe("single");
    // `totpRequired` stays false (it is the TOTP-specific flag the
    // clients key their 24h-vs-3d copy off) even though a credential
    // was required and consumed.
    expect(body.totpRequired).toBe(false);
    expect(body.credentialUsed).toBe("recovery-credential");
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.graceSeconds).toBe(259_200);
    expect(row?.totpRequired).toBe(false);
    expect(row?.totpProofConsumed).toBe(true);
    // Bit 0 (T+0) stamped on initiate — the scheduler must not
    // re-fire the T+0 push on its first sweep.
    expect(row?.alertsFiredBitmap).toBe(1);
  });

  it("stamps graceSeconds=86400 + totpRequired=true on a multi-device account's pending row", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      depsFor(storage),
      USERNAME,
      initBody({ newIrk, oldIrk }),
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
      depsFor(storage),
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
      depsFor(storage),
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
      depsFor(storage),
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
      depsFor(storage),
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        totpProof: { code: aRecoveryCode(storage), method: "recovery" },
      }),
    );
    expect(res.status).toBe(200);
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.totpProofConsumed).toBe(true);
  });

  it("swaps the IRK after the single-device grace (3 days) for a single-device account", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const deps = depsFor(storage);
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    // 24h is too early.
    const earlyRes = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_GRACE_MS + 1_000 },
      USERNAME,
      completeBody({ newIrk, issuedAt: Date.now() + RE_PAIR_GRACE_MS + 1_000 }),
    );
    expect(earlyRes.status).toBe(425);
    // The single-device grace (3 days) + 1s is enough.
    const lateRes = await handleCompleteRePair(
      { ...deps, now: () => Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000 },
      USERNAME,
      completeBody({ newIrk, issuedAt: Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000 }),
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
      deviceId: "10112233445566778899aabbccddeeff",
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
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
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      pushTokens: storage.pushTokens,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME, completeBody({ newIrk, deps: { ...deps, now: () => finishAt } }));
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
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      pushTokens: storage.pushTokens,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME, completeBody({ newIrk, deps: { ...deps, now: () => finishAt } }));
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
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
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
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
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
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

  it("FAILS CLOSED (503) when totpKekHex isn't wired — a code can't be checked", async () => {
    // This used to fall back to a STRUCTURAL-ONLY check, so any
    // non-empty six characters cleared the gate — the second factor
    // became a formality on exactly the accounts that enrolled one.
    // With no KEK the stored secret can't be decrypted, so there is
    // nothing to verify against and the recovery is refused.
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        // NOTE: no totpKekHex.
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
      },
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        totpProof: { code: "000000", method: "totp" },
      }),
    );
    expect(res.status).toBe(503);
    expect((res.body as { reason: string }).reason).toBe("totp-kek-unavailable");
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
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
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        auditEvents: storage.auditEvents,
        now: () => future,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: future }),
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
      deviceId: "20112233445566778899aabbccddeeff",
      platform: "apns",
      providerToken: "providerOld",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const fires: Array<{ username: string; category: string; tokenIds: string[]; deepLink: string }> = [];
    const res = await handleInitiateRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
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
      deviceId: "30112233445566778899aabbccddeeff",
      platform: "apns",
      providerToken: "providerTrust",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      registeredAt: 1,
      lastSeenAt: 1,
    });
    const fires: Array<{ category: string }> = [];
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
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
      deviceId: "01".repeat(16),
      devicePubKey: devA.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    const grantB: import("@flagship/protocol").DeviceCapabilityGrant = {
      grantId: "00000000-0000-4000-8000-000000000002",
      username: USERNAME,
      deviceId: "02".repeat(16),
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
      deviceId: grantA.deviceId,
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
      deviceId: grantB.deviceId,
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
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME, completeBody({ newIrk, deps: { ...deps, now: () => finishAt } }));
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
      deviceId: "03".repeat(16),
      devicePubKey: dev.publicKey,
      scopes: ["browse", "install-service"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    const oldSig = signDeviceCapabilityGrant(oldGrant, oldIrk);
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceId: oldGrant.deviceId,
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
      deviceId: "03".repeat(16),
      devicePubKey: dev.publicKey,
      scopes: ["browse", "install-service"],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const newSig = signDeviceCapabilityGrant(refreshed, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      completeBody({ newIrk, issuedAt: finishAt, refreshedGrants: [
          {
            grantId: refreshed.grantId,
            deviceId: refreshed.deviceId,
            devicePubKey: bytesToHex(refreshed.devicePubKey),
            scopes: refreshed.scopes,
            issuedAt: refreshed.issuedAt,
            expiresAt: refreshed.expiresAt,
            signature: bytesToHex(newSig),
          },
        ] }),
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
      deviceId: "04".repeat(16),
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceId: oldGrant.deviceId,
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
      deviceId: "04".repeat(16),
      devicePubKey: dev.publicKey,
      scopes: ["browse", "install-service"] as DeviceScope[],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const sig = signDeviceCapabilityGrant(inflated, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      completeBody({ newIrk, issuedAt: finishAt, refreshedGrants: [
          {
            grantId: inflated.grantId,
            deviceId: inflated.deviceId,
            devicePubKey: bytesToHex(inflated.devicePubKey),
            scopes: inflated.scopes,
            issuedAt: inflated.issuedAt,
            expiresAt: inflated.expiresAt,
            signature: bytesToHex(sig),
          },
        ] }),
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
      deviceId: "05".repeat(16),
      devicePubKey: unknownDev.publicKey,
      scopes: ["browse"],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const sig = signDeviceCapabilityGrant(phantom, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      completeBody({ newIrk, issuedAt: finishAt, refreshedGrants: [
          {
            grantId: phantom.grantId,
            deviceId: phantom.deviceId,
            devicePubKey: bytesToHex(phantom.devicePubKey),
            scopes: phantom.scopes,
            issuedAt: phantom.issuedAt,
            expiresAt: phantom.expiresAt,
            signature: bytesToHex(sig),
          },
        ] }),
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
      deviceId: "06".repeat(16),
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceId: oldGrant.deviceId,
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
      deviceId: "06".repeat(16),
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 2,
      expiresAt: 1_900_000_000_000,
    };
    const sig = signDeviceCapabilityGrant(refreshed, newIrk);

    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair(
      { ...deps, now: () => finishAt },
      USERNAME,
      completeBody({ newIrk, issuedAt: finishAt, refreshedGrants: [
          {
            grantId: refreshed.grantId,
            deviceId: refreshed.deviceId,
            devicePubKey: bytesToHex(refreshed.devicePubKey),
            scopes: refreshed.scopes,
            issuedAt: refreshed.issuedAt,
            expiresAt: refreshed.expiresAt,
            signature: bytesToHex(sig),
          },
        ] }),
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
      deviceId: "07".repeat(16),
      devicePubKey: dev.publicKey,
      scopes: ["browse"],
      issuedAt: 1,
      expiresAt: 1_900_000_000_000,
    };
    await storage.deviceCapabilityGrants.put({
      grantId: oldGrant.grantId,
      username: USERNAME,
      deviceId: oldGrant.deviceId,
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
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      deviceCapabilityGrants: storage.deviceCapabilityGrants,
    };
    await handleInitiateRePair(deps, USERNAME, initBody({ newIrk, oldIrk, totpProof: null }));
    const finishAt = Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000;
    const res = await handleCompleteRePair({ ...deps, now: () => finishAt }, USERNAME, completeBody({ newIrk, deps: { ...deps, now: () => finishAt } }));
    expect(res.status).toBe(200);
    const body = res.body as { recoveryWipePolicy: string };
    expect(body.recoveryWipePolicy).toBe("graceful");
    // Grant is untouched.
    const after = await storage.deviceCapabilityGrants.get(oldGrant.grantId);
    expect(after?.revokedAt).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────
// #52 follow-up — completion window. A pending row is completable
// only inside [completesAt, completesAt + RE_PAIR_COMPLETE_WINDOW_MS);
// past the deadline it's DEAD (410 + sweep + audit) and a fresh
// initiate sweeps it instead of 409ing. Inside the window it's a LIVE
// recovery that keeps the recovery lock (initiate still 409s).
// ───────────────────────────────────────────────────────────────────

import { RE_PAIR_COMPLETE_WINDOW_MS } from "../src/rePair.js";

describe("#52 — re-pair completion window (stale-row hole)", () => {
  const T0 = 1_700_000_000_000;

  /** Initiate a single-device row at T0; returns deps + the row's
   *  completesAt. Authorized by a cloud-recovery proof minted on the
   *  SAME clock — a proof is bound to a 15-minute window, so a
   *  fast-forwarded test has to mint its own. */
  async function initiateSingleAt(t0 = T0) {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const deps = {
      usernames: storage.usernames,
      pendingRePairs: storage.pendingRePairs,
      webauthnRecovery: storage.webauthnRecovery,
      recoveryProofSecret: TEST_PROOF_SECRET,
      totpKekHex: TEST_KEK_HEX,
      now: () => t0,
    };
    const res = await handleInitiateRePair(
      deps,
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: t0,
        totpProof: null,
        recoveryProof: await proofAt(t0),
      }),
    );
    expect(res.status).toBe(200);
    const completesAt = t0 + RE_PAIR_SINGLE_GRACE_MS;
    return { storage, oldIrk, newIrk, completesAt };
  }

  it("exports a 7-day completion window", () => {
    expect(RE_PAIR_COMPLETE_WINDOW_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it("completes at exactly completesAt (window-open boundary)", async () => {
    const { storage, newIrk, completesAt } = await initiateSingleAt();
    const res = await handleCompleteRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        now: () => completesAt,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: completesAt }),
    );
    expect(res.status).toBe(200);
  });

  it("completes at the last tick inside the window (deadline - 1)", async () => {
    const { storage, newIrk, completesAt } = await initiateSingleAt();
    const res = await handleCompleteRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        now: () => completesAt + RE_PAIR_COMPLETE_WINDOW_MS - 1,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: completesAt + RE_PAIR_COMPLETE_WINDOW_MS - 1 }),
    );
    expect(res.status).toBe(200);
  });

  it("410s at the deadline, sweeps the row, and audits the expiry", async () => {
    const { storage, oldIrk, newIrk, completesAt } = await initiateSingleAt();
    const res = await handleCompleteRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        auditEvents: storage.auditEvents,
        now: () => completesAt + RE_PAIR_COMPLETE_WINDOW_MS,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: completesAt + RE_PAIR_COMPLETE_WINDOW_MS }),
    );
    expect(res.status).toBe(410);
    const body = res.body as { completesAt: number; completionDeadline: number };
    expect(body.completesAt).toBe(completesAt);
    expect(body.completionDeadline).toBe(completesAt + RE_PAIR_COMPLETE_WINDOW_MS);
    // Row swept — the IRK never moved.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
    const rec = await storage.usernames.get(USERNAME);
    expect(rec?.irkPubHex).toBe(bytesToHex(oldIrk.publicKey));
    // Audit row landed.
    const events = await storage.auditEvents.list(USERNAME, 0, 50);
    expect(events.some((e) => e.eventKind === "re-pair-expired")).toBe(true);
  });

  it("a stale row from old testing is NOT completable months later (the same-day-takeover hole)", async () => {
    const { storage, newIrk } = await initiateSingleAt();
    const monthsLater = T0 + 90 * 24 * 60 * 60_000;
    const res = await handleCompleteRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        now: () => monthsLater,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: monthsLater }),
    );
    expect(res.status).toBe(410);
  });

  it("initiate stays BLOCKED (409) while the row is past grace but inside the completion window", async () => {
    // The legitimate flow is initiate → wait grace → complete: a row
    // between completesAt and the deadline is a live recovery awaiting
    // its /complete call. A second initiate must NOT evict it.
    const { storage, oldIrk, newIrk, completesAt } = await initiateSingleAt();
    const rival = makeKey();
    const insideWindow = completesAt + 1_000;
    const res = await handleInitiateRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        now: () => insideWindow,
      },
      USERNAME,
      initBody({
        newIrk: rival,
        oldIrk,
        issuedAt: insideWindow,
        totpProof: null,
        recoveryProof: await proofAt(insideWindow),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("initiate sweeps a row past the completion window and succeeds", async () => {
    const { storage, oldIrk, newIrk, completesAt } = await initiateSingleAt();
    const rival = makeKey();
    const pastDeadline = completesAt + RE_PAIR_COMPLETE_WINDOW_MS;
    const res = await handleInitiateRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        now: () => pastDeadline,
      },
      USERNAME,
      initBody({
        newIrk: rival,
        oldIrk,
        issuedAt: pastDeadline,
        totpProof: null,
        recoveryProof: await proofAt(pastDeadline),
      }),
    );
    expect(res.status).toBe(200);
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.newIrkPubHex).toBe(bytesToHex(rival.publicKey));
  });

  it("the 410 sweep releases the recovery lock — the next initiate succeeds", async () => {
    const { storage, oldIrk, newIrk, completesAt } = await initiateSingleAt();
    const late = completesAt + RE_PAIR_COMPLETE_WINDOW_MS + 1;
    const gone = await handleCompleteRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        now: () => late,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: late }),
    );
    expect(gone.status).toBe(410);
    const rival = makeKey();
    const res = await handleInitiateRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        now: () => late,
      },
      USERNAME,
      initBody({
        newIrk: rival,
        oldIrk,
        issuedAt: late,
        totpProof: null,
        recoveryProof: await proofAt(late),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("honors the completeWindowMs test override", async () => {
    const { storage, oldIrk, newIrk, completesAt } = await initiateSingleAt();
    const shortWindow = 60_000;
    // Inside the shortened window: completable (the swap lands).
    const okRes = await handleCompleteRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        completeWindowMs: shortWindow,
        now: () => completesAt + shortWindow - 1,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: completesAt + shortWindow - 1 }),
    );
    expect(okRes.status).toBe(200);
    const rec = await storage.usernames.get(USERNAME);
    expect(rec!.irkPubHex).not.toBe(bytesToHex(oldIrk.publicKey));
  });
});

// ───────────────────────────────────────────────────────────────────
// #52 follow-up — credential on single-device initiate. A single-
// device account with an enrolled second factor (TOTP secret and/or
// unspent recovery codes) must prove it before the grace starts;
// accounts with NEITHER keep the grace-only path but the initiate is
// audit-logged. Multi-device is unchanged.
// ───────────────────────────────────────────────────────────────────

describe("#52 — credential required on single-device initiate", () => {
  const T0 = 1_700_000_000_000;

  /** Enroll TOTP + recovery codes via the real Phase-3 handlers (they
   *  flip the account to 'multi'), then flip the account-type back to
   *  'single' — landing exactly the hardening target: a single-device
   *  account with enrolled credentials. */
  async function setupSingleEnrolled(): Promise<{
    storage: InMemoryStorage;
    oldIrk: Keypair;
    secretBase32: string;
    recoveryCodes: string[];
  }> {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const enrolled = await enrollMultiDevice(storage, oldIrk, T0);
    const rec = await storage.usernames.get(USERNAME);
    await storage.usernames.put({ ...rec!, accountType: "single" });
    const after = await storage.usernames.get(USERNAME);
    expect(after?.accountType).toBe("single");
    expect(after?.totpSecretEncrypted).toBeTruthy();
    return { storage, oldIrk, ...enrolled };
  }

  /** Production deps, pinned to this block's fixed clock. */
  function depsAtT0(storage: InMemoryStorage) {
    return depsFor(storage, {
      auditEvents: storage.auditEvents,
      now: () => T0,
    });
  }

  it("single + TOTP enrolled: bare initiate → 401 with credentialRequired", async () => {
    const { storage, oldIrk } = await setupSingleEnrolled();
    const newIrk = makeKey();
    const res = await handleInitiateRePair(
      depsAtT0(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }),
    );
    expect(res.status).toBe(401);
    const body = res.body as {
      error: string;
      accountType: string;
      credentialRequired: string[];
    };
    // "totpProof" substring is load-bearing: the webapp's existing
    // prompt-and-retry keys off it.
    expect(body.error).toContain("totpProof");
    expect(body.accountType).toBe("single");
    expect(body.credentialRequired).toContain("totp");
    expect(body.credentialRequired).toContain("recovery-code");
    // No grace started.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });

  it("single + TOTP enrolled: valid TOTP proof → 200 with the 3-day single grace", async () => {
    const { storage, oldIrk, secretBase32 } = await setupSingleEnrolled();
    const newIrk = makeKey();
    const res = await handleInitiateRePair(
      depsAtT0(storage),
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: T0,
        totpProof: { code: codeAt(secretBase32, T0), method: "totp" },
      }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { accountType: string }).accountType).toBe("single");
    const row = await storage.pendingRePairs.get(USERNAME);
    expect(row?.graceSeconds).toBe(RE_PAIR_SINGLE_GRACE_MS / 1000);
    expect(row?.totpRequired).toBe(false); // stays the multi marker
    expect(row?.totpProofConsumed).toBe(true);
  });

  it("single + enrolled: BAD proof → 401 invalid (same wire as multi)", async () => {
    const { storage, oldIrk } = await setupSingleEnrolled();
    const newIrk = makeKey();
    const res = await handleInitiateRePair(
      depsAtT0(storage),
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: T0,
        totpProof: { code: "000000", method: "totp" },
      }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toContain("invalid TOTP proof");
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });

  it("single + recovery codes only (no TOTP secret): 401 advertises recovery-code only", async () => {
    _resetTotpVerifyRateLimitForTests();
    const oldIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const { recoveryCodes } = await enrollMultiDevice(storage, oldIrk, T0);
    const rec = await storage.usernames.get(USERNAME);
    // Simulate a codes-only account: keep the hashed codes, drop the
    // TOTP secret. (InMemory put coalesces absent fields, so write the
    // record through a fresh storage row instead.)
    const codesOnly = new InMemoryStorage();
    await codesOnly.usernames.put({
      username: USERNAME,
      irkPubHex: rec!.irkPubHex,
      claimedAt: 1,
      accountType: "single",
      recoveryCodesHashesJson: rec!.recoveryCodesHashesJson,
    });
    const newIrk = makeKey();
    const missing = await handleInitiateRePair(
      depsAtT0(codesOnly),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }),
    );
    expect(missing.status).toBe(401);
    expect(
      (missing.body as { credentialRequired: string[] }).credentialRequired,
    ).toEqual(["recovery-code", "registered-key"]);
    // A valid recovery code clears the gate AND is consumed + audited.
    const target = recoveryCodes[0] as string;
    const ok = await handleInitiateRePair(
      depsAtT0(codesOnly),
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: T0,
        totpProof: { code: target, method: "recovery" },
      }),
    );
    expect(ok.status).toBe(200);
    const after = await codesOnly.usernames.get(USERNAME);
    expect(JSON.parse(after!.recoveryCodesHashesJson!)).toHaveLength(9);
    const events = await codesOnly.auditEvents.list(USERNAME, 0, 50);
    const consumed = events.find((e) => e.eventKind === "recovery-code-consumed");
    expect(consumed?.accountTypeAtEvent).toBe("single");
  });

  it("single + NO credential at all: REFUSED (409) — recovery is credential-only", async () => {
    // THE takeover primitive, closed. `oldIrkPub` is public (the
    // username lookup serves it) and the envelope is signed by the
    // incoming key, so a credential-less initiate asked a stranger for
    // nothing it couldn't supply — and nothing downstream could stop
    // it (`/object` is self-cancel only). No credential ⇒ no recovery.
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, {
      accountType: "single",
      credential: "none",
    });
    const res = await handleInitiateRePair(
      depsAtT0(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }),
    );
    expect(res.status).toBe(409);
    expect((res.body as { reason: string }).reason).toBe("no-credential");
    // No grace clock started, so nothing can ripen into a swap.
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
    // The attempt is still visible to the owner.
    const events = await storage.auditEvents.list(USERNAME, 0, 50);
    const audit = events.find(
      (e) => e.eventKind === "re-pair-refused-no-credential",
    );
    expect(audit).toBeTruthy();
    expect(audit?.recoveryMethod).toBe("none");
    expect(audit?.accountTypeAtEvent).toBe("single");
  });

  it("a credential-less account can't be taken over by COMPLETING either", async () => {
    // Belt + braces on the same hole: with no pending row there is
    // nothing to finalize, and /complete can no longer be used as an
    // unauthenticated poke to find out.
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, {
      accountType: "single",
      credential: "none",
    });
    const res = await handleCompleteRePair(
      depsAtT0(storage),
      USERNAME,
      completeBody({ newIrk, issuedAt: T0 }),
    );
    expect(res.status).toBe(404);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(oldIrk.publicKey));
  });

  it("multi-device 401 now also carries credentialRequired (additive, same status/error)", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const res = await handleInitiateRePair(
      depsAtT0(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }),
    );
    expect(res.status).toBe(401);
    const body = res.body as {
      error: string;
      accountType: string;
      credentialRequired: string[];
    };
    expect(body.error).toBe("totpProof required for multi-device recovery");
    expect(body.accountType).toBe("multi");
    expect(body.credentialRequired).toEqual(["totp", "recovery-code"]);
  });

  it("complete after a single TOTP-proven recovery audits recoveryMethod='totp'", async () => {
    const { storage, oldIrk, secretBase32 } = await setupSingleEnrolled();
    const newIrk = makeKey();
    const init = await handleInitiateRePair(
      depsAtT0(storage),
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: T0,
        totpProof: { code: codeAt(secretBase32, T0), method: "totp" },
      }),
    );
    expect(init.status).toBe(200);
    const done = await handleCompleteRePair(
      {
        webauthnRecovery: storage.webauthnRecovery,
        recoveryProofSecret: TEST_PROOF_SECRET,
        totpKekHex: TEST_KEK_HEX,
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        auditEvents: storage.auditEvents,
        now: () => T0 + RE_PAIR_SINGLE_GRACE_MS + 1,
      },
      USERNAME,
      completeBody({ newIrk, issuedAt: T0 + RE_PAIR_SINGLE_GRACE_MS + 1 }),
    );
    expect(done.status).toBe(200);
    const events = await storage.auditEvents.list(USERNAME, 0, 50);
    const replaced = events.find((e) => e.eventKind === "device-replaced");
    expect(replaced?.recoveryMethod).toBe("totp");
  });
});

// ───────────────────────────────────────────────────────────────────
// The recovery-credential gate on initiate, and the signature gate on
// complete. Together these are what stops an unauthenticated caller
// from scheduling an IRK swap on any account whose handle they know:
// before them, a single-device account with no TOTP needed only its
// PUBLIC oldIrkPub (GET /api/username/:u serves it) plus a self-signed
// envelope, and no veto existed downstream.
// ───────────────────────────────────────────────────────────────────

describe("recovery-credential gate on initiate", () => {
  const T0 = 1_700_000_000_000;

  async function single(): Promise<{
    storage: InMemoryStorage;
    oldIrk: Keypair;
    newIrk: Keypair;
  }> {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    return { storage, oldIrk, newIrk };
  }

  function depsAt(storage: InMemoryStorage, now = T0) {
    return depsFor(storage, { auditEvents: storage.auditEvents, now: () => now });
  }

  it("the attack: public oldIrkPub + a self-signed envelope is NOT enough", async () => {
    const { storage, oldIrk, newIrk } = await single();
    // Everything an internet stranger can obtain: the handle, and the
    // current IRK from the unauthenticated username lookup.
    const res = await handleInitiateRePair(
      depsAt(storage),
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        issuedAt: T0,
        totpProof: null,
        recoveryProof: null,
      }),
    );
    expect(res.status).toBe(401);
    const body = res.body as { credentialRequired: string[] };
    expect(body.credentialRequired).toEqual(["recovery-credential", "registered-key"]);
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });

  it("accepts the proof the gated wrapped-UMK fetch minted", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const res = await handleInitiateRePair(
      depsAt(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: await proofAt(T0) }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { credentialUsed: string }).credentialUsed).toBe(
      "recovery-credential",
    );
    const events = await storage.auditEvents.list(USERNAME, 0, 50);
    const started = events.find((e) => e.eventKind === "re-pair-initiated");
    expect(started?.recoveryMethod).toBe("recovery-credential");
  });

  it("rejects a forged token (wrong MAC secret)", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const { token } = await mintRecoveryProof(
      { username: USERNAME, fetchTokenHashHex: TEST_FETCH_TOKEN_HASH },
      "not-the-worker-secret",
      { now: T0 },
    );
    const res = await handleInitiateRePair(
      depsAt(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: token }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { reason: string }).reason).toBe("bad-signature");
  });

  it("rejects a token minted for a DIFFERENT account", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const { token } = await mintRecoveryProof(
      { username: "someone-else", fetchTokenHashHex: TEST_FETCH_TOKEN_HASH },
      TEST_PROOF_SECRET,
      { now: T0 },
    );
    const res = await handleInitiateRePair(
      depsAt(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: token }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { reason: string }).reason).toBe("bad-signature");
  });

  it("rejects a token that outlived its TTL", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const stale = await proofAt(T0 - RECOVERY_PROOF_TTL_MS - 1_000);
    const res = await handleInitiateRePair(
      depsAt(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: stale }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { reason: string }).reason).toBe("expired");
  });

  it("re-enrolling cloud recovery invalidates outstanding tokens", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const issued = await proofAt(T0);
    // The user changes their recovery passphrase: a new fetchToken, so
    // a new stored hash. Tokens bound to the old hash are now dead.
    const rec = await storage.webauthnRecovery.get(USERNAME);
    await storage.webauthnRecovery.upsert({
      ...rec!,
      fetchTokenHashHex: "cd".repeat(32),
    });
    const res = await handleInitiateRePair(
      depsAt(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: issued }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { reason: string }).reason).toBe("bad-signature");
  });

  it("a record predating the passphrase gate cannot authorize a recovery", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const rec = await storage.webauthnRecovery.get(USERNAME);
    const { fetchTokenHashHex: _dropped, ...legacy } = rec!;
    const fresh = new InMemoryStorage();
    await fresh.usernames.put((await storage.usernames.get(USERNAME))!);
    await fresh.webauthnRecovery.upsert(legacy);
    const res = await handleInitiateRePair(
      depsAt(fresh),
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: await proofAt(T0) }),
    );
    expect(res.status).toBe(409);
    expect((res.body as { reason: string }).reason).toBe("no-credential");
  });

  it("FAILS CLOSED (503) when the proof secret isn't configured", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        webauthnRecovery: storage.webauthnRecovery,
        // NOTE: no recoveryProofSecret — the dep this gate needs.
        now: () => T0,
      },
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: await proofAt(T0) }),
    );
    expect(res.status).toBe(503);
    expect((res.body as { reason: string }).reason).toBe(
      "recovery-proof-unavailable",
    );
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });

  it("FAILS CLOSED (503) when the escrow store isn't wired", async () => {
    const { storage, oldIrk, newIrk } = await single();
    const res = await handleInitiateRePair(
      {
        usernames: storage.usernames,
        pendingRePairs: storage.pendingRePairs,
        recoveryProofSecret: TEST_PROOF_SECRET,
        // NOTE: no webauthnRecovery — we cannot even tell whether a
        // credential exists, so we must not assume there is none.
        now: () => T0,
      },
      USERNAME,
      initBody({ newIrk, oldIrk, issuedAt: T0, recoveryProof: await proofAt(T0) }),
    );
    expect(res.status).toBe(503);
  });

  it("a recovery-credential proof does NOT satisfy a multi-device account", async () => {
    // Multi's 24h grace (vs 3 days) is priced on the stronger factor.
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    await enrollCloudRecovery(storage);
    const res = await handleInitiateRePair(
      depsAt(storage, Date.now()),
      USERNAME,
      initBody({
        newIrk,
        oldIrk,
        totpProof: null,
        recoveryProof: await proofAt(Date.now()),
      }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { credentialRequired: string[] }).credentialRequired).toEqual([
      "totp",
      "recovery-code",
    ]);
  });
});

describe("signature gate on re-pair complete", () => {
  async function ripened(): Promise<{
    storage: InMemoryStorage;
    oldIrk: Keypair;
    newIrk: Keypair;
    finishAt: number;
  }> {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "single" });
    const init = await handleInitiateRePair(
      depsFor(storage),
      USERNAME,
      initBody({ newIrk, oldIrk, totpProof: null }),
    );
    expect(init.status).toBe(200);
    return {
      storage,
      oldIrk,
      newIrk,
      finishAt: Date.now() + RE_PAIR_SINGLE_GRACE_MS + 1_000,
    };
  }

  it("refuses a bare POST — the old behaviour let any passer-by fire the swap", async () => {
    const { storage, oldIrk, finishAt } = await ripened();
    const res = await handleCompleteRePair(
      depsFor(storage, { now: () => finishAt }),
      USERNAME,
      undefined,
    );
    expect(res.status).toBe(401);
    expect((res.body as { reason: string }).reason).toBe("signature-required");
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(oldIrk.publicKey));
  });

  it("refuses a signature by a key other than the pending row's", async () => {
    const { storage, oldIrk, finishAt } = await ripened();
    const impostor = makeKey();
    const res = await handleCompleteRePair(
      depsFor(storage, { now: () => finishAt }),
      USERNAME,
      completeBody({ newIrk: impostor, issuedAt: finishAt }),
    );
    expect(res.status).toBe(403);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(oldIrk.publicKey));
  });

  it("refuses a self-cancel signature replayed as a completion (tag separation)", async () => {
    // RePairObject and RePairComplete carry IDENTICAL fields and are
    // signed by the SAME key. Only the canonical tag distinguishes
    // "stop" from "go" — if it didn't, a captured cancel would finish
    // the takeover it was meant to abort.
    const { storage, newIrk, oldIrk, finishAt } = await ripened();
    const cancel = objectBody({
      signer: newIrk,
      newIrkPub: newIrk.publicKey,
      issuedAt: finishAt,
    });
    const res = await handleCompleteRePair(
      depsFor(storage, { now: () => finishAt }),
      USERNAME,
      cancel as Parameters<typeof handleCompleteRePair>[2],
    );
    expect(res.status).toBe(403);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(oldIrk.publicKey));
  });

  it("refuses a stale envelope", async () => {
    const { storage, newIrk, finishAt } = await ripened();
    const res = await handleCompleteRePair(
      depsFor(storage, { now: () => finishAt }),
      USERNAME,
      completeBody({ newIrk, issuedAt: finishAt - 60 * 60_000 }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/stale/i);
  });

  it("accepts the pending row's own key and swaps", async () => {
    const { storage, newIrk, finishAt } = await ripened();
    const res = await handleCompleteRePair(
      depsFor(storage, { now: () => finishAt }),
      USERNAME,
      completeBody({ newIrk, issuedAt: finishAt }),
    );
    expect(res.status).toBe(200);
    const after = await storage.usernames.get(USERNAME);
    expect(after?.irkPubHex).toBe(bytesToHex(newIrk.publicKey));
  });

  it("authorizes BEFORE reporting timing, so it can't probe a recovery's state", async () => {
    // An unauthenticated caller must not learn "too early" / "objected"
    // / "expired" about someone else's recovery.
    const { storage } = await ripened();
    const res = await handleCompleteRePair(depsFor(storage), USERNAME, undefined);
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty("completesAt");
    expect(res.body).not.toHaveProperty("secondsRemaining");
  });
});

describe("registered-key credential (key-file / device-pair recovery)", () => {
  const T0 = 1_700_000_000_000;

  /** The key-file case: no TOTP, no cloud escrow — just the seed, and
   *  therefore the account's currently-registered key. */
  async function bare(): Promise<{
    storage: InMemoryStorage;
    oldIrk: Keypair;
    newIrk: Keypair;
  }> {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, {
      accountType: "single",
      credential: "none",
    });
    return { storage, oldIrk, newIrk };
  }

  function withOldIrkProof(
    body: ReturnType<typeof initBody>,
    oldIrk: Keypair,
    args: { newIrk: Keypair; issuedAt: number },
  ) {
    // A second signature over the SAME canonical bytes, by the key the
    // swap will displace.
    const sig = signRePairInitiate(
      {
        username: USERNAME,
        newIrkPub: args.newIrk.publicKey,
        oldIrkPub: oldIrk.publicKey,
        issuedAt: args.issuedAt,
      },
      oldIrk,
    );
    return { ...body, oldIrkSignature: bytesToHex(sig) };
  }

  it("authorizes an account with NO enrolled recovery credential", async () => {
    const { storage, oldIrk, newIrk } = await bare();
    const depsAt = depsFor(storage, {
      auditEvents: storage.auditEvents,
      now: () => T0,
    });
    const res = await handleInitiateRePair(
      depsAt,
      USERNAME,
      withOldIrkProof(
        initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }),
        oldIrk,
        { newIrk, issuedAt: T0 },
      ),
    );
    expect(res.status).toBe(200);
    expect((res.body as { credentialUsed: string }).credentialUsed).toBe(
      "registered-key",
    );
    const events = await storage.auditEvents.list(USERNAME, 0, 50);
    expect(
      events.find((e) => e.eventKind === "re-pair-initiated")?.recoveryMethod,
    ).toBe("registered-key");
  });

  it("rejects a proof signed by a key that is NOT the registered one", async () => {
    const { storage, oldIrk, newIrk } = await bare();
    const impostor = makeKey();
    const depsAt = depsFor(storage, { now: () => T0 });
    const base = initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null });
    const forged = signRePairInitiate(
      {
        username: USERNAME,
        newIrkPub: newIrk.publicKey,
        oldIrkPub: oldIrk.publicKey,
        issuedAt: T0,
      },
      impostor,
    );
    const res = await handleInitiateRePair(depsAt, USERNAME, {
      ...base,
      oldIrkSignature: bytesToHex(forged),
    });
    expect(res.status).toBe(401);
    expect((res.body as { reason: string }).reason).toBe("bad-registered-key-proof");
    expect(await storage.pendingRePairs.get(USERNAME)).toBeUndefined();
  });

  it("does NOT let the new key sign its own ownership proof", async () => {
    // The self-signature is already required and proves only key
    // possession. Re-presenting it as the ownership proof must fail.
    const { storage, oldIrk, newIrk } = await bare();
    const depsAt = depsFor(storage, { now: () => T0 });
    const base = initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }) as {
      signature: string;
    };
    const res = await handleInitiateRePair(depsAt, USERNAME, {
      ...base,
      oldIrkSignature: base.signature,
    });
    expect(res.status).toBe(401);
    expect((res.body as { reason: string }).reason).toBe("bad-registered-key-proof");
  });

  it("still requires TOTP on a multi-device account", async () => {
    const oldIrk = makeKey();
    const newIrk = makeKey();
    const storage = await setup(oldIrk, { accountType: "multi" });
    const depsAt = depsFor(storage, { now: () => T0 });
    const res = await handleInitiateRePair(
      depsAt,
      USERNAME,
      withOldIrkProof(
        initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }),
        oldIrk,
        { newIrk, issuedAt: T0 },
      ),
    );
    // The registered-key proof is accepted as a credential, but multi's
    // own gate is unchanged: it is the one account type where a second
    // factor is mandatory.
    expect(res.status).toBe(200);
    expect((res.body as { credentialUsed: string }).credentialUsed).toBe(
      "registered-key",
    );
  });

  it("is refused once the account's key has moved on (stale key file)", async () => {
    const { storage, oldIrk, newIrk } = await bare();
    // Someone else rotated the account (or the user did, on another
    // device): the key file now holds a key the account no longer uses.
    const rotated = makeKey();
    const swapped = await storage.usernames.swapIrkPub(
      USERNAME,
      bytesToHex(oldIrk.publicKey),
      bytesToHex(rotated.publicKey),
      T0 - 1_000,
    );
    expect(swapped).toBe(true);
    const depsAt = depsFor(storage, { now: () => T0 });
    const res = await handleInitiateRePair(
      depsAt,
      USERNAME,
      withOldIrkProof(
        initBody({ newIrk, oldIrk, issuedAt: T0, totpProof: null }),
        oldIrk,
        { newIrk, issuedAt: T0 },
      ),
    );
    // Rejected earlier, by the oldIrkPub-matches-current check.
    expect(res.status).toBe(403);
  });
});
