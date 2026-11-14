import { describe, expect, it } from "vitest";
import { canonicalBoxHealthReport, canonicalPqKeyBinding, ed, hybridSigKeygen, hybridSign, TAG_BOX_HEALTH } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetUserPods, handlePostServerHealth } from "../src/index.js";
import { handlePutPqKeyBinding } from "../src/pqKeyBindings.js";

const NOW = 1_800_000_000_000;
const DOMAIN = "home2.harry.flagship.services";
const sk = new Uint8Array(32).fill(5);
const pub = ed.getPublicKey(sk);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function report(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1, domain: DOMAIN, at: NOW - 1_000, uptimeS: 600, memTotalMB: 3900, memAvailMB: 120,
    swapUsedMB: 0, oomKills: 3, daemon: { state: "activating", restarts: 4, lastExit: 137 },
    tunnel: false, diskUsedPct: 41, ...over,
  });
}
const sign = (r: string, key = sk) => hex(ed.sign(new TextEncoder().encode(r), key));

async function setup() {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: DOMAIN, username: "harry", identityPubKeyHex: hex(pub), registeredAt: NOW - 50_000 });
  const deps = { servers: storage.servers, serverHealth: storage.serverHealth, now: () => NOW };
  return { storage, deps };
}

describe("box health reports", () => {
  it("stores a report signed by the box and relays it on /pods", async () => {
    const { storage, deps } = await setup();
    const r = report();
    const res = await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r) });
    expect(res.status).toBe(200);
    const pods = await handleGetUserPods(
      { daemonStatus: storage.daemonStatus, serverHealth: storage.serverHealth, servers: storage.servers, routing: storage.routing, now: () => NOW },
      "harry",
    );
    const health = (pods.body as { pods: Array<{ health?: Record<string, unknown> }> }).pods[0]!.health;
    expect(health).toMatchObject({ oomKills: 3, memAvailMB: 120, tunnel: false, receivedAt: NOW });
    expect(health?.daemon).toEqual({ state: "activating", restarts: 4, lastExit: 137 });
  });

  it("refuses another key, another server's report, replays, stale reports and junk", async () => {
    const { deps } = await setup();
    const r = report();
    const other = new Uint8Array(32).fill(9);
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r, other) })).status).toBe(403);
    const elsewhere = report({ domain: "evil.harry.flagship.services" });
    expect((await handlePostServerHealth(deps, DOMAIN, { report: elsewhere, signature: sign(elsewhere) })).status).toBe(403);
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r) })).status).toBe(200);
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r) })).status).toBe(403);
    const old = report({ at: NOW - 60 * 60_000 });
    expect((await handlePostServerHealth(deps, DOMAIN, { report: old, signature: sign(old) })).status).toBe(403);
    const freeText = report({ daemon: { state: "Error: secret at /home/x", restarts: 0, lastExit: 0 } });
    expect((await handlePostServerHealth(deps, DOMAIN, { report: freeText, signature: sign(freeText) })).status).toBe(400);
    expect((await handlePostServerHealth(deps, "nobody.harry.flagship.services", { report: r, signature: sign(r) })).status).toBe(403);
  });
});

describe("tagged box health reports (B2 #2)", () => {
  const tagged = (r: string, key = sk) => hex(ed.sign(canonicalBoxHealthReport(r), key));
  const T0 = NOW - 10_000;

  it("signs flagship/box-health/v1 bytes and stores the report marked as tagged", async () => {
    const { storage, deps } = await setup();
    const r = report();
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: tagged(r) })).status).toBe(200);
    const stored = JSON.parse((await storage.serverHealth.get(DOMAIN))!.reportJson) as Record<string, unknown>;
    expect(stored.tag).toBe(TAG_BOX_HEALTH);
    expect(stored.oomKills).toBe(3);
  });

  it("never takes an untagged report again once the server sent a tagged one", async () => {
    const { deps } = await setup();
    const first = report({ at: T0 });
    expect((await handlePostServerHealth(deps, DOMAIN, { report: first, signature: tagged(first) })).status).toBe(200);
    const later = report();
    const res = await handlePostServerHealth(deps, DOMAIN, { report: later, signature: sign(later) });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/untagged/) });
  });

  it("refuses an untagged report from a server whose heartbeat says boxLevel >= 3", async () => {
    const { storage, deps } = await setup();
    const withStatus = { ...deps, daemonStatus: storage.daemonStatus };
    await storage.daemonStatus.put({
      serverDomain: DOMAIN, certSha256: null, certValidUntil: null, certIssuer: null, servicesServedJson: "[]",
      lastReported: NOW, reportJson: JSON.stringify({ serverDomain: DOMAIN, boxLevel: 3 }), signatureHex: null,
    });
    const r = report();
    expect((await handlePostServerHealth(withStatus, DOMAIN, { report: r, signature: sign(r) })).status).toBe(403);
    expect((await handlePostServerHealth(withStatus, DOMAIN, { report: r, signature: tagged(r) })).status).toBe(200);
  });

  it("still takes a 0.2 box's untagged report (no boxLevel, never tagged)", async () => {
    const { storage, deps } = await setup();
    const withStatus = { ...deps, daemonStatus: storage.daemonStatus };
    await storage.daemonStatus.put({
      serverDomain: DOMAIN, certSha256: null, certValidUntil: null, certIssuer: null, servicesServedJson: "[]",
      lastReported: NOW, reportJson: JSON.stringify({ serverDomain: DOMAIN }), signatureHex: null,
    });
    const r = report();
    expect((await handlePostServerHealth(withStatus, DOMAIN, { report: r, signature: sign(r) })).status).toBe(200);
  });

  it("does not take the tagged signature as an untagged one, or the reverse", async () => {
    const { deps } = await setup();
    const r = report();
    // A signature over the bare JSON never verifies as the tagged bytes, and vice versa.
    expect(ed.verify(Buffer.from(sign(r), "hex"), canonicalBoxHealthReport(r), pub)).toBe(false);
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: tagged(r, new Uint8Array(32).fill(9)) })).status).toBe(403);
  });

  it("goes through the critical-signature gate: a strict installation refuses a classical-only report", async () => {
    const { storage, deps } = await setup();
    await storage.pqTrust.putPolicy({ scopeKind: "installation", scopeId: DOMAIN, profile: "strict", rollout: "enforced", generation: 1, headDigest: "00".repeat(32), enforcedEver: true, updatedAt: NOW });
    const gated = { ...deps, pqTrust: storage.pqTrust };
    const r = report();
    const t = await handlePostServerHealth(gated, DOMAIN, { report: r, signature: tagged(r) });
    expect(t.status).toBe(403);
    expect(t.body).toMatchObject({ error: "signature refused: strict-requires-hybrid" });
    const l = await handlePostServerHealth(gated, DOMAIN, { report: r, signature: sign(r) });
    expect(l.status).toBe(403);
  });

  it("checks a hybrid signature the box sends beside the classical one", async () => {
    const { storage, deps } = await setup();
    const gated = { ...deps, pqTrust: storage.pqTrust };
    const r = report();
    const res = await handlePostServerHealth(gated, DOMAIN, { report: r, signature: tagged(r), pqSignature: { suite: "x" } });
    expect(res.body).toMatchObject({ error: "signature refused: unknown-suite" });
  });

  it("takes a strict installation's report when the box signs it hybrid with its bound STK (keyd sign-health)", async () => {
    const { storage, deps } = await setup();
    const pqSeed = new Uint8Array(32).fill(0x2b);
    const secret = Uint8Array.from([...sk, ...pqSeed]);
    const st = { role: "box-stk" as const, subjectId: DOMAIN, ed25519PubHex: hex(pub), mldsaPubHex: hex(hybridSigKeygen(sk, pqSeed).publicKey.subarray(32)), issuedAt: NOW - 60_000 };
    const binding = { v: 1 as const, ...st, signature: hex(hybridSign(secret, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st))) };
    expect((await handlePutPqKeyBinding({ servers: storage.servers, pqTrust: storage.pqTrust, now: () => NOW }, DOMAIN, binding)).status).toBe(200);
    await storage.pqTrust.putPolicy({ scopeKind: "installation", scopeId: DOMAIN, profile: "strict", rollout: "enforced", generation: 1, headDigest: "00".repeat(32), enforcedEver: true, updatedAt: NOW });
    const gated = { ...deps, pqTrust: storage.pqTrust };
    const r = report();
    const pqSignature = { suite: "hybrid-ed25519-mldsa65/v1", signature: hex(hybridSign(secret, TAG_BOX_HEALTH, canonicalBoxHealthReport(r))) };
    const res = await handlePostServerHealth(gated, DOMAIN, { report: r, signature: tagged(r), pqSignature });
    expect(res.status).toBe(200);
  });
});
