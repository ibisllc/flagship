/**
 * Unit tests for the watch-delegate handlers (Phase 2b).
 *
 * Mirrors deviceCapabilityGrants.test.ts: pure handlers over InMemory
 * storage, no network. Covered:
 *   - mint round-trip → list shows the delegate
 *   - re-mint REVOKES the prior active delegate (one-active-per-user)
 *   - bad signature → 403; unknown user → 404; expired → 400; bad scopes → 400
 *   - revoke → list excludes; revoke is idempotent
 *   - requireBootApprovalDelegate: happy path + every deny branch
 *     (no delegate, user mismatch, expired, wrong scope, IRK-rotation
 *      invalidates via stored-envelope re-verify)
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signWatchDelegateKey,
  signRevokeWatchDelegate,
  type WatchDelegateKey,
  type DelegateScope,
  type Keypair,
  type RevokeWatchDelegate,
} from "@flagship/protocol";
import {
  InMemoryWatchDelegateStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleMintWatchDelegate,
  handleListWatchDelegates,
  handleRevokeWatchDelegate,
  requireBootApprovalDelegate,
  type WatchDelegatesDeps,
} from "../src/watchDelegates.js";

const USER = "dani";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

interface Harness {
  deps: WatchDelegatesDeps;
  usernames: InMemoryUsernameStorage;
  storage: InMemoryWatchDelegateStorage;
  userIrk: Keypair;
  clock: { now: number };
}

async function mkHarness(): Promise<Harness> {
  const userIrk = makeKey();
  const usernames = new InMemoryUsernameStorage();
  await usernames.put({
    username: USER,
    irkPubHex: hex(userIrk.publicKey),
    claimedAt: 1,
  });
  const storage = new InMemoryWatchDelegateStorage();
  const clock = { now: 1_000_000 };
  const deps: WatchDelegatesDeps = { storage, usernames, now: () => clock.now };
  return { deps, usernames, storage, userIrk, clock };
}

function mintDelegate(args: {
  userIrk: Keypair;
  username?: string;
  delegatePub?: Uint8Array;
  scopes?: DelegateScope[];
  issuedAt?: number;
  expiresAt?: number;
  grantId?: string;
}): {
  body: {
    grant: {
      grantId: string;
      username: string;
      delegatePubKey: string;
      scopes: DelegateScope[];
      issuedAt: number;
      expiresAt: number;
    };
    signature: string;
  };
  grant: WatchDelegateKey;
  signature: Uint8Array;
} {
  const delegatePub = args.delegatePub ?? makeKey().publicKey;
  const scopes = args.scopes ?? ["boot-approval"];
  const issuedAt = args.issuedAt ?? 1_000_000;
  const expiresAt = args.expiresAt ?? issuedAt + 7 * 24 * 3_600_000;
  const grantId = args.grantId ?? "wd-uuid-1";
  const grant: WatchDelegateKey = {
    grantId,
    username: args.username ?? USER,
    delegatePubKey: delegatePub,
    scopes,
    issuedAt,
    expiresAt,
  };
  const signature = signWatchDelegateKey(grant, args.userIrk);
  return {
    body: {
      grant: {
        grantId,
        username: grant.username,
        delegatePubKey: hex(delegatePub),
        scopes,
        issuedAt,
        expiresAt,
      },
      signature: hex(signature),
    },
    grant,
    signature,
  };
}

describe("handleMintWatchDelegate", () => {
  it("mints a delegate → list shows it", async () => {
    const h = await mkHarness();
    const { body } = mintDelegate({ userIrk: h.userIrk });
    const res = await handleMintWatchDelegate(h.deps, body);
    expect(res.status).toBe(200);
    expect((res.body as { grantId: string }).grantId).toBe("wd-uuid-1");

    const listed = await handleListWatchDelegates(h.deps, USER);
    expect((listed.body as { delegates: unknown[] }).delegates.length).toBe(1);
  });

  it("re-minting revokes the prior active delegate (one active per user)", async () => {
    const h = await mkHarness();
    await handleMintWatchDelegate(
      h.deps,
      mintDelegate({ userIrk: h.userIrk, grantId: "wd-1" }).body,
    );
    const second = await handleMintWatchDelegate(
      h.deps,
      mintDelegate({ userIrk: h.userIrk, grantId: "wd-2" }).body,
    );
    expect(second.status).toBe(200);
    expect((second.body as { replacedGrantId?: string }).replacedGrantId).toBe(
      "wd-1",
    );

    const listed = await handleListWatchDelegates(h.deps, USER);
    const delegates = (listed.body as { delegates: { grantId: string }[] })
      .delegates;
    expect(delegates.length).toBe(1);
    expect(delegates[0]?.grantId).toBe("wd-2");
  });

  it("rejects a bad signature with 403", async () => {
    const h = await mkHarness();
    const { body } = mintDelegate({ userIrk: h.userIrk });
    body.signature = hex(new Uint8Array(64)); // all-zero sig
    const res = await handleMintWatchDelegate(h.deps, body);
    expect(res.status).toBe(403);
  });

  it("rejects an unknown user with 404", async () => {
    const h = await mkHarness();
    const { body } = mintDelegate({ userIrk: h.userIrk, username: "nobody" });
    const res = await handleMintWatchDelegate(h.deps, body);
    expect(res.status).toBe(404);
  });

  it("rejects an already-expired delegate with 400", async () => {
    const h = await mkHarness();
    const { body } = mintDelegate({
      userIrk: h.userIrk,
      issuedAt: 1,
      expiresAt: 2,
    });
    const res = await handleMintWatchDelegate(h.deps, body);
    expect(res.status).toBe(400);
  });

  it("rejects scopes outside the v1 boot-approval set with 400", async () => {
    const h = await mkHarness();
    const { body } = mintDelegate({ userIrk: h.userIrk });
    // Tamper the wire scopes AFTER signing — the cloud's parseDelegateScopes
    // rejects it before the signature is even checked.
    (body.grant.scopes as unknown as string[]) = ["install-service"];
    const res = await handleMintWatchDelegate(h.deps, body);
    expect(res.status).toBe(400);
  });
});

describe("handleListWatchDelegates", () => {
  it("excludes an active row that no longer verifies under the current IRK", async () => {
    // Models post-IRK-rotation: an active delegate signed by a superseded
    // IRK must not appear in the authoritative list.
    const h = await mkHarness();
    const good = mintDelegate({ userIrk: h.userIrk, grantId: "wd-good" });
    await handleMintWatchDelegate(h.deps, good.body);

    // The unique-active index allows only one un-revoked row, so revoke the
    // good one first, then inject a rogue-signed active row in its place.
    await h.storage.revoke("wd-good", 1_000_400);
    const rogue = makeKey();
    const delegate = makeKey();
    const grant: WatchDelegateKey = {
      grantId: "wd-rogue",
      username: USER,
      delegatePubKey: delegate.publicKey,
      scopes: ["boot-approval"],
      issuedAt: 1_000_000,
      expiresAt: 1_000_000 + 7 * 24 * 3_600_000,
    };
    await h.storage.put({
      grantId: grant.grantId,
      username: USER,
      delegatePubHex: hex(delegate.publicKey),
      scopesJson: JSON.stringify(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: hex(signWatchDelegateKey(grant, rogue)),
      revokedAt: null,
    });

    const listed = await handleListWatchDelegates(h.deps, USER);
    expect((listed.body as { delegates: unknown[] }).delegates.length).toBe(0);
  });
});

describe("handleRevokeWatchDelegate", () => {
  it("revokes → list excludes; revoke is idempotent", async () => {
    const h = await mkHarness();
    const minted = mintDelegate({ userIrk: h.userIrk });
    await handleMintWatchDelegate(h.deps, minted.body);

    const revoke: RevokeWatchDelegate = {
      grantId: minted.grant.grantId,
      username: USER,
      issuedAt: 1_000_500,
    };
    const sig = signRevokeWatchDelegate(revoke, h.userIrk);
    const res = await handleRevokeWatchDelegate(h.deps, {
      request: revoke,
      signature: hex(sig),
    });
    expect(res.status).toBe(200);

    const listed = await handleListWatchDelegates(h.deps, USER);
    expect((listed.body as { delegates: unknown[] }).delegates.length).toBe(0);

    // Idempotent: a second revoke returns the existing tombstone, still 200.
    const again = await handleRevokeWatchDelegate(h.deps, {
      request: revoke,
      signature: hex(sig),
    });
    expect(again.status).toBe(200);
  });

  it("rejects revoke for an unknown grantId with 404", async () => {
    const h = await mkHarness();
    const revoke: RevokeWatchDelegate = {
      grantId: "does-not-exist",
      username: USER,
      issuedAt: 1_000_500,
    };
    const sig = signRevokeWatchDelegate(revoke, h.userIrk);
    const res = await handleRevokeWatchDelegate(h.deps, {
      request: revoke,
      signature: hex(sig),
    });
    expect(res.status).toBe(404);
  });
});

describe("requireBootApprovalDelegate", () => {
  it("allows an active, in-scope, unexpired delegate", async () => {
    const h = await mkHarness();
    const delegate = makeKey();
    await handleMintWatchDelegate(
      h.deps,
      mintDelegate({ userIrk: h.userIrk, delegatePub: delegate.publicKey }).body,
    );
    const check = await requireBootApprovalDelegate(h.deps, {
      delegatePubHex: hex(delegate.publicKey),
      username: USER,
    });
    expect(check.ok).toBe(true);
  });

  it("denies an unknown delegate pubkey", async () => {
    const h = await mkHarness();
    const check = await requireBootApprovalDelegate(h.deps, {
      delegatePubHex: hex(makeKey().publicKey),
      username: USER,
    });
    expect(check).toEqual({ ok: false, reason: "no active delegate" });
  });

  it("denies a delegate registered to a different user", async () => {
    const h = await mkHarness();
    const delegate = makeKey();
    await handleMintWatchDelegate(
      h.deps,
      mintDelegate({ userIrk: h.userIrk, delegatePub: delegate.publicKey }).body,
    );
    const check = await requireBootApprovalDelegate(h.deps, {
      delegatePubHex: hex(delegate.publicKey),
      username: "someone-else",
    });
    expect(check).toEqual({ ok: false, reason: "user mismatch" });
  });

  it("denies an expired delegate", async () => {
    const h = await mkHarness();
    const delegate = makeKey();
    await handleMintWatchDelegate(
      h.deps,
      mintDelegate({
        userIrk: h.userIrk,
        delegatePub: delegate.publicKey,
        issuedAt: 1_000_000,
        expiresAt: 1_000_010,
      }).body,
    );
    h.clock.now = 2_000_000; // now well past expiry
    const check = await requireBootApprovalDelegate(h.deps, {
      delegatePubHex: hex(delegate.publicKey),
      username: USER,
    });
    expect(check).toEqual({ ok: false, reason: "delegate expired" });
  });

  it("denies a stored envelope that does not verify under the user's IRK", async () => {
    // Models the post-IRK-rotation state (Replace-device / Wipe): a delegate
    // signed under a now-superseded IRK survives as an active row but no
    // longer verifies under the user's CURRENT IRK. We construct that state
    // directly by storing a delegate signed with a ROGUE key.
    const h = await mkHarness();
    const delegate = makeKey();
    const rogue = makeKey();
    const grant: WatchDelegateKey = {
      grantId: "wd-rogue",
      username: USER,
      delegatePubKey: delegate.publicKey,
      scopes: ["boot-approval"],
      issuedAt: 1_000_000,
      expiresAt: 1_000_000 + 7 * 24 * 3_600_000,
    };
    const rogueSig = signWatchDelegateKey(grant, rogue); // NOT the user's IRK
    await h.storage.put({
      grantId: grant.grantId,
      username: USER,
      delegatePubHex: hex(delegate.publicKey),
      scopesJson: JSON.stringify(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: hex(rogueSig),
      revokedAt: null,
    });
    const check = await requireBootApprovalDelegate(h.deps, {
      delegatePubHex: hex(delegate.publicKey),
      username: USER,
    });
    expect(check).toEqual({ ok: false, reason: "delegate signature invalid" });
  });

  it("denies a delegate whose stored scope lacks boot-approval", async () => {
    const h = await mkHarness();
    const delegate = makeKey();
    // Inject a record directly with an off-spec scope to exercise the scope
    // branch (the mint path can't produce one — parseDelegateScopes blocks it).
    await h.storage.put({
      grantId: "wd-offscope",
      username: USER,
      delegatePubHex: hex(delegate.publicKey),
      scopesJson: JSON.stringify(["something-else"]),
      issuedAt: 1_000_000,
      expiresAt: 1_000_000 + 7 * 24 * 3_600_000,
      signatureHex: hex(new Uint8Array(64)),
      revokedAt: null,
    });
    const check = await requireBootApprovalDelegate(h.deps, {
      delegatePubHex: hex(delegate.publicKey),
      username: USER,
    });
    expect(check).toEqual({ ok: false, reason: "scope not authorized" });
  });
});
