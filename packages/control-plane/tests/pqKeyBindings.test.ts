/**
 * Architecture v2 milestone 1 on `.com`: the box-stk hybrid binding route, the boot-key binding
 * with its v2 hybrid signature, and the daemon-status report through the critical-signature gate.
 */
import { describe, expect, it } from "vitest";
import {
  bootKeyBindingToWire,
  canonicalDaemonStatusReport,
  canonicalPqKeyBinding,
  ed,
  hybridSigKeygen,
  hybridSign,
  messagePurpose,
  signBootKeyBinding,
  signBootKeyBindingV2,
  signDaemonStatusReport,
  type DaemonStatusReport,
  type PqKeyBindingStatement,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetBootKey, handlePutBootKey } from "../src/bootKeys.js";
import { handleGetPqKeyBinding, handlePutPqKeyBinding } from "../src/pqKeyBindings.js";
import { handlePostDaemonStatus } from "../src/podInventory.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const S = "home.alice.flagship.services";
const T = 1_790_000_000_000;
const stkSeed = new Uint8Array(32).fill(0x0b);
const pqSeed = new Uint8Array(32).fill(0x2b);
const otherPq = new Uint8Array(32).fill(0x3c);
const stkPub = ed.getPublicKey(stkSeed);
const secret = (pq = pqSeed) => Uint8Array.from([...stkSeed, ...pq]);
const hsign = (m: Uint8Array, pq = pqSeed) => hybridSign(secret(pq), messagePurpose(m), m);
const mldsa = (pq = pqSeed) => hex(hybridSigKeygen(stkSeed, pq).publicKey.subarray(32));
const bootPub = ed.getPublicKey(new Uint8Array(32).fill(0x1b));

function stmt(over: Partial<PqKeyBindingStatement> = {}, pq = pqSeed): PqKeyBindingStatement {
  return { role: "box-stk", subjectId: S, ed25519PubHex: hex(stkPub), mldsaPubHex: mldsa(pq), issuedAt: T, ...over };
}
const wire = (st = stmt(), pq = pqSeed) => ({ v: 1 as const, ...st, signature: hex(hsign(canonicalPqKeyBinding(st), pq)) });

async function world(policy?: { profile: string; rollout: string }) {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stkPub), registeredAt: T });
  if (policy) {
    await storage.pqTrust.putPolicy({ scopeKind: "installation", scopeId: S, ...policy, generation: 1, headDigest: "00".repeat(32), enforcedEver: true, updatedAt: T });
  }
  const now = () => T;
  return {
    storage,
    pq: { servers: storage.servers, pqTrust: storage.pqTrust, now },
    boot: { servers: storage.servers, serverBootKeys: storage.serverBootKeys, pqTrust: storage.pqTrust, now },
    status: { daemonStatus: storage.daemonStatus, servers: storage.servers, routing: storage.routing, pqTrust: storage.pqTrust, now },
  };
}

describe("/api/server/:host/pq-key-binding", () => {
  it("stores a box-stk binding under the registered STK and serves it", async () => {
    const w = await world();
    expect((await handleGetPqKeyBinding(w.pq, S)).status).toBe(404);
    const one = wire();
    expect((await handlePutPqKeyBinding(w.pq, S, one)).status).toBe(200);
    expect((await handleGetPqKeyBinding(w.pq, S)).body).toEqual(one);
  });

  it("refuses another role, host, STK, a swapped ML-DSA key and a later rebind to another one", async () => {
    const w = await world();
    expect((await handlePutPqKeyBinding(w.pq, S, wire(stmt({ role: "admin-root" })))).status).toBe(403);
    expect((await handlePutPqKeyBinding(w.pq, "x.alice.flagship.services", wire())).status).toBe(403);
    const otherStk = ed.getPublicKey(new Uint8Array(32).fill(9));
    expect((await handlePutPqKeyBinding(w.pq, S, { ...wire(), ed25519PubHex: hex(otherStk) })).body).toMatchObject({ error: "binding-key-mismatch" });
    expect((await handlePutPqKeyBinding(w.pq, S, { ...wire(), mldsaPubHex: mldsa(otherPq) })).body).toMatchObject({ error: "bad-signature" });
    expect((await handlePutPqKeyBinding(w.pq, S, { junk: 1 })).status).toBe(400);
    expect((await handlePutPqKeyBinding(w.pq, S, wire())).status).toBe(200);
    expect(await handlePutPqKeyBinding(w.pq, S, wire(stmt({ issuedAt: T + 1 }, otherPq), otherPq))).toEqual({ status: 409, body: { error: "pq-key-changed" } });
    expect((await handlePutPqKeyBinding(w.pq, S, wire(stmt({ issuedAt: T + 1 })))).status).toBe(200);
  });

  it("stops serving the binding once the server's STK changes", async () => {
    const w = await world();
    await handlePutPqKeyBinding(w.pq, S, wire());
    await w.storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(ed.getPublicKey(new Uint8Array(32).fill(9))), registeredAt: T });
    expect((await handleGetPqKeyBinding(w.pq, S)).status).toBe(404);
  });
});

describe("boot-key binding v2 on .com", () => {
  const b = { serverDomain: S, bootPubHex: hex(bootPub), issuedAt: T };
  const v1 = signBootKeyBinding(b, (m) => ed.sign(m, stkSeed));
  it("stores and serves the hybrid signature once the STK binding is on file", async () => {
    const w = await world();
    const both = bootKeyBindingToWire(b, v1, signBootKeyBindingV2(b, (m) => hsign(m)));
    expect((await handlePutBootKey(w.boot, S, both)).status).toBe(403);
    await handlePutPqKeyBinding(w.pq, S, wire());
    expect((await handlePutBootKey(w.boot, S, both)).status).toBe(200);
    expect((await handleGetBootKey(w.boot, S)).body).toEqual(both);
  });
  it("needs it on a strict installation, and refuses one over other fields", async () => {
    const w = await world({ profile: "strict", rollout: "enforced" });
    await handlePutPqKeyBinding(w.pq, S, wire());
    expect((await handlePutBootKey(w.boot, S, bootKeyBindingToWire(b, v1))).status).toBe(403);
    const wrong = bootKeyBindingToWire(b, v1, signBootKeyBindingV2({ ...b, issuedAt: T + 1 }, (m) => hsign(m)));
    expect((await handlePutBootKey(w.boot, S, wrong)).status).toBe(403);
    expect((await handlePutBootKey(w.boot, S, bootKeyBindingToWire(b, v1, signBootKeyBindingV2(b, (m) => hsign(m))))).status).toBe(200);
  });
});

describe("daemon-status through the gate", () => {
  const report: DaemonStatusReport = { serverDomain: S, certSha256: null, certValidUntil: null, certIssuer: null, appsServed: [], nonce: "ab", issuedAt: T };
  const request = { ...report };
  const classical = hex(signDaemonStatusReport(report, (m) => ed.sign(m, stkSeed)));
  const hybrid = { suite: "hybrid-ed25519-mldsa65/v1", signature: hex(hsign(canonicalDaemonStatusReport(report))) };

  it("accepts classical on a legacy installation, and a hybrid one only under the bound key", async () => {
    const w = await world();
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical })).status).toBe(200);
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical, pqSignature: hybrid })).body).toMatchObject({ error: "signature refused: no-binding" });
    await handlePutPqKeyBinding(w.pq, S, wire());
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical, pqSignature: hybrid })).status).toBe(200);
    const bad = { ...hybrid, signature: hex(hsign(canonicalDaemonStatusReport(report), otherPq)) };
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical, pqSignature: bad })).body).toMatchObject({ error: "signature refused: bad-signature" });
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical, pqSignature: { suite: "x" } })).body).toMatchObject({ error: "signature refused: unknown-suite" });
  });

  it("refuses a stripped suite on a strict installation", async () => {
    const w = await world({ profile: "strict", rollout: "enforced" });
    await handlePutPqKeyBinding(w.pq, S, wire());
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical })).body).toMatchObject({ error: "signature refused: strict-requires-hybrid" });
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical, pqSignature: hybrid })).status).toBe(200);
  });

  it("reads an unknown policy value as strict", async () => {
    const w = await world({ profile: "quantum-ish", rollout: "enforced" });
    expect((await handlePostDaemonStatus(w.status, { request, signature: classical })).body).toMatchObject({ error: "signature refused: strict-requires-hybrid" });
  });
});
