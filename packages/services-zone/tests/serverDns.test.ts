import { describe, expect, it } from "vitest";
import {
  DirectModeUnsupportedError,
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

function publisher(zone: FakeZoneApi) {
  return new ServerDnsPublisher({ zone, registry: new InMemoryServerDnsRegistry(), tunnelIngressIp: "203.0.113.1" });
}

describe("ServerDnsPublisher (root-wildcard layout, docs/wildcard-dns.md)", () => {
  it("publishes NOTHING for mode=tunnel: the zone wildcard answers the box", async () => {
    const zone = new FakeZoneApi();
    const registry = new InMemoryServerDnsRegistry();
    const out = await new ServerDnsPublisher({ zone, registry, tunnelIngressIp: "203.0.113.1" }).publish({
      username: "harry",
      serverName: "home-box",
      mode: "tunnel",
    });
    expect(out.apex).toBe("home-box.harry.flagship.services");
    expect(out.wildcard).toBe("*.home-box.harry.flagship.services");
    expect(out.target).toBe("203.0.113.1");
    expect(zone.a).toEqual([]);
    expect(zone.txt).toEqual([]);
    expect(registry.get("home-box.harry.flagship.services")).toBeDefined();
  });

  it("writes nothing for any number of boxes of one user", async () => {
    const zone = new FakeZoneApi();
    const p = publisher(zone);
    await p.publish({ username: "harry", serverName: "home-box", mode: "tunnel" });
    await p.publish({ username: "harry", serverName: "chillout", mode: "tunnel" });
    expect(zone.a).toEqual([]);
  });

  it("a tunnel publish removes older per-box records of the same box, and only that box", async () => {
    const zone = new FakeZoneApi();
    await zone.createA({ name: "home-box.harry.flagship.services", value: "203.0.113.1" });
    await zone.createA({ name: "*.home-box.harry.flagship.services", value: "203.0.113.1" });
    await zone.createA({ name: "chillout.harry.flagship.services", value: "203.0.113.1" });
    await publisher(zone).publish({ username: "harry", serverName: "home-box", mode: "tunnel" });
    expect(zone.a.map((r) => r.name)).toEqual(["chillout.harry.flagship.services"]);
  });

  it("refuses mode=direct: a record at the box name would stop the wildcard below it", async () => {
    const zone = new FakeZoneApi();
    await expect(
      publisher(zone).publish({ username: "harry", serverName: "home-box", mode: "direct", directIp: "192.0.2.10" }),
    ).rejects.toBeInstanceOf(DirectModeUnsupportedError);
    await expect(
      publisher(zone).publish({ username: "harry", serverName: "home-box", mode: "direct" }),
    ).rejects.toThrow(/not supported/);
    expect(zone.a).toEqual([]);
  });

  it("rejects non-DNS-label inputs (defense against injection through username/serverName)", async () => {
    const p = publisher(new FakeZoneApi());
    await expect(p.publish({ username: "Has-Caps", serverName: "home-box", mode: "tunnel" })).rejects.toThrow(/RFC 1035/);
    await expect(p.publish({ username: "harry", serverName: "with.dot", mode: "tunnel" })).rejects.toThrow(/RFC 1035/);
  });

  it("unpublish removes the box's own leftovers and nothing else", async () => {
    const zone = new FakeZoneApi();
    await zone.createA({ name: "home-box.harry.flagship.services", value: "203.0.113.1" });
    await zone.createA({ name: "*.home-box.harry.flagship.services", value: "203.0.113.1" });
    await zone.createA({ name: "*.harry.flagship.services", value: "203.0.113.1" });
    await publisher(zone).unpublish({ username: "harry", serverName: "home-box" });
    expect(zone.a.map((r) => r.name)).toEqual(["*.harry.flagship.services"]);
  });
});
