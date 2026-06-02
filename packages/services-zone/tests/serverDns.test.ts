import { describe, expect, it } from "vitest";
import {
  InMemoryServerDnsRegistry,
  ServerDnsPublisher,
} from "../src/serverDns.js";
import type { TxtRecord, ZoneApi } from "../src/types.js";

interface AStore {
  id: string;
  name: string;
  value: string;
}

class FakeZoneApi implements ZoneApi {
  txt: { id: string; name: string; value: string }[] = [];
  a: AStore[] = [];
  private nextId = 1;

  async createTxt(record: { name: string; value: string; ttl?: number }): Promise<TxtRecord> {
    const id = `txt-${this.nextId++}`;
    this.txt.push({ id, name: record.name, value: record.value });
    return { id, name: record.name, value: record.value, ttl: record.ttl };
  }
  async deleteTxt(id: string): Promise<void> {
    this.txt = this.txt.filter((r) => r.id !== id);
  }
  async listTxtByName(name: string): Promise<TxtRecord[]> {
    return this.txt.filter((r) => r.name === name);
  }

  async createA(record: { name: string; value: string; ttl?: number }): Promise<{ id?: string }> {
    const id = `a-${this.nextId++}`;
    this.a.push({ id, name: record.name, value: record.value });
    return { id };
  }
  async deleteA(id: string): Promise<void> {
    this.a = this.a.filter((r) => r.id !== id);
  }
  async listAByName(name: string): Promise<{ id?: string; value: string }[]> {
    return this.a.filter((r) => r.name === name);
  }
}

describe("ServerDnsPublisher", () => {
  it("publishes apex + wildcard A records pointing at the tunnel ingress for mode=tunnel", async () => {
    const zone = new FakeZoneApi();
    const registry = new InMemoryServerDnsRegistry();
    const publisher = new ServerDnsPublisher({
      zone,
      registry,
      tunnelIngressIp: "203.0.113.1",
    });
    const out = await publisher.publish({
      username: "harry",
      serverName: "home-box",
      mode: "tunnel",
    });
    // PER-USER DNS (task #23): two user-zone records, NOT per-server. The box
    // apex `home-box.harry` resolves via the `*.harry` wildcard.
    expect(out.apex).toBe("harry.flagship.services");
    expect(out.wildcard).toBe("*.harry.flagship.services");
    expect(out.target).toBe("203.0.113.1");
    expect(zone.a.map((r) => r.name).sort()).toEqual([
      "*.harry.flagship.services",
      "harry.flagship.services",
    ]);
    for (const r of zone.a) expect(r.value).toBe("203.0.113.1");
  });

  it("publishes A records pointing at the user-supplied IP for mode=direct", async () => {
    const zone = new FakeZoneApi();
    const publisher = new ServerDnsPublisher({
      zone,
      registry: new InMemoryServerDnsRegistry(),
      tunnelIngressIp: "203.0.113.1",
    });
    const out = await publisher.publish({
      username: "harry",
      serverName: "home-box",
      mode: "direct",
      directIp: "192.0.2.10",
    });
    expect(out.target).toBe("192.0.2.10");
    for (const r of zone.a) expect(r.value).toBe("192.0.2.10");
  });

  it("flipping tunnel → direct removes the old records before writing the new (clean zone)", async () => {
    const zone = new FakeZoneApi();
    const publisher = new ServerDnsPublisher({
      zone,
      registry: new InMemoryServerDnsRegistry(),
      tunnelIngressIp: "203.0.113.1",
    });
    await publisher.publish({ username: "harry", serverName: "home-box", mode: "tunnel" });
    expect(zone.a.every((r) => r.value === "203.0.113.1")).toBe(true);
    await publisher.publish({
      username: "harry",
      serverName: "home-box",
      mode: "direct",
      directIp: "192.0.2.10",
    });
    expect(zone.a.every((r) => r.value === "192.0.2.10")).toBe(true);
    expect(zone.a).toHaveLength(2); // apex + wildcard, no stragglers
  });

  it("rejects mode=direct without a directIp", async () => {
    const zone = new FakeZoneApi();
    const publisher = new ServerDnsPublisher({
      zone,
      registry: new InMemoryServerDnsRegistry(),
      tunnelIngressIp: "203.0.113.1",
    });
    await expect(
      publisher.publish({ username: "harry", serverName: "home-box", mode: "direct" }),
    ).rejects.toThrow(/directIp required/);
  });

  it("rejects malformed IPs at the boundary", async () => {
    const zone = new FakeZoneApi();
    const publisher = new ServerDnsPublisher({
      zone,
      registry: new InMemoryServerDnsRegistry(),
      tunnelIngressIp: "203.0.113.1",
    });
    await expect(
      publisher.publish({ username: "harry", serverName: "home-box", mode: "direct", directIp: "not-an-ip" }),
    ).rejects.toThrow(/IPv4|IPv6/);
  });

  it("rejects non-DNS-label inputs (defense against injection through username/serverName)", async () => {
    const zone = new FakeZoneApi();
    const publisher = new ServerDnsPublisher({
      zone,
      registry: new InMemoryServerDnsRegistry(),
      tunnelIngressIp: "203.0.113.1",
    });
    await expect(
      publisher.publish({ username: "Has-Caps", serverName: "home-box", mode: "tunnel" }),
    ).rejects.toThrow(/RFC 1035/);
    await expect(
      publisher.publish({ username: "harry", serverName: "with.dot", mode: "tunnel" }),
    ).rejects.toThrow(/RFC 1035/);
  });

  it("unpublish removes both records for the named server", async () => {
    const zone = new FakeZoneApi();
    const publisher = new ServerDnsPublisher({
      zone,
      registry: new InMemoryServerDnsRegistry(),
      tunnelIngressIp: "203.0.113.1",
    });
    await publisher.publish({ username: "harry", serverName: "home-box", mode: "tunnel" });
    expect(zone.a).toHaveLength(2);
    await publisher.unpublish({ username: "harry", serverName: "home-box" });
    expect(zone.a).toHaveLength(0);
  });
});
