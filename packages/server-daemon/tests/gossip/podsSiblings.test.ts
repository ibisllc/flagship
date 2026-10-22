import { describe, expect, it } from "vitest";
import { buildGossipLoop } from "../../src/gossip/gossipLoop.js";
import { SiblingView, type ViewMember } from "../../src/gossip/siblingView.js";
import type { RouteClaimer } from "../../src/gossip/routeClaimer.js";
import { buildPodsPeers } from "../../src/accessPeers.js";

class Claimer implements RouteClaimer {
  held = new Set<string>();
  async claim(s: string) { this.held.add(s); }
  async release(s: string) { this.held.delete(s); }
  holds(s: string) { return this.held.has(s); }
}

const SELF = "home2.alice.flagship.services";
const OTHER = "home.alice.flagship.services";
const rank = (stk: string) => ({ aa: 0, bb: 1 } as Record<string, number>)[stk] ?? null;
const silent = (async () => ({ ok: true, status: 204 })) as unknown as typeof fetch;

function loopWith(claimer: Claimer, extra: () => ViewMember[]) {
  return buildGossipLoop({
    cgk: new Uint8Array(32).fill(7),
    view: new SiblingView(1000),
    claimer,
    broadcastUrl: "https://broadcast--alice.flagship.services",
    fetchImpl: silent,
    rankOf: rank,
    extraSiblings: extra,
    readSelf: () => ({ user: "alice", name: SELF, birthAuthHex: "bb", birthDate: 900, order: null, services: ["club"] }),
  });
}

const other = (services: string[]): ViewMember => ({
  id: OTHER, domain: OTHER, stkHex: "aa", birthDate: 0, orderRank: 0, liveness: "live", services,
});

describe("siblings learned from .com and a direct ask", () => {
  it("a higher-ranked server that runs the app keeps the canonical route; this box does not claim", async () => {
    const c = new Claimer();
    await loopWith(c, () => [other(["club"])]).tick();
    expect(c.holds("club")).toBe(false);
  });

  it("this box claims once that server stops running the app", async () => {
    const c = new Claimer();
    let up = true;
    const loop = loopWith(c, () => (up ? [other(["club"])] : []));
    await loop.tick();
    expect(c.holds("club")).toBe(false);
    up = false;
    await loop.tick();
    expect(c.holds("club")).toBe(true);
  });

  it("a lower-ranked server does not take the route from this box, and it hands it back to a higher one", async () => {
    const c = new Claimer();
    const low: ViewMember = { ...other(["club"]), id: "z.alice.flagship.services", domain: "z.alice.flagship.services", stkHex: "zz", orderRank: null };
    let extra: ViewMember[] = [low];
    const loop = loopWith(c, () => extra);
    await loop.tick();
    expect(c.holds("club")).toBe(true);
    extra = [low, other(["club"])];
    await loop.tick();
    expect(c.holds("club")).toBe(false);
  });
});

describe("PodsPeers.peerRunners", () => {
  it("lists each other server once with the apps it answered for", async () => {
    const p = buildPodsPeers({
      selfFqdn: SELF,
      fetchPods: async () => [
        { serverDomain: OTHER, identityPubKey: "AA", liveness: "live" },
        { serverDomain: SELF, identityPubKey: "bb", liveness: "live" },
      ],
      rankOf: rank,
      apps: () => ["alice--club", "alice--blog"],
      probe: async (_peer, ref) => ref !== "alice--blog",
    });
    await p.refresh();
    expect(p.peerRunners()).toEqual([{ domain: OTHER, stkHex: "aa", apps: ["alice--club"] }]);
  });
});
