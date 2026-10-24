import { describe, expect, it } from "vitest";
import { KeyCustodian } from "../../src/keyCustodian.js";
import { accessSyncKeyFromOps, accessSyncMac, deriveAccessSyncKey } from "../../src/accessSync.js";
import { gossipCryptoFromCgk, gossipCryptoFromOps, verifyFrameMac } from "../../src/gossip/gossipCrypto.js";

const CGK = new Uint8Array(32).fill(0x22);
const A = { user: "alice", name: "home.alice.flagship.services", birthAuthHex: "ab".repeat(32), birthDate: 1, orderDate: 0, services: ["chess"], liveness: "live" as const, issuedAt: 2 };

describe("gossip through the key custodian", () => {
  it("talks to a box that holds the key itself: same MAC, frames open both ways", () => {
    const custodian = new KeyCustodian({ identityPriv: new Uint8Array(32).fill(1), cgk: CGK });
    const viaCustodian = gossipCryptoFromOps(custodian);
    const viaKey = gossipCryptoFromCgk(CGK);
    expect(viaCustodian.mac(A)).toBe(viaKey.mac(A));
    expect(verifyFrameMac(viaCustodian, A, viaKey.mac(A))).toBe(true);
    expect(verifyFrameMac(viaCustodian, { ...A, issuedAt: 3 }, viaKey.mac(A))).toBe(false);
    const pt = new TextEncoder().encode("frame");
    expect(new TextDecoder().decode(viaCustodian.open(viaKey.seal(pt)))).toBe("frame");
    expect(new TextDecoder().decode(viaKey.open(viaCustodian.seal(pt)))).toBe("frame");
    expect(() => gossipCryptoFromCgk(new Uint8Array(32).fill(9)).open(viaCustodian.seal(pt))).toThrow();
  });

  it("MACs a one-list message as a box holding the key would, and each MAC only its own tag", () => {
    const custodian = new KeyCustodian({ identityPriv: new Uint8Array(32).fill(1), cgk: CGK });
    const msg = { op: "push" as const, from: "home.alice.flagship.services", to: "cabin.alice.flagship.services", serviceRef: "chess--alice", issuedAt: 5, body: "{}" };
    expect(accessSyncMac(accessSyncKeyFromOps(custodian), msg)).toBe(accessSyncMac(deriveAccessSyncKey(CGK), msg));
    expect(() => custodian.gossipMac(new TextEncoder().encode("flagship/access-sync/v1|x"))).toThrow();
    expect(() => custodian.accessSyncMac(new TextEncoder().encode("flagship/gossip/v2|x"))).toThrow();
  });
});
