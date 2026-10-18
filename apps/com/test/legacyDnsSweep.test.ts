import { afterEach, describe, expect, it, vi } from "vitest";
import { runLegacyDnsSweepCron } from "../src/scheduled.js";

// Root-wildcard layout (docs/wildcard-dns.md): the hourly sweep removes what
// the older layouts left at account and box names, and only once the root
// wildcard is in the zone.

const ENV = {
  CLOUDFLARE_DNS_API_TOKEN: "t",
  CLOUDFLARE_SERVICES_ZONE_ID: "z",
  SERVICES_APEX: "flagship.services",
  SERVICES_PASSTHROUGH_IPV4: "203.0.113.7",
  SERVICES_PASSTHROUGH_IPV6: "2001:db8::7",
};
const OLD = "2026-07-20T10:00:00.000Z";
const NOW = new Date("2026-07-20T12:00:00.000Z");

function zone(rows: Array<[string, string, string]>) {
  const records = rows.map(([type, name, content], i) => ({
    id: String(i + 1).padStart(32, "0"),
    type,
    name,
    content,
    proxied: false,
    ttl: 60,
    created_on: OLD,
    modified_on: OLD,
  }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      const id = url.split("/").at(-1)!;
      const i = records.findIndex((r) => r.id === id);
      if (i >= 0) records.splice(i, 1);
      return new Response(JSON.stringify({ success: true }));
    }
    return new Response(JSON.stringify({ success: true, result: records, result_info: { total_pages: 1 } }));
  });
  return records;
}

const ROOT: Array<[string, string, string]> = [
  ["A", "*.flagship.services", "203.0.113.7"],
  ["AAAA", "*.flagship.services", "2001:db8::7"],
];

describe("runLegacyDnsSweepCron", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing without Cloudflare credentials or a relay address", async () => {
    expect(await runLegacyDnsSweepCron({}, NOW)).toBeNull();
    expect(await runLegacyDnsSweepCron({ ...ENV, SERVICES_PASSTHROUGH_IPV4: undefined }, NOW)).toBeNull();
  });

  it("removes the legacy records once the root wildcard is in the zone", async () => {
    const records = zone([...ROOT, ["A", "*.alice.flagship.services", "203.0.113.7"], ["CAA", "alice.flagship.services", '0 issue "letsencrypt.org"']]);
    const r = await runLegacyDnsSweepCron(ENV, NOW);
    expect(r).toMatchObject({ eligible: 2, deleted: 2, remaining: 0 });
    expect(records.map((x) => x.name)).toEqual(["*.flagship.services", "*.flagship.services"]);
  });

  it("waits while the root wildcard is missing", async () => {
    const records = zone([["A", "*.alice.flagship.services", "203.0.113.7"]]);
    const r = await runLegacyDnsSweepCron(ENV, NOW);
    expect(r).toMatchObject({ deleted: 0, skipped: "root-wildcard-not-ready" });
    expect(records).toHaveLength(1);
  });

  it("leaves the protected store-review account alone", async () => {
    const records = zone([...ROOT, ["A", "*.playstore-test-0725.flagship.services", "203.0.113.7"], ["A", "*.alice.flagship.services", "203.0.113.7"]]);
    const r = await runLegacyDnsSweepCron(ENV, NOW);
    expect(r?.deleted).toBe(1);
    expect(records.map((x) => x.name)).toContain("*.playstore-test-0725.flagship.services");
  });
});
