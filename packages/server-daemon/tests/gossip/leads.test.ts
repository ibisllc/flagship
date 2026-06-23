/**
 * GossipLoop.currentLeads() — the per-service "services I lead" set the daemon
 * heartbeat reports (Phase 6 Part 3), plus the pure `selfLeadsForRound` elector.
 */
import { describe, expect, it } from "vitest";
import { buildGossipLoop } from "../../src/gossip/gossipLoop.js";
import { selfLeadsForRound, type SelfMember } from "../../src/gossip/election.js";
import type { RouteClaimer } from "../../src/gossip/routeClaimer.js";
import { SiblingView } from "../../src/gossip/siblingView.js";
import type { ViewMember } from "../../src/gossip/siblingView.js";

const USER = "harry";
const CGK = new Uint8Array(32).fill(0x42);

class MockClaimer implements RouteClaimer {
  held = new Set<string>();
  async claim(s: string) {
    this.held.add(s);
  }
  async release(s: string) {
    this.held.delete(s);
  }
  holds(s: string) {
    return this.held.has(s);
  }
}

function sibling(over: Partial<ViewMember>): ViewMember {
  return {
    id: "old.harry.flagship.services",
    domain: "old.harry.flagship.services",
    birthDate: 1,
    voteIssuedAt: null,
    liveness: "live",
    services: ["blog"],
    ...over,
  };
}

describe("selfLeadsForRound", () => {
  it("self leads a service it runs when no live sibling outranks it", () => {
    const self: SelfMember = {
      id: "self",
      domain: "self.harry.flagship.services",
      birthDate: 100,
      voteIssuedAt: null,
      services: ["blog", "wiki"],
    };
    expect(selfLeadsForRound({ self, liveSiblings: [] })).toEqual(["blog", "wiki"]);
  });

  it("self does NOT lead a service an OLDER live sibling runs", () => {
    const self: SelfMember = {
      id: "self",
      domain: "self.harry.flagship.services",
      birthDate: 500, // younger
      voteIssuedAt: null,
      services: ["blog", "wiki"],
    };
    const older = sibling({ id: "old", domain: "old.harry.flagship.services", birthDate: 1, services: ["blog"] });
    // The sibling outranks self on `blog` (older birth) but doesn't run `wiki`.
    expect(selfLeadsForRound({ self, liveSiblings: [older] })).toEqual(["wiki"]);
  });
});

describe("GossipLoop.currentLeads", () => {
  it("is empty before the first tick, then reflects the election outcome", async () => {
    const view = new SiblingView(10_000);
    const claimer = new MockClaimer();
    const now = () => 1000;
    const silentFetch = (async () => ({ ok: true, status: 204, text: async () => "" }) as Response) as unknown as typeof fetch;

    const loop = buildGossipLoop({
      cgk: CGK,
      view,
      claimer,
      broadcastUrl: "https://broadcast--harry.flagship.services",
      fetchImpl: silentFetch,
      now,
      readSelf: () => ({
        user: USER,
        name: "self.harry.flagship.services",
        birthAuthHex: "bb".repeat(32),
        birthDate: 100,
        vote: null,
        services: ["blog", "wiki"],
      }),
    });

    expect(loop.currentLeads()).toEqual([]);
    await loop.tick();
    // No siblings → self leads both services it runs (sorted).
    expect(loop.currentLeads()).toEqual(["blog", "wiki"]);
  });
});
