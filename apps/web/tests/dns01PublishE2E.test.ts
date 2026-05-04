import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  deriveIRK,
  deriveSTK,
  deriveSWK,
  signDns01Delete,
  signDns01Publish,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
} from "@flagship/protocol";
import type { TxtRecord, ZoneApi } from "@flagship/services-zone";
import { buildServer } from "../src/server.js";
import { InMemoryServerRegistry } from "../src/routes/serverRegistry.js";
import { RemoteDnsChallengeWriter } from "@flagship/server-daemon";
import type { FetchLike } from "@flagship/llm-providers";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const homeBoxSwk = deriveSWK(harryUmk, "home-box");
const homeBoxStk = deriveSTK(homeBoxSwk);

const sarahStk = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(22) }, "sarah-srv"));

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

class FakeZone implements ZoneApi {
  records: { id: string; name: string; value: string }[] = [];
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
}

function makeApp() {
  const registry = new InMemoryServerRegistry();
  registry.put({
    userId: "harry",
    serverId: "home-box",
    stkPub: homeBoxStk.publicKey,
    registeredAt: Date.now(),
  });
  const zone = new FakeZone();
  const app = buildServer({
    surface: "services",
    serverRegistry: registry,
    zone,
    tunnelIngressIp: "203.0.113.1",
    resolveUserIrk: (uid) => (uid === "harry" ? harryIrk.publicKey : null),
  });
  return { app, zone, registry };
}

function buildSignedPublish(
  recordValue: string,
  over: Partial<Dns01PublishRequest> = {},
  signer = homeBoxStk,
) {
  const recordName = over.recordName ?? "_acme-challenge.home-box.harry.flagship.services";
  const recordValueHash = sha256(new TextEncoder().encode(recordValue));
  const claim: Dns01PublishRequest = {
    serverId: over.serverId ?? "home-box",
    recordName,
    recordValueHash,
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: {
      serverId: claim.serverId,
      recordName: claim.recordName,
      recordValueHash: bytesToHex(claim.recordValueHash),
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(signDns01Publish(claim, signer)),
    recordValue,
  };
}

describe("/api/services-zone/dns-01-publish", () => {
  it("STK-signed publish writes a TXT under the server's namespace", async () => {
    const { app, zone } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-publish",
      payload: buildSignedPublish("acme-token-thumb"),
    });
    expect(r.statusCode).toBe(200);
    expect(zone.records).toHaveLength(1);
    expect(zone.records[0]!.value).toBe("acme-token-thumb");
  });

  it("rejects when recordName is outside the signing server's namespace", async () => {
    const { app, zone } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-publish",
      payload: buildSignedPublish("v", {
        // home-box is signing but the recordName is for a different server
        recordName: "_acme-challenge.chillout.harry.flagship.services",
      }),
    });
    expect(r.statusCode).toBe(403);
    expect(zone.records).toHaveLength(0);
  });

  it("rejects when recordValue plaintext doesn't match the signed hash (no swap-after-sign)", async () => {
    const { app } = makeApp();
    const payload = buildSignedPublish("the-real-value");
    payload.recordValue = "swapped-value";
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-publish",
      payload,
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects forged STK signatures (sarah's STK can't sign for harry's server)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-publish",
      payload: buildSignedPublish("v", {}, sarahStk),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects when the server is revoked", async () => {
    const { app, registry } = makeApp();
    registry.revoke("home-box", "stolen", Date.now());
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-publish",
      payload: buildSignedPublish("v"),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects names that aren't ACME challenges", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-publish",
      payload: buildSignedPublish("v", {
        recordName: "evil.home-box.harry.flagship.services",
      }),
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("/api/services-zone/dns-01-delete", () => {
  it("removes a previously-published record on STK-signed delete", async () => {
    const { app, zone } = makeApp();
    const pub = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-publish",
      payload: buildSignedPublish("token"),
    });
    const { recordId } = JSON.parse(pub.body);
    expect(zone.records).toHaveLength(1);

    const issuedAt = Date.now();
    const dClaim: Dns01DeleteRequest = { serverId: "home-box", recordId, issuedAt };
    const del = await app.inject({
      method: "POST",
      url: "/api/services-zone/dns-01-delete",
      payload: {
        request: { serverId: "home-box", recordId, issuedAt },
        signature: bytesToHex(signDns01Delete(dClaim, homeBoxStk)),
      },
    });
    expect(del.statusCode).toBe(200);
    expect(zone.records).toHaveLength(0);
  });
});

describe("end-to-end: RemoteDnsChallengeWriter → /api/services-zone/dns-01-publish", () => {
  it("the daemon's writer publishes a TXT and returns a working disposer", async () => {
    const { app, zone } = makeApp();
    // Bridge fetch to the in-process Fastify via `inject`.
    const inProcessFetch: FetchLike = async (url, init) => {
      const u = new URL(url);
      const r = await app.inject({
        method: (init?.method ?? "GET") as "POST" | "GET",
        url: u.pathname + u.search,
        payload: init?.body ? JSON.parse(init.body) : undefined,
        headers: init?.headers,
      });
      return {
        ok: r.statusCode >= 200 && r.statusCode < 300,
        status: r.statusCode,
        async text() {
          return r.body;
        },
        async json() {
          return JSON.parse(r.body);
        },
      };
    };

    const writer = new RemoteDnsChallengeWriter({
      servicesBaseUrl: "https://flagship.services",
      serverId: "home-box",
      stk: homeBoxStk,
      fetchImpl: inProcessFetch,
    });

    const dispose = await writer.publishTxt(
      "_acme-challenge.home-box.harry.flagship.services",
      "key-auth-thumb",
    );
    expect(zone.records).toHaveLength(1);
    expect(zone.records[0]!.value).toBe("key-auth-thumb");

    await dispose();
    expect(zone.records).toHaveLength(0);
  });
});
