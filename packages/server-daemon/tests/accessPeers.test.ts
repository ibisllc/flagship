import { describe, expect, it } from "vitest";
import { buildPodsPeers, type PodView } from "../src/accessPeers.js";

const pods: PodView[] = [
  { serverDomain: "home.alice.flagship.services", identityPubKey: "aa", liveness: "live" },
  { serverDomain: "home2.alice.flagship.services", identityPubKey: "bb", liveness: "live" },
  { serverDomain: "home3.alice.flagship.services", identityPubKey: "cc", liveness: "live" },
  { serverDomain: "old.alice.flagship.services", identityPubKey: "dd", liveness: "never" },
];

function peers(self: string, opts: { order?: string[]; runs?: Record<string, string[]>; down?: Set<string> } = {}) {
  const order = opts.order ?? ["aa", "bb", "cc"];
  return buildPodsPeers({
    selfFqdn: self,
    fetchPods: async () => pods,
    rankOf: (stk) => (order.includes(stk) ? order.indexOf(stk) : null),
    apps: () => ["alice--club"],
    probe: async (peer, ref) => !opts.down?.has(peer) && (opts.runs?.[peer] ?? ["alice--club"]).includes(ref),
  });
}

describe("where an app's other servers are", () => {
  it("the leader is the first live server in the order that runs the app", async () => {
    const p = peers("home2.alice.flagship.services");
    await p.refresh();
    expect(p.leaderFor("alice--club")).toBe("home.alice.flagship.services");
    expect(p.runners("alice--club")).toEqual(["home.alice.flagship.services", "home3.alice.flagship.services"]);
  });

  it("a server that doesn't run the app, or doesn't answer, isn't a runner; the next one leads", async () => {
    const down = new Set(["home.alice.flagship.services"]);
    const p = peers("home3.alice.flagship.services", { down });
    await p.refresh();
    expect(p.leaderFor("alice--club")).toBe("home2.alice.flagship.services");
    const q = peers("home3.alice.flagship.services", { runs: { "home.alice.flagship.services": [], "home2.alice.flagship.services": [] } });
    await q.refresh();
    expect(q.leaderFor("alice--club")).toBe("home3.alice.flagship.services");
    expect(q.runners("alice--club")).toEqual([]);
  });

  it("follows the server order the box holds", async () => {
    const p = peers("home.alice.flagship.services", { order: ["cc", "aa", "bb"] });
    await p.refresh();
    expect(p.leaderFor("alice--club")).toBe("home3.alice.flagship.services");
  });

  it("keeps the last list when .com can't be reached", async () => {
    let up = true;
    const p = buildPodsPeers({
      selfFqdn: "home2.alice.flagship.services",
      fetchPods: async () => (up ? pods : null),
      rankOf: (stk) => ["aa", "bb", "cc"].indexOf(stk),
      apps: () => ["alice--club"],
      probe: async () => true,
    });
    await p.refresh();
    up = false;
    await p.refresh();
    expect(p.leaderFor("alice--club")).toBe("home.alice.flagship.services");
  });
});
