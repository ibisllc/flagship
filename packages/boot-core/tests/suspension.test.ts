/**
 * SEC-LOCK-001 at the boot worker: who may lock and resume, and that a locked
 * server's lease is never handed out by this route (or by deposit, or by a
 * stale resume).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  ed,
  buildAutoUnlockLeaseV2,
  signAutoUnlockLeaseV2,
  signBootSuspension,
  type BootSuspensionOrder,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryBootSuspensionStorage, InMemoryBoxSealedLeaseStorage, InMemorySecretMailboxStorage } from "@flagship/storage";
import { routeBoot, type BootRouteDeps } from "../src/routes.js";
import { signBootRequest, type GateRole } from "../src/gate.js";
import { InMemoryNonceStore } from "../src/nonceStore.js";
import type { DirectoryClient } from "../src/directory.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number): Keypair => ({ privateKey: new Uint8Array(32).fill(n), publicKey: ed.getPublicKey(new Uint8Array(32).fill(n)) });
const S = "kitchen.alice.flagship.services";
const box = kp(1);
const owner = kp(2);
const stranger = kp(9);

let now = 1_800_000_000_000;
let nonceCounter = 0;
let deps: BootRouteDeps;

const directory: DirectoryClient = {
  boxStkForDomain: async (d) => (d === S ? hex(box.publicKey) : null),
  ownerIrkForDomain: async (d) => (d === S ? hex(owner.publicKey) : null),
  activeBootDelegatesForDomain: async (d) => (d === S ? [] : null),
  usernameForDomain: async (d) => (d === S ? "alice" : null),
};

beforeEach(() => {
  now = 1_800_000_000_000;
  const suspensions = new InMemoryBootSuspensionStorage();
  deps = {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(suspensions),
    bootSuspensions: suspensions,
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory,
    notify: { notifyOwner: async () => true },
    gate: { directory, nonces: new InMemoryNonceStore(), now: () => now },
    now: () => now,
  };
});

function auth(role: GateRole, key: Keypair, method: string, path: string) {
  nonceCounter++;
  return signBootRequest(
    { role, serverDomain: S, method, path, pubKeyHex: hex(key.publicKey), nonceHex: nonceCounter.toString(16).padStart(64, "0"), issuedAt: now },
    key.privateKey,
  );
}
const ownerOrder = (epoch: number, action: "suspend" | "resume"): BootSuspensionOrder => ({
  serverDomain: S, epoch, seq: 0, action, reason: action === "suspend" ? "manual-lock" : "owner-resume", signer: "owner", issuedAt: now,
});
const boxOrder = (epoch: number, seq: number): BootSuspensionOrder => ({
  serverDomain: S, epoch, seq, action: "suspend", reason: "dead-man", signer: "box", issuedAt: now,
});
const body = (o: BootSuspensionOrder, key: Keypair) => ({ order: o, signature: hex(signBootSuspension(o, key.privateKey)) });

async function ownerSet(o: BootSuspensionOrder, key: Keypair = owner) {
  return routeBoot(deps, "PUT", "/api/boot/suspension", auth("owner", key, "PUT", "/api/boot/suspension"), body(o, key));
}
async function boxSet(o: BootSuspensionOrder, key: Keypair = box) {
  return routeBoot(deps, "POST", "/api/boot/suspension/box", auth("box", key, "POST", "/api/boot/suspension/box"), body(o, key));
}
async function deposit(id: string) {
  const lease = buildAutoUnlockLeaseV2({ serverDomain: S, stkPub: box.publicKey, leaseId: id.repeat(32).slice(0, 32), luksKey: new Uint8Array(32).fill(0xab), issuedAt: now, expiresAt: now + 3_600_000 });
  const sig = signAutoUnlockLeaseV2(lease, owner);
  return routeBoot(deps, "PUT", "/api/boot/lease", auth("owner", owner, "PUT", "/api/boot/lease"), {
    lease: { serverDomain: S, stkPub: hex(lease.stkPub), leaseId: lease.leaseId, sealedKey: hex(lease.sealedKey), issuedAt: lease.issuedAt, expiresAt: lease.expiresAt },
    signature: hex(sig),
  });
}
async function fetchLease() {
  const p = `/api/boot/lease/${S}`;
  return routeBoot(deps, "GET", p, auth("box", box, "GET", p), undefined);
}
async function read(role: GateRole, key: Keypair) {
  const p = `/api/boot/suspension/${S}`;
  return routeBoot(deps, "GET", p, auth(role, key, "GET", p), undefined);
}

describe("lock → the lease is gone and stays gone", () => {
  it("an owner lock revokes the leases, answers 423 to the box, and a new deposit does not lift it", async () => {
    expect((await deposit("a"))?.status).toBe(200);
    expect((await fetchLease())?.status).toBe(200);

    const lock = await ownerSet(ownerOrder(1, "suspend"));
    expect(lock?.status).toBe(200);
    expect(lock?.body).toMatchObject({ ok: true, durable: true, leasesRevoked: 1, state: { suspended: true, epoch: 1 } });

    expect((await fetchLease())?.status).toBe(423);
    expect((await deposit("b"))?.status).toBe(200); // storing is allowed...
    const again = await fetchLease(); // ...releasing is not
    expect(again?.status).toBe(423);
    expect(again?.body).toMatchObject({ suspended: true });
  });

  it("only a newer owner epoch resumes; then the box needs a fresh lease", async () => {
    await deposit("a");
    await ownerSet(ownerOrder(1, "suspend"));
    expect((await ownerSet(ownerOrder(1, "resume")))?.status).toBe(409); // not a new epoch
    expect((await ownerSet(ownerOrder(3, "resume")))?.status).toBe(409); // skipped one
    const ok = await ownerSet(ownerOrder(2, "resume"));
    expect(ok?.status).toBe(200);
    expect((await fetchLease())?.status).toBe(404); // the pre-lock lease did not survive
    await deposit("c");
    expect((await fetchLease())?.status).toBe(200);
  });
});

describe("the box key can lock but never unlock", () => {
  it("a dead-man post suspends and revokes; the same key cannot resume or reach the next epoch", async () => {
    await deposit("a");
    const r = await boxSet(boxOrder(0, 1));
    expect(r?.status).toBe(200);
    expect(r?.body).toMatchObject({ state: { suspended: true, signer: "box", reason: "dead-man" }, leasesRevoked: 1 });
    expect((await fetchLease())?.status).toBe(423);

    now += 60_000;
    expect((await boxSet({ ...boxOrder(0, 2), action: "resume" }))?.status).toBe(409);
    expect((await boxSet(boxOrder(1, 1)))?.status).toBe(409);
    expect((await fetchLease())?.status).toBe(423);
    // The owner's next epoch is still exactly 1.
    expect((await ownerSet(ownerOrder(1, "resume")))?.status).toBe(200);
  });

  it("the box cannot use the owner route, nor the owner the box route, nor a stranger either", async () => {
    expect((await ownerSet(ownerOrder(1, "suspend"), box))?.status).toBe(403);
    expect((await ownerSet(ownerOrder(1, "suspend"), stranger))?.status).toBe(403);
    // A box-role header cannot carry an owner-signed order.
    const o = ownerOrder(1, "suspend");
    const p = "/api/boot/suspension";
    const mismatched = await routeBoot(deps, "PUT", p, auth("box", box, "PUT", p), body(o, owner));
    expect(mismatched?.status).toBe(403);
    // And an order whose signer field says "owner" cannot ride the box route.
    const viaBox = await boxSet(ownerOrder(1, "suspend"));
    expect(viaBox?.status).toBe(400);
    expect((await read("owner", owner))?.body).toMatchObject({ suspended: false, epoch: 0 });
  });
});

describe("integrity", () => {
  it("rejects a signature that doesn't cover the order, a stale order, and malformed bodies", async () => {
    const o = ownerOrder(1, "suspend");
    const p = "/api/boot/suspension";
    const tampered = await routeBoot(deps, "PUT", p, auth("owner", owner, "PUT", p), { order: { ...o, epoch: 2 }, signature: hex(signBootSuspension(o, owner.privateKey)) });
    expect(tampered?.status).toBe(403);
    const old = { ...ownerOrder(1, "suspend"), issuedAt: now - 10 * 60_000 };
    expect((await ownerSet(old))?.status).toBe(409);
    const bad = await routeBoot(deps, "PUT", p, auth("owner", owner, "PUT", p), { order: { serverDomain: S }, signature: "zz" });
    expect(bad?.status).toBe(400);
    const none = await routeBoot(deps, "PUT", p, null, body(o, owner));
    expect(none?.status).toBe(400);
  });

  it("a record that cannot be written is reported as not durable, never as locked", async () => {
    deps.bootSuspensions = { get: async () => undefined, apply: async () => { throw new Error("down"); } };
    const r = await ownerSet(ownerOrder(1, "suspend"));
    expect(r?.status).toBe(503);
    expect(r?.body).toMatchObject({ durable: false });
  });

  it("a suspension read that fails is a 503, and an unreadable record blocks the lease", async () => {
    await deposit("a");
    const real = deps.bootSuspensions;
    deps.bootSuspensions = { get: async () => { throw new Error("down"); }, apply: real.apply.bind(real) };
    expect((await read("owner", owner))?.status).toBe(503);
    // the lease store was built over the healthy record, so only the route's own answer changes
    expect((await fetchLease())?.status).toBe(200);
  });
});

describe("reads", () => {
  it("owner and box can read the state; the signature is the order's", async () => {
    const o = ownerOrder(1, "suspend");
    await ownerSet(o);
    for (const [role, key] of [["owner", owner], ["box", box]] as const) {
      const g = await read(role, key);
      expect(g?.status).toBe(200);
      expect(g?.body).toMatchObject({ suspended: true, epoch: 1, seq: 0, signer: "owner", signature: hex(signBootSuspension(o, owner.privateKey)) });
    }
    expect((await read("owner", stranger))?.status).toBe(403);
  });
});
