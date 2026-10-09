// Custom domains are a Pro feature (owner decision 2026-10-09): Free none,
// Pro ("hobby") one, Pro Max ("maker") unlimited. These pin the rule at every
// place `.com` decides what the relay routes: the order, the verifier sweep
// (lapse ⇒ suspend, renewal ⇒ restore, downgrade ⇒ keep the oldest), and the
// two lookup endpoints the hub reads.
import { describe, expect, it } from "vitest";
import { ed, signSetCustomDomain, type Keypair } from "@flagship/protocol";
import { InMemoryStorage, type TierName } from "@flagship/storage";
import { handleGetCustomDomain, handleSetCustomDomain } from "../src/customDomain.js";
import { runCustomDomainVerificationPass } from "../src/customDomainVerifier.js";
import { handleActiveRedirections, handleRedirectionLookup } from "../src/customDomainRedirections.js";
import { isOwnZone } from "../src/customDomainEntitlement.js";

const USER = "alice";
const POD = "home.alice.flagship.services";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function setup(tier: TierName | null, periodEnd?: number) {
  const s = new InMemoryStorage();
  const priv = ed.utils.randomPrivateKey();
  const irk: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
  await s.usernames.put({ username: USER, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await s.servers.put({ serverDomain: POD, username: USER, identityPubKeyHex: "11".repeat(32), registeredAt: 1 });
  if (tier) await s.tiers.put({ username: USER, tier, updatedAt: 1, ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}) });
  return { s, irk };
}

function order(s: InMemoryStorage, irk: Keypair, serviceId: string, fqdn: string, now = NOW) {
  const claim = { username: USER, serviceId, fqdn, issuedAt: now };
  return handleSetCustomDomain(
    { usernames: s.usernames, customDomainOrders: s.customDomainOrders, tiers: s.tiers, now: () => now },
    USER,
    serviceId,
    { request: claim, signature: hex(signSetCustomDomain(claim, irk)) },
  );
}

async function active(s: InMemoryStorage, serviceId: string, fqdn: string, createdAt: number) {
  await s.customDomainOrders.upsert({
    serviceId, userId: USER, fqdn, status: "active", podCanonical: POD,
    lastChanged: createdAt, failCount: 0, createdAt, updatedAt: NOW,
  });
}

function pass(s: InMemoryStorage, now = NOW, cname = [`${USER}.flagship.services`]) {
  const pushed: Array<{ op: string; fqdn: string }> = [];
  const run = runCustomDomainVerificationPass({
    customDomainOrders: s.customDomainOrders,
    servers: s.servers,
    tiers: s.tiers,
    resolveCname: async () => cname,
    pushRedirection: async (op, fqdn) => {
      pushed.push({ op, fqdn });
    },
    now: () => now,
  });
  return run.then((r) => ({ r, pushed }));
}

describe("ordering a custom domain is a Pro feature", () => {
  it("refuses a Free account with 402 tier-required and records nothing", async () => {
    const { s, irk } = await setup(null);
    const r = await order(s, irk, "blog", "www.example.com");
    expect(r.status).toBe(402);
    expect((r.body as { code: string }).code).toBe("tier-required");
    expect(await s.customDomainOrders.get(USER, "blog")).toBeUndefined();
  });

  it("refuses a lapsed Pro subscription like Free", async () => {
    const { s, irk } = await setup("hobby", NOW - DAY);
    expect((await order(s, irk, "blog", "www.example.com")).status).toBe(402);
  });

  it("gives Pro exactly one domain; replacing that service's own domain is fine", async () => {
    const { s, irk } = await setup("hobby", NOW + 30 * DAY);
    expect((await order(s, irk, "blog", "www.example.com")).status).toBe(200);
    const second = await order(s, irk, "shop", "shop.example.com");
    expect(second.status).toBe(403);
    expect((second.body as { code: string }).code).toBe("domain-limit");
    const replaced = await order(s, irk, "blog", "blog.example.com", NOW + 10 * 60_000);
    expect(replaced.status).toBe(200);
  });

  it("gives Pro Max as many as it likes", async () => {
    const { s, irk } = await setup("maker", NOW + 30 * DAY);
    for (const [svc, fqdn] of [["a", "a.example.com"], ["b", "b.example.com"], ["c", "c.example.net"]]) {
      expect((await order(s, irk, svc!, fqdn!)).status).toBe(200);
    }
  });

  it("refuses Flagship's own zones as a custom domain, whatever the tier", async () => {
    const { s, irk } = await setup("maker", NOW + 30 * DAY);
    for (const fqdn of ["shop.bob.flagship.services", "x.flagshipserver.com", "a.b.voi.ci"]) {
      expect((await order(s, irk, "blog", fqdn)).status).toBe(400);
    }
    expect(isOwnZone("flagship.services.example.com")).toBe(false);
  });
});

describe("the verifier keeps routing in step with the tier", () => {
  it("does not activate a verified domain for a Free account", async () => {
    const { s } = await setup(null);
    await s.customDomainOrders.upsert({
      serviceId: "blog", userId: USER, fqdn: "www.example.com", status: "pending",
      lastChanged: NOW, failCount: 0, createdAt: NOW, updatedAt: NOW,
    });
    const { r, pushed } = await pass(s);
    expect(r.activated).toBe(0);
    expect(pushed).toEqual([]);
  });

  it("suspends on lapse (route removed, order kept) and restores on renewal", async () => {
    const { s } = await setup("hobby", NOW - DAY);
    await active(s, "blog", "www.example.com", 1);

    const lapsed = await pass(s);
    expect(lapsed.r.suspended).toBe(1);
    expect(lapsed.pushed).toEqual([{ op: "delete", fqdn: "www.example.com" }]);
    const row = await s.customDomainOrders.get(USER, "blog");
    expect(row?.status).toBe("pending");
    expect(row?.podCanonical).toBe(POD);
    const shown = await handleGetCustomDomain(
      { usernames: s.usernames, customDomainOrders: s.customDomainOrders, tiers: s.tiers },
      USER,
      "blog",
    );
    expect((shown.body as { status: string }).status).toBe("suspended");

    // Days later, still unpaid: never given up on.
    const later = await pass(s, NOW + 3 * DAY);
    expect(later.r.failed).toBe(0);

    await s.tiers.put({ username: USER, tier: "hobby", currentPeriodEnd: NOW + 40 * DAY, updatedAt: NOW });
    const renewed = await pass(s, NOW + 4 * DAY);
    expect(renewed.r.reactivated).toBe(1);
    expect(renewed.pushed).toEqual([{ op: "add", fqdn: "www.example.com" }]);
    expect((await s.customDomainOrders.get(USER, "blog"))?.status).toBe("active");
  });

  it("on a Pro Max → Pro downgrade keeps the oldest domain and suspends the rest", async () => {
    const { s } = await setup("hobby", NOW + 30 * DAY);
    await active(s, "c", "c.example.com", 300);
    await active(s, "a", "a.example.com", 100);
    await active(s, "b", "b.example.com", 200);
    const { r, pushed } = await pass(s);
    expect(r.suspended).toBe(2);
    expect(pushed.map((p) => p.fqdn).sort()).toEqual(["b.example.com", "c.example.com"]);
    expect((await s.customDomainOrders.get(USER, "a"))?.status).toBe("active");
  });
});

describe("the hub's lookup endpoints ignore unpaid accounts", () => {
  it("omits a lapsed account from the cold-start list and the point lookup", async () => {
    const { s } = await setup("hobby", NOW - DAY);
    await active(s, "blog", "www.example.com", 1);
    const deps = { customDomainOrders: s.customDomainOrders, tiers: s.tiers, now: () => NOW };
    const list = await handleActiveRedirections(deps, "S", "S");
    expect((list.body as { redirections: unknown[] }).redirections).toEqual([]);
    expect((await handleRedirectionLookup(deps, "S", "S", "www.example.com")).status).toBe(404);

    await s.tiers.put({ username: USER, tier: "hobby", currentPeriodEnd: NOW + DAY, updatedAt: NOW });
    expect((await handleRedirectionLookup(deps, "S", "S", "www.example.com")).status).toBe(200);
  });
});
