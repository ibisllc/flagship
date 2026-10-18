import { describe, expect, it } from "vitest";
import {
  authorizeAdmin,
  handleCleanupApex,
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
