/**
 * Per-service leadership reads:
 *   - `selfLeadsForRound` — "which of MY services do I lead" (Phase 6 Part 3).
 *   - `leadsSnapshot` — the FULL map over the union of every live member's slugs
 *     (a box answers for services it doesn't host).
 *   - `GossipLoop.{currentLeads,leadsSnapshot}` — the live-computed surfaces.
 *   - `wireGossip(...).leadsSnapshot()` — gossip-disabled returns the empty shape.
 *   - `GET /api/leads` handler — the client-facing response shape.
 */
import { describe, expect, it } from "vitest";
import { buildGossipLoop } from "../../src/gossip/gossipLoop.js";
import {
  leadsSnapshot,
  selfLeadsForRound,
  type SelfMember,
} from "../../src/gossip/election.js";
import type { RouteClaimer } from "../../src/gossip/routeClaimer.js";
import { SiblingView } from "../../src/gossip/siblingView.js";
import type { ViewMember } from "../../src/gossip/siblingView.js";
import { buildLeadsHttpHandler } from "../../src/gossip/leadsHttp.js";
import { wireGossip } from "../../src/gossip/index.js";
import type { GossipAnnouncement } from "@flagship/protocol";

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
    stkHex: "ee".repeat(32),
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
      stkHex: "aa".repeat(32),
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
      stkHex: "aa".repeat(32),
      birthDate: 500, // younger
      voteIssuedAt: null,
      services: ["blog", "wiki"],
    };
    const older = sibling({ id: "old", domain: "old.harry.flagship.services", birthDate: 1, services: ["blog"] });
    // The sibling outranks self on `blog` (older birth) but doesn't run `wiki`.
    expect(selfLeadsForRound({ self, liveSiblings: [older] })).toEqual(["wiki"]);
  });
});

describe("leadsSnapshot (the FULL map)", () => {
  const self = (over: Partial<SelfMember> = {}): SelfMember => ({
    id: "self.harry.flagship.services",
    domain: "self.harry.flagship.services",
    stkHex: "aa".repeat(32),
    birthDate: 100,
    voteIssuedAt: null,
    services: ["blog"],
    ...over,
  });

  it("resolves a leader for a service hosted ONLY by a sibling (a box answers for services it doesn't host)", () => {
    const onlySibling = sibling({
      id: "b.harry.flagship.services",
      domain: "b.harry.flagship.services",
      stkHex: "bb".repeat(32),
      services: ["chat"], // self does NOT run chat
      birthDate: 50,
    });
    const map = leadsSnapshot({ self: self({ services: ["blog"] }), liveSiblings: [onlySibling] });
    // Both self's `blog` AND the sibling-only `chat` are in the union and resolve.
    expect(Object.keys(map).sort()).toEqual(["blog", "chat"]);
    expect(map.blog).toEqual({
      leaderFqdn: "self.harry.flagship.services",
      leaderStkHex: "aa".repeat(32),
      live: true,
    });
    expect(map.chat).toEqual({
      leaderFqdn: "b.harry.flagship.services",
      leaderStkHex: "bb".repeat(32),
      live: true,
    });
  });

  it("the highest-clout (oldest birth) live runner is the leader", () => {
    // self younger, sibling older → sibling leads the shared `blog`.
    const older = sibling({
      id: "old.harry.flagship.services",
      domain: "old.harry.flagship.services",
      stkHex: "cc".repeat(32),
      birthDate: 1, // oldest → leads
      services: ["blog"],
    });
    const map = leadsSnapshot({ self: self({ birthDate: 999, services: ["blog"] }), liveSiblings: [older] });
    expect(map.blog).toEqual({
      leaderFqdn: "old.harry.flagship.services",
      leaderStkHex: "cc".repeat(32),
      live: true,
    });
  });

  it("an owner VOTE makes the voted pod the leader (outranks seniority)", () => {
    const voted = sibling({
      id: "v.harry.flagship.services",
      domain: "v.harry.flagship.services",
      stkHex: "dd".repeat(32),
      birthDate: 999, // youngest, but voted
      voteIssuedAt: 5000,
      services: ["blog"],
    });
    const map = leadsSnapshot({ self: self({ birthDate: 1, services: ["blog"] }), liveSiblings: [voted] });
    expect(map.blog.leaderStkHex).toBe("dd".repeat(32));
  });

  it("a service with NO live runner is absent (an unreachable-only sibling doesn't count)", () => {
    const dead = sibling({
      id: "d.harry.flagship.services",
      domain: "d.harry.flagship.services",
      liveness: "unreachable",
      services: ["chat"], // only an unreachable sibling runs chat
    });
    const map = leadsSnapshot({ self: self({ services: ["blog"] }), liveSiblings: [dead] });
    expect(Object.keys(map)).toEqual(["blog"]); // chat absent — no LIVE runner
  });

  it("is empty when self runs nothing and no live sibling runs anything", () => {
    expect(leadsSnapshot({ self: self({ services: [] }), liveSiblings: [] })).toEqual({});
  });
});

describe("GossipLoop.currentLeads / leadsSnapshot", () => {
  const silentFetch = (async () => ({ ok: true, status: 204, text: async () => "" }) as Response) as unknown as typeof fetch;

  function loopWith(view: SiblingView) {
    return buildGossipLoop({
      cgk: CGK,
      view,
      claimer: new MockClaimer(),
      broadcastUrl: "https://broadcast--harry.flagship.services",
      fetchImpl: silentFetch,
      now: () => 1000,
      readSelf: () => ({
        user: USER,
        name: "self.harry.flagship.services",
        birthAuthHex: "aa".repeat(32),
        birthDate: 100,
        vote: null,
        services: ["blog", "wiki"],
      }),
    });
  }

  it("currentLeads is empty before the first tick, then reflects the election outcome", async () => {
    const loop = loopWith(new SiblingView(10_000));
    expect(loop.currentLeads()).toEqual([]);
    await loop.tick();
    expect(loop.currentLeads()).toEqual(["blog", "wiki"]);
  });

  it("leadsSnapshot computes the FULL live map on demand, including a sibling-only service", () => {
    const view = new SiblingView(10_000);
    const announce: GossipAnnouncement = {
      user: USER,
      name: "b.harry.flagship.services",
      birthAuthHex: "bb".repeat(32),
      birthDate: 50,
      voteStkHex: "none",
      voteDate: 0,
      services: ["chat"],
      liveness: "live",
      issuedAt: 999,
    };
    view.upsert(announce, 999);
    const loop = loopWith(view);
    const map = loop.leadsSnapshot();
    // self leads blog+wiki; the live sibling leads chat (self doesn't host it).
    expect(Object.keys(map).sort()).toEqual(["blog", "chat", "wiki"]);
    expect(map.chat.leaderFqdn).toBe("b.harry.flagship.services");
    expect(map.chat.leaderStkHex).toBe("bb".repeat(32));
    expect(map.blog.leaderFqdn).toBe("self.harry.flagship.services");
  });
});

describe("wireGossip leadsSnapshot — gossip DISABLED", () => {
  it("returns gossipActive:false + empty leads when no CGK is provisioned", async () => {
    // Make resolveCgk() deterministically find nothing: no env key, and an
    // install-blob path that doesn't exist (the /var/flagship/cgk.hex read also
    // misses on a dev/CI box).
    delete process.env.FLAGSHIP_CGK_HEX;
    process.env.FLAGSHIP_INSTALL_BLOB = "/nonexistent/flagship/install-blob.json";
    const res = await wireGossip({
      user: USER,
      serverFqdn: "self.harry.flagship.services",
      identityPubHex: "aa".repeat(32),
      birthDate: 100,
      urlController: { claim: async () => {}, release: async () => {}, list: () => [] },
      listServiceSlugs: () => ["blog"],
      // cgk omitted → resolveCgk() finds none in tests → disabled.
    });
    expect(res.enabled).toBe(false);
    expect(res.leadsSnapshot()).toEqual({ gossipActive: false, leads: {} });
  });
});

describe("GET /api/leads handler (response shape)", () => {
  it("serves 200 with asOf/self/gossipActive/leads, only for GET /api/leads", async () => {
    const handler = buildLeadsHttpHandler({
      serverFqdn: "self.harry.flagship.services",
      now: () => 1_700_000_000_000,
      snapshot: () => ({
        gossipActive: true,
        leads: {
          blog: { leaderFqdn: "self.harry.flagship.services", leaderStkHex: "aa".repeat(32), live: true },
        },
      }),
    });

    const res = await handler({
      method: "GET",
      path: "/api/leads",
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(res!.body as string)).toEqual({
      asOf: 1_700_000_000_000,
      self: "self.harry.flagship.services",
      gossipActive: true,
      leads: {
        blog: { leaderFqdn: "self.harry.flagship.services", leaderStkHex: "aa".repeat(32), live: true },
      },
    });

    // Falls through (null) for other paths/methods.
    expect(await handler({ method: "POST", path: "/api/leads", headers: {}, body: Buffer.alloc(0) })).toBeNull();
    expect(await handler({ method: "GET", path: "/api/services", headers: {}, body: Buffer.alloc(0) })).toBeNull();
  });

  it("serves the gossip-DISABLED shape unchanged (200, gossipActive:false, empty)", async () => {
    const handler = buildLeadsHttpHandler({
      serverFqdn: "self.harry.flagship.services",
      now: () => 42,
      snapshot: () => ({ gossipActive: false, leads: {} }),
    });
    const res = await handler({ method: "GET", path: "/api/leads", headers: {}, body: Buffer.alloc(0) });
    expect(JSON.parse(res!.body as string)).toEqual({
      asOf: 42,
      self: "self.harry.flagship.services",
      gossipActive: false,
      leads: {},
    });
  });
});
