/**
 * Tests for the on-disk entitlement-bundle store (N12b). The daemon
 * loads an IRK-signed RootEntitlement (+ optional ServiceEntitlement)
 * from disk and presents it on every tunnel HELLO. These tests cover
 * the round-trip (mint → write → load → verifies under the same IRK)
 * and the structural-validation rejections that surface a clear
 * failed{} to the phone instead of a generic crash.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ed,
  mintDevEntitlements,
  verifyRootEntitlement,
  verifyServiceEntitlement,
  type Keypair,
} from "@flagship/protocol";
import {
  defaultEntitlementBundlePath,
  loadEntitlementBundle,
  parseEntitlementBundle,
  serializeEntitlementBundle,
  writeEntitlementBundle,
} from "../src/entitlementBundleStore.js";

function makeKeypair(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const USERNAME = "alice";
const POD_CANONICAL = "home.alice.flagship.services";

describe("entitlementBundleStore", () => {
  let dir: string;
  let irk: Keypair;
  let stk: Keypair;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flagship-entitlements-"));
    irk = makeKeypair(0x11);
    stk = makeKeypair(0x22);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a root-only bundle through disk and verifies under the IRK", async () => {
    const minted = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: POD_CANONICAL,
    });
    const path = defaultEntitlementBundlePath(dir);
    await writeEntitlementBundle(path, minted);

    const loaded = await loadEntitlementBundle(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.rootEntitlement.username).toBe(USERNAME);
    expect(loaded!.rootEntitlement.podCanonical).toBe(POD_CANONICAL);
    expect(loaded!.rootEntitlement.podPubKey).toEqual(stk.publicKey);
    expect(loaded!.serviceEntitlement).toBeUndefined();

    // Re-verifies under the original IRK — the signature survived the
    // hex encode/decode round-trip.
    expect(
      verifyRootEntitlement(
        loaded!.rootEntitlement,
        loaded!.rootEntitlementSig,
        irk.publicKey,
      ),
    ).toBe(true);
    // ...and fails under a different IRK.
    expect(
      verifyRootEntitlement(
        loaded!.rootEntitlement,
        loaded!.rootEntitlementSig,
        makeKeypair(0x99).publicKey,
      ),
    ).toBe(false);
  });

  it("round-trips a bundle with a service entitlement", async () => {
    const minted = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: POD_CANONICAL,
      serviceCanonicals: ["photos.home.alice.flagship.services"],
    });
    const path = defaultEntitlementBundlePath(dir);
    await writeEntitlementBundle(path, minted);
    const loaded = await loadEntitlementBundle(path);

    expect(loaded!.serviceEntitlement).toBeDefined();
    expect(loaded!.serviceEntitlement!.canonicals).toEqual([
      "photos.home.alice.flagship.services",
    ]);
    expect(
      verifyServiceEntitlement(
        loaded!.serviceEntitlement!,
        loaded!.serviceEntitlementSig!,
        irk.publicKey,
      ),
    ).toBe(true);
  });

  it("returns null when the file is absent", async () => {
    const loaded = await loadEntitlementBundle(join(dir, "nope.json"));
    expect(loaded).toBeNull();
  });

  it("serialize → parse is an identity transform", () => {
    const minted = mintDevEntitlements({
      irk,
      podPubKey: stk.publicKey,
      username: USERNAME,
      podCanonical: POD_CANONICAL,
      serviceCanonicals: ["a.home.alice.flagship.services"],
    });
    const json = serializeEntitlementBundle(minted);
    const parsed = parseEntitlementBundle(JSON.parse(json));
    expect(parsed.rootEntitlement).toEqual(minted.rootEntitlement);
    expect(parsed.rootEntitlementSig).toEqual(minted.rootEntitlementSig);
    expect(parsed.serviceEntitlement).toEqual(minted.serviceEntitlement);
    expect(parsed.serviceEntitlementSig).toEqual(minted.serviceEntitlementSig);
  });

  it("rejects a non-object", () => {
    expect(() => parseEntitlementBundle("nope")).toThrow(/not an object/);
  });

  it("rejects a missing rootEntitlement", () => {
    expect(() => parseEntitlementBundle({})).toThrow(/rootEntitlement missing/);
  });

  it("rejects a podPubKey that is not 32-byte hex", () => {
    expect(() =>
      parseEntitlementBundle({
        rootEntitlement: {
          username: "alice",
          podPubKey: "abc",
          podCanonical: POD_CANONICAL,
          issuedAt: 1,
        },
        rootEntitlementSig: "00".repeat(64),
      }),
    ).toThrow(/podPubKey must be 32-byte hex/);
  });

  it("rejects a rootEntitlementSig that is not 64-byte hex", () => {
    expect(() =>
      parseEntitlementBundle({
        rootEntitlement: {
          username: "alice",
          podPubKey: "11".repeat(32),
          podCanonical: POD_CANONICAL,
          issuedAt: 1,
        },
        rootEntitlementSig: "deadbeef",
      }),
    ).toThrow(/rootEntitlementSig must be 64-byte hex/);
  });

  it("throws (not null) on a present but non-JSON file", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = join(dir, "garbage.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(loadEntitlementBundle(path)).rejects.toThrow(/not valid JSON/);
  });
});
