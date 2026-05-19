import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  deriveIRK,
  signMigrationRequest,
  type MigrationRequest,
} from "@flagship/protocol";
import { registerMigration } from "../src/routes/migration.js";
import { bytesToHex } from "../src/lib/hex.js";

const harryUmk = { seed: new Uint8Array(32).fill(11) };
const sarahUmk = { seed: new Uint8Array(32).fill(33) };
const mallory = { seed: new Uint8Array(32).fill(99) };

const harryIrk = deriveIRK(harryUmk);
const sarahIrk = deriveIRK(sarahUmk);
const malloryIrk = deriveIRK(mallory);

function makeApp(now = () => Date.now()) {
  const app = Fastify({ logger: false });
  registerMigration(app, {
    resolveIrkPubKey: (uid) => {
      if (uid === "harry") return harryIrk.publicKey;
      if (uid === "sarah") return sarahIrk.publicKey;
      return null;
    },
    now,
  });
  return app;
}

function makeRequest(overrides: Partial<MigrationRequest> = {}): MigrationRequest {
  return {
    serviceId: "habit-tracker",
    fromUser: "harry",
    toUser: "sarah",
    mode: "cut",
    withData: true,
    issuedAt: Date.now(),
    ...overrides,
  };
}

async function start(app: ReturnType<typeof makeApp>, request: MigrationRequest, signer = harryIrk) {
  const sig = signMigrationRequest(request, signer);
  return app.inject({
    method: "POST",
    url: "/api/migration/start",
    payload: {
      request,
      signature: bytesToHex(sig),
    },
  });
}

describe("migration matchmaker", () => {
  it("happy path: start → accept → complete (cut + with-data)", async () => {
    const app = makeApp();
    const r = makeRequest({ mode: "cut", withData: true });

    const startRes = await start(app, r);
    expect(startRes.statusCode).toBe(200);
    const { sessionId } = JSON.parse(startRes.body);

    const stateRes = await app.inject({ method: "GET", url: `/api/migration/${sessionId}/state` });
    expect(stateRes.statusCode).toBe(200);
    expect(JSON.parse(stateRes.body).status).toBe("pending");

    const accSig = signMigrationRequest(r, sarahIrk);
    const accept = await app.inject({
      method: "POST",
      url: "/api/migration/accept",
      payload: {
        sessionId,
        signature: bytesToHex(accSig),
        recipientTunnelInfo: "wss://srv-sarah.flagship.services/tunnel#token-abc",
      },
    });
    expect(accept.statusCode).toBe(200);
    expect(JSON.parse(accept.body).status).toBe("accepted");

    const sender_complete = signMigrationRequest(r, harryIrk);
    const complete = await app.inject({
      method: "POST",
      url: "/api/migration/complete",
      payload: { sessionId, side: "sender", signature: bytesToHex(sender_complete) },
    });
    expect(complete.statusCode).toBe(200);
    expect(JSON.parse(complete.body).status).toBe("completed");
  });

  it("supports all four modes (cut/copy × with/without-data)", async () => {
    const app = makeApp();
    for (const mode of ["cut", "copy"] as const) {
      for (const withData of [true, false]) {
        const r = makeRequest({ mode, withData, issuedAt: Date.now() + Math.random() });
        const res = await start(app, r);
        expect(res.statusCode).toBe(200);
      }
    }
  });

  it("rejects start with invalid sender signature", async () => {
    const app = makeApp();
    const r = makeRequest();
    const badSig = signMigrationRequest(r, malloryIrk);
    const res = await app.inject({
      method: "POST",
      url: "/api/migration/start",
      payload: { request: r, signature: bytesToHex(badSig) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects start when fromUser==toUser", async () => {
    const app = makeApp();
    const r = makeRequest({ toUser: "harry" });
    const res = await start(app, r);
    expect(res.statusCode).toBe(400);
  });

  it("rejects start when toUser has no registered IRK", async () => {
    const app = makeApp();
    const r = makeRequest({ toUser: "stranger" });
    const res = await start(app, r);
    expect(res.statusCode).toBe(403);
  });

  it("rejects accept with the WRONG recipient signature (cannot let an attacker take over the migration)", async () => {
    const app = makeApp();
    const r = makeRequest();
    const startRes = await start(app, r);
    const { sessionId } = JSON.parse(startRes.body);

    const malSig = signMigrationRequest(r, malloryIrk);
    const accept = await app.inject({
      method: "POST",
      url: "/api/migration/accept",
      payload: { sessionId, signature: bytesToHex(malSig), recipientTunnelInfo: "x" },
    });
    expect(accept.statusCode).toBe(403);
  });

  it("rejects accept on a non-pending session (already accepted)", async () => {
    const app = makeApp();
    const r = makeRequest();
    const { sessionId } = JSON.parse((await start(app, r)).body);
    const accSig = signMigrationRequest(r, sarahIrk);
    await app.inject({
      method: "POST",
      url: "/api/migration/accept",
      payload: { sessionId, signature: bytesToHex(accSig), recipientTunnelInfo: "x" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/migration/accept",
      payload: { sessionId, signature: bytesToHex(accSig), recipientTunnelInfo: "x" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("expires pending sessions past TTL", async () => {
    let now = 1_000_000;
    const app = makeApp(() => now);
    const r = makeRequest({ issuedAt: now });
    const { sessionId } = JSON.parse((await start(app, r)).body);
    now += 60 * 60_000; // 1 hour later
    const stateRes = await app.inject({ method: "GET", url: `/api/migration/${sessionId}/state` });
    expect(JSON.parse(stateRes.body).status).toBe("rejected");
  });

  it("rejects stale start requests (issuedAt > 5 min ago)", async () => {
    const app = makeApp();
    const r = makeRequest({ issuedAt: Date.now() - 10 * 60_000 });
    const res = await start(app, r);
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for unknown session", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/migration/deadbeef/state" });
    expect(res.statusCode).toBe(404);
  });
});
