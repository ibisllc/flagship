import { describe, expect, it } from "vitest";
import { publishUserZoneCaa, type CaaUpsertClient } from "../src/caaPublish.js";

/**
 * In-memory CAA-capable DNS client that mirrors the idempotent-by-rdata
 * behaviour of the real `CloudflareDnsClient.upsert` for CAA: a record whose
 * (name, rdata) already exists is a no-op rather than a duplicate.
 */
class FakeCaaDns implements CaaUpsertClient {
  records = new Map<string, { id: string; name: string; content: string }>();
  upsertCalls = 0;
  createCount = 0;

  async upsert(opts: {
    name: string;
    type: "CAA";
    content: string;
    data?: { flags: number; tag: string; value: string };
    ttl?: number;
  }): Promise<{ id: string; name: string; content: string }> {
    this.upsertCalls += 1;
    const key = `${opts.name}|${opts.content}`;
    const existing = this.records.get(key);
    if (existing) return existing;
    this.createCount += 1;
    const rec = { id: `caa-${this.createCount}`, name: opts.name, content: opts.content };
    this.records.set(key, rec);
    return rec;
  }
}

describe("publishUserZoneCaa", () => {
  it("publishes the exact CA-restriction rdata at the apex and the wildcard", async () => {
    const dns = new FakeCaaDns();
    const published = await publishUserZoneCaa({ client: dns, userZone: "alice.flagship.services" });

    const set = published.map((p) => `${p.name} :: ${p.rdata}`).sort();
    expect(set).toEqual(
      [
        'alice.flagship.services :: 0 issue "letsencrypt.org"',
        'alice.flagship.services :: 0 issuewild "letsencrypt.org"',
        'alice.flagship.services :: 0 iodef "mailto:security@flagshipserver.com"',
        '*.alice.flagship.services :: 0 issue "letsencrypt.org"',
        '*.alice.flagship.services :: 0 issuewild "letsencrypt.org"',
        '*.alice.flagship.services :: 0 iodef "mailto:security@flagshipserver.com"',
      ].sort(),
    );
  });

  it("passes Cloudflare's structured CAA `data` field through to the client", async () => {
    let captured: { flags: number; tag: string; value: string } | undefined;
    const client: CaaUpsertClient = {
      async upsert(opts) {
        if (opts.data && opts.data.tag === "issue") captured = opts.data;
        return { id: "x", name: opts.name, content: opts.content };
      },
    };
    await publishUserZoneCaa({ client, userZone: "bob.flagship.services" });
    expect(captured).toEqual({ flags: 0, tag: "issue", value: "letsencrypt.org" });
  });

  it("is idempotent — a second publish creates NO duplicate records", async () => {
    const dns = new FakeCaaDns();
    await publishUserZoneCaa({ client: dns, userZone: "alice.flagship.services" });
    const afterFirst = dns.createCount;
    await publishUserZoneCaa({ client: dns, userZone: "alice.flagship.services" });
    expect(dns.createCount).toBe(afterFirst); // no new records created
    expect(dns.records.size).toBe(6); // 3 tags × {apex, wildcard}
    expect(dns.upsertCalls).toBe(12); // called both times, but second round all no-ops
  });

  it("threads custom CA domain / iodef through", async () => {
    const dns = new FakeCaaDns();
    const published = await publishUserZoneCaa({
      client: dns,
      userZone: "eve.flagship.services",
      options: { caDomain: "pki.goog", iodef: "" },
    });
    expect(published.some((p) => p.rdata.includes("pki.goog"))).toBe(true);
    expect(published.some((p) => p.rdata.includes("iodef"))).toBe(false);
    expect(published).toHaveLength(4); // issue + issuewild × {apex, wildcard}
  });
});
