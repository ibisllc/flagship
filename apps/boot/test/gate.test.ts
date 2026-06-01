import { describe, it, expect, beforeEach } from "vitest";
import { ed } from "@flagship/protocol";
import { gate, signBootRequest, encodeAuthHeader, type GateEnvelope, type GateDeps } from "../src/gate.js";
import { InMemoryNonceStore } from "../src/nonceStore.js";
import type { DirectoryClient } from "../src/directory.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function kp(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  return { priv: seed, pubHex: bytesToHex(ed.getPublicKey(seed)) };
}
function nonce(byte: number): string {
  return bytesToHex(new Uint8Array(32).fill(byte));
}

const SERVER_A = "kitchen.alice.flagship.services";
const SERVER_B = "kitchen.bob.flagship.services";

const boxA = kp(1);
const ownerA = kp(2);
const boxB = kp(3);
const delegateA = kp(4); // active watch delegate for ownerA's account
const expiredDelegateA = kp(5); // a delegate past its TTL
const foreign = kp(9);

const FUTURE = 9_000_000; // well past the test clock (1_000_000)
const PAST = 500_000; // before the test clock — an expired delegate

/** Directory: serverA → boxA STK / ownerA IRK + one active + one expired
 *  boot-approval delegate; serverB → boxB STK only (no owner, no delegates). */
function makeDirectory(): DirectoryClient {
  return {
    async boxStkForDomain(d) {
      if (d.toLowerCase() === SERVER_A) return boxA.pubHex;
      if (d.toLowerCase() === SERVER_B) return boxB.pubHex;
      return null;
    },
    async ownerIrkForDomain(d) {
      if (d.toLowerCase() === SERVER_A) return ownerA.pubHex;
      return null;
    },
    async activeBootDelegatesForDomain(d) {
      if (d.toLowerCase() === SERVER_A) {
        return [
          { pubKeyHex: delegateA.pubHex, expiresAt: FUTURE },
          { pubKeyHex: expiredDelegateA.pubHex, expiresAt: PAST },
        ];
      }
      if (d.toLowerCase() === SERVER_B) return []; // server exists, no delegates
      return null; // unknown server
    },
  };
}

function makeDeps(now = () => 1_000_000): GateDeps {
  return { directory: makeDirectory(), nonces: new InMemoryNonceStore(), now };
}

describe("identity gate — box-STK reads", () => {
  let deps: GateDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("accepts a valid box STK on a box-read route", async () => {
    const path = `/api/boot/lease/${SERVER_A}`;
    const auth = signBootRequest(
      { role: "box", serverDomain: SERVER_A, method: "GET", path, pubKeyHex: boxA.pubHex, nonceHex: nonce(11), issuedAt: 1_000_000 },
      boxA.priv,
    );
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, auth);
    expect(r.ok).toBe(true);
  });

  it("rejects a FOREIGN key even with a valid self-signature", async () => {
    const path = `/api/boot/lease/${SERVER_A}`;
    const auth = signBootRequest(
      { role: "box", serverDomain: SERVER_A, method: "GET", path, pubKeyHex: foreign.pubHex, nonceHex: nonce(12), issuedAt: 1_000_000 },
      foreign.priv,
    );
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("AUTHZ binding: box B cannot read box A's lease (cross-account)", async () => {
    // box B signs perfectly, but for serverDomain A — its STK is not A's
    // directory STK, so the binding rejects it.
    const path = `/api/boot/lease/${SERVER_A}`;
    const auth = signBootRequest(
      { role: "box", serverDomain: SERVER_A, method: "GET", path, pubKeyHex: boxB.pubHex, nonceHex: nonce(13), issuedAt: 1_000_000 },
      boxB.priv,
    );
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe("identity gate — owner-IRK writes", () => {
  let deps: GateDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("accepts the owner IRK on a write route", async () => {
    const path = "/api/boot/lease";
    const auth = signBootRequest(
      { role: "owner", serverDomain: SERVER_A, method: "PUT", path, pubKeyHex: ownerA.pubHex, nonceHex: nonce(21), issuedAt: 1_000_000 },
      ownerA.priv,
    );
    const r = await gate(deps, { role: "owner", serverDomain: SERVER_A, method: "PUT", path }, auth);
    expect(r.ok).toBe(true);
  });

  it("rejects a BOX trying to write (wrong principal)", async () => {
    const path = "/api/boot/lease";
    // box signs an owner-role envelope; the gate requires owner and the
    // box STK is not the account IRK.
    const auth = signBootRequest(
      { role: "owner", serverDomain: SERVER_A, method: "PUT", path, pubKeyHex: boxA.pubHex, nonceHex: nonce(22), issuedAt: 1_000_000 },
      boxA.priv,
    );
    const r = await gate(deps, { role: "owner", serverDomain: SERVER_A, method: "PUT", path }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects a PHONE (owner) trying a box-read route (wrong principal)", async () => {
    const path = `/api/boot/lease/${SERVER_A}`;
    // owner signs role:"owner" but the route requires role:"box".
    const auth = signBootRequest(
      { role: "owner", serverDomain: SERVER_A, method: "GET", path, pubKeyHex: ownerA.pubHex, nonceHex: nonce(23), issuedAt: 1_000_000 },
      ownerA.priv,
    );
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe("identity gate — watch-delegate boot approval", () => {
  // The boot-approval route (POST /api/boot/response) permits BOTH owner and
  // delegate; every other route names owner only. These exercise the gate
  // with the ["owner","delegate"] allowed set the route passes.
  const APPROVE_PATH = "/api/boot/response";
  let deps: GateDeps;
  beforeEach(() => {
    deps = makeDeps(() => 1_000_000);
  });

  it("accepts an active boot-approval delegate on the approval route", async () => {
    const auth = signBootRequest(
      { role: "delegate", serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH, pubKeyHex: delegateA.pubHex, nonceHex: nonce(41), issuedAt: 1_000_000 },
      delegateA.priv,
    );
    const r = await gate(deps, { role: ["owner", "delegate"], serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH }, auth);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe("delegate");
  });

  it("still accepts the owner IRK on the same route (delegate is additive)", async () => {
    const auth = signBootRequest(
      { role: "owner", serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH, pubKeyHex: ownerA.pubHex, nonceHex: nonce(42), issuedAt: 1_000_000 },
      ownerA.priv,
    );
    const r = await gate(deps, { role: ["owner", "delegate"], serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH }, auth);
    expect(r.ok).toBe(true);
  });

  it("rejects a delegate NOT registered for the account", async () => {
    const auth = signBootRequest(
      { role: "delegate", serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH, pubKeyHex: foreign.pubHex, nonceHex: nonce(43), issuedAt: 1_000_000 },
      foreign.priv,
    );
    const r = await gate(deps, { role: ["owner", "delegate"], serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects an EXPIRED delegate (past its TTL)", async () => {
    const auth = signBootRequest(
      { role: "delegate", serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH, pubKeyHex: expiredDelegateA.pubHex, nonceHex: nonce(44), issuedAt: 1_000_000 },
      expiredDelegateA.priv,
    );
    const r = await gate(deps, { role: ["owner", "delegate"], serverDomain: SERVER_A, method: "POST", path: APPROVE_PATH }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toMatch(/expired/);
    }
  });

  it("rejects a delegate on an owner-ONLY route (deposit lease)", async () => {
    // The delegate signs a lease-deposit envelope, but that route names only
    // "owner" — the delegate is the LEAST-destructive principal and may not
    // deposit a long-lived auto-unlock lease.
    const leasePath = "/api/boot/lease";
    const auth = signBootRequest(
      { role: "delegate", serverDomain: SERVER_A, method: "PUT", path: leasePath, pubKeyHex: delegateA.pubHex, nonceHex: nonce(45), issuedAt: 1_000_000 },
      delegateA.priv,
    );
    const r = await gate(deps, { role: "owner", serverDomain: SERVER_A, method: "PUT", path: leasePath }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("AUTHZ binding: a serverA delegate cannot approve serverB (cross-account)", async () => {
    const auth = signBootRequest(
      { role: "delegate", serverDomain: SERVER_B, method: "POST", path: APPROVE_PATH, pubKeyHex: delegateA.pubHex, nonceHex: nonce(46), issuedAt: 1_000_000 },
      delegateA.priv,
    );
    const r = await gate(deps, { role: ["owner", "delegate"], serverDomain: SERVER_B, method: "POST", path: APPROVE_PATH }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe("identity gate — freshness + replay", () => {
  it("rejects a stale timestamp (outside ±5 min)", async () => {
    const deps = makeDeps(() => 1_000_000);
    const path = `/api/boot/lease/${SERVER_A}`;
    const auth = signBootRequest(
      { role: "box", serverDomain: SERVER_A, method: "GET", path, pubKeyHex: boxA.pubHex, nonceHex: nonce(31), issuedAt: 1_000_000 - 6 * 60_000 },
      boxA.priv,
    );
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toMatch(/stale/);
    }
  });

  it("rejects a replayed nonce (same nonce twice)", async () => {
    const deps = makeDeps(() => 1_000_000);
    const path = `/api/boot/lease/${SERVER_A}`;
    const mk = () =>
      signBootRequest(
        { role: "box", serverDomain: SERVER_A, method: "GET", path, pubKeyHex: boxA.pubHex, nonceHex: nonce(32), issuedAt: 1_000_000 },
        boxA.priv,
      );
    const first = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, mk());
    expect(first.ok).toBe(true);
    const second = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, mk());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(403);
      expect(second.error).toMatch(/replay/);
    }
  });

  it("rejects a tampered signature (invalid sig)", async () => {
    const deps = makeDeps();
    const path = `/api/boot/lease/${SERVER_A}`;
    const env: GateEnvelope = {
      role: "box",
      serverDomain: SERVER_A,
      method: "GET",
      path,
      pubKeyHex: boxA.pubHex,
      nonceHex: nonce(33),
      issuedAt: 1_000_000,
      signatureHex: "0".repeat(128),
    };
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path }, encodeAuthHeader(env));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects a method/path-rebound signature (binding mismatch)", async () => {
    const deps = makeDeps();
    // sign for GET .../lease/A but present it at a DELETE route.
    const signedPath = `/api/boot/lease/${SERVER_A}`;
    const auth = signBootRequest(
      { role: "box", serverDomain: SERVER_A, method: "GET", path: signedPath, pubKeyHex: boxA.pubHex, nonceHex: nonce(34), issuedAt: 1_000_000 },
      boxA.priv,
    );
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "DELETE", path: signedPath }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects a malformed Authorization header (400, before any work)", async () => {
    const deps = makeDeps();
    const r = await gate(deps, { role: "box", serverDomain: SERVER_A, method: "GET", path: "/x" }, "garbage-header");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects an unknown server (404 on binding)", async () => {
    const deps = makeDeps();
    const unknownDomain = "kitchen.nobody.flagship.services";
    const path = `/api/boot/lease/${unknownDomain}`;
    const auth = signBootRequest(
      { role: "box", serverDomain: unknownDomain, method: "GET", path, pubKeyHex: boxA.pubHex, nonceHex: nonce(35), issuedAt: 1_000_000 },
      boxA.priv,
    );
    const r = await gate(deps, { role: "box", serverDomain: unknownDomain, method: "GET", path }, auth);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});
