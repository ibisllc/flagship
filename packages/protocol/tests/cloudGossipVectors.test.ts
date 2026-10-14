import { describe, expect, it } from "vitest";
import {
  deriveCGK,
  canonicalGossip,
  macGossip,
  verifyGossipMac,
  sealGossip,
  openGossip,
  compareClout,
  electLeadForService,
  birthDateFromAuthCode,
  type CloutMember,
  type GossipAnnouncement,
} from "../src/index.js";

/**
 * Cross-platform pins for the Phase-3 cloud-gossip / leadership foundation.
 * The exact hex / `|`-joined canonical strings here MUST match the Swift mirror
 * (`apps/mobile/shared/Tests/FlagshipSharedTests/CloudGossipCanonicalTests.swift`)
 * and the Kotlin mirror
 * (`apps/mobile/android/app/src/test/java/com/flagshipserver/app/core/CloudGossipVectorTest.kt`).
 */
const toHex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

// ── 1. CGK ─────────────────────────────────────────────────────────────
describe("CGK derivation", () => {
  it("seed=0x07×32 → the pinned CGK hex", () => {
    const seed = new Uint8Array(32).fill(0x07);
    expect(toHex(deriveCGK(seed))).toBe(
      "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd",
    );
  });

  it("is per-cloud — no serverId in the construction (deterministic per seed)", () => {
    const seed = new Uint8Array(32).fill(0x07);
    expect(toHex(deriveCGK(seed))).toBe(toHex(deriveCGK(new Uint8Array(32).fill(0x07))));
    expect(toHex(deriveCGK(seed))).not.toBe(toHex(deriveCGK(new Uint8Array(32).fill(0x08))));
  });
});

// ── 3. gossip ──────────────────────────────────────────────────────────
describe("gossip announcement", () => {
  const CGK = deriveCGK(new Uint8Array(32).fill(0x07));
  const ANN: GossipAnnouncement = {
    user: "alice",
    name: "bb".repeat(32),
    birthAuthHex: "cc".repeat(32),
    birthDate: 1000,
    orderDate: 1500,
    services: ["photos", "notes", "chat"], // unsorted on purpose
    liveness: "live",
    issuedAt: 1700,
  };
  const ANN_CANONICAL =
    "flagship/gossip/v2|alice|" +
    "bb".repeat(32) +
    "|" +
    "cc".repeat(32) +
    "|1000|1500|chat,notes,photos|live|1700";

  it("canonical bytes sort services and match the pinned string", () => {
    expect(new TextDecoder().decode(canonicalGossip(ANN))).toBe(ANN_CANONICAL);
  });

  it("HMAC under the CGK matches the pinned hex", () => {
    expect(macGossip(ANN, CGK)).toBe(
      "a1e8167791f338e0f2f066fdae5432965239d9f4d7585fc685c75429a28e588f",
    );
  });

  it("verifyGossipMac accepts the right mac, rejects a wrong one, never throws", () => {
    expect(verifyGossipMac(ANN, macGossip(ANN, CGK), CGK)).toBe(true);
    expect(verifyGossipMac(ANN, "00".repeat(32), CGK)).toBe(false);
    expect(verifyGossipMac(ANN, "not-hex", CGK)).toBe(false);
    // Wrong CGK → fails.
    expect(verifyGossipMac(ANN, macGossip(ANN, CGK), deriveCGK(new Uint8Array(32).fill(0x09)))).toBe(false);
  });

  it("seal/open is a nonce-prefixed AES-256-GCM round-trip under the CGK", () => {
    const pt = new TextEncoder().encode("hello-gossip");
    const blob = sealGossip(pt, CGK);
    expect(blob.length).toBe(12 + pt.length + 16); // nonce + ct + GCM tag
    expect(new TextDecoder().decode(openGossip(blob, CGK))).toBe("hello-gossip");
    // Wrong key → GCM throws (open is the throwing half; verifyGossipMac is the safe one).
    expect(() => openGossip(blob, deriveCGK(new Uint8Array(32).fill(0x09)))).toThrow();
  });
});

// ── 4. clout ───────────────────────────────────────────────────────────
describe("clout ranking", () => {
  const mk = (
    id: string,
    domain: string,
    birthDate: number,
    orderRank: number | null,
    liveness: CloutMember["liveness"],
    services: string[],
  ): CloutMember => ({ id, domain, birthDate, orderRank, liveness, services });

  it("scenario A — a place in the order outranks an older birth", () => {
    const members = [
      mk("p1", "home.alice.flagship.services", 1000, null, "live", ["photos"]),
      mk("p2", "work.alice.flagship.services", 2000, 5000, "live", ["photos"]),
    ];
    expect(electLeadForService(members, "photos")?.id).toBe("p2");
  });

  it("scenario B — no order ⇒ the oldest birth certificate wins", () => {
    const members = [
      mk("p1", "home.alice.flagship.services", 2000, null, "live", ["notes"]),
      mk("p2", "work.alice.flagship.services", 1000, null, "live", ["notes"]),
    ];
    expect(electLeadForService(members, "notes")?.id).toBe("p2");
  });

  it("scenario C — equal rank + equal birth ⇒ lowest domain wins", () => {
    const members = [
      mk("pz", "zeta.alice.flagship.services", 1000, 3000, "live", ["chat"]),
      mk("pa", "alpha.alice.flagship.services", 1000, 3000, "live", ["chat"]),
    ];
    expect(electLeadForService(members, "chat")?.id).toBe("pa");
  });

  it("only live runners of the service are eligible; null when none", () => {
    const members = [
      mk("p1", "home.alice.flagship.services", 1000, 9000, "unreachable", ["mail"]),
      mk("p2", "work.alice.flagship.services", 1000, null, "never", ["mail"]),
    ];
    expect(electLeadForService(members, "mail")).toBeNull();

    const mixed = [
      mk("p1", "home.alice.flagship.services", 1000, null, "live", ["photos"]),
      mk("p2", "work.alice.flagship.services", 2000, null, "live", ["notes"]),
    ];
    expect(electLeadForService(mixed, "notes")?.id).toBe("p2");
  });

  it("the role passes down the order while the first is down", () => {
    const members = [
      mk("p1", "a.alice.flagship.services", 1000, 0, "unreachable", ["photos"]),
      mk("p2", "b.alice.flagship.services", 3000, 1, "live", ["photos"]),
      mk("p3", "c.alice.flagship.services", 2000, 2, "live", ["photos"]),
    ];
    expect(electLeadForService(members, "photos")?.id).toBe("p2");
    members[0] = { ...members[0]!, liveness: "live" };
    expect(electLeadForService(members, "photos")?.id).toBe("p1");
  });

  it("compareClout is a total order (negative = a leads)", () => {
    const voted = mk("v", "z.a", 5000, 0, "live", []);
    const old = mk("o", "a.a", 1000, null, "live", []);
    expect(compareClout(voted, old)).toBeLessThan(0);
    expect(compareClout(old, voted)).toBeGreaterThan(0);
    expect(compareClout(voted, voted)).toBe(0);
  });
});

// ── 5. birth date ──────────────────────────────────────────────────────
describe("birthDateFromAuthCode", () => {
  it("returns the immutable AuthCode.issuedAt (ms)", () => {
    expect(
      birthDateFromAuthCode({
        version: 1,
        serial: "s",
        username: "alice",
        serverName: "home",
        serverDomain: "home.alice.flagship.services",
        delegatedPubKey: new Uint8Array(32),
        userPubKey: new Uint8Array(32),
        issuedAt: 1234567,
        expiresAt: 9999999,
      }),
    ).toBe(1234567);
  });
});
