import { describe, expect, it } from "vitest";
import { KeyCustodian } from "../../src/keyCustodian.js";
import { deriveAccessSyncKey } from "../../src/accessSync.js";
import { gossipCryptoFromKey, gossipCryptoFromOps, verifyGossipCryptoMac } from "../../src/gossip/gossipCrypto.js";

const CGK = new Uint8Array(32).fill(0x22);
const A = { user: "alice", name: "home.alice.flagship.services", birthAuthHex: "ab".repeat(32), birthDate: 1, orderDate: 0, services: ["chess"], liveness: "live" as const, issuedAt: 2 };

describe("gossip through the key custodian", () => {
  it("talks to a box that holds the key itself: same MAC, frames open both ways", () => {
    const custodian = new KeyCustodian({ identityPriv: new Uint8Array(32).fill(1), cgk: CGK });
    const viaCustodian = gossipCryptoFromOps(custodian);
    const viaKey = gossipCryptoFromKey(CGK);
    expect(viaCustodian.mac(A)).toBe(viaKey.mac(A));
    expect(verifyGossipCryptoMac(viaCustodian, A, viaKey.mac(A))).toBe(true);
    expect(verifyGossipCryptoMac(viaCustodian, { ...A, issuedAt: 3 }, viaKey.mac(A))).toBe(false);
    const pt = new TextEncoder().encode("frame");
    expect(new TextDecoder().decode(viaCustodian.open(viaKey.seal(pt)))).toBe("frame");
    expect(new TextDecoder().decode(viaKey.open(viaCustodian.seal(pt)))).toBe("frame");
    expect(() => gossipCryptoFromKey(new Uint8Array(32).fill(9)).open(viaCustodian.seal(pt))).toThrow();
  });

  it("derives the one-list sync key from the custodian and MACs nothing but gossip", () => {
    const custodian = new KeyCustodian({ identityPriv: new Uint8Array(32).fill(1), cgk: CGK });
    expect(Buffer.from(custodian.deriveAccessSyncKey()).toString("hex")).toBe(Buffer.from(deriveAccessSyncKey(CGK)).toString("hex"));
    expect(() => custodian.macGossip(new TextEncoder().encode("flagship/access-sync/v1|x"))).toThrow();
  });
});
