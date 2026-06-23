import { describe, expect, it } from "vitest";
import {
  ed,
  deriveCGK,
  signSetLeader,
  verifySetLeader,
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
  type Keypair,
  type SetLeaderVote,
} from "../src/index.js";

/**
 * Cross-platform pins for the Phase-3 cloud-gossip / leadership foundation.
 * The exact hex / `|`-joined canonical strings here MUST match the Swift mirror
 * (`apps/mobile/shared/Tests/FlagshipSharedTests/CloudGossipCanonicalTests.swift`)
 * and the Kotlin mirror
 * (`apps/mobile/android/app/src/test/java/com/flagshipserver/app/core/CloudGossipVectorTest.kt`).
 */
function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

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

// ── 2. set-leader ──────────────────────────────────────────────────────
describe("set-leader vote", () => {
  const VOTE: SetLeaderVote = {
    user: "alice",
    preferredStkPubHex: "aa".repeat(32),
    issuedAt: 1700,
    nonce: "deadbeef",
  };
  const VOTE_CANONICAL =
    "flagship/set-leader/v1|alice|" + "aa".repeat(32) + "|1700|deadbeef";

  it("canonical bytes match the pinned cross-platform string", () => {
    const irk = makeKey(7);
    const sig = signSetLeader(VOTE, irk);
    expect(ed.verify(sig, new TextEncoder().encode(VOTE_CANONICAL), irk.publicKey)).toBe(true);
    expect(verifySetLeader(VOTE, sig, irk.publicKey)).toBe(true);
  });

  it("signature for the 0x07 IRK matches the pinned hex", () => {
    const irk = makeKey(7);
    expect(toHex(irk.publicKey)).toBe(
      "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
    );
    expect(toHex(signSetLeader(VOTE, irk))).toBe(
      "f08aa5168903b8b214e4ca867e1d2588eb060238c8ba88eb421a202af5077db7" +
        "c9ecc09b58c3fade22ee12a9fa638549a8508cfdfe05485cd9e7ea774fe54200",
    );
  });

  it("lowercases user + preferredStk + nonce into the canonical bytes", () => {
    const irk = makeKey(8);
    const upper: SetLeaderVote = {
      ...VOTE,
      user: "Alice",
      preferredStkPubHex: "AA".repeat(32),
      nonce: "DEADBEEF",
    };
    const sig = signSetLeader(upper, irk);
    expect(ed.verify(sig, new TextEncoder().encode(VOTE_CANONICAL), irk.publicKey)).toBe(true);
  });

  it("'none' clears the vote (carried verbatim in the bytes)", () => {
    const irk = makeKey(9);
    const clear: SetLeaderVote = { ...VOTE, preferredStkPubHex: "none" };
    const sig = signSetLeader(clear, irk);
    const expected =
      "flagship/set-leader/v1|alice|none|1700|deadbeef";
    expect(ed.verify(sig, new TextEncoder().encode(expected), irk.publicKey)).toBe(true);
  });

  it("verify never throws on a forged/junk signature", () => {
    const irk = makeKey(10);
    expect(verifySetLeader(VOTE, new Uint8Array(64), irk.publicKey)).toBe(false);
    expect(verifySetLeader(VOTE, new Uint8Array(3), irk.publicKey)).toBe(false);
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
    voteStkHex: "none",
    voteDate: 0,
    services: ["photos", "notes", "chat"], // unsorted on purpose
    liveness: "live",
    issuedAt: 1700,
  };
  const ANN_CANONICAL =
    "flagship/gossip/v1|alice|" +
    "bb".repeat(32) +
    "|" +
    "cc".repeat(32) +
    "|1000|none|0|chat,notes,photos|live|1700";

  it("canonical bytes sort services and match the pinned string", () => {
    expect(new TextDecoder().decode(canonicalGossip(ANN))).toBe(ANN_CANONICAL);
  });

  it("HMAC under the CGK matches the pinned hex", () => {
    expect(macGossip(ANN, CGK)).toBe(
      "2454b8b48b4e560e4613e32cb46c0df1161dfb934dd0c3f550a7507ff4a1647e",
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
    voteIssuedAt: number | null,
    liveness: CloutMember["liveness"],
    services: string[],
  ): CloutMember => ({ id, domain, birthDate, voteIssuedAt, liveness, services });

  it("scenario A — a vote outranks an older birth", () => {
    const members = [
      mk("p1", "home.alice.flagship.services", 1000, null, "live", ["photos"]),
      mk("p2", "work.alice.flagship.services", 2000, 5000, "live", ["photos"]),
    ];
    expect(electLeadForService(members, "photos")?.id).toBe("p2");
  });

  it("scenario B — no votes ⇒ the oldest birth certificate wins", () => {
    const members = [
      mk("p1", "home.alice.flagship.services", 2000, null, "live", ["notes"]),
      mk("p2", "work.alice.flagship.services", 1000, null, "live", ["notes"]),
    ];
    expect(electLeadForService(members, "notes")?.id).toBe("p2");
  });

  it("scenario C — equal vote + equal birth ⇒ lowest domain wins", () => {
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

  it("compareClout is a total order (negative = a leads)", () => {
    const voted = mk("v", "z.a", 5000, 9000, "live", []);
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
