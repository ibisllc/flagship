/**
 * Box-side graceful-decommission consumer
 * (docs/server-replacement-graceful-decommission.md §10 + §9).
 *
 * The daemon polls its OWN eviction order; when `.com` has deposited an
 * owner-IRK-signed ServerDecommission order naming THIS instance's STK, it
 * re-verifies under the config-pinned owner IRK (I1), gates on the STK (I2), then
 * runs the closeout: optional final-backup flush + epoch-complete report (§9),
 * release routing, apply the signed disk disposition, mark, ack, power off.
 *
 * These tests cover the 10-case set:
 *   1. valid + STK-match proceeds (keep);
 *   2. wrong-STK order ignored (no action);
 *   3. forged signature rejected (no action);
 *   4. wrong-account order rejected (no action);
 *   5. 404 (no order) no-op;
 *   6. marker-exists no-op (idempotent);
 *   7. finalBackup:yes → flush + epoch-complete report;
 *      finalBackup:no  → skip flush + report;
 *   8. keep → lockAndPower, NO wipe;
 *   9. wipe-now → wipe + power;
 *  10. wipe-after-handoff: confirm-arrives → wipe + power;
 *      AND timeout → power WITHOUT wiping (the fail-safe).
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signServerDecommission,
  type Keypair,
  type ServerDecommission,
} from "@flagship/protocol";
import {
  runDecommissionConsumer,
  decodeAndVerifyDecommissionOrder,
  type DecommissionMarkerStore,
  type RunDecommissionOptions,
} from "../src/decommissionConsumer.js";

const DOMAIN = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const MY_STK = makeKey(9);
const MY_STK_HEX = hex(MY_STK.publicKey);
const NONCE = hex(new Uint8Array(32).fill(0xab));

function makeOrder(over: Partial<ServerDecommission> = {}): ServerDecommission {
  return {
    podCanonical: DOMAIN,
    retiredStkPubHex: MY_STK_HEX,
    finalBackup: false,
    diskDisposition: "keep",
    backupEpoch: 0,
    nonce: NONCE,
    issuedAt: 1_000,
    ...over,
  };
}

/** Build the `{orderJson, orderSignatureHex}` carrier as `.com` serves it. */
function carrier(order: ServerDecommission, irk: Keypair) {
  return {
    orderJson: JSON.stringify(order),
    orderSignatureHex: hex(signServerDecommission(order, irk)),
  };
}

/** A fetch that returns the order on GET decommission, 404 if null, and 200 to POSTs. */
function fetchFor(
  body: { orderJson: string; orderSignatureHex: string } | null,
  opts?: { posts?: string[]; evictionChain?: unknown },
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "POST") {
      opts?.posts?.push(u);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes("/eviction-chain")) {
      return new Response(JSON.stringify(opts?.evictionChain ?? { evictions: [] }), { status: 200 });
    }
    // GET decommission
    if (body === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function inMemMarker(): DecommissionMarkerStore & { marked: boolean } {
  const m = {
    marked: false,
    async has() {
      return m.marked;
    },
    async mark() {
      m.marked = true;
    },
  };
  return m;
}

interface Spy {
  flushes: number[];
  released: number;
  wipes: number;
  powers: number;
}

function baseOpts(
  over: Partial<RunDecommissionOptions> & {
    fetchImpl: typeof fetch;
    ownerIrkPub: Uint8Array;
  },
): { opts: RunDecommissionOptions; spy: Spy; marker: ReturnType<typeof inMemMarker> } {
  const spy: Spy = { flushes: [], released: 0, wipes: 0, powers: 0 };
  const marker = inMemMarker();
  const opts: RunDecommissionOptions = {
    serverDomain: DOMAIN,
    myStkHex: MY_STK_HEX,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    backupFlush: async (epoch) => {
      spy.flushes.push(epoch);
    },
    releaseRouting: async () => {
      spy.released++;
    },
    wipeContent: async () => {
      spy.wipes++;
    },
    lockAndPower: async () => {
      spy.powers++;
    },
    markerStore: marker,
    ...over,
  };
  return { opts, spy, marker };
}

describe("decodeAndVerifyDecommissionOrder", () => {
  it("returns the verified order for a good carrier", () => {
    const irk = makeKey(1);
    const c = carrier(makeOrder(), irk);
    const order = decodeAndVerifyDecommissionOrder({ ...c, ownerIrkPub: irk.publicKey });
    expect(order.podCanonical).toBe(DOMAIN);
    expect(order.retiredStkPubHex).toBe(MY_STK_HEX);
  });

  it("throws on a wrong-owner signature", () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const c = carrier(makeOrder(), wrong);
    expect(() => decodeAndVerifyDecommissionOrder({ ...c, ownerIrkPub: irk.publicKey })).toThrow(
      /does not verify/,
    );
  });

  it("throws on junk JSON / missing fields", () => {
    const irk = makeKey(1);
    expect(() =>
      decodeAndVerifyDecommissionOrder({ orderJson: "{", orderSignatureHex: "00", ownerIrkPub: irk.publicKey }),
    ).toThrow(/not valid JSON/);
    expect(() =>
      decodeAndVerifyDecommissionOrder({ orderJson: "{}", orderSignatureHex: "00", ownerIrkPub: irk.publicKey }),
    ).toThrow(/missing required fields/);
  });
});

describe("runDecommissionConsumer", () => {
  // 1
  it("valid + STK-match proceeds (keep → release + power, no wipe)", async () => {
    const irk = makeKey(1);
    const { opts, spy, marker } = baseOpts({ fetchImpl: fetchFor(carrier(makeOrder(), irk)), ownerIrkPub: irk.publicKey });
    const out = await runDecommissionConsumer(opts);
    expect(out).toEqual({ decommissioned: true, disposition: "keep", wiped: false });
    expect(spy.released).toBe(1);
    expect(spy.powers).toBe(1);
    expect(spy.wipes).toBe(0);
    expect(marker.marked).toBe(true);
  });

  // 2
  it("ignores an order naming a DIFFERENT STK (I2 — predecessor's order)", async () => {
    const irk = makeKey(1);
    const order = makeOrder({ retiredStkPubHex: hex(makeKey(7).publicKey) });
    const { opts, spy } = baseOpts({ fetchImpl: fetchFor(carrier(order, irk)), ownerIrkPub: irk.publicKey });
    const out = await runDecommissionConsumer(opts);
    expect(out).toEqual({ decommissioned: false, reason: "wrong-stk" });
    expect(spy.released).toBe(0);
    expect(spy.powers).toBe(0);
    expect(spy.wipes).toBe(0);
  });

  // 3
  it("rejects a forged signature without acting", async () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const { opts, spy } = baseOpts({ fetchImpl: fetchFor(carrier(makeOrder(), wrong)), ownerIrkPub: irk.publicKey });
    const out = await runDecommissionConsumer(opts);
    expect(out).toEqual({ decommissioned: false, reason: "rejected" });
    expect(spy.powers).toBe(0);
    expect(spy.wipes).toBe(0);
  });

  // 4
  it("rejects a wrong-account order (signed by another IRK) without acting", async () => {
    const myIrk = makeKey(1);
    const otherOwner = makeKey(3);
    // The order is well-formed + signed by SOME owner, but not the box's owner IRK.
    const { opts, spy } = baseOpts({
      fetchImpl: fetchFor(carrier(makeOrder(), otherOwner)),
      ownerIrkPub: myIrk.publicKey,
    });
    const out = await runDecommissionConsumer(opts);
    expect(out).toEqual({ decommissioned: false, reason: "rejected" });
    expect(spy.powers).toBe(0);
  });

  // 5
  it("does nothing on a 404 (no order deposited)", async () => {
    const irk = makeKey(1);
    const { opts, spy } = baseOpts({ fetchImpl: fetchFor(null), ownerIrkPub: irk.publicKey });
    const out = await runDecommissionConsumer(opts);
    expect(out).toEqual({ decommissioned: false, reason: "no-order" });
    expect(spy.released).toBe(0);
    expect(spy.powers).toBe(0);
  });

  // 6
  it("no-ops when the marker is already present (idempotent)", async () => {
    const irk = makeKey(1);
    const { opts, spy, marker } = baseOpts({ fetchImpl: fetchFor(carrier(makeOrder(), irk)), ownerIrkPub: irk.publicKey });
    marker.marked = true;
    const out = await runDecommissionConsumer(opts);
    expect(out).toEqual({ decommissioned: false, reason: "already-done" });
    expect(spy.released).toBe(0);
    expect(spy.powers).toBe(0);
  });

  // 7a
  it("finalBackup:yes → flushes at the epoch AND reports epoch-complete", async () => {
    const irk = makeKey(1);
    const posts: string[] = [];
    const order = makeOrder({ finalBackup: true, backupEpoch: 42 });
    const { opts, spy } = baseOpts({
      fetchImpl: fetchFor(carrier(order, irk), { posts }),
      ownerIrkPub: irk.publicKey,
    });
    const out = await runDecommissionConsumer(opts);
    expect(out.decommissioned).toBe(true);
    expect(spy.flushes).toEqual([42]);
    expect(posts.some((u) => u.includes("/decommission/epoch-complete"))).toBe(true);
    expect(posts.some((u) => u.includes("/decommission/ack-old"))).toBe(true);
  });

  // 7b
  it("finalBackup:no → skips the flush + epoch-complete report", async () => {
    const irk = makeKey(1);
    const posts: string[] = [];
    const { opts, spy } = baseOpts({
      fetchImpl: fetchFor(carrier(makeOrder({ finalBackup: false }), irk), { posts }),
      ownerIrkPub: irk.publicKey,
    });
    await runDecommissionConsumer(opts);
    expect(spy.flushes).toEqual([]);
    expect(posts.some((u) => u.includes("/decommission/epoch-complete"))).toBe(false);
    // ack-old is still sent (advisory GC).
    expect(posts.some((u) => u.includes("/decommission/ack-old"))).toBe(true);
  });

  // 8
  it("keep → lockAndPower, NEVER wipes", async () => {
    const irk = makeKey(1);
    const { opts, spy } = baseOpts({
      fetchImpl: fetchFor(carrier(makeOrder({ diskDisposition: "keep" }), irk)),
      ownerIrkPub: irk.publicKey,
    });
    const out = await runDecommissionConsumer(opts);
    expect(out).toMatchObject({ decommissioned: true, disposition: "keep", wiped: false });
    expect(spy.wipes).toBe(0);
    expect(spy.powers).toBe(1);
  });

  // 9
  it("wipe-now → wipes THEN powers off", async () => {
    const irk = makeKey(1);
    const { opts, spy } = baseOpts({
      fetchImpl: fetchFor(carrier(makeOrder({ diskDisposition: "wipe-now" }), irk)),
      ownerIrkPub: irk.publicKey,
    });
    const out = await runDecommissionConsumer(opts);
    expect(out).toMatchObject({ decommissioned: true, disposition: "wipe-now", wiped: true });
    expect(spy.wipes).toBe(1);
    expect(spy.powers).toBe(1);
  });

  // 10a
  it("wipe-after-handoff + confirm ARRIVES → wipes + powers off", async () => {
    const irk = makeKey(1);
    const { opts, spy } = baseOpts({
      fetchImpl: fetchFor(carrier(makeOrder({ diskDisposition: "wipe-after-handoff" }), irk)),
      ownerIrkPub: irk.publicKey,
      awaitHandoffConfirm: async () => true,
    });
    const out = await runDecommissionConsumer(opts);
    expect(out).toMatchObject({ decommissioned: true, disposition: "wipe-after-handoff", wiped: true });
    expect(spy.wipes).toBe(1);
    expect(spy.powers).toBe(1);
  });

  // 10b
  it("wipe-after-handoff + TIMEOUT → powers off WITHOUT wiping (fail-safe keeps data)", async () => {
    const irk = makeKey(1);
    const { opts, spy } = baseOpts({
      fetchImpl: fetchFor(carrier(makeOrder({ diskDisposition: "wipe-after-handoff" }), irk)),
      ownerIrkPub: irk.publicKey,
      awaitHandoffConfirm: async () => false,
    });
    const out = await runDecommissionConsumer(opts);
    expect(out).toMatchObject({ decommissioned: true, disposition: "wipe-after-handoff", wiped: false });
    expect(spy.wipes).toBe(0);
    expect(spy.powers).toBe(1);
  });

  it("still marks + powers off (no loop) when wipeContent itself fails", async () => {
    const irk = makeKey(1);
    const { opts, spy, marker } = baseOpts({
      fetchImpl: fetchFor(carrier(makeOrder({ diskDisposition: "wipe-now" }), irk)),
      ownerIrkPub: irk.publicKey,
      wipeContent: async () => {
        throw new Error("docker not installed");
      },
    });
    const out = await runDecommissionConsumer(opts);
    expect(out).toMatchObject({ decommissioned: true, wiped: false });
    expect(marker.marked).toBe(true);
    expect(spy.powers).toBe(1);
  });
});
