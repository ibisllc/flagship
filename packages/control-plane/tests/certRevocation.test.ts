/**
 * Unit tests for the per-box cert routing-revocation handlers
 * (per-user-cert design §5.1–5.2, task #27).
 *
 * Pure handlers over InMemory username storage + an injectable in-deps
 * debounce Map; no network, real sign/verify. Covered:
 *   - hardRevokeSteps() is the exact §5.2 ordered array
 *   - SOFT requires wiped=true (un-wiped → 400 + useHardRevoke)
 *   - SOFT with wiped=true → ok, action "decommissioned", NO re-mint
 *   - HARD → ok with the ordered steps + records the debounce timestamp
 *   - HARD debounce: a rapid second hard revoke → 429 (no second re-mint);
 *     a third past the window is allowed again
 *   - bad signature → 403 (soft + hard); unknown user → 404; malformed → 400
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signCertSoftRevoke,
  signCertHardRevoke,
  type CertSoftRevoke,
  type CertHardRevoke,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryUsernameStorage } from "@flagship/storage";
import {
  hardRevokeSteps,
  handleSoftRevoke,
  handleHardRevoke,
  type CertRevocationDeps,
} from "../src/certRevocation.js";

const USER = "dani";
const DOMAIN = "nas.dani.flagship.services";

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
  deps: CertRevocationDeps;
  usernames: InMemoryUsernameStorage;
  userIrk: Keypair;
  lastHardRevokeAt: Map<string, number>;
  clock: { now: number };
}

async function mkHarness(debounceMs?: number): Promise<Harness> {
  const userIrk = makeKey();
  const usernames = new InMemoryUsernameStorage();
  await usernames.put({
    username: USER,
    irkPubHex: hex(userIrk.publicKey),
    claimedAt: 1,
  });
  const lastHardRevokeAt = new Map<string, number>();
  const clock = { now: 1_000_000 };
  const deps: CertRevocationDeps = {
    usernames,
    lastHardRevokeAt,
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    now: () => clock.now,
  };
  return { deps, usernames, userIrk, lastHardRevokeAt, clock };
}

function softBody(args: {
  userIrk: Keypair;
  username?: string;
  serverDomain?: string;
  wiped: boolean;
  issuedAt?: number;
}) {
  const username = args.username ?? USER;
  const serverDomain = args.serverDomain ?? DOMAIN;
  const issuedAt = args.issuedAt ?? 1_000_000;
  const env: CertSoftRevoke = {
    username,
    serverDomain,
    wiped: args.wiped,
    issuedAt,
  };
  const sig = signCertSoftRevoke(env, args.userIrk);
  return { username, serverDomain, wiped: args.wiped, issuedAt, signature: hex(sig) };
}

function hardBody(args: {
  userIrk: Keypair;
  username?: string;
  serverDomain?: string;
  issuedAt?: number;
}) {
  const username = args.username ?? USER;
  const serverDomain = args.serverDomain ?? DOMAIN;
  const issuedAt = args.issuedAt ?? 1_000_000;
  const env: CertHardRevoke = { username, serverDomain, issuedAt };
  const sig = signCertHardRevoke(env, args.userIrk);
  return { username, serverDomain, issuedAt, signature: hex(sig) };
}

describe("hardRevokeSteps", () => {
  it("is the exact §5.2 ordered sequence", () => {
    expect(hardRevokeSteps()).toEqual([
      "routing-revoke",
      "delegation-revoke",
      "eject-from-recipient-set",
      "re-mint",
      "ca-revoke",
    ]);
  });

  it("returns a fresh array each call (no shared mutable state)", () => {
    const a = hardRevokeSteps();
    a.push("tampered");
    expect(hardRevokeSteps()).toHaveLength(5);
  });
});

describe("handleSoftRevoke", () => {
  it("refuses an un-wiped box with a 400 + useHardRevoke hint", async () => {
    const h = await mkHarness();
    const res = await handleSoftRevoke(
      h.deps,
      softBody({ userIrk: h.userIrk, wiped: false }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ useHardRevoke: true });
  });

  it("decommissions a wiped box with NO re-mint", async () => {
    const h = await mkHarness();
    const res = await handleSoftRevoke(
      h.deps,
      softBody({ userIrk: h.userIrk, wiped: true }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      action: "decommissioned",
      reMint: false,
    });
  });

  it("rejects a bad signature with 403", async () => {
    const h = await mkHarness();
    const body = softBody({ userIrk: h.userIrk, wiped: true });
    body.signature = hex(new Uint8Array(64)); // all-zero sig never verifies
    const res = await handleSoftRevoke(h.deps, body);
    expect(res.status).toBe(403);
  });

  it("rejects a signature from a non-account key with 403", async () => {
    const h = await mkHarness();
    const attacker = makeKey();
    const body = softBody({ userIrk: attacker, wiped: true });
    const res = await handleSoftRevoke(h.deps, body);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown user", async () => {
    const h = await mkHarness();
    const res = await handleSoftRevoke(
      h.deps,
      softBody({ userIrk: h.userIrk, username: "nobody", wiped: true }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed body", async () => {
    const h = await mkHarness();
    const res = await handleSoftRevoke(h.deps, { username: USER } as never);
    expect(res.status).toBe(400);
  });
});

describe("handleHardRevoke", () => {
  it("returns ok with the ordered steps and records the debounce stamp", async () => {
    const h = await mkHarness();
    const res = await handleHardRevoke(h.deps, hardBody({ userIrk: h.userIrk }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      action: "hard-revoked",
      steps: hardRevokeSteps(),
    });
    expect(h.lastHardRevokeAt.get(USER)).toBe(h.clock.now);
  });

  it("debounces a rapid second hard revoke with 429", async () => {
    const h = await mkHarness();
    const first = await handleHardRevoke(h.deps, hardBody({ userIrk: h.userIrk }));
    expect(first.status).toBe(200);

    h.clock.now += 5_000; // well inside the 60s default window
    const second = await handleHardRevoke(
      h.deps,
      hardBody({ userIrk: h.userIrk, issuedAt: h.clock.now }),
    );
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ error: "hard revoke debounced" });
  });

  it("allows a hard revoke again once the debounce window has passed", async () => {
    const h = await mkHarness();
    await handleHardRevoke(h.deps, hardBody({ userIrk: h.userIrk }));

    h.clock.now += 60_001; // just past the default window
    const again = await handleHardRevoke(
      h.deps,
      hardBody({ userIrk: h.userIrk, issuedAt: h.clock.now }),
    );
    expect(again.status).toBe(200);
    expect(h.lastHardRevokeAt.get(USER)).toBe(h.clock.now);
  });

  it("honors a custom debounceMs", async () => {
    const h = await mkHarness(10_000);
    await handleHardRevoke(h.deps, hardBody({ userIrk: h.userIrk }));

    h.clock.now += 9_000;
    const blocked = await handleHardRevoke(
      h.deps,
      hardBody({ userIrk: h.userIrk, issuedAt: h.clock.now }),
    );
    expect(blocked.status).toBe(429);

    h.clock.now += 2_000; // now 11s after the first → past the 10s window
    const allowed = await handleHardRevoke(
      h.deps,
      hardBody({ userIrk: h.userIrk, issuedAt: h.clock.now }),
    );
    expect(allowed.status).toBe(200);
  });

  it("does NOT record a debounce stamp when the signature is bad", async () => {
    const h = await mkHarness();
    const body = hardBody({ userIrk: h.userIrk });
    body.signature = hex(new Uint8Array(64));
    const res = await handleHardRevoke(h.deps, body);
    expect(res.status).toBe(403);
    // An unauthenticated request must not touch (or probe) the debounce state.
    expect(h.lastHardRevokeAt.has(USER)).toBe(false);
  });

  it("rejects a signature from a non-account key with 403", async () => {
    const h = await mkHarness();
    const attacker = makeKey();
    const res = await handleHardRevoke(h.deps, hardBody({ userIrk: attacker }));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown user", async () => {
    const h = await mkHarness();
    const res = await handleHardRevoke(
      h.deps,
      hardBody({ userIrk: h.userIrk, username: "nobody" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed body", async () => {
    const h = await mkHarness();
    const res = await handleHardRevoke(h.deps, { serverDomain: DOMAIN } as never);
    expect(res.status).toBe(400);
  });
});
