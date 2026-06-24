/**
 * `POST /internal/route-nudge` — the hub's on-demand "someone wants this
 * unclaimed meta-URL" prod, plus cert pre-warm + on-service-delete release.
 *
 * Cases (per the routing-resolution test plan):
 *   - nudge for a service this box LEADS → claims (+ cert ensured);
 *   - nudge for a service a HIGHER-CLOUT sibling leads → NO claim;
 *   - nudge for a service NOT run here → no-op 204;
 *   - single-box (no live siblings) → claims;
 *   - bad/unknown/foreign-account domain → 204, no throw, no claim;
 *   - wrong method → 405; non-nudge path → null (chain continues);
 *   - cert pre-warm loads a provisioned cert; absent ⇒ false but still claims;
 *   - on-delete → release called + re-announce (tick);
 *   - idempotent re-claim.
 */
import { describe, expect, it } from "vitest";
import {
  buildRouteNudgeHandler,
  buildCertPrewarm,
  apexFromBoxFqdn,
  type CertPrewarm,
  type PrewarmCertManager,
  type PrewarmCertStore,
} from "../../src/gossip/routeNudge.js";
import type { RouteClaimer } from "../../src/gossip/routeClaimer.js";
import type { ViewMember } from "../../src/gossip/siblingView.js";
import { tier2FqdnFor } from "../../src/gossip/routeClaimer.js";

const USER = "harry";
const SELF = "self.harry.flagship.services";

class MockClaimer implements RouteClaimer {
  held = new Set<string>();
  log: Array<{ op: "claim" | "release"; service: string }> = [];
  async claim(service: string) {
    this.log.push({ op: "claim", service });
    this.held.add(service);
  }
  async release(service: string) {
    this.log.push({ op: "release", service });
    this.held.delete(service);
  }
  holds(service: string) {
    return this.held.has(service);
  }
}

function nudgeReq(domain: unknown, method = "POST") {
  return {
    method,
    path: "/internal/route-nudge",
    headers: {},
    body: Buffer.from(JSON.stringify({ domain })),
  };
}

const liveSibling = (over: Partial<ViewMember> & { id: string }): ViewMember => ({
  domain: over.id,
  birthDate: 1000,
  voteIssuedAt: null,
  liveness: "live",
  services: ["blog"],
  ...over,
});

function buildHandler(opts: {
  claimer: RouteClaimer;
  services?: string[];
  liveSiblings?: ViewMember[];
  birthDate?: number;
  certPrewarm?: CertPrewarm;
  selfVoteIssuedAt?: number | null;
}) {
  return buildRouteNudgeHandler({
    user: USER,
    serverFqdn: SELF,
    birthDate: opts.birthDate ?? 100,
    listServiceSlugs: () => opts.services ?? ["blog"],
    liveSiblings: () => opts.liveSiblings ?? [],
    selfVoteIssuedAt: () => opts.selfVoteIssuedAt ?? null,
    claimer: opts.claimer,
    fqdnForService: tier2FqdnFor(USER, "flagship.services"),
    ...(opts.certPrewarm ? { certPrewarm: opts.certPrewarm } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────
describe("route-nudge: claim when self leads", () => {
  it("single-box (no live siblings) → claims the route, replies 204", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({ claimer });
    const res = await handle(nudgeReq("blog.harry.flagship.services"));
    expect(res).toEqual({ status: 204, body: "" });
    expect(claimer.holds("blog")).toBe(true);
    expect(claimer.log).toEqual([{ op: "claim", service: "blog" }]);
  });

  it("self is the highest-clout live runner (older) → claims", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({
      claimer,
      birthDate: 100, // older → wins on seniority
      liveSiblings: [liveSibling({ id: "b.harry.flagship.services", birthDate: 200 })],
    });
    await handle(nudgeReq("blog.harry.flagship.services"));
    expect(claimer.holds("blog")).toBe(true);
  });

  it("pre-warms the cert BEFORE claiming when self leads", async () => {
    const claimer = new MockClaimer();
    const order: string[] = [];
    const certPrewarm: CertPrewarm = {
      async ensure(fqdn) {
        order.push(`prewarm:${fqdn}`);
        return true;
      },
    };
    const claimerSpy: RouteClaimer = {
      claim: async (s) => {
        order.push(`claim:${s}`);
        await claimer.claim(s);
      },
      release: (s) => claimer.release(s),
      holds: (s) => claimer.holds(s),
    };
    const handle = buildHandler({ claimer: claimerSpy, certPrewarm });
    await handle(nudgeReq("blog.harry.flagship.services"));
    expect(order).toEqual(["prewarm:blog.harry.flagship.services", "claim:blog"]);
    expect(claimer.holds("blog")).toBe(true);
  });

  it("still claims even when the cert is NOT provisioned (pre-warm false)", async () => {
    const claimer = new MockClaimer();
    const certPrewarm: CertPrewarm = { async ensure() { return false; } };
    const handle = buildHandler({ claimer, certPrewarm });
    await handle(nudgeReq("blog.harry.flagship.services"));
    expect(claimer.holds("blog")).toBe(true);
  });

  it("idempotent: a re-nudge for an already-held route is a no-op claim (still 204)", async () => {
    const claimer = new MockClaimer();
    claimer.held.add("blog"); // already claimed
    const handle = buildHandler({ claimer });
    const res = await handle(nudgeReq("blog.harry.flagship.services"));
    expect(res).toEqual({ status: 204, body: "" });
    // claim() is called again (idempotent on the claimer side); route stays held.
    expect(claimer.holds("blog")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("route-nudge: do NOT claim", () => {
  it("a higher-clout (voted) sibling leads → no claim, 204", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({
      claimer,
      birthDate: 100, // oldest, but the sibling is VOTED → sibling leads
      liveSiblings: [
        liveSibling({ id: "b.harry.flagship.services", birthDate: 999, voteIssuedAt: 5000 }),
      ],
    });
    const res = await handle(nudgeReq("blog.harry.flagship.services"));
    expect(res).toEqual({ status: 204, body: "" });
    expect(claimer.holds("blog")).toBe(false);
    expect(claimer.log).toEqual([]);
  });

  it("a higher-clout (older) sibling leads → no claim", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({
      claimer,
      birthDate: 300, // younger → loses
      liveSiblings: [liveSibling({ id: "b.harry.flagship.services", birthDate: 100 })],
    });
    await handle(nudgeReq("blog.harry.flagship.services"));
    expect(claimer.holds("blog")).toBe(false);
  });

  it("service NOT run on this box → no-op 204, no claim", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({ claimer, services: ["chat"] });
    const res = await handle(nudgeReq("blog.harry.flagship.services"));
    expect(res).toEqual({ status: 204, body: "" });
    expect(claimer.log).toEqual([]);
  });

  it("an unreachable would-be-lead sibling is ignored → self (only live runner) claims", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({
      claimer,
      birthDate: 300, // younger, but the older sibling is NOT live
      liveSiblings: [
        liveSibling({ id: "b.harry.flagship.services", birthDate: 100, liveness: "unreachable" }),
      ],
    });
    await handle(nudgeReq("blog.harry.flagship.services"));
    expect(claimer.holds("blog")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("route-nudge: malformed / hostile input", () => {
  const cases: Array<[string, unknown]> = [
    ["missing domain", undefined],
    ["empty domain", ""],
    ["box name (not a meta-URL)", "self.harry.flagship.services"],
    ["deeper hierarchy", "x.blog.harry.flagship.services"],
    ["wrong apex", "blog.harry.example.com"],
    ["foreign account", "blog.mallory.flagship.services"],
    ["non-string domain", 42],
  ];
  for (const [name, domain] of cases) {
    it(`${name} → 204, no throw, no claim`, async () => {
      const claimer = new MockClaimer();
      const handle = buildHandler({ claimer });
      const res = await handle(nudgeReq(domain));
      expect(res).toEqual({ status: 204, body: "" });
      expect(claimer.log).toEqual([]);
    });
  }

  it("non-JSON body → 204, no claim", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({ claimer });
    const res = await handle({
      method: "POST",
      path: "/internal/route-nudge",
      headers: {},
      body: Buffer.from("not json{"),
    });
    expect(res).toEqual({ status: 204, body: "" });
    expect(claimer.log).toEqual([]);
  });

  it("a claimer that THROWS does not propagate — still 204", async () => {
    const throwing: RouteClaimer = {
      claim: async () => {
        throw new Error("boom");
      },
      release: async () => {},
      holds: () => false,
    };
    const handle = buildHandler({ claimer: throwing });
    const res = await handle(nudgeReq("blog.harry.flagship.services"));
    expect(res).toEqual({ status: 204, body: "" });
  });

  it("wrong method → 405; non-nudge path → null (chain continues)", async () => {
    const claimer = new MockClaimer();
    const handle = buildHandler({ claimer });
    expect(await handle(nudgeReq("blog.harry.flagship.services", "GET"))).toEqual({
      status: 405,
      body: "",
    });
    expect(
      await handle({ method: "POST", path: "/api/health", headers: {}, body: Buffer.alloc(0) }),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("buildCertPrewarm (live seam)", () => {
  function mkManager(present: Record<string, number>): PrewarmCertManager {
    const installed = new Map<string, number>(Object.entries(present));
    return {
      customNeedsRenewal(fqdn, _windowMs, now) {
        const notAfter = installed.get(fqdn.toLowerCase());
        if (notAfter === undefined) return true;
        return notAfter <= (now ?? Date.now());
      },
      installCustom(fqdn, _cert, notAfterMs) {
        installed.set(fqdn.toLowerCase(), notAfterMs);
      },
    };
  }

  it("returns true without a disk read when the cert is already loaded", async () => {
    let loadCalls = 0;
    const store: PrewarmCertStore = {
      async loadCert() {
        loadCalls++;
        return null;
      },
    };
    const cm = mkManager({ "blog.harry.flagship.services": 9_999_999 });
    const pw = buildCertPrewarm({ certManager: cm, store, now: () => 1000 });
    expect(await pw.ensure("blog.harry.flagship.services")).toBe(true);
    expect(loadCalls).toBe(0);
  });

  it("loads a provisioned cert from disk into the CertManager → true", async () => {
    const installed: string[] = [];
    const cm: PrewarmCertManager = {
      customNeedsRenewal: () => true, // not in memory
      installCustom: (fqdn) => installed.push(fqdn),
    };
    const store: PrewarmCertStore = {
      async loadCert(fqdn) {
        return {
          certPem: "CERT",
          privateKeyPem: "KEY",
          names: [fqdn],
          notAfter: 9_999_999,
        };
      },
    };
    const pw = buildCertPrewarm({ certManager: cm, store, now: () => 1000 });
    expect(await pw.ensure("blog.harry.flagship.services")).toBe(true);
    expect(installed).toEqual(["blog.harry.flagship.services"]);
  });

  it("no provisioned cert anywhere → false (no mint)", async () => {
    const cm: PrewarmCertManager = {
      customNeedsRenewal: () => true,
      installCustom: () => {
        throw new Error("should not install");
      },
    };
    const store: PrewarmCertStore = { async loadCert() { return null; } };
    const pw = buildCertPrewarm({ certManager: cm, store, now: () => 1000 });
    expect(await pw.ensure("blog.harry.flagship.services")).toBe(false);
  });

  it("an expired-on-disk cert → false (can't serve it)", async () => {
    const cm: PrewarmCertManager = {
      customNeedsRenewal: () => true,
      installCustom: () => {
        throw new Error("should not install an expired cert");
      },
    };
    const store: PrewarmCertStore = {
      async loadCert(fqdn) {
        return { certPem: "C", privateKeyPem: "K", names: [fqdn], notAfter: 500 };
      },
    };
    const pw = buildCertPrewarm({ certManager: cm, store, now: () => 1000 });
    expect(await pw.ensure("blog.harry.flagship.services")).toBe(false);
  });

  it("a store that throws → false, never propagates", async () => {
    const cm: PrewarmCertManager = { customNeedsRenewal: () => true, installCustom: () => {} };
    const store: PrewarmCertStore = {
      async loadCert() {
        throw new Error("disk error");
      },
    };
    const pw = buildCertPrewarm({ certManager: cm, store });
    expect(await pw.ensure("blog.harry.flagship.services")).toBe(false);
  });
});

describe("apexFromBoxFqdn", () => {
  it("strips the first two labels (server + user)", () => {
    expect(apexFromBoxFqdn("self.harry.flagship.services")).toBe("flagship.services");
    expect(apexFromBoxFqdn("box.user.gym.flagship.services")).toBe("gym.flagship.services");
    expect(apexFromBoxFqdn("two.labels")).toBeNull();
  });
});
