/**
 * Box-side admin master-root ROTATION consumer (docs/device-admin-tier-spec.md
 * §5 — "the box must not trust `.com`"). The box re-pins its authority root ONLY
 * on a proof that chains from — and verifies under — the root it CURRENTLY pins.
 *
 * Covered:
 *   - applyRotationChain: a valid old-root-signed hop re-pins forward
 *   - applyRotationChain: a hop NOT signed by the current root does NOT re-pin
 *   - applyRotationChain: a multi-hop chain replays old → A1 → A2
 *   - applyRotationChain: an already-advanced pin skips applied leading hops
 *   - applyRotationChain: a fork/gap that doesn't chain from the pin re-pins nothing
 *   - claimAdminRootRotations: verified advance persists the pin + restarts; a
 *     re-poll of the unchanged chain is a no-op (no second restart) — idempotent
 *   - resolvePinnedAdminRoot: a persisted re-pin overrides the config seed
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signAdminRootRotation,
  type AdminRootRotation,
  type Keypair,
} from "@flagship/protocol";
import {
  applyRotationChain,
  claimAdminRootRotations,
  resolvePinnedAdminRoot,
  type AdminRootPin,
  type AdminRootPinStore,
  type RotationChainEntry,
} from "../src/adminRootRotationConsumer.js";

const USER = "alice";

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

/** A served-lane entry for `old → new`, signed by `signer` (default = old). */
function entry(
  seq: number,
  oldKp: Keypair,
  newKp: Keypair,
  issuedAt: number,
  signer: Keypair = oldKp,
): RotationChainEntry {
  const rotation: AdminRootRotation = {
    username: USER,
    oldAdminRootPub: oldKp.publicKey,
    newAdminRootPub: newKp.publicKey,
    issuedAt,
  };
  return {
    seq,
    oldAdminRootPub: hex(oldKp.publicKey),
    newAdminRootPub: hex(newKp.publicKey),
    issuedAt,
    signatureHex: hex(signAdminRootRotation(rotation, signer)),
  };
}

function memPinStore(initial: AdminRootPin | null = null): AdminRootPinStore & { current: AdminRootPin | null } {
  const box = { current: initial };
  return {
    get current() {
      return box.current;
    },
    async read() {
      return box.current;
    },
    async write(p) {
      box.current = p;
    },
  };
}

/** Minimal fetch stub returning the given rotation rows for the lane URL. */
function fetchStub(rows: RotationChainEntry[]): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes("/admin-root-rotations")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ username: USER, rotations: rows }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("applyRotationChain", () => {
  it("re-pins forward on a valid old-root-signed hop", () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const out = applyRotationChain({
      pinnedHex: hex(a0.publicKey),
      username: USER,
      chain: [entry(1, a0, a1, 1000)],
    });
    expect(out.pinnedHex).toBe(hex(a1.publicKey));
    expect(out.applied).toBe(1);
    expect(out.lastSeq).toBe(1);
  });

  it("does NOT re-pin on a hop not signed by the current root", () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const evil = makeKey();
    const out = applyRotationChain({
      pinnedHex: hex(a0.publicKey),
      username: USER,
      chain: [entry(1, a0, a1, 1000, evil)], // old=a0, but signed by evil
    });
    expect(out.pinnedHex).toBe(hex(a0.publicKey));
    expect(out.applied).toBe(0);
  });

  it("replays a multi-hop chain old → A1 → A2", () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const a2 = makeKey();
    const out = applyRotationChain({
      pinnedHex: hex(a0.publicKey),
      username: USER,
      chain: [entry(1, a0, a1, 1000), entry(2, a1, a2, 2000)],
    });
    expect(out.pinnedHex).toBe(hex(a2.publicKey));
    expect(out.applied).toBe(2);
    expect(out.lastSeq).toBe(2);
  });

  it("skips already-applied leading hops when the pin is already advanced", () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const a2 = makeKey();
    const out = applyRotationChain({
      pinnedHex: hex(a1.publicKey), // already at A1
      username: USER,
      chain: [entry(1, a0, a1, 1000), entry(2, a1, a2, 2000)],
    });
    expect(out.pinnedHex).toBe(hex(a2.publicKey));
    expect(out.applied).toBe(1);
    expect(out.lastSeq).toBe(2);
  });

  it("re-pins nothing when the chain does not depart from the pinned root (fork/gap)", () => {
    const a0 = makeKey();
    const b0 = makeKey();
    const b1 = makeKey();
    const out = applyRotationChain({
      pinnedHex: hex(a0.publicKey),
      username: USER,
      chain: [entry(1, b0, b1, 1000)], // departs from b0, not a0
    });
    expect(out.pinnedHex).toBe(hex(a0.publicKey));
    expect(out.applied).toBe(0);
  });

  it("stops at the first hop that fails to verify (never adopts an unproven root)", () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const a2 = makeKey();
    const evil = makeKey();
    const out = applyRotationChain({
      pinnedHex: hex(a0.publicKey),
      username: USER,
      chain: [entry(1, a0, a1, 1000), entry(2, a1, a2, 2000, evil)], // 2nd hop forged
    });
    expect(out.pinnedHex).toBe(hex(a1.publicKey)); // only the first hop applied
    expect(out.applied).toBe(1);
  });
});

describe("claimAdminRootRotations", () => {
  it("persists the re-pin and restarts on a verified advance; idempotent on re-poll", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const store = memPinStore();
    let restarts = 0;
    const rows = [entry(1, a0, a1, 1000)];

    const out = await claimAdminRootRotations({
      username: USER,
      seedAdminRootHex: hex(a0.publicKey),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      pinStore: store,
      restart: () => { restarts += 1; },
      fetchImpl: fetchStub(rows),
      now: () => 5000,
    });
    expect(out).toMatchObject({ rotated: true, to: hex(a1.publicKey), applied: 1 });
    expect(store.current).toMatchObject({ adminRootPubHex: hex(a1.publicKey), seq: 1 });
    expect(restarts).toBe(1);

    // Re-poll the SAME (unchanged) chain — the pin is now at A1, so nothing to do.
    const again = await claimAdminRootRotations({
      username: USER,
      seedAdminRootHex: hex(a0.publicKey),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      pinStore: store,
      restart: () => { restarts += 1; },
      fetchImpl: fetchStub(rows),
      now: () => 6000,
    });
    expect(again.rotated).toBe(false);
    expect(restarts).toBe(1); // no second restart
  });

  it("no-ops (never restarts) when the box has no admin root", async () => {
    let restarts = 0;
    const out = await claimAdminRootRotations({
      username: USER,
      seedAdminRootHex: null,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      pinStore: memPinStore(),
      restart: () => { restarts += 1; },
      fetchImpl: fetchStub([]),
    });
    expect(out).toEqual({ rotated: false, reason: "no-admin-root" });
    expect(restarts).toBe(0);
  });

  it("does not re-pin (or restart) on a `.com`-served proof not signed by the current root", async () => {
    const a0 = makeKey();
    const a1 = makeKey();
    const evil = makeKey();
    const store = memPinStore();
    let restarts = 0;
    const out = await claimAdminRootRotations({
      username: USER,
      seedAdminRootHex: hex(a0.publicKey),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      pinStore: store,
      restart: () => { restarts += 1; },
      fetchImpl: fetchStub([entry(1, a0, a1, 1000, evil)]),
    });
    expect(out.rotated).toBe(false);
    expect(store.current).toBeNull();
    expect(restarts).toBe(0);
  });
});

describe("resolvePinnedAdminRoot", () => {
  it("returns the persisted re-pin over the config seed", async () => {
    const seed = makeKey();
    const pinned = makeKey();
    const store = memPinStore({ adminRootPubHex: hex(pinned.publicKey), seq: 3, updatedAt: 1 });
    expect(await resolvePinnedAdminRoot(hex(seed.publicKey), store)).toBe(hex(pinned.publicKey));
  });

  it("falls back to the seed when no re-pin is persisted", async () => {
    const seed = makeKey();
    expect(await resolvePinnedAdminRoot(hex(seed.publicKey), memPinStore())).toBe(hex(seed.publicKey));
  });

  it("returns null when there is no admin root at all", async () => {
    expect(await resolvePinnedAdminRoot(null, memPinStore())).toBeNull();
  });
});
