import { describe, expect, it } from "vitest";
import { ed, signRePairComplete, signRePairVeto, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleCompleteRePair, handleGetRePair, handleVetoRePair, RE_PAIR_GRACE_MS, RE_PAIR_OFFLINE_ALERT_MS } from "../src/rePair.js";

const U = "alice";
const T0 = 1_760_000_000_000;
const key = (n: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const OLD = key(1), NEW = key(2), ADMIN = key(3), OTHER = key(4);

async function setup(admin: Keypair | null = ADMIN) {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: U, irkPubHex: hex(OLD.publicKey), claimedAt: 1, accountType: "multi", ...(admin ? { adminRootPubHex: hex(admin.publicKey) } : {}) });
  const completesAt = T0 + RE_PAIR_GRACE_MS;
  await s.pendingRePairs.initiate({
    username: U, newIrkPubHex: hex(NEW.publicKey), oldIrkPubHex: hex(OLD.publicKey),
    initiatedAt: T0, completesAt, graceSeconds: RE_PAIR_GRACE_MS / 1000, offlineAlertMs: RE_PAIR_OFFLINE_ALERT_MS,
  });
  return { s, completesAt };
}
const deps = (s: InMemoryStorage, now: number) => ({ usernames: s.usernames, pendingRePairs: s.pendingRePairs, auditEvents: s.auditEvents, now: () => now });

function vetoBody(over: Partial<{ username: string; newIrkPub: Uint8Array; initiatedAt: number; completesAt: number; vetoerPub: Uint8Array; issuedAt: number }>, signer: Keypair, completesAt: number) {
  const req = { username: U, newIrkPub: NEW.publicKey, initiatedAt: T0, completesAt, vetoerPub: ADMIN.publicKey, issuedAt: T0 + 1000, ...over };
  return {
    request: { ...req, newIrkPub: hex(req.newIrkPub), vetoerPub: hex(req.vetoerPub) },
    signature: hex(signRePairVeto(req, signer)),
  };
}
function completeBody(issuedAt: number) {
  const req = { username: U, newIrkPub: NEW.publicKey, issuedAt };
  return { request: { username: U, newIrkPub: hex(NEW.publicKey), issuedAt }, signature: hex(signRePairComplete(req, NEW)) };
}

describe("an admin veto of a pending recovery", () => {
  it("cancels the attempt, is audited, and the swap can never happen", async () => {
    const { s, completesAt } = await setup();
    const r = await handleVetoRePair(deps(s, T0 + 2000), U, vetoBody({}, ADMIN, completesAt));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const got = (await handleGetRePair(deps(s, T0 + 3000), U)).body as { pending: { objectedAt: number; vetoedBy: string } };
    expect(got.pending.vetoedBy).toBe(hex(ADMIN.publicKey));
    // even after the deadline, completion is refused
    const done = await handleCompleteRePair(deps(s, completesAt + 1), U, completeBody(completesAt + 1));
    expect(done.status).toBe(409);
    expect((done.body as { reason: string }).reason).toBe("vetoed");
    expect((await s.usernames.get(U))!.irkPubHex).toBe(hex(OLD.publicKey));
    expect((await s.auditEvents.listByUser?.(U, 10))?.some((e) => e.eventKind === "re-pair-vetoed") ?? true).toBe(true);
  });

  it("refuses anyone but the pinned admin key, including the pending device itself", async () => {
    const { s, completesAt } = await setup();
    for (const [name, signer, pub] of [["a stranger", OTHER, OTHER], ["the pending device", NEW, NEW], ["the old IRK", OLD, OLD]] as const) {
      const r = await handleVetoRePair(deps(s, T0 + 2000), U, vetoBody({ vetoerPub: pub.publicKey }, signer, completesAt));
      expect(r.status, name).toBe(403);
    }
    expect((await s.pendingRePairs.get(U))!.objectedAt).toBeUndefined();
  });

  it("refuses an account with no pinned admin key", async () => {
    const { s, completesAt } = await setup(null);
    expect((await handleVetoRePair(deps(s, T0 + 2000), U, vetoBody({}, ADMIN, completesAt))).status).toBe(403);
  });

  it("refuses a forged signature, a wrong attempt and a stale request", async () => {
    const { s, completesAt } = await setup();
    const bad = vetoBody({}, OTHER, completesAt);
    expect((await handleVetoRePair(deps(s, T0 + 2000), U, bad)).status).toBe(403);
    expect((await handleVetoRePair(deps(s, T0 + 2000), U, vetoBody({ initiatedAt: T0 - 5 }, ADMIN, completesAt))).status).toBe(409);
    expect((await handleVetoRePair(deps(s, T0 + 2000), U, vetoBody({ completesAt: completesAt + 1 }, ADMIN, completesAt + 1))).status).toBe(409);
    expect((await handleVetoRePair(deps(s, T0 + 2000 + 3 * 3600_000), U, vetoBody({}, ADMIN, completesAt))).status).toBe(403);
    expect((await s.pendingRePairs.get(U))!.objectedAt).toBeUndefined();
  });

  it("a veto cannot be replayed onto a fresh attempt", async () => {
    const { s, completesAt } = await setup();
    const body = vetoBody({}, ADMIN, completesAt);
    expect((await handleVetoRePair(deps(s, T0 + 2000), U, body)).status).toBe(200);
    await s.pendingRePairs.delete(U);
    await s.pendingRePairs.initiate({ username: U, newIrkPubHex: hex(NEW.publicKey), oldIrkPubHex: hex(OLD.publicKey), initiatedAt: T0 + 10_000, completesAt: completesAt + 10_000 });
    expect((await handleVetoRePair(deps(s, T0 + 12_000), U, body)).status).toBe(409);
    expect((await s.pendingRePairs.get(U))!.objectedAt).toBeUndefined();
  });
});

describe("veto against completion is decided by one atomic claim", () => {
  it("a completion that claims first wins and the veto then fails", async () => {
    const { s, completesAt } = await setup();
    const done = await handleCompleteRePair(deps(s, completesAt + 1), U, completeBody(completesAt + 1));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await s.usernames.get(U))!.irkPubHex).toBe(hex(NEW.publicKey));
    const late = await handleVetoRePair(deps(s, completesAt + 2), U, vetoBody({ issuedAt: completesAt + 2 }, ADMIN, completesAt));
    expect([404, 409]).toContain(late.status);
  });

  it("at the storage layer exactly one of veto and claim wins, in either order", async () => {
    for (const vetoFirst of [true, false]) {
      const { s } = await setup();
      const veto = () => s.pendingRePairs.veto(U, 1, "aa", "bb");
      const claim = () => s.pendingRePairs.claimCompletion(U, 1);
      const [a, b] = vetoFirst ? [await veto(), await claim()] : [await claim(), await veto()];
      expect([a, b]).toEqual([true, false]);
    }
  });

  it("the recoverer's own cancel also loses to a claim that already started", async () => {
    const { s } = await setup();
    expect(await s.pendingRePairs.claimCompletion(U, 1)).toBe(true);
    expect(await s.pendingRePairs.object(U, 2)).toBe(false);
  });
});

describe("the wait", () => {
  it("is at least twice the offline-alert threshold and the threshold is frozen on the row", async () => {
    expect(RE_PAIR_GRACE_MS).toBeGreaterThanOrEqual(2 * RE_PAIR_OFFLINE_ALERT_MS);
    const { s } = await setup();
    expect((await s.pendingRePairs.get(U))!.offlineAlertMs).toBe(RE_PAIR_OFFLINE_ALERT_MS);
  });
});
