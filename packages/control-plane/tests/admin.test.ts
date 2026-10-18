import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import {
  authorizeAdmin,
  handleCleanupApex,
  handleRepublishServerDns,
} from "../src/admin.js";
import { CloudflareDnsClient, type CloudflareDnsRecord } from "../src/cloudflareDns.js";

class FakeCfClient extends CloudflareDnsClient {
  upserts: Array<{ name: string; type: string; content: string }> = [];
  deletes: Array<{ name: string; type: string }> = [];
  failNext = false;

  constructor() {
    super({ apiToken: "fake", zoneId: "fake" });
  }
  override async upsert(opts: {
    name: string;
    type: "A" | "AAAA" | "TXT" | "CNAME";
    content: string;
  }): Promise<CloudflareDnsRecord> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("synthetic CF failure");
    }
    this.upserts.push({ name: opts.name, type: opts.type, content: opts.content });
    return {
      id: `cf-${this.upserts.length}`,
      type: opts.type,
      name: opts.name,
      content: opts.content,
      proxied: false,
      ttl: 60,
    };
  }
  override async deleteByName(name: string, type: string): Promise<number> {
    this.deletes.push({ name, type });
    return 1;
  }
}

describe("authorizeAdmin", () => {
  it("503 when the secret env isn't configured at all", () => {
    const r = authorizeAdmin({ expected: undefined, provided: "anything" });
    expect(r?.status).toBe(503);
  });
  it("401 when the header is missing", () => {
    const r = authorizeAdmin({ expected: "secret", provided: null });
    expect(r?.status).toBe(401);
  });
  it("403 on a wrong secret", () => {
    const r = authorizeAdmin({ expected: "secret", provided: "wrong" });
    expect(r?.status).toBe(403);
  });
  it("returns null (passes) on a matching secret", () => {
    expect(authorizeAdmin({ expected: "secret", provided: "secret" })).toBeNull();
  });
  it("constant-time compare: rejects strings of different lengths", () => {
    expect(authorizeAdmin({ expected: "secret", provided: "secrets" })?.status).toBe(403);
  });
});

describe("handleRepublishServerDns", () => {
  it("rewrites each account's wildcard A/AAAA and CAA once for every active server", async () => {
    const storage = new InMemoryStorage();
    await storage.servers.put({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      identityPubKeyHex: "aa".repeat(32),
      registeredAt: 1,
    });
    await storage.servers.put({
      serverDomain: "media.bob.flagship.services",
      username: "bob",
      identityPubKeyHex: "bb".repeat(32),
      registeredAt: 2,
    });
    const dns = new FakeCfClient();
    const r = await handleRepublishServerDns({
      servers: storage.servers,
      dns,
      servicesIpv4: "1.2.3.4",
      servicesIpv6: "::1",
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.ok).toBe(2);
    expect(r.body.failed).toBe(0);

    // One wildcard per account (docs/wildcard-dns.md): 2 accounts x (A + AAAA
    // + CAA issue + CAA issuewild) = 8 upserts, and no per-box record.
    expect(dns.upserts.length).toBe(8);
    const names = dns.upserts.map((u) => `${u.type} ${u.name} ${u.content}`).sort();
    expect(names).toContain("A *.alice.flagship.services 1.2.3.4");
    expect(names).toContain("AAAA *.alice.flagship.services ::1");
    expect(names).toContain("AAAA *.bob.flagship.services ::1");
    expect(names).toContain('CAA alice.flagship.services 0 issue "letsencrypt.org"');
    expect(names).toContain('CAA bob.flagship.services 0 issuewild "letsencrypt.org"');
    expect(names.some((n) => n.includes("home.alice") || n.includes("media.bob"))).toBe(false);
    // No CAA copy at the wildcard node.
    expect(names.some((n) => n.startsWith("CAA *."))).toBe(false);
  });

  it("publishes the account set ONCE however many servers the user has", async () => {
    const storage = new InMemoryStorage();
    await storage.servers.put({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      identityPubKeyHex: "aa".repeat(32),
      registeredAt: 1,
    });
    await storage.servers.put({
      serverDomain: "media.alice.flagship.services",
      username: "alice",
      identityPubKeyHex: "cc".repeat(32),
      registeredAt: 2,
    });
    const dns = new FakeCfClient();
    const r = await handleRepublishServerDns({
      servers: storage.servers,
      dns,
      servicesIpv4: "1.2.3.4",
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2); // both servers reported
    expect(r.body.ok).toBe(2);
    // One wildcard A (no IPv6 configured) + the two CAA, once for the account.
    expect(dns.upserts.map((u) => `${u.type} ${u.name}`).sort()).toEqual([
      "A *.alice.flagship.services",
      "CAA alice.flagship.services",
      "CAA alice.flagship.services",
    ]);
  });

  it("skips revoked servers", async () => {
    const storage = new InMemoryStorage();
    await storage.servers.put({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      identityPubKeyHex: "aa".repeat(32),
      registeredAt: 1,
    });
    await storage.servers.revoke("home.alice.flagship.services", "test", 100);
    const dns = new FakeCfClient();
    const r = await handleRepublishServerDns({
      servers: storage.servers,
      dns,
      servicesIpv4: "1.2.3.4",
    });
    expect(r.body.total).toBe(0);
    expect(dns.upserts.length).toBe(0);
  });

  it("surfaces per-server errors without failing the whole run", async () => {
    const storage = new InMemoryStorage();
    await storage.servers.put({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      identityPubKeyHex: "aa".repeat(32),
      registeredAt: 1,
    });
    await storage.servers.put({
      serverDomain: "media.bob.flagship.services",
      username: "bob",
      identityPubKeyHex: "bb".repeat(32),
      registeredAt: 2,
    });
    const dns = new FakeCfClient();
    dns.failNext = true; // first upsert call fails
    const r = await handleRepublishServerDns({
      servers: storage.servers,
      dns,
      servicesIpv4: "1.2.3.4",
    });
    expect(r.body.failed).toBe(1);
    expect(r.body.ok).toBe(1);
    expect(r.body.outcomes.find((o) => !o.ok)?.error).toMatch(/synthetic/);
  });

  it("works with no IPv6 (some users may run a v4-only zone temporarily)", async () => {
    const storage = new InMemoryStorage();
    await storage.servers.put({
      serverDomain: "home.alice.flagship.services",
      username: "alice",
      identityPubKeyHex: "aa".repeat(32),
      registeredAt: 1,
    });
    const dns = new FakeCfClient();
    const r = await handleRepublishServerDns({
      servers: storage.servers,
      dns,
      servicesIpv4: "1.2.3.4",
      // no servicesIpv6
    });
    expect(r.body.ok).toBe(1);
    expect(dns.upserts.some((u) => u.type === "AAAA")).toBe(false);
    expect(dns.upserts.filter((u) => u.type === "A")).toHaveLength(1); // the account wildcard, A only
  });
});

describe("handleCleanupApex", () => {
  it("deletes both A and AAAA on the apex and reports counts", async () => {
    const dns = new FakeCfClient();
    const r = await handleCleanupApex({ dns, apex: "flagship.services" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, apex: "flagship.services", deletedA: 1, deletedAaaa: 1 });
    expect(dns.deletes).toEqual([
      { name: "flagship.services", type: "A" },
      { name: "flagship.services", type: "AAAA" },
    ]);
  });
});
