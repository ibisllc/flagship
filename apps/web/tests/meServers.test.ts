import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  deriveSTK,
  signRebuildRequest,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import {
  InMemoryServerRegistry,
} from "../src/routes/serverRegistry.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const harryIrk = deriveIRK(harryUmk);
const harryStk = deriveSTK(deriveSWK(harryUmk, "srv-1"));

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function pairDesktop(app: ReturnType<typeof buildServer>) {
  const desktopPub = bytesToHex(new Uint8Array(32).fill(0xab));
  const start = await app.inject({
    method: "POST",
    url: "/api/desktop/pair/start",
    payload: { desktopPubKey: desktopPub },
  });
  const sessionId = JSON.parse(start.body).sessionId as string;
  const phonePub = new Uint8Array(32).fill(0xcd);
  const issuedAt = Date.now();
  const claim = {
    userId: "harry",
    newServerId: `desktop-pair:${sessionId}`,
    wifiSsid: desktopPub,
    wifiPskHash: phonePub,
    shareRatio: 0,
    issuedAt,
  };
  const sig = signRebuildRequest(claim, harryIrk);
  const confirm = await app.inject({
    method: "POST",
    url: "/api/desktop/pair/confirm",
    payload: {
      sessionId,
      userId: "harry",
      phonePubKey: bytesToHex(phonePub),
      irkSignature: bytesToHex(sig),
      issuedAt,
    },
  });
  expect(confirm.statusCode).toBe(200);
  return sessionId;
}

function makeApp() {
  const registry = new InMemoryServerRegistry();
  registry.put({
    userId: "harry",
    serverId: "srv-1",
    stkPub: harryStk.publicKey,
    registeredAt: Date.now(),
  });
  registry.put({
    userId: "harry",
    serverId: "srv-2",
    stkPub: harryStk.publicKey,
    registeredAt: Date.now(),
  });
  registry.put({
    userId: "ghost",
    serverId: "srv-other",
    stkPub: harryStk.publicKey,
    registeredAt: Date.now(),
  });
  registry.revoke("srv-2", "stolen", Date.now());
  const app = buildServer({
    serverRegistry: registry,
    resolveUserIrk: (uid) => (uid === "harry" ? harryIrk.publicKey : null),
    desktopPair: { resolveIrkPubKey: (uid) => (uid === "harry" ? harryIrk.publicKey : null) },
  });
  return { app, registry };
}

describe("/api/me/servers", () => {
  it("returns the user's servers, including revocation status, for a paired session", async () => {
    const { app } = makeApp();
    const sid = await pairDesktop(app);
    const r = await app.inject({
      method: "GET",
      url: `/api/me/servers?sessionId=${sid}`,
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.userId).toBe("harry");
    const ids = body.servers.map((s: { serverId: string }) => s.serverId).sort();
    expect(ids).toEqual(["srv-1", "srv-2"]);
    const srv2 = body.servers.find((s: { serverId: string }) => s.serverId === "srv-2");
    expect(srv2.revoked.reason).toBe("stolen");
  });

  it("does not leak other users' servers", async () => {
    const { app } = makeApp();
    const sid = await pairDesktop(app);
    const r = await app.inject({
      method: "GET",
      url: `/api/me/servers?sessionId=${sid}`,
    });
    const body = JSON.parse(r.body);
    expect(body.servers.find((s: { serverId: string }) => s.serverId === "srv-other")).toBeUndefined();
  });

  it("rejects requests without a sessionId (400)", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/api/me/servers" });
    expect(r.statusCode).toBe(400);
  });

  it("rejects unknown / unpaired sessions (401)", async () => {
    const { app } = makeApp();
    const r = await app.inject({
      method: "GET",
      url: "/api/me/servers?sessionId=ffffffffffffffff",
    });
    expect(r.statusCode).toBe(401);
  });
});
