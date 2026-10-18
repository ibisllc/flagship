import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareDnsClient, type CloudflareDnsRecord } from "../src/cloudflareDns.js";
import { FakeCloudflare } from "./fakeCloudflare.js";

describe("CloudflareDnsClient stale ACME TXT cleanup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("paginates and deletes only old in-zone ACME TXT records", async () => {
    const old = "2026-07-20T10:00:00.000Z";
    const fresh = "2026-07-20T11:45:00.000Z";
    const filler = Array.from({ length: 496 }, (_, index): CloudflareDnsRecord => ({
      id: `filler-${index}`,
      type: "TXT",
      name: `unrelated-${index}.flagship.services`,
      content: "kept",
      proxied: false,
      ttl: 60,
      created_on: old,
    }));
    const firstPage: CloudflareDnsRecord[] = [
      {
        id: "old-challenge",
        type: "TXT",
        name: "_acme-challenge.home.openai-build.flagship.services",
        content: "old",
        proxied: false,
        ttl: 60,
        created_on: old,
      },
      {
        id: "fresh-challenge",
        type: "TXT",
        name: "_acme-challenge.home.fresh.flagship.services",
        content: "fresh",
        proxied: false,
        ttl: 60,
        modified_on: fresh,
      },
      {
        id: "outside-zone",
        type: "TXT",
        name: "_acme-challenge.example.com",
        content: "outside",
        proxied: false,
        ttl: 60,
        created_on: old,
      },
      {
        id: "routing-record",
        type: "A",
        name: "_acme-challenge.home.other.flagship.services",
        content: "203.0.113.10",
        proxied: false,
        ttl: 60,
        created_on: old,
      },
      ...filler,
    ];
    const secondPage: CloudflareDnsRecord[] = [
      {
        id: "apex-challenge",
        type: "TXT",
        name: "_acme-challenge.flagship.services.",
        content: "old-apex",
        proxied: false,
        ttl: 60,
        created_on: old,
      },
      {
        id: "missing-timestamp",
        type: "TXT",
        name: "_acme-challenge.home.unknown.flagship.services",
        content: "unknown",
        proxied: false,
        ttl: 60,
      },
    ];
    const deleted: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(url.split("/").at(-1)!);
        return new Response(JSON.stringify({ success: true }));
      }
      const page = new URL(url).searchParams.get("page");
      return new Response(JSON.stringify({
        success: true,
        result: page === "1" ? firstPage : secondPage,
        result_info: { total_pages: 2 },
      }));
    });

    const dns = new CloudflareDnsClient({ apiToken: "token", zoneId: "zone" });
    const result = await dns.deleteStaleAcmeTxt({
      apex: "flagship.services",
      cutoffMs: Date.parse("2026-07-20T11:00:00.000Z"),
    });

    expect(result).toEqual({
      scanned: 502,
      eligible: 2,
      deleted: 2,
      names: [
        "_acme-challenge.flagship.services.",
        "_acme-challenge.home.openai-build.flagship.services",
      ],
      shieldsReleased: 0,
    });
    expect(deleted).toEqual(["old-challenge", "apex-challenge"]);
  });

  it("fails closed when Cloudflare cannot list the zone", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 }),
    );
    const dns = new CloudflareDnsClient({ apiToken: "token", zoneId: "zone" });
    await expect(dns.deleteStaleAcmeTxt({
      apex: "flagship.services",
      cutoffMs: Date.now(),
    })).rejects.toThrow(/listAll failed/);
  });
});

describe("CloudflareDnsClient legacy account-record sweep", () => {
  const APEX = "flagship.services";
  const RELAY = { servicesIpv4: "203.0.113.7", servicesIpv6: "2001:db8::7" };
  const OLD = "2026-07-20T10:00:00.000Z";
  const FRESH = "2026-07-20T11:45:00.000Z";
  const CUTOFF = Date.parse("2026-07-20T11:00:00.000Z");
  let cf: FakeCloudflare;
  let dns: CloudflareDnsClient;

  beforeEach(() => {
    cf = new FakeCloudflare();
    cf.install();
    dns = new CloudflareDnsClient({ apiToken: "token", zoneId: "zone" });
  });
  afterEach(() => vi.unstubAllGlobals());

  const seedRoot = () => {
    cf.seed("A", `*.${APEX}`, RELAY.servicesIpv4, { modified_on: OLD, created_on: OLD });
    cf.seed("AAAA", `*.${APEX}`, RELAY.servicesIpv6, { modified_on: OLD, created_on: OLD });
  };
  const old = (type: string, name: string, content = RELAY.servicesIpv4) =>
    cf.seed(type, name, content, { modified_on: OLD, created_on: OLD });
  const sweep = (over = {}) => dns.deleteLegacyAccountRecords({ apex: APEX, relay: RELAY, cutoffMs: CUTOFF, ...over });

  it("deletes old A/AAAA/CAA at account and box names and nothing else", async () => {
    seedRoot();
    old("A", `home.old-user.${APEX}`);
    old("AAAA", `*.home.old-user.${APEX}`, RELAY.servicesIpv6);
    old("A", `*.openai-build.${APEX}`);
    old("CAA", `openai-build.${APEX}`, '0 issue "letsencrypt.org"');
    cf.seed("A", `box.fresh-user.${APEX}`, RELAY.servicesIpv4, { modified_on: FRESH, created_on: FRESH });
    old("A", `api.${APEX}`, "198.51.100.1");
    old("A", `home.gym.${APEX}`);
    old("TXT", `_acme-challenge.home.old-user.${APEX}`, "token");
    old("TXT", `old-user.${APEX}`, "stray");
    old("A", "box.old-user.example.com");
    const r = await sweep();
    expect(r).toMatchObject({ scanned: 12, eligible: 4, deleted: 4, remaining: 0, dryRun: false });
    expect(r.names.sort()).toEqual(
      [`home.old-user.${APEX}`, `*.home.old-user.${APEX}`, `*.openai-build.${APEX}`, `openai-build.${APEX}`].sort(),
    );
    expect(cf.dump().filter((l) => !l.includes(`*.${APEX}`))).toEqual(
      [
        `A box.fresh-user.${APEX} ${RELAY.servicesIpv4}`,
        `A api.${APEX} 198.51.100.1`,
        `A home.gym.${APEX} ${RELAY.servicesIpv4}`,
        `TXT _acme-challenge.home.old-user.${APEX} token`,
        `TXT old-user.${APEX} stray`,
        "A box.old-user.example.com 203.0.113.7",
      ].sort(),
    );
  });

  it("deletes records of accounts that still serve too, since they block the wildcard", async () => {
    seedRoot();
    old("A", `home.live-user.${APEX}`);
    old("A", `*.live-user.${APEX}`);
    const r = await sweep();
    expect(r.deleted).toBe(2);
  });

  it("does nothing, and says so, until the root wildcard is in the zone", async () => {
    old("A", `home.old-user.${APEX}`);
    old("A", `*.old-user.${APEX}`);
    const r = await sweep();
    expect(r).toMatchObject({ eligible: 2, deleted: 0, remaining: 2, skipped: "root-wildcard-not-ready" });
    expect(cf.records).toHaveLength(2);
    // The wildcard at the wrong address is not ready either.
    cf.seed("A", `*.${APEX}`, "198.51.100.9", { modified_on: OLD });
    expect((await sweep()).skipped).toBe("root-wildcard-not-ready");
    expect(cf.records).toHaveLength(3);
  });

  it("reports candidates without deleting in dry-run mode", async () => {
    seedRoot();
    old("A", `box.old-user.${APEX}`);
    const r = await sweep({ dryRun: true });
    expect(r).toMatchObject({ eligible: 1, deleted: 0, remaining: 1, dryRun: true, names: [`box.old-user.${APEX}`] });
    expect(cf.records).toHaveLength(3);
  });

  it("caps one pass below the Worker subrequest limit and drains over repeated passes", async () => {
    seedRoot();
    for (let i = 0; i < 25; i++) old("A", `box.user-${i}.${APEX}`);
    const first = await sweep({ maxDeletes: 20 });
    expect(first).toMatchObject({ eligible: 25, deleted: 20, remaining: 5 });
    const second = await sweep({ maxDeletes: 20 });
    expect(second).toMatchObject({ eligible: 5, deleted: 5, remaining: 0 });
  });

  it("deletes the account's CAA first and the account wildcard last", async () => {
    seedRoot();
    old("A", `*.alice.${APEX}`);
    old("A", `home.alice.${APEX}`);
    old("CAA", `alice.${APEX}`, '0 issue "letsencrypt.org"');
    old("A", `*.home.alice.${APEX}`);
    const order: string[] = [];
    cf.afterRequest = (method, name) => {
      if (method === "DELETE" && name) order.push(name);
    };
    await sweep();
    expect(order).toEqual([`alice.${APEX}`, `home.alice.${APEX}`, `*.home.alice.${APEX}`, `*.alice.${APEX}`]);
  });

  it("leaves the protected accounts alone", async () => {
    seedRoot();
    old("A", `*.review.${APEX}`);
    old("CAA", `review.${APEX}`, '0 issue "letsencrypt.org"');
    old("A", `*.other.${APEX}`);
    const r = await sweep({ skipUsers: ["review"] });
    expect(r.deleted).toBe(1);
    expect(cf.dump().filter((l) => l.includes("review"))).toHaveLength(2);
  });
});
