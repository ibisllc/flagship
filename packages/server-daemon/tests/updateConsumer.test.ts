/**
 * Box-side self-update consumer (docs/server-update-mechanism.md) — the 2-of-2
 * gate + replay gates + the staged apply, all against injected seams (command
 * runner / stores / fetch / clock): tests never touch a real box.
 *
 * Coverage (the security-critical set):
 *   1. forged / non-admin-signed order rejected WITHOUT any side effect
 *      (admin root pinned ⇒ an owner-IRK-signed order is REJECTED);
 *   2. unendorsed targetCommit rejected (admin-valid but the ReleaseGate
 *      fails) — no checkout, no marker, no exit;
 *   3. wrong serverDomain rejected;
 *   4. fromCommit != current HEAD rejected;
 *   5. nonce replay rejected (second delivery of a consumed nonce);
 *   6. stale issuedAt rejected;
 *   7. happy path: fetch + checkout + rebuild + pending marker + exit
 *      (legacy owner-IRK path with no admin root, AND the admin-root path);
 *   8. pending-verify marker present ⇒ the consumer never even fetches.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signUpdateOrder,
  type Keypair,
  type UpdateOrder,
} from "@flagship/protocol";
import {
  decodeUpdateOrderCarrier,
  runUpdateConsumer,
  type PendingVerifyMarker,
  type PendingVerifyStore,
  type RunUpdateConsumerOptions,
  type UpdateCommandRunner,
  type UsedNonceStore,
} from "../src/updateConsumer.js";
import type { ReleaseGate } from "../src/updateClient.js";

const DOMAIN = "home.alice.flagship.services";
const USERNAME = "alice";
const CURRENT = "1111111111111111111111111111111111111111";
const TARGET = "2222222222222222222222222222222222222222";
const NONCE = "00112233445566778899aabbccddeeff";
const NOW = 1_000_000_000;

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function utf8ToHex(s: string): string {
  return hex(new TextEncoder().encode(s));
}

const OWNER_IRK = makeKey(1);
const ADMIN_ROOT = makeKey(2);

function makeOrder(over: Partial<UpdateOrder> = {}): UpdateOrder {
  return {
    serverDomain: DOMAIN,
    targetCommit: TARGET,
    fromCommit: CURRENT,
    nonce: NONCE,
    issuedAt: NOW - 60_000,
    ...over,
  };
}

/** Build the `{sealed}` carrier hex exactly as `.com` stores + serves it. */
function carrierHex(order: UpdateOrder, signer: Keypair): string {
  return utf8ToHex(
    JSON.stringify({ order, signature: hex(signUpdateOrder(order, signer)) }),
  );
}

function fetchFor(sealed: string | null): typeof fetch {
  return (async (_url: string) => {
    if (sealed === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ sealed }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

interface RunnerSpy {
  calls: string[][];
  failOn?: string;
}
function makeRunner(spy: RunnerSpy): UpdateCommandRunner {
  return async (cmd, args) => {
    const call = [cmd, ...args];
    spy.calls.push(call);
    if (spy.failOn && call.join(" ").includes(spy.failOn)) {
      throw new Error(`injected failure on ${spy.failOn}`);
    }
    if (cmd === "git" && args.includes("rev-parse")) {
      return { stdout: `${CURRENT}\n` };
    }
    return { stdout: "" };
  };
}

function inMemNonces(preUsed: string[] = []): UsedNonceStore & { marked: string[] } {
  const used = new Set(preUsed);
  const store = {
    marked: [] as string[],
    async has(n: string) {
      return used.has(n.toLowerCase());
    },
    async mark(n: string) {
      used.add(n.toLowerCase());
      store.marked.push(n.toLowerCase());
    },
  };
  return store;
}

function inMemPending(
  initial: PendingVerifyMarker | null = null,
): PendingVerifyStore & { current: PendingVerifyMarker | null } {
  const store = {
    current: initial,
    async read() {
      return store.current;
    },
    async write(m: PendingVerifyMarker) {
      store.current = m;
    },
    async clear() {
      store.current = null;
    },
  };
  return store;
}

const passGate: ReleaseGate = { assertCommitEndorsed: () => {} };
const failGate: ReleaseGate = {
  assertCommitEndorsed: () => {
    throw new Error("not maintainer-endorsed");
  },
};

function baseOpts(over: Partial<RunUpdateConsumerOptions> = {}): {
  opts: RunUpdateConsumerOptions;
  runner: RunnerSpy;
  nonces: ReturnType<typeof inMemNonces>;
  pending: ReturnType<typeof inMemPending>;
  exits: { count: number };
} {
  const runner: RunnerSpy = { calls: [] };
  const nonces = inMemNonces();
  const pending = inMemPending();
  const exits = { count: 0 };
  const opts: RunUpdateConsumerOptions = {
    serverDomain: DOMAIN,
    ownerIrkPub: OWNER_IRK.publicKey,
    username: USERNAME,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    repoPath: "/opt/flagship",
    releaseGate: passGate,
    runner: makeRunner(runner),
    usedNonceStore: nonces,
    pendingStore: pending,
    requestExit: () => {
      exits.count++;
    },
    fetchImpl: fetchFor(carrierHex(makeOrder(), OWNER_IRK)),
    now: () => NOW,
    ...over,
  };
  return { opts, runner, nonces, pending, exits };
}

function calls(spy: RunnerSpy, verb: string): string[][] {
  return spy.calls.filter((c) => c.includes(verb));
}

describe("decodeUpdateOrderCarrier", () => {
  it("round-trips a good carrier", () => {
    const order = makeOrder();
    const { order: decoded, signature } = decodeUpdateOrderCarrier(
      carrierHex(order, ADMIN_ROOT),
    );
    expect(decoded).toEqual(order);
    expect(signature.length).toBe(64);
  });

  it("throws on junk hex / junk JSON / missing fields", () => {
    expect(() => decodeUpdateOrderCarrier("zz")).toThrow(/not valid hex/);
    expect(() => decodeUpdateOrderCarrier(utf8ToHex("{"))).toThrow(/not valid JSON/);
    expect(() => decodeUpdateOrderCarrier(utf8ToHex("{}"))).toThrow(/missing required/);
    expect(() =>
      decodeUpdateOrderCarrier(utf8ToHex(JSON.stringify({ order: makeOrder(), signature: "xx" }))),
    ).toThrow(/missing required/);
  });
});

describe("runUpdateConsumer — the 2-of-2 + replay gates", () => {
  // 1a. forged signature (random key) — rejected, no side effects.
  it("rejects a forged order without touching the box", async () => {
    const { opts, runner, pending, exits } = baseOpts({
      fetchImpl: fetchFor(carrierHex(makeOrder(), makeKey(9))),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "rejected" });
    expect(runner.calls).toEqual([]);
    expect(pending.current).toBeNull();
    expect(exits.count).toBe(0);
  });

  // 1b. admin root pinned ⇒ an owner-IRK-signed order is NOT admin authority.
  it("rejects an owner-IRK-signed order when an admin master root is pinned", async () => {
    const { opts, runner, pending, exits } = baseOpts({
      adminRootPub: ADMIN_ROOT.publicKey,
      fetchImpl: fetchFor(carrierHex(makeOrder(), OWNER_IRK)),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "rejected" });
    expect(runner.calls).toEqual([]);
    expect(pending.current).toBeNull();
    expect(exits.count).toBe(0);
  });

  // 2. admin-valid but unendorsed target — the AUTHENTICITY half must
  //    INDEPENDENTLY reject: no checkout, no marker, no exit.
  it("rejects an unendorsed targetCommit after a valid admin signature", async () => {
    const { opts, runner, pending, exits } = baseOpts({
      adminRootPub: ADMIN_ROOT.publicKey,
      releaseGate: failGate,
      fetchImpl: fetchFor(carrierHex(makeOrder(), ADMIN_ROOT)),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "unendorsed" });
    expect(calls(runner, "checkout")).toEqual([]);
    expect(pending.current).toBeNull();
    expect(exits.count).toBe(0);
  });

  // 3. wrong serverDomain.
  it("rejects an order naming a different box", async () => {
    const order = makeOrder({ serverDomain: "other.alice.flagship.services" });
    const { opts, runner, exits } = baseOpts({
      fetchImpl: fetchFor(carrierHex(order, OWNER_IRK)),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "wrong-domain" });
    expect(runner.calls).toEqual([]);
    expect(exits.count).toBe(0);
  });

  // 4. fromCommit mismatch (stale order for a different base).
  it("rejects an order whose fromCommit is not the current HEAD", async () => {
    const order = makeOrder({ fromCommit: "3333333333333333333333333333333333333333" });
    const { opts, runner, pending, exits } = baseOpts({
      fetchImpl: fetchFor(carrierHex(order, OWNER_IRK)),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "from-commit-mismatch" });
    // Only the read-only HEAD probe ran — no fetch/checkout/build.
    expect(calls(runner, "fetch")).toEqual([]);
    expect(calls(runner, "checkout")).toEqual([]);
    expect(pending.current).toBeNull();
    expect(exits.count).toBe(0);
  });

  // 5. nonce replay.
  it("rejects a second delivery of an already-consumed nonce", async () => {
    const { opts, runner, exits } = baseOpts({
      usedNonceStore: inMemNonces([NONCE]),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "replayed-nonce" });
    expect(calls(runner, "fetch")).toEqual([]);
    expect(exits.count).toBe(0);
  });

  // 6. stale issuedAt (outside the freshness window) + future-dated.
  it("rejects a stale or future-dated order", async () => {
    const stale = makeOrder({ issuedAt: NOW - 15 * 24 * 60 * 60_000 });
    const s = baseOpts({ fetchImpl: fetchFor(carrierHex(stale, OWNER_IRK)) });
    expect(await runUpdateConsumer(s.opts)).toEqual({ applied: false, reason: "stale" });
    expect(s.runner.calls).toEqual([]);

    const future = makeOrder({ issuedAt: NOW + 60 * 60_000 });
    const f = baseOpts({ fetchImpl: fetchFor(carrierHex(future, OWNER_IRK)) });
    expect(await runUpdateConsumer(f.opts)).toEqual({ applied: false, reason: "stale" });
  });

  // 7a. happy path — legacy owner-IRK (no admin root pinned).
  it("stages a valid owner-IRK-signed update (legacy path): fetch + checkout + rebuild + marker + exit", async () => {
    const { opts, runner, nonces, pending, exits } = baseOpts();
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: true, previousCommit: CURRENT, targetCommit: TARGET });
    expect(runner.calls).toEqual([
      ["git", "-C", "/opt/flagship", "rev-parse", "HEAD"],
      ["git", "-C", "/opt/flagship", "fetch"],
      ["git", "-C", "/opt/flagship", "checkout", TARGET],
      ["npm", "ci", "--no-audit", "--no-fund"],
      ["npx", "tsc", "-b"],
    ]);
    expect(nonces.marked).toEqual([NONCE]);
    expect(pending.current).toEqual({
      previousCommit: CURRENT,
      targetCommit: TARGET,
      bootAttempts: 0,
    });
    expect(exits.count).toBe(1);
  });

  // 7b. happy path — admin-root-signed with the root pinned.
  it("stages a valid admin-root-signed update when the admin root is pinned", async () => {
    const { opts, pending, exits } = baseOpts({
      adminRootPub: ADMIN_ROOT.publicKey,
      fetchImpl: fetchFor(carrierHex(makeOrder(), ADMIN_ROOT)),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: true, previousCommit: CURRENT, targetCommit: TARGET });
    expect(pending.current?.targetCommit).toBe(TARGET);
    expect(exits.count).toBe(1);
  });

  // 8. a staged update awaiting its boot verdict blocks new consumption.
  it("does nothing while a pending-verify marker exists", async () => {
    let fetched = 0;
    const { opts, runner } = baseOpts({
      pendingStore: inMemPending({
        previousCommit: CURRENT,
        targetCommit: TARGET,
        bootAttempts: 1,
      }),
      fetchImpl: (async () => {
        fetched++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "pending-verify" });
    expect(fetched).toBe(0);
    expect(runner.calls).toEqual([]);
  });

  it("no-ops on 404 (no order deposited)", async () => {
    const { opts, runner } = baseOpts({ fetchImpl: fetchFor(null) });
    expect(await runUpdateConsumer(opts)).toEqual({ applied: false, reason: "no-order" });
    expect(runner.calls).toEqual([]);
  });

  it("reverts the checkout when the rebuild fails (no marker, no exit)", async () => {
    const runnerSpy: RunnerSpy = { calls: [], failOn: "npm ci" };
    // npm install also fails so the rebuild genuinely fails; the revert's own
    // rebuild failing too must still leave us with no marker + no exit.
    runnerSpy.failOn = "npm";
    const { opts, pending, exits } = baseOpts({ runner: makeRunner(runnerSpy) });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "apply-failed" });
    // The revert checkout back to CURRENT ran after the failed rebuild.
    expect(calls(runnerSpy, "checkout").map((c) => c[c.length - 1])).toEqual([
      TARGET,
      CURRENT,
    ]);
    expect(pending.current).toBeNull();
    expect(exits.count).toBe(0);
  });
});
