import { describe, expect, it } from "vitest";
import {
  ed,
  signInheritanceDeclaration,
  type InheritanceDeclaration,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  InMemoryInheritanceStorage,
  eligibleForTakeover,
  handleGetInheritanceDeclaration,
  handlePutInheritanceDeclaration,
  takeoverNoticeWindowEnd,
} from "../src/inheritance.js";

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

async function seedUsername(irk: Keypair) {
  const usernames = new InMemoryStorage().usernames;
  await usernames.put({ username: USERNAME, irkPubHex: bytesToHex(irk.publicKey), claimedAt: 1 });
  return usernames;
}

function makeBody(args: {
  irk: Keypair;
  heirPubs: Uint8Array[];
  threshold?: number;
  heirSetVersion?: number;
  triggerAfterInactiveDays?: number;
  issuedAt?: number;
  signerOverride?: Keypair;
}) {
  const decl: InheritanceDeclaration = {
    username: USERNAME,
    heirIrkPub: args.heirPubs,
    threshold: args.threshold ?? 1,
    heirSetVersion: args.heirSetVersion ?? 1,
    triggerAfterInactiveDays: args.triggerAfterInactiveDays ?? 365,
    issuedAt: args.issuedAt ?? Date.now(),
  };
  const sig = signInheritanceDeclaration(decl, args.signerOverride ?? args.irk);
  return {
    declaration: {
      username: decl.username,
      heirIrkPub: decl.heirIrkPub.map(bytesToHex),
      threshold: decl.threshold,
      heirSetVersion: decl.heirSetVersion,
      triggerAfterInactiveDays: decl.triggerAfterInactiveDays,
      issuedAt: decl.issuedAt,
    },
    signature_hex: bytesToHex(sig),
  };
}

describe("InheritanceDeclaration envelope (separator rejection)", () => {
  it("rejects '|' in username at canonical-bytes time", () => {
    const irk = makeKey();
    const heir = makeKey();
    expect(() =>
      signInheritanceDeclaration(
        {
          username: "alice|attacker",
          heirIrkPub: [heir.publicKey],
          threshold: 1,
          heirSetVersion: 1,
          triggerAfterInactiveDays: 365,
          issuedAt: Date.now(),
        },
        irk,
      ),
    ).toThrow(/separator/);
  });

  it("rejects control chars in username", () => {
    const irk = makeKey();
    const heir = makeKey();
    expect(() =>
      signInheritanceDeclaration(
        {
          username: "alice\n",
          heirIrkPub: [heir.publicKey],
          threshold: 1,
          heirSetVersion: 1,
          triggerAfterInactiveDays: 365,
          issuedAt: Date.now(),
        },
        irk,
      ),
    ).toThrow(/control char/);
  });
});

describe("POST /api/inheritance", () => {
  it("stores a valid IRK-signed declaration", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const res = await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({ irk, heirPubs: [heir.publicKey] }),
    );
    expect(res.status).toBe(200);
    const stored = await storage.get(USERNAME);
    expect(stored?.heirIrkPubHex).toEqual([bytesToHex(heir.publicKey)]);
    expect(stored?.threshold).toBe(1);
  });

  it("rejects a signature by anyone other than the user's IRK", async () => {
    const irk = makeKey();
    const attacker = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const res = await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({ irk, heirPubs: [heir.publicKey], signerOverride: attacker }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a stale request", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const res = await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({ irk, heirPubs: [heir.publicKey], issuedAt: Date.now() - 60 * 60_000 }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects threshold > heir count", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const res = await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({ irk, heirPubs: [heir.publicKey], threshold: 2 }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an older heirSetVersion when a newer one is on record", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const heir2 = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    // First publish version=2 (with two heirs)
    await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({
        irk,
        heirPubs: [heir.publicKey, heir2.publicKey],
        threshold: 2,
        heirSetVersion: 2,
      }),
    );
    // Now try to publish version=1 (a replay) — must 409
    const res = await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({ irk, heirPubs: [heir.publicKey], heirSetVersion: 1 }),
    );
    expect(res.status).toBe(409);
  });

  it("default is OFF — no row exists until POST", async () => {
    const irk = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const res = await handleGetInheritanceDeclaration({ storage, usernames }, USERNAME);
    expect(res.status).toBe(404);
  });

  it("user can revoke by posting an empty heir list (heirSetVersion bumps)", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({ irk, heirPubs: [heir.publicKey], heirSetVersion: 1 }),
    );
    const res = await handlePutInheritanceDeclaration(
      { storage, usernames },
      makeBody({ irk, heirPubs: [], threshold: 1, heirSetVersion: 2 }),
    );
    expect(res.status).toBe(200);
    const stored = await storage.get(USERNAME);
    expect(stored?.heirIrkPubHex.length).toBe(0);
  });
});

describe("eligibleForTakeover (scheduled-job helper)", () => {
  it("returns nothing while the user is active", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    await handlePutInheritanceDeclaration(
      { storage, usernames, now: () => 1_700_000_000_000 },
      makeBody({ irk, heirPubs: [heir.publicKey], issuedAt: 1_700_000_000_000 }),
    );
    const list = await eligibleForTakeover({
      storage,
      usernames,
      now: () => 1_700_000_000_000 + 10_000,
    });
    expect(list.length).toBe(0);
  });

  it("returns the user after triggerAfterInactiveDays of silence", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const t0 = 1_700_000_000_000;
    await handlePutInheritanceDeclaration(
      { storage, usernames, now: () => t0 },
      makeBody({
        irk,
        heirPubs: [heir.publicKey],
        issuedAt: t0,
        triggerAfterInactiveDays: 30,
      }),
    );
    const longLater = t0 + 31 * 24 * 60 * 60_000;
    const list = await eligibleForTakeover({
      storage,
      usernames,
      now: () => longLater,
    });
    expect(list.length).toBe(1);
    expect(list[0]?.username).toBe(USERNAME);
    expect(list[0]?.bindsAt).toBeGreaterThan(list[0]!.eligibleAt);
    // 7-day notice window past eligibility
    expect(list[0]?.bindsAt).toBe(list[0]!.eligibleAt + 7 * 24 * 60 * 60_000);
  });

  it("recordSigningActivity resets the inactive timer", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const t0 = 1_700_000_000_000;
    await handlePutInheritanceDeclaration(
      { storage, usernames, now: () => t0 },
      makeBody({
        irk,
        heirPubs: [heir.publicKey],
        issuedAt: t0,
        triggerAfterInactiveDays: 30,
      }),
    );
    const sigTimeNearExpiry = t0 + 29 * 24 * 60 * 60_000;
    await storage.recordSigningActivity(USERNAME, sigTimeNearExpiry);
    const dayPastOriginalExpiry = t0 + 31 * 24 * 60 * 60_000;
    const list = await eligibleForTakeover({
      storage,
      usernames,
      now: () => dayPastOriginalExpiry,
    });
    expect(list.length).toBe(0);
  });

  it("an empty-heir-list declaration is never eligible (revoked state)", async () => {
    const irk = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const t0 = 1_700_000_000_000;
    await handlePutInheritanceDeclaration(
      { storage, usernames, now: () => t0 },
      makeBody({ irk, heirPubs: [], threshold: 1, issuedAt: t0, triggerAfterInactiveDays: 1 }),
    );
    const list = await eligibleForTakeover({
      storage,
      usernames,
      now: () => t0 + 30 * 24 * 60 * 60_000,
    });
    expect(list.length).toBe(0);
  });

  it("takeoverNoticeWindowEnd returns the bind moment for a given declaration", async () => {
    const irk = makeKey();
    const heir = makeKey();
    const usernames = await seedUsername(irk);
    const storage = new InMemoryInheritanceStorage();
    const t0 = 1_700_000_000_000;
    await handlePutInheritanceDeclaration(
      { storage, usernames, now: () => t0 },
      makeBody({
        irk,
        heirPubs: [heir.publicKey],
        issuedAt: t0,
        triggerAfterInactiveDays: 1,
      }),
    );
    const stored = await storage.get(USERNAME);
    const bind = takeoverNoticeWindowEnd(stored!);
    expect(bind).toBe(t0 + 1 * 24 * 60 * 60_000 + 7 * 24 * 60 * 60_000);
  });
});
