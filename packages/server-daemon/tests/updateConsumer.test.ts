/**
 * Box-side self-update consumer (docs/server-update-mechanism.md) — the 2-of-2
 * gate + replay gates + the staged apply, all against injected seams (command
 * runner / stores / fetch / clock): tests never touch a real box.
 *
 * Coverage (the security-critical set):
 *   1. forged / non-admin-signed order rejected WITHOUT any side effect
 *      (admin root pinned ⇒ an owner-IRK-signed order is REJECTED);
 *   2. unsigned/refused release rejected (admin-valid but the release
 *      verifier refuses it) — no switch, no marker, no exit;
 *   3. wrong serverDomain rejected;
 *   4. fromCommit != current HEAD rejected;
 *   5. nonce replay rejected (second delivery of a consumed nonce);
 *   6. stale issuedAt rejected;
 *   7. happy path: download + verify + switch release + pending marker + exit
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
  buildCurrentCommitProvider,
  buildUpdateConsumerPoller,
  decodeUpdateOrderCarrier,
  runUpdateConsumer,
  type PendingVerifyMarker,
  type PendingVerifyStore,
  type RunUpdateConsumerOptions,
  type UsedNonceStore,
} from "../src/updateConsumer.js";
import { ArtifactRefusedError, type ReleaseSwapper } from "../src/artifactUpdate.js";
import type { UpdateOutcomeRecord, UpdateOutcomeStore } from "../src/updateOutcome.js";

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

interface SwapSpy {
  calls: string[];
  install?: "refused" | "error";
  restoreFails?: boolean;
}
function makeSwapper(spy: SwapSpy): ReleaseSwapper {
  return {
    async install(commit) {
      spy.calls.push(`install ${commit}`);
      if (spy.install === "refused") throw new ArtifactRefusedError("not signed by enough release keys");
      if (spy.install === "error") throw new Error("injected install failure");
    },
    async restore(commit) {
      spy.calls.push(`restore ${commit}`);
      if (spy.restoreFails) throw new Error("injected restore failure");
    },
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

function baseOpts(over: Partial<RunUpdateConsumerOptions> = {}): {
  opts: RunUpdateConsumerOptions;
  runner: SwapSpy;
  nonces: ReturnType<typeof inMemNonces>;
  pending: ReturnType<typeof inMemPending>;
  exits: { count: number };
} {
  const runner: SwapSpy = { calls: [] };
  const nonces = inMemNonces();
  const pending = inMemPending();
  const exits = { count: 0 };
  const opts: RunUpdateConsumerOptions = {
    serverDomain: DOMAIN,
    ownerIrkPub: OWNER_IRK.publicKey,
    username: USERNAME,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    swapper: makeSwapper(runner),
    currentCommit: () => CURRENT,
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

function calls(spy: SwapSpy, verb: string): string[] {
  return spy.calls.filter((c) => c.startsWith(verb));
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
      swapper: makeSwapper({ calls: [], install: "refused" }),
      fetchImpl: fetchFor(carrierHex(makeOrder(), ADMIN_ROOT)),
    });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "unendorsed" });
    expect(runner.calls).toEqual([]);
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
    // Nothing was downloaded, installed or switched.
    expect(runner.calls).toEqual([]);
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
    expect(runner.calls).toEqual([]);
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
  it("stages a valid owner-IRK-signed update (legacy path): install the signed release + marker + exit", async () => {
    const { opts, runner, nonces, pending, exits } = baseOpts();
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: true, previousCommit: CURRENT, targetCommit: TARGET });
    expect(runner.calls).toEqual([`install ${TARGET}`]);
    expect(nonces.marked).toEqual([NONCE]);
    expect(pending.current).toEqual({
      previousCommit: CURRENT,
      targetCommit: TARGET,
      bootAttempts: 0,
      stage: "staged",
    });
    expect(exits.count).toBe(1);
  });

  it("refuses to update a box that was not installed from a signed release", async () => {
    const { opts, runner, pending, exits } = baseOpts({ currentCommit: () => null });
    expect(await runUpdateConsumer(opts)).toEqual({ applied: false, reason: "error" });
    expect(runner.calls).toEqual([]);
    expect(pending.current).toBeNull();
    expect(exits.count).toBe(0);
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

  it("marks the update applying before it switches releases", async () => {
    const seen: Array<PendingVerifyMarker | null> = [];
    const { opts, pending } = baseOpts();
    opts.swapper = {
      async install() {
        seen.push(pending.current && { ...pending.current });
      },
      async restore() {},
    };
    await runUpdateConsumer(opts);
    expect(seen).toEqual([
      { previousCommit: CURRENT, targetCommit: TARGET, bootAttempts: 0, stage: "applying" },
    ]);
  });

  it("switches back to the running release when the install fails, then clears the marker", async () => {
    const spy: SwapSpy = { calls: [], install: "error" };
    const { opts, pending, exits } = baseOpts({ swapper: makeSwapper(spy) });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "apply-failed" });
    expect(spy.calls).toEqual([`install ${TARGET}`, `restore ${CURRENT}`]);
    expect(pending.current).toBeNull();
    expect(exits.count).toBe(0);
  });

  it("leaves the applying marker when the switch back fails too, so the next start rolls back", async () => {
    const spy: SwapSpy = { calls: [], install: "error", restoreFails: true };
    const { opts, pending, exits } = baseOpts({ swapper: makeSwapper(spy) });
    const out = await runUpdateConsumer(opts);
    expect(out).toEqual({ applied: false, reason: "apply-failed" });
    expect(pending.current).toEqual({
      previousCommit: CURRENT,
      targetCommit: TARGET,
      bootAttempts: 0,
      stage: "applying",
    });
    expect(exits.count).toBe(0);
  });

  it("clears the marker and changes nothing when the verifier refuses the release", async () => {
    const spy: SwapSpy = { calls: [], install: "refused" };
    const { opts, pending, exits } = baseOpts({ swapper: makeSwapper(spy) });
    expect(await runUpdateConsumer(opts)).toEqual({ applied: false, reason: "unendorsed" });
    expect(pending.current).toBeNull();
    expect(spy.calls).toEqual([`install ${TARGET}`]);
    expect(exits.count).toBe(0);
  });
});

describe("buildCurrentCommitProvider — the BFF's applied-commit truth", () => {
  const HEAD = "9f2c1ab3de4567890abcdef1234567890abcdef1";

  it("reads the installed release once and caches it (one read per process)", () => {
    let reads = 0;
    const provider = buildCurrentCommitProvider("/state", (dir) => {
      reads++;
      expect(dir).toBe("/state");
      return { commit: HEAD };
    });
    expect(provider()).toBe(HEAD);
    expect(provider()).toBe(HEAD);
    expect(reads).toBe(1);
  });

  it("returns null (and caches it) when there is no release record", () => {
    let reads = 0;
    const provider = buildCurrentCommitProvider("/state", () => {
      reads++;
      return null;
    });
    expect(provider()).toBeNull();
    expect(provider()).toBeNull();
    expect(reads).toBe(1);
  });

  it("returns null when the read throws", () => {
    const provider = buildCurrentCommitProvider("/state", () => {
      throw new Error("unreadable");
    });
    expect(provider()).toBeNull();
  });
});

describe("buildUpdateConsumerPoller — records refusals the owner should see", () => {
  function memOutcomes(): UpdateOutcomeStore & { written: UpdateOutcomeRecord[] } {
    const store = {
      written: [] as UpdateOutcomeRecord[],
      async write(r: UpdateOutcomeRecord) {
        store.written.push(r);
      },
      readSync: () => store.written.at(-1) ?? null,
    };
    return store;
  }

  it("records an unendorsed refusal", async () => {
    const outcomes = memOutcomes();
    const { opts } = baseOpts({
      adminRootPub: ADMIN_ROOT.publicKey,
      swapper: makeSwapper({ calls: [], install: "refused" }),
      fetchImpl: fetchFor(carrierHex(makeOrder(), ADMIN_ROOT)),
    });
    const out = await buildUpdateConsumerPoller({ ...opts, outcomeStore: outcomes }).pollOnce();
    expect(out).toEqual({ applied: false, reason: "unendorsed" });
    expect(outcomes.written).toEqual([{ outcome: "refused", reason: "unendorsed", at: NOW }]);
  });

  it("records nothing when there is no order or the nonce was already used", async () => {
    const outcomes = memOutcomes();
    const noOrder = baseOpts({
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    await buildUpdateConsumerPoller({ ...noOrder.opts, outcomeStore: outcomes }).pollOnce();
    const order = makeOrder();
    const replay = baseOpts({
      adminRootPub: ADMIN_ROOT.publicKey,
      fetchImpl: fetchFor(carrierHex(order, ADMIN_ROOT)),
      usedNonceStore: inMemNonces([order.nonce]),
    });
    const out = await buildUpdateConsumerPoller({ ...replay.opts, outcomeStore: outcomes }).pollOnce();
    expect(out).toEqual({ applied: false, reason: "replayed-nonce" });
    expect(outcomes.written).toEqual([]);
  });
});
