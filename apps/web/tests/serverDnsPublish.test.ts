import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  signPublishServerDns,
  type PublishServerDns,
} from "@flagship/protocol";
import {
  InMemoryServerDnsRegistry,
  ServerDnsPublisher,
  type TxtRecord,
  type ZoneApi,
} from "@flagship/services-zone";
import { buildServer } from "../src/server.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const sarahIrk = deriveIRK({ seed: new Uint8Array(32).fill(22) });

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

class FakeZone implements ZoneApi {
  records: { id: string; name: string; value: string }[] = [];
  a: { id: string; name: string; value: string }[] = [];
  private nextId = 1;
  async createTxt(record: { name: string; value: string }): Promise<TxtRecord> {
    const id = `txt-${this.nextId++}`;
    this.records.push({ id, ...record });
    return { id, name: record.name, value: record.value };
  }
  async deleteTxt(id: string) {
    this.records = this.records.filter((r) => r.id !== id);
  }
  async listTxtByName(name: string) {
    return this.records.filter((r) => r.name === name);
  }
  async createA(record: { name: string; value: string }) {
    const id = `a-${this.nextId++}`;
    this.a.push({ id, ...record });
    return { id };
  }
  async deleteA(id: string) {
    this.a = this.a.filter((r) => r.id !== id);
  }
  async listAByName(name: string) {
    return this.a.filter((r) => r.name === name);
  }
}

function makeApp() {
  const zone = new FakeZone();
  const registry = new InMemoryServerDnsRegistry();
  const app = buildServer({
    surface: "services",
    zone,
    serverDnsRegistry: registry,
    tunnelIngressIp: "203.0.113.1",
    resolveUserIrk: (uid) => {
      if (uid === "harry") return harryIrk.publicKey;
      if (uid === "sarah") return sarahIrk.publicKey;
      return null;
    },
  });
  return { app, zone, registry };
}

function buildSignedPublish(
  over: Partial<PublishServerDns> = {},
  signer = harryIrk,
) {
  const claim: PublishServerDns = {
    userId: over.userId ?? "harry",
    serverId: over.serverId ?? "home-box",
    mode: over.mode ?? "tunnel",
    directIp: over.directIp ?? "",
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      userId: claim.userId,
      serverId: claim.serverId,
      mode: claim.mode,
      directIp: claim.directIp,
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(signPublishServerDns(claim, signer)),
  };
}

describe("/api/services-zone/publish-server", () => {
  it("accepts a valid IRK-signed tunnel claim and writes no record (the zone wildcard answers the box)", async () => {
    const { app, zone } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/publish-server",
      payload: buildSignedPublish({ mode: "tunnel" }),
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.target).toBe("203.0.113.1");
    expect(zone.a).toEqual([]);
  });

  it("clears the per-box records an older build left for the box", async () => {
    const { app, zone } = makeApp();
    await zone.createA({ name: "home-box.harry.flagship.services", value: "203.0.113.1" });
    await zone.createA({ name: "*.home-box.harry.flagship.services", value: "203.0.113.1" });
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/publish-server",
      payload: buildSignedPublish({ mode: "tunnel" }),
    });
    expect(r.statusCode).toBe(200);
    expect(zone.a).toEqual([]);
  });

  it("refuses mode=direct with direct-mode-unsupported and writes nothing", async () => {
    const { app, zone } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/publish-server",
      payload: buildSignedPublish({ mode: "direct", directIp: "192.0.2.10" }),
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe("direct-mode-unsupported");
    expect(zone.a).toEqual([]);
  });

  it("rejects forged signatures (Sarah signing for Harry)", async () => {
    const { app, zone } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/publish-server",
      payload: buildSignedPublish({ userId: "harry" }, sarahIrk),
    });
    expect(r.statusCode).toBe(403);
    expect(zone.a).toHaveLength(0);
  });

  it("rejects stale claims (5-minute replay window)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/publish-server",
      payload: buildSignedPublish({ issuedAt: Date.now() - 6 * 60_000 }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("DELETE removes the box's leftover records", async () => {
    const { app, zone } = makeApp();
    await zone.createA({ name: "home-box.harry.flagship.services", value: "203.0.113.1" });
    const del = await app.inject({
      method: "DELETE",
      url: "/api/services-zone/server/harry/home-box",
      payload: buildSignedPublish(),
    });
    expect(del.statusCode).toBe(200);
    expect(zone.a).toHaveLength(0);
  });

  it("DELETE rejects when URL params and signed claim disagree", async () => {
    const { app } = makeApp();
    const del = await app.inject({
      method: "DELETE",
      url: "/api/services-zone/server/harry/chillout", // URL says chillout
      payload: buildSignedPublish({ serverId: "home-box" }), // signed for home-box
    });
    expect(del.statusCode).toBe(400);
  });
});

describe(".com surface does NOT host the publish-server route", () => {
  it("returns 404 in surface=com mode (route is .services-only)", async () => {
    const app = buildServer({
      surface: "com",
      zone: new FakeZone(),
      tunnelIngressIp: "203.0.113.1",
      resolveUserIrk: (uid) => (uid === "harry" ? harryIrk.publicKey : null),
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/publish-server",
      payload: buildSignedPublish(),
    });
    expect(r.statusCode).toBe(404);
  });
});
