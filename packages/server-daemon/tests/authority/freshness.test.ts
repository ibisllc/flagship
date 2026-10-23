import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthClock, FreshnessLeases, LeaderCandidate, LeaseVoter, PropagationBoard, type FreshnessCheckpoint, type GrantResult } from "../../src/authority/index.js";

const tmp = () => mkdtemp(join(tmpdir(), "fresh-"));
const cp = (over: Partial<FreshnessCheckpoint> = {}): FreshnessCheckpoint => ({ app: "chess#1", authorityEpoch: 1, policyRevision: 5, revocationDigest: "d5", leaderTerm: 3, freshUntil: 100_000 + 300_000, ...over });

function clockAt(auth: number) {
  let mono = 0;
  const c = new AuthClock({ mono: () => mono });
  c.observe(auth);
  return { c, advance: (ms: number) => void (mono += ms) };
}

describe("authenticated clock", () => {
  it("has no time until it observes one, counts with the monotonic clock, and ignores replayed older times", () => {
    let mono = 0;
    const c = new AuthClock({ mono: () => mono });
    expect(c.now()).toBeNull();
    c.observe(1_000);
    mono += 500;
    expect(c.now()).toBe(1_500);
    c.observe(200); // a replayed signed response from the past
    expect(c.now()).toBe(1_500);
    c.observe(5_000);
    expect(c.now()).toBe(5_000);
  });
});

describe("freshness of external access", () => {
  it("guest access works on a current checkpoint, stops at its deadline and resumes only on a newer revision", async () => {
    const { c, advance } = clockAt(100_000);
    const f = new FreshnessLeases(join(await tmp(), "f.json"), c);
    await f.load();
    expect(f.externalAccessAllowed("chess#1", 5)).toBe(false);
    expect(await f.accept(cp())).toEqual({ ok: true });
    expect(f.externalAccessAllowed("chess#1", 5)).toBe(true);
    // the access decision was made against a newer revision than the box has confirmed
    expect(f.externalAccessAllowed("chess#1", 6)).toBe(false);
    advance(400_000);
    expect(f.externalAccessAllowed("chess#1", 5)).toBe(false);
    // an old checkpoint cannot revive it
    expect(await f.accept(cp({ policyRevision: 4, freshUntil: 900_000 }))).toMatchObject({ ok: false, reason: "stale-policy" });
    expect(await f.accept(cp({ policyRevision: 6, revocationDigest: "d6", freshUntil: 900_000 }))).toEqual({ ok: true });
    expect(f.externalAccessAllowed("chess#1", 6)).toBe(true);
  });

  it("a peer's far-future deadline is capped; an old term or epoch is refused", async () => {
    const { c } = clockAt(100_000);
    const f = new FreshnessLeases(join(await tmp(), "f.json"), c);
    await f.accept(cp({ freshUntil: 9_999_999_999 }));
    expect(f.status("chess#1").freshUntil).toBe(100_000 + 15 * 60_000);
    expect(await f.accept(cp({ leaderTerm: 2 }))).toMatchObject({ reason: "old-term" });
    expect(await f.accept(cp({ authorityEpoch: 0 }))).toMatchObject({ reason: "old-epoch" });
    expect(await f.accept(cp({ revocationDigest: "different" }))).toMatchObject({ reason: "same-revision-different-digest" });
  });

  it("no trusted time (just rebooted, or a clock jump we cannot authenticate) pauses external access only", async () => {
    let mono = 0;
    const c = new AuthClock({ mono: () => mono });
    const f = new FreshnessLeases(join(await tmp(), "f.json"), c);
    expect(await f.accept(cp())).toMatchObject({ reason: "no-trusted-time" });
    c.observe(100_000);
    await f.accept(cp());
    expect(f.status("chess#1").trustedTime).toBe(true);
    // a fresh process: the same lease file, no observed time
    const again = new FreshnessLeases(join(await tmp(), "f.json"), new AuthClock({ mono: () => 0 }));
    expect(again.externalAccessAllowed("chess#1", 1)).toBe(false);
    expect(again.status("chess#1").trustedTime).toBe(false);
  });

  it("high-water marks survive a restart, so a restored older list cannot look current", async () => {
    const dir = await tmp();
    const { c } = clockAt(100_000);
    const f = new FreshnessLeases(join(dir, "f.json"), c);
    await f.accept(cp({ policyRevision: 9, revocationDigest: "d9" }));
    const g = new FreshnessLeases(join(dir, "f.json"), c);
    await g.load();
    expect(await g.accept(cp({ policyRevision: 8 }))).toMatchObject({ reason: "stale-policy" });
  });

  it("a damaged marks file is kept aside and nothing is fresh until a checkpoint arrives", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "f.json"), "garbage");
    const { c } = clockAt(100_000);
    const f = new FreshnessLeases(join(dir, "f.json"), c);
    await f.load();
    expect(f.externalAccessAllowed("chess#1", 0)).toBe(false);
    expect(await f.accept(cp())).toEqual({ ok: true });
  });
});

describe("exclusive lead term", () => {
  async function cluster(n: number, now: () => number | null, maxLease = 10_000) {
    const dir = await tmp();
    const voters = new Map<string, LeaseVoter>();
    for (let i = 0; i < n; i++) {
      const v = new LeaseVoter(`s${i}`, join(dir, `v${i}.json`), now, maxLease);
      await v.load();
      voters.set(v.id, v);
    }
    const down = new Set<string>();
    const cut = new Set<string>(); // "from|to" pairs the network drops
    const ask = (from: string) => async (m: string, term: number, ms: number): Promise<GrantResult> => {
      if (down.has(m) || cut.has(`${from}|${m}`)) throw new Error("unreachable");
      return voters.get(m)!.grant(from, term, ms);
    };
    const members = [...voters.keys()];
    const cand = (id: string) => new LeaderCandidate(id, members, ask(id), now, { leaseMs: 10_000, driftMs: 1_000 });
    return { voters, down, cut, cand, dir };
  }

  it("two leads can not both hold the lease: the second is refused while the first runs", async () => {
    let t = 1_000;
    const k = await cluster(3, () => t);
    const a = k.cand("s0");
    const b = k.cand("s1");
    expect(await a.campaign()).toBe(true);
    expect(await b.campaign()).toBe(false);
    expect(a.mayAct()).toBe(true);
    expect(b.mayAct()).toBe(false);
  });

  it("a partitioned lead stops acting at its lease end, then the majority side may elect another", async () => {
    let t = 1_000;
    const k = await cluster(3, () => t);
    const a = k.cand("s0");
    expect(await a.campaign()).toBe(true);
    // s0 is cut off from s1 and s2 (and they from it)
    for (const m of ["s1", "s2"]) k.cut.add(`s0|${m}`);
    t += 8_000; // still inside the lease: the old lead may still act (that is what the margin bounds)
    expect(a.mayAct()).toBe(true);
    const b = k.cand("s1");
    expect(await b.campaign()).toBe(false); // s1/s2 leases to s0 still running
    t += 2_000; // past the earliest expiry less drift
    expect(a.mayAct()).toBe(false);
    expect(await a.campaign()).toBe(false); // cannot renew: only itself reachable
    expect(await b.campaign()).toBe(true);
    expect(a.mayAct()).toBe(false);
  });

  it("loss of quorum ends the term; the lead cannot admit anyone", async () => {
    let t = 1_000;
    const k = await cluster(3, () => t);
    const a = k.cand("s0");
    await a.campaign();
    k.down.add("s1");
    k.down.add("s2");
    t += 9_500;
    expect(await a.campaign()).toBe(false);
    expect(a.mayAct()).toBe(false);
  });

  it("planned handover: the old lead releases, the next is granted at once", async () => {
    let t = 1_000;
    const k = await cluster(3, () => t);
    const a = k.cand("s0");
    const b = k.cand("s1");
    await a.campaign();
    await a.stepDown(async (m, holder) => k.voters.get(m)!.release(holder));
    expect(a.mayAct()).toBe(false);
    expect(await b.campaign()).toBe(true);
  });

  it("clock jumps: no trusted time means no lead; a backwards jump cannot extend a lease", async () => {
    let t: number | null = 1_000;
    const k = await cluster(3, () => t);
    const a = k.cand("s0");
    await a.campaign();
    t = null;
    expect(a.mayAct()).toBe(false);
    expect(await a.campaign()).toBe(false);
    t = 20_000;
    expect(a.mayAct()).toBe(false); // lease from t=1000 has ended
  });

  it("a voter that lost its state stays silent until any lease it granted must have ended", async () => {
    let t = 1_000;
    const k = await cluster(3, () => t);
    const a = k.cand("s0");
    await a.campaign();
    await writeFile(join(k.dir, "v1.json"), "garbage");
    const reborn = new LeaseVoter("s1", join(k.dir, "v1.json"), () => t, 10_000);
    await reborn.load();
    expect(await reborn.grant("s2", 99, 5_000)).toMatchObject({ granted: false, reason: "recovering" });
    t += 11_000;
    expect(await reborn.grant("s2", 99, 5_000)).toMatchObject({ granted: true });
  });

  it("a singleton persists its term locally", async () => {
    const dir = await tmp();
    let t = 1_000;
    let stored = 0;
    const persist = { load: async () => stored, save: async (v: number) => void (stored = v) };
    const v = new LeaseVoter("s0", join(dir, "v.json"), () => t, 10_000);
    const mk = () => new LeaderCandidate("s0", ["s0"], (m, term, ms) => v.grant("s0", term, ms), () => t, { leaseMs: 10_000, driftMs: 1_000 }, persist);
    const a = mk();
    await a.init();
    expect(await a.campaign()).toBe(true);
    expect(stored).toBe(1);
    const b = mk(); // restart
    await b.init();
    t += 20_000;
    await b.campaign();
    expect(b.state.term).toBe(2);
  });
});

describe("propagation lights", () => {
  const replicas = [
    { id: "phone", kind: "device" as const },
    { id: "home", kind: "server" as const },
    { id: "cabin", kind: "server" as const },
  ];

  it("a new edit starts dark everywhere and never inherits an old acknowledgement", () => {
    const b = new PropagationBoard(() => replicas);
    b.publish("app-access", "d1");
    for (const r of replicas) b.acknowledge("app-access", r.id, "d1", 1);
    expect(b.lights("app-access").every((l) => l.state === "bright")).toBe(true);
    b.publish("app-access", "d2");
    expect(b.lights("app-access").every((l) => l.state === "dark")).toBe(true);
    expect(b.lights("app-access")[0]!.lastConfirmedDigest).toBe("d1");
    b.acknowledge("app-access", "home", "d2", 2);
    expect(b.lights("app-access").map((l) => l.state)).toEqual(["dark", "bright", "dark"]);
  });

  it("says 'pending on one offline server', never 'revoked everywhere'", () => {
    const b = new PropagationBoard(() => replicas);
    b.publish("app-access", "d1");
    b.acknowledge("app-access", "phone", "d1", 1);
    b.acknowledge("app-access", "home", "d1", 1);
    b.mark("app-access", "cabin", "offline");
    expect(b.summary("app-access")).toBe("Confirmed by 2 of 3. Pending on 1 offline replica.");
    b.acknowledge("app-access", "cabin", "d1", 5);
    expect(b.summary("app-access")).toBe("Confirmed by all 3 replicas.");
  });

  it("a late acknowledgement of an older digest does not move a replica backwards", () => {
    const b = new PropagationBoard(() => replicas);
    b.publish("doc", "d1");
    b.publish("doc", "d2");
    b.acknowledge("doc", "home", "d2", 2);
    b.acknowledge("doc", "home", "d1", 3);
    expect(b.lights("doc").find((l) => l.replica.id === "home")!.lastConfirmedDigest).toBe("d2");
  });
});
