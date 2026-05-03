import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  signRebuildRequest,
  type ImageRebuildRequest,
} from "@flagship/protocol";
import { buildServer } from "../src/server.js";
import { bytesToHex } from "../src/lib/hex.js";

const umk = { seed: new Uint8Array(32).fill(99) };

function makeRebuild(overrides: Partial<ImageRebuildRequest> = {}): ImageRebuildRequest {
  return {
    userId: "u1",
    newServerId: "srv-new",
    wifiSsid: "Home",
    wifiPskHash: new Uint8Array(32).fill(7),
    shareRatio: 0.5,
    issuedAt: Date.now(),
    ...overrides,
  };
}

function payloadFor(rebuild: ImageRebuildRequest, sig: Uint8Array, pub: Uint8Array) {
  return {
    request: {
      userId: rebuild.userId,
      newServerId: rebuild.newServerId,
      wifiSsid: rebuild.wifiSsid,
      wifiPskHash: bytesToHex(rebuild.wifiPskHash),
      shareRatio: rebuild.shareRatio,
      issuedAt: rebuild.issuedAt,
    },
    signature: bytesToHex(sig),
    irkPublicKey: bytesToHex(pub),
  };
}

describe("POST /api/build-image", () => {
  it("accepts a valid IRK-signed request and returns a job id", async () => {
    const app = buildServer();
    const irk = deriveIRK(umk);
    const rebuild = makeRebuild();
    const sig = signRebuildRequest(rebuild, irk);
    const res = await app.inject({
      method: "POST",
      url: "/api/build-image",
      payload: payloadFor(rebuild, sig, irk.publicKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jobId).toContain("srv-new");
    expect(body.status).toBe("queued");
  });

  it("rejects an invalid signature with 403", async () => {
    const app = buildServer();
    const irk = deriveIRK(umk);
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(0) });
    const rebuild = makeRebuild();
    const sig = signRebuildRequest(rebuild, otherIrk);
    const res = await app.inject({
      method: "POST",
      url: "/api/build-image",
      payload: payloadFor(rebuild, sig, irk.publicKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a stale request older than 5 minutes", async () => {
    const app = buildServer();
    const irk = deriveIRK(umk);
    const rebuild = makeRebuild({ issuedAt: Date.now() - 10 * 60_000 });
    const sig = signRebuildRequest(rebuild, irk);
    const res = await app.inject({
      method: "POST",
      url: "/api/build-image",
      payload: payloadFor(rebuild, sig, irk.publicKey),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/stale/);
  });

  it("rejects malformed request body with 400", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/build-image",
      payload: { request: { userId: "x" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, service: "flagshipserver.com" });
  });
});
