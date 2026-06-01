import { describe, expect, it } from "vitest";
import {
  generateUMK,
  deriveIRK,
  signWatchDelegateKey,
  verifyWatchDelegateKey,
  watchDelegateKeyId,
  watchDelegateAuthorizesScope,
  signRevokeWatchDelegate,
  verifyRevokeWatchDelegate,
  type WatchDelegateKey,
  type RevokeWatchDelegate,
} from "../src/index.js";

const NOW = 1_780_000_000_000;

function sampleGrant(over: Partial<WatchDelegateKey> = {}): WatchDelegateKey {
  // Any keypair stands in for the watch-delegate pubkey (32 bytes).
  const delegate = deriveIRK(generateUMK());
  return {
    grantId: "11111111-1111-4111-8111-111111111111",
    username: "dani",
    delegatePubKey: delegate.publicKey,
    scopes: ["boot-approval"],
    issuedAt: NOW,
    expiresAt: NOW + 7 * 24 * 3600 * 1000,
    ...over,
  };
}

describe("WatchDelegateKey", () => {
  it("signs + verifies under the IRK; rejects a wrong key + any field tamper", () => {
    const irk = deriveIRK(generateUMK());
    const other = deriveIRK(generateUMK());
    const g = sampleGrant();
    const sig = signWatchDelegateKey(g, irk);
    expect(verifyWatchDelegateKey(g, sig, irk.publicKey)).toBe(true);
    expect(verifyWatchDelegateKey(g, sig, other.publicKey)).toBe(false);
    expect(verifyWatchDelegateKey({ ...g, username: "mallory" }, sig, irk.publicKey)).toBe(false);
    expect(verifyWatchDelegateKey({ ...g, expiresAt: g.expiresAt + 1 }, sig, irk.publicKey)).toBe(false);
  });

  it("id is a deterministic, content-bound sha256 hex", async () => {
    const g = sampleGrant();
    const id1 = await watchDelegateKeyId(g);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    expect(await watchDelegateKeyId({ ...g })).toBe(id1);
    expect(await watchDelegateKeyId({ ...g, expiresAt: g.expiresAt + 1 })).not.toBe(id1);
  });

  it("authorizes ONLY boot-approval (the v1 scope)", () => {
    expect(watchDelegateAuthorizesScope(sampleGrant(), "boot-approval")).toBe(true);
  });

  it("validates: expiry order, scope set, pubkey length, separator + control bytes", () => {
    const irk = deriveIRK(generateUMK());
    const ctrl = "a" + String.fromCharCode(1) + "b";
    expect(() => signWatchDelegateKey(sampleGrant({ expiresAt: NOW }), irk)).toThrow(/expiresAt/);
    expect(() => signWatchDelegateKey(sampleGrant({ scopes: [] }), irk)).toThrow(/at least one/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => signWatchDelegateKey(sampleGrant({ scopes: ["nope" as any] }), irk)).toThrow(/unknown scope/);
    expect(() => signWatchDelegateKey(sampleGrant({ delegatePubKey: new Uint8Array(31) }), irk)).toThrow(/32 bytes/);
    expect(() => signWatchDelegateKey(sampleGrant({ grantId: "a|b" }), irk)).toThrow(/separator/);
    expect(() => signWatchDelegateKey(sampleGrant({ username: ctrl }), irk)).toThrow(/control char/);
  });

  it("RevokeWatchDelegate signs + verifies; rejects tamper", () => {
    const irk = deriveIRK(generateUMK());
    const r: RevokeWatchDelegate = {
      grantId: "11111111-1111-4111-8111-111111111111",
      username: "dani",
      issuedAt: NOW,
    };
    const sig = signRevokeWatchDelegate(r, irk);
    expect(verifyRevokeWatchDelegate(r, sig, irk.publicKey)).toBe(true);
    expect(verifyRevokeWatchDelegate({ ...r, grantId: "other" }, sig, irk.publicKey)).toBe(false);
  });
});
