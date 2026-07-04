import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveSWK,
  signBackupToggle,
  type BackupToggle,
} from "@flagship/protocol";
import { BackupLoop } from "../src/backupLoop.js";
import { AppMembership } from "../src/membership.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext } from "../src/httpApi.js";

const umk = { seed: new Uint8Array(32).fill(11) };
const irk = deriveIRK(umk);
const swk = deriveSWK(umk, "home-box");

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeCtx(extra: { backupLoop?: BackupLoop; serverId?: string } = {}): DaemonContext {
  const apps = new Map<string, AppMembership>();
  return {
    serverId: extra.serverId ?? "home-box",
    userId: "harry",
    apps,
    resolveSession: () => null,
    injectors: new Map<string, IdentityInjector>(),
    backupLoop: extra.backupLoop ?? new BackupLoop({ swk, k: 10, n: 16 }),
    irkPubKey: irk.publicKey,
  };
}

function buildSignedToggle(over: Partial<BackupToggle> = {}, signer = irk) {
  const claim: BackupToggle = {
    serverId: over.serverId ?? "home-box",
    enabled: over.enabled ?? true,
    issuedAt: over.issuedAt ?? Date.now(),
  };
  return {
    request: { ...claim },
    signature: bytesToHex(signBackupToggle(claim, signer)),
  };
}

describe("BackupLoop — enabled flag gates work", () => {
  it("does nothing when disabled (the default at boot)", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16 });
    const r = await loop.runOnce([{ path: "x", content: new Uint8Array([1, 2, 3]) }]);
    expect(r.filesProcessed).toBe(0);
    expect(loop.status().enabled).toBe(false);
    expect(loop.status().lastBackupAt).toBeNull();
  });

  it("processes work when enabled, and stamps lastBackupAt", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16, initiallyEnabled: true });
    const r = await loop.runOnce([{ path: "x", content: new Uint8Array(1024).fill(7) }], 999);
    expect(r.filesProcessed).toBe(1);
    expect(loop.status().lastBackupAt).toBe(999);
    expect(loop.status().totalChunks).toBe(1);
  });

  it("setEnabled(false) immediately stops new work", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16, initiallyEnabled: true });
    await loop.runOnce([{ path: "x", content: new Uint8Array([1]) }]);
    loop.setEnabled(false);
    const r = await loop.runOnce([{ path: "y", content: new Uint8Array([2]) }]);
    expect(r.filesProcessed).toBe(0);
  });

  it("recordHostedBytes tracks reciprocal hosting (clamped at 0)", () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16 });
    loop.recordHostedBytes(4096);
    loop.recordHostedBytes(2048);
    expect(loop.status().hostingBytes).toBe(6144);
    loop.recordHostedBytes(-99999);
    expect(loop.status().hostingBytes).toBe(0);
  });
});

describe("daemon HTTP — GET /backup/status", () => {
  it("returns the BackupLoop status as JSON", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16, initiallyEnabled: true });
    loop.recordHostedBytes(2048);
    const app = buildDaemonHttp(makeCtx({ backupLoop: loop }));
    const r = await app.inject({ method: "GET", url: "/backup/status" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.enabled).toBe(true);
    expect(body.hostingBytes).toBe(2048);
  });

  it("returns 503 when no BackupLoop is configured", async () => {
    const ctx = makeCtx();
    ctx.backupLoop = undefined;
    const app = buildDaemonHttp(ctx);
    const r = await app.inject({ method: "GET", url: "/backup/status" });
    expect(r.statusCode).toBe(503);
  });
});

describe("daemon HTTP — POST /backup/toggle (IRK-signed)", () => {
  it("flips enabled on a valid IRK-signed claim", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16 });
    const app = buildDaemonHttp(makeCtx({ backupLoop: loop }));
    const r = await app.inject({
      method: "POST",
      url: "/backup/toggle",
      payload: buildSignedToggle({ enabled: true }),
    });
    expect(r.statusCode).toBe(200);
    expect(loop.status().enabled).toBe(true);
    expect(loop.status().lastToggledAt).not.toBeNull();
  });

  it("rejects toggles signed for a different serverId (cross-server replay)", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16 });
    const app = buildDaemonHttp(makeCtx({ backupLoop: loop, serverId: "home-box" }));
    const r = await app.inject({
      method: "POST",
      url: "/backup/toggle",
      // signed claim is for "chillout", not us
      payload: buildSignedToggle({ serverId: "chillout" }),
    });
    expect(r.statusCode).toBe(403);
    expect(loop.status().enabled).toBe(false);
  });

  it("rejects forged signatures", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16 });
    const app = buildDaemonHttp(makeCtx({ backupLoop: loop }));
    const otherIrk = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    const r = await app.inject({
      method: "POST",
      url: "/backup/toggle",
      payload: buildSignedToggle({ enabled: true }, otherIrk),
    });
    expect(r.statusCode).toBe(403);
    expect(loop.status().enabled).toBe(false);
  });

  it("rejects stale claims (5-minute replay window)", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16 });
    const app = buildDaemonHttp(makeCtx({ backupLoop: loop }));
    const r = await app.inject({
      method: "POST",
      url: "/backup/toggle",
      payload: buildSignedToggle({ enabled: true, issuedAt: Date.now() - 6 * 60_000 }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects malformed bodies with 400", async () => {
    const loop = new BackupLoop({ swk, k: 10, n: 16 });
    const app = buildDaemonHttp(makeCtx({ backupLoop: loop }));
    const r = await app.inject({
      method: "POST",
      url: "/backup/toggle",
      payload: { request: { serverId: "home-box" }, signature: "00" },
    });
    expect(r.statusCode).toBe(400);
  });
});
