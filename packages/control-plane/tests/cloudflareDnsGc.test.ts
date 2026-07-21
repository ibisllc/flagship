import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareDnsClient, type CloudflareDnsRecord } from "../src/cloudflareDns.js";

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

describe("CloudflareDnsClient orphaned server route cleanup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves active and unrelated routes while deleting old generated orphans", async () => {
    const old = "2026-07-20T10:00:00.000Z";
    const fresh = "2026-07-20T11:45:00.000Z";
    const records: CloudflareDnsRecord[] = [
      ["active-a", "A", "home.openai-build.flagship.services", old],
      ["active-wild", "AAAA", "*.home.openai-build.flagship.services", old],
      ["orphan-a", "A", "box.old-user.flagship.services", old],
      ["orphan-wild", "AAAA", "*.box.old-user.flagship.services", old],
      ["fresh-orphan", "A", "box.fresh-user.flagship.services", fresh],
      ["static", "A", "api.flagship.services", old],
      ["reserved-shape", "A", "home.gym.flagship.services", old],
      ["other-zone", "A", "box.old-user.example.com", old],
    ].map(([id, type, name, timestamp]) => ({
      id: id!,
      type: type!,
      name: name!,
      content: "203.0.113.1",
      proxied: false,
      ttl: 60,
      created_on: timestamp,
    }));
    const deleted: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(url.split("/").at(-1)!);
        return new Response(JSON.stringify({ success: true }));
      }
      const type = new URL(url).searchParams.get("type");
      return new Response(JSON.stringify({
        success: true,
        result: records.filter((record) => record.type === type),
        result_info: { total_pages: 1 },
      }));
    });

    const dns = new CloudflareDnsClient({ apiToken: "token", zoneId: "zone" });
    const result = await dns.deleteOrphanedServerRoutes({
      apex: "flagship.services",
      activeServerDomains: ["home.openai-build.flagship.services"],
      cutoffMs: Date.parse("2026-07-20T11:00:00.000Z"),
    });

    expect(result).toEqual({
      scanned: 8,
      eligible: 2,
      deleted: 2,
      remaining: 0,
      names: ["*.box.old-user.flagship.services", "box.old-user.flagship.services"],
      dryRun: false,
    });
    expect(deleted).toEqual(["orphan-a", "orphan-wild"]);
  });

  it("reports candidates without deleting in dry-run mode", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const type = new URL(url).searchParams.get("type");
      return new Response(JSON.stringify({
        success: true,
        result: type === "A" ? [{
          id: "orphan",
          type: "A",
          name: "box.old-user.flagship.services",
          content: "203.0.113.1",
          proxied: false,
          ttl: 60,
          created_on: "2026-07-20T10:00:00.000Z",
        }] : [],
        result_info: { total_pages: 1 },
      }));
    });
    const dns = new CloudflareDnsClient({ apiToken: "token", zoneId: "zone" });
    const result = await dns.deleteOrphanedServerRoutes({
      apex: "flagship.services",
      activeServerDomains: [],
      cutoffMs: Date.parse("2026-07-20T11:00:00.000Z"),
      dryRun: true,
    });
    expect(result).toMatchObject({ eligible: 1, deleted: 0, remaining: 1, dryRun: true });
  });

  it("caps one pass below the Worker subrequest limit", async () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      id: `orphan-${index}`,
      type: "A",
      name: `box.user-${index}.flagship.services`,
      content: "203.0.113.1",
      proxied: false,
      ttl: 60,
      created_on: "2026-07-20T10:00:00.000Z",
    }));
    const deleted: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(url.split("/").at(-1)!);
        return new Response(JSON.stringify({ success: true }));
      }
      const type = new URL(url).searchParams.get("type");
      return new Response(JSON.stringify({
        success: true,
        result: type === "A" ? records : [],
        result_info: { total_pages: 1 },
      }));
    });
    const dns = new CloudflareDnsClient({ apiToken: "token", zoneId: "zone" });
    const result = await dns.deleteOrphanedServerRoutes({
      apex: "flagship.services",
      activeServerDomains: [],
      cutoffMs: Date.parse("2026-07-20T11:00:00.000Z"),
      maxDeletes: 20,
    });
    expect(result).toMatchObject({ eligible: 25, deleted: 20, remaining: 5 });
    expect(deleted).toHaveLength(20);
  });
});
