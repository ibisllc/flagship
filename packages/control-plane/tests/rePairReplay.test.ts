/**
 * Security report F3 (docs/security/F3-re-pair-disclosure-investigation.md): a re-pair
 * initiate is used once, an envelope signed before a cancel cannot revive it, and an
 * admin veto refuses the rejected key for a day. A self-cancel by the recoverer starts
 * no such block.
 */
import { describe, expect, it } from "vitest";
import * as OTPAuth from "otpauth";
import { ed, signRePairInitiate, signRePairObject, signRePairVeto, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleInitiateRePair,
  handleObjectRePair,
  handleVetoRePair,
  RE_PAIR_COMPLETE_WINDOW_MS,
  RE_PAIR_GRACE_MS,
  RE_PAIR_SINGLE_GRACE_MS,
  RE_PAIR_VETO_BLOCK_MS,
} from "../src/rePair.js";
import { encryptTotpSecret } from "../src/totp.js";
import { mintRecoveryProof } from "../src/recoveryProof.js";

const U = "alice";
const T0 = 1_760_000_000_000;
const SECRET = "test-recovery-proof-secret-0123456789";
const FETCH_HASH = "ab".repeat(32);
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const key = (n: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const OLD = key(1), NEW = key(2), ADMIN = key(3), OTHER = key(4);

async function setup(extra: { totpSecretBase32?: string } = {}) {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: U, irkPubHex: hex(OLD.publicKey), claimedAt: 1, accountType: "single", adminRootPubHex: hex(ADMIN.publicKey),
    ...(extra.totpSecretBase32
      ? { totpSecretEncrypted: await encryptTotpSecret(OTPAuth.Secret.fromBase32(extra.totpSecretBase32).bytes, KEK), totpEnrolledAt: 1 }
      : {}),
  });
  await s.webauthnRecovery.upsert({ username: U, credentialIdHex: "aa".repeat(16), wrappedUmkB64: "AAAA", fetchTokenHashHex: FETCH_HASH, updatedAt: 1 });
  return s;
}

const deps = (s: InMemoryStorage, now: number) => ({
  usernames: s.usernames,
  pendingRePairs: s.pendingRePairs,
  webauthnRecovery: s.webauthnRecovery,
  auditEvents: s.auditEvents,
  recoveryProofSecret: SECRET,
  totpKekHex: KEK,
  now: () => now,
});

/** A registered-key initiate: the body a stranger could rebuild from the old public GET. */
function initiate(newIrk: Keypair, issuedAt: number, credential: Record<string, unknown> | "registered-key" = "registered-key") {
  const req = { username: U, newIrkPub: newIrk.publicKey, oldIrkPub: OLD.publicKey, issuedAt };
  return {
    request: { username: U, newIrkPub: hex(newIrk.publicKey), oldIrkPub: hex(OLD.publicKey), issuedAt },
    signature: hex(signRePairInitiate(req, newIrk)),
    ...(credential === "registered-key" ? { oldIrkSignature: hex(signRePairInitiate(req, OLD)) } : credential),
  };
}

function selfCancel(newIrk: Keypair, issuedAt: number) {
  const req = { username: U, newIrkPub: newIrk.publicKey, issuedAt };
  return { request: { ...req, newIrkPub: hex(newIrk.publicKey) }, signature: hex(signRePairObject(req, newIrk)) };
}

async function adminVeto(s: InMemoryStorage, at: number) {
  const row = (await s.pendingRePairs.get(U))!;
  const req = { username: U, newIrkPub: Buffer.from(row.newIrkPubHex, "hex"), initiatedAt: row.initiatedAt, completesAt: row.completesAt, vetoerPub: ADMIN.publicKey, issuedAt: at };
  const r = await handleVetoRePair(deps(s, at), U, {
    request: { ...req, newIrkPub: row.newIrkPubHex, vetoerPub: hex(ADMIN.publicKey) },
    signature: hex(signRePairVeto(req, ADMIN)),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const code = (r: { body: unknown }) => (r.body as { code?: string }).code;

describe("replay of a re-pair initiate (b1, b2)", () => {
  it("a replay after the recoverer's self-cancel is refused and the row stays cancelled", async () => {
    const s = await setup();
    const body = initiate(NEW, T0);
    expect((await handleInitiateRePair(deps(s, T0 + 100), U, body)).status).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 700), U, selfCancel(NEW, T0 + 700))).status).toBe(200);
    const replay = await handleInitiateRePair(deps(s, T0 + 60_000), U, body);
    expect(replay.status).toBe(409);
    expect(code(replay)).toBe("re-pair-cancelled-replay");
    expect((await s.pendingRePairs.get(U))!.objectedAt).toBe(T0 + 700);
  });

  it("a replay after an admin veto is refused and the vetoed row is kept", async () => {
    const s = await setup();
    const body = initiate(NEW, T0);
    expect((await handleInitiateRePair(deps(s, T0 + 100), U, body)).status).toBe(200);
    await adminVeto(s, T0 + 2_000);
    const replay = await handleInitiateRePair(deps(s, T0 + 60_000), U, body);
    expect(replay.status).toBe(409);
    expect(code(replay)).toBe("re-pair-cancelled-replay");
    const row = (await s.pendingRePairs.get(U))!;
    expect(row.vetoedByHex).toBe(hex(ADMIN.publicKey));
    expect(row.objectedAt).toBe(T0 + 2_000);
  });

  it("the exact envelope of a row past its completion window is refused", async () => {
    const s = await setup();
    const body = initiate(NEW, T0);
    expect((await handleInitiateRePair(deps(s, T0), U, body)).status).toBe(200);
    // The row is dead (never completed); the freshness check is the only other gate.
    const late = T0 + RE_PAIR_SINGLE_GRACE_MS + RE_PAIR_COMPLETE_WINDOW_MS + 1;
    const r = await handleInitiateRePair({ ...deps(s, late), maxAgeMs: Number.MAX_SAFE_INTEGER }, U, body);
    expect(r.status).toBe(409);
    expect(code(r)).toBe("re-pair-replay");
  });

  it("an envelope is accepted once, even after its row was replaced", async () => {
    const s = await setup();
    const first = initiate(NEW, T0);
    expect((await handleInitiateRePair(deps(s, T0), U, first)).status).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 1_000), U, selfCancel(NEW, T0 + 1_000))).status).toBe(200);
    // Another key starts and cancels: the first row is gone.
    expect((await handleInitiateRePair(deps(s, T0 + 2_000), U, initiate(OTHER, T0 + 2_000))).status).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 3_000), U, selfCancel(OTHER, T0 + 3_000))).status).toBe(200);
    const replay = await handleInitiateRePair(deps(s, T0 + 4_000), U, first);
    expect(replay.status).toBe(409);
    expect(code(replay)).toBe("re-pair-replay");
  });

  it("an honest retry after a self-cancel, freshly signed, is accepted at once (no veto block)", async () => {
    const s = await setup();
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0))).status).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 1_000), U, selfCancel(NEW, T0 + 1_000))).status).toBe(200);
    const retry = await handleInitiateRePair(deps(s, T0 + 5_000), U, initiate(NEW, T0 + 5_000));
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  });

  it("a live row still answers 'already pending', and a refused attempt does not burn its envelope", async () => {
    const s = await setup();
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0))).status).toBe(200);
    const other = initiate(OTHER, T0 + 1_000);
    const busy = await handleInitiateRePair(deps(s, T0 + 1_000), U, other);
    expect(busy.status).toBe(409);
    expect(code(busy)).toBeUndefined();
    expect((await handleObjectRePair(deps(s, T0 + 2_000), U, selfCancel(NEW, T0 + 2_000))).status).toBe(200);
    expect((await handleInitiateRePair(deps(s, T0 + 3_000), U, other)).status).toBe(200);
  });

  it("refuses an initiate dated more than a minute ahead", async () => {
    const s = await setup();
    const r = await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0 + 2 * 60_000));
    expect(r.status).toBe(403);
    expect(code(r)).toBe("re-pair-stale");
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0 + 30_000))).status).toBe(200);
  });
});

describe("a credential is spent once (b2)", () => {
  it("the same recovery-session token cannot start a second attempt", async () => {
    const s = await setup();
    const { token } = await mintRecoveryProof({ username: U, fetchTokenHashHex: FETCH_HASH }, SECRET, { now: T0 });
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0, { recoveryProof: { token } }))).status).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 1_000), U, selfCancel(NEW, T0 + 1_000))).status).toBe(200);
    const again = await handleInitiateRePair(deps(s, T0 + 2_000), U, initiate(NEW, T0 + 2_000, { recoveryProof: { token } }));
    expect(again.status).toBe(409);
    expect(code(again)).toBe("re-pair-credential-used");
  });

  it("the same TOTP code cannot start a second attempt", async () => {
    const base32 = new OTPAuth.Secret({ size: 20 }).base32;
    const s = await setup({ totpSecretBase32: base32 });
    const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(base32) });
    const c = totp.generate({ timestamp: T0 });
    const proof = { totpProof: { code: c, method: "totp" } };
    const ok = await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0, proof));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 1_000), U, selfCancel(NEW, T0 + 1_000))).status).toBe(200);
    const again = await handleInitiateRePair(deps(s, T0 + 2_000), U, initiate(NEW, T0 + 2_000, proof));
    expect(again.status).toBe(409);
    expect(code(again)).toBe("re-pair-credential-used");
  });
});

describe("an admin veto holds for a day against the rejected key", () => {
  it("refuses a fresh initiate with the vetoed key for 24 hours, then accepts it", async () => {
    const s = await setup();
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0))).status).toBe(200);
    await adminVeto(s, T0 + 2_000);
    const soon = T0 + 60 * 60_000;
    const blocked = await handleInitiateRePair(deps(s, soon), U, initiate(NEW, soon));
    expect(blocked.status).toBe(409);
    expect(code(blocked)).toBe("re-pair-vetoed-recently");
    expect((blocked.body as { until: number }).until).toBe(T0 + 2_000 + RE_PAIR_VETO_BLOCK_MS);
    const later = T0 + 2_000 + RE_PAIR_VETO_BLOCK_MS + 1;
    expect((await handleInitiateRePair(deps(s, later), U, initiate(NEW, later))).status).toBe(200);
  });

  it("does not block another key, and still blocks the vetoed key after its row was replaced", async () => {
    const s = await setup();
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0))).status).toBe(200);
    await adminVeto(s, T0 + 2_000);
    const { token } = await mintRecoveryProof({ username: U, fetchTokenHashHex: FETCH_HASH }, SECRET, { now: T0 + 3_000 });
    expect((await handleInitiateRePair(deps(s, T0 + 3_000), U, initiate(OTHER, T0 + 3_000, { recoveryProof: { token } }))).status).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 4_000), U, selfCancel(OTHER, T0 + 4_000))).status).toBe(200);
    const blocked = await handleInitiateRePair(deps(s, T0 + 5_000), U, initiate(NEW, T0 + 5_000));
    expect(blocked.status).toBe(409);
    expect(code(blocked)).toBe("re-pair-vetoed-recently");
  });

  it("on an admin-pinned account the account key starts no recovery for a day after a veto, whatever key it names", async () => {
    const s = await setup();
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0))).status).toBe(200);
    await adminVeto(s, T0 + 2_000);
    const blocked = await handleInitiateRePair(deps(s, T0 + 3_000), U, initiate(OTHER, T0 + 3_000));
    expect(blocked.status).toBe(409);
    expect(code(blocked)).toBe("re-pair-vetoed-recently");
    const later = T0 + 2_000 + RE_PAIR_VETO_BLOCK_MS + 1;
    expect((await handleInitiateRePair(deps(s, later), U, initiate(OTHER, later))).status).toBe(200);
  });

  it("a self-cancel starts no block", async () => {
    const s = await setup();
    expect((await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0))).status).toBe(200);
    expect((await handleObjectRePair(deps(s, T0 + 1_000), U, selfCancel(NEW, T0 + 1_000))).status).toBe(200);
    expect(await s.pendingRePairs.vetoedKeyBlockedUntil(U, hex(NEW.publicKey), T0 + 2_000)).toBeUndefined();
  });
});

describe("the account key as a recovery credential", () => {
  async function multi(pinnedRoot: boolean) {
    const s = new InMemoryStorage();
    await s.usernames.put({
      username: U, irkPubHex: hex(OLD.publicKey), claimedAt: 1, accountType: "multi",
      ...(pinnedRoot ? { adminRootPubHex: hex(ADMIN.publicKey) } : {}),
    });
    return s;
  }

  it("never buys the 24 h multi-device window on an admin-pinned account", async () => {
    const s = await multi(true);
    const r = await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0));
    expect(r.status).toBe(200);
    expect((r.body as { completesAt: number }).completesAt).toBe(T0 + RE_PAIR_SINGLE_GRACE_MS);
    expect((await s.pendingRePairs.get(U))!.completesAt).toBe(T0 + RE_PAIR_SINGLE_GRACE_MS);
  });

  it("an account with no admin root keeps its window", async () => {
    const s = await multi(false);
    const r = await handleInitiateRePair(deps(s, T0), U, initiate(NEW, T0));
    expect(r.status).toBe(200);
    expect((r.body as { completesAt: number }).completesAt).toBe(T0 + RE_PAIR_GRACE_MS);
  });
});
