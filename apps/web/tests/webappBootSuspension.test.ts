// SEC-LOCK-001 in the webapp: shared vectors, and the whole lock/resume flow
// against the real boot-worker router (in process).
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { routeBoot, InMemoryNonceStore, type BootRouteDeps, type DirectoryClient } from "@flagship/boot-core";
import { InMemoryBootSuspensionStorage, InMemoryBoxSealedLeaseStorage, InMemorySecretMailboxStorage } from "@flagship/storage";
import { deriveIRK, ed, buildAutoUnlockLeaseV2, verifyBootSuspension, signBootSuspension } from "@flagship/protocol";
import {
  boundedLeaseTtl,
  canonicalBootSuspensionBytes,
  cachedDeadManView,
  describeLockResult,
  leaseCapForDeadMan,
  lockAndPower,
  markLockPending,
  pendingLocks,
  readSuspension,
  rememberDeadManView,
  retryPendingLocks,
  setOwnerSuspension,
} from "../public/webapp/lib/bootSuspension.js";

const V = JSON.parse(readFileSync(new URL("../../../packages/protocol/test-vectors/boot-suspension/vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const S = "home.alice.flagship.services";
const umk = new Uint8Array(32).fill(7);
const irk = deriveIRK({ seed: umk });
const boxPriv = new Uint8Array(32).fill(31);
const boxPub = ed.getPublicKey(boxPriv);
const signWithIrk = async (_u: Uint8Array, bytes: Uint8Array) => ed25519.sign(bytes, irk.privateKey);
let t = 1_800_000_000_000;

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

function world() {
  const directory: DirectoryClient = {
    boxStkForDomain: async (d) => (d === S ? hex(boxPub) : null),
    ownerIrkForDomain: async (d) => (d === S ? hex(irk.publicKey) : null),
    activeBootDelegatesForDomain: async (d) => (d === S ? [] : null),
    usernameForDomain: async (d) => (d === S ? "alice" : null),
  };
  const suspensions = new InMemoryBootSuspensionStorage();
  const deps: BootRouteDeps = {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(suspensions),
    bootSuspensions: suspensions,
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory,
    notify: { notifyOwner: async () => true },
    gate: { directory, nonces: new InMemoryNonceStore(), now: () => t },
    now: () => t,
  };
  let down = false;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (down) throw new Error("offline");
    const u = new URL(url);
    const res = await routeBoot(deps, init.method ?? "GET", u.pathname, (init.headers as Record<string, string>)?.authorization ?? null, init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(res?.body ?? {}), { status: res?.status ?? 404 });
  });
  const d = (extra: Record<string, unknown> = {}) => ({
    session: { umk, irk }, fetch: fetchImpl, bootBase: "https://boot.example", signWithIrk, now: () => t, storage: mem(), ...extra,
  });
  return { deps, fetchImpl, d, setDown: (v: boolean) => (down = v) };
}

describe("canonical bytes match the shared vectors", () => {
  it("every step's canonical string and signature", () => {
    for (const s of V.steps) {
      expect(new TextDecoder().decode(canonicalBootSuspensionBytes(s.order)), s.name).toBe(s.canonical);
    }
    const owner = V.steps[0];
    const sig = ed25519.sign(canonicalBootSuspensionBytes(owner.order), new Uint8Array(Buffer.from(V.ownerSeedHex, "hex")));
    expect(hex(sig)).toBe(owner.signatureHex);
  });

  it("rejects a field that would break the form", () => {
    const o = V.steps[0].order;
    expect(() => canonicalBootSuspensionBytes({ ...o, serverDomain: "a|b" })).toThrow();
    expect(() => canonicalBootSuspensionBytes({ ...o, epoch: -1 })).toThrow();
    expect(() => canonicalBootSuspensionBytes({ ...o, signer: "root" })).toThrow();
  });
});

describe("lock and resume against the boot worker", () => {
  it("a lock is durable, revokes the leases and answers 423 to the box; only a new epoch resumes", async () => {
    const w = world();
    const lease = buildAutoUnlockLeaseV2({ serverDomain: S, stkPub: boxPub, leaseId: "a".repeat(32), luksKey: new Uint8Array(32).fill(2), issuedAt: t, expiresAt: t + 3_600_000 });
    await w.deps.boxSealedLeases.put({ serverDomain: S, leaseId: lease.leaseId, stkPubHex: hex(boxPub), sealedKeyHex: hex(lease.sealedKey), issuedAt: t, expiresAt: t + 3_600_000, maxUses: null, usesConsumed: 0, signatureHex: "cc".repeat(64), depositedAt: t });

    const r = await setOwnerSuspension(S, "suspend", w.d());
    expect(r).toMatchObject({ durable: true, leasesRevoked: 1, state: { suspended: true, epoch: 1 } });
    expect(await w.deps.boxSealedLeases.release(S, t)).toBeUndefined();
    expect(await readSuspension(S, w.d())).toMatchObject({ suspended: true, epoch: 1, signer: "owner" });

    // The signature the worker kept verifies for anyone.
    const rec = await w.deps.bootSuspensions.get(S);
    const order = { serverDomain: S, epoch: 1, seq: 0, action: "suspend" as const, reason: "manual-lock" as const, signer: "owner" as const, issuedAt: rec!.orderIssuedAt };
    expect(verifyBootSuspension(order, new Uint8Array(Buffer.from(rec!.signatureHex, "hex")), irk.publicKey)).toBe(true);

    const back = await setOwnerSuspension(S, "resume", w.d());
    expect(back).toMatchObject({ durable: true, state: { suspended: false, epoch: 2 } });
    expect(await w.deps.boxSealedLeases.release(S, t)).toBeUndefined(); // the old lease did not come back
  });

  it("an unreachable worker is reported as not durable, never as locked", async () => {
    const w = world();
    w.setDown(true);
    expect(await setOwnerSuspension(S, "suspend", w.d())).toMatchObject({ durable: false, why: "unreachable" });
    expect(await readSuspension(S, w.d())).toBeNull();
  });

  it("a worker that can't record it answers not-durable", async () => {
    const w = world();
    w.deps.bootSuspensions = { get: async () => undefined, apply: async () => { throw new Error("down"); } };
    expect(await setOwnerSuspension(S, "suspend", w.d())).toMatchObject({ durable: false, why: "not-durable" });
  });

  it("moves on to the next epoch when the record changed underneath it", async () => {
    const w = world();
    // The box locks itself between the phone's read and its write: the phone's epoch 1 still lands.
    const boxOrder = { serverDomain: S, epoch: 0, seq: 1, action: "suspend" as const, reason: "dead-man" as const, signer: "box" as const, issuedAt: t };
    await w.deps.bootSuspensions.apply(boxOrder, hex(signBootSuspension(boxOrder, boxPriv)), t);
    const r = await setOwnerSuspension(S, "suspend", w.d({ reuseExisting: false }));
    expect(r).toMatchObject({ durable: true, state: { epoch: 1, suspended: true, signer: "owner" } });
  });
});

describe("lock and power", () => {
  it("off: both at once; the power order is sent even when the worker is down, and the lock stays pending", async () => {
    const w = world();
    w.setDown(true);
    const storage = mem();
    const sent: string[] = [];
    const r = await lockAndPower({ serverDomain: S, mode: "off", sendPower: async (m: string) => void sent.push(m) }, w.d({ storage }));
    expect(sent).toEqual(["off"]);
    expect(r).toMatchObject({ lock: "pending", power: "sent" });
    expect(describeLockResult(r)).toMatch(/powering off; remote lock pending/i);
    expect(describeLockResult(r)).not.toMatch(/\blocked\b.*can't unlock/);
    expect(pendingLocks({ storage })).toEqual([S]);
    // Back online: the pending lock lands.
    w.setDown(false);
    expect(await retryPendingLocks(w.d({ storage }))).toEqual([S]);
    expect(pendingLocks({ storage })).toEqual([]);
    expect(await readSuspension(S, w.d())).toMatchObject({ suspended: true });
  });

  it("restart: waits for the lock; if it can't be made the restart is NOT sent and shutdown is offered", async () => {
    const w = world();
    w.setDown(true);
    const sent: string[] = [];
    const r = await lockAndPower({ serverDomain: S, mode: "restart", sendPower: async (m: string) => void sent.push(m) }, w.d());
    expect(sent).toEqual([]);
    expect(r).toMatchObject({ lock: "pending", power: "not-sent", needsChoice: "shutdown-instead" });
    expect(describeLockResult(r)).toMatch(/not restarted/i);
  });

  it("restart with a durable lock sends the restart afterwards", async () => {
    const w = world();
    const order: string[] = [];
    const r = await lockAndPower({ serverDomain: S, mode: "restart", sendPower: async (m: string) => void order.push(`power:${m}`) }, w.d());
    expect(order).toEqual(["power:restart"]);
    expect(r).toMatchObject({ lock: "confirmed", power: "sent" });
    expect((await w.deps.bootSuspensions.get(S))?.suspended).toBe(true);
  });

  it("a failed power order is reported as such, not as success", async () => {
    const w = world();
    const r = await lockAndPower({ serverDomain: S, mode: "off", sendPower: async () => { throw new Error("no route"); } }, w.d());
    expect(r).toMatchObject({ lock: "confirmed", power: "failed" });
    expect(describeLockResult(r)).toMatch(/power command didn't reach/i);
  });
});

describe("dead-man bounds on leases", () => {
  it("caps a lease at the affirmation deadline and refuses one past a lapsed switch", () => {
    expect(boundedLeaseTtl(7 * 86_400_000, { enabled: true, leaseExpiry: t + 60_000 }, t)).toBe(60_000);
    expect(boundedLeaseTtl(1000, { enabled: true, leaseExpiry: t + 60_000 }, t)).toBe(1000);
    expect(boundedLeaseTtl(1000, { enabled: true, leaseExpiry: t - 1 }, t)).toBe(0);
    expect(boundedLeaseTtl(1000, { enabled: true, leaseExpiry: 0 }, t)).toBe(0);
    expect(boundedLeaseTtl(1000, { enabled: false, leaseExpiry: 0 }, t)).toBe(1000);
    expect(leaseCapForDeadMan({ enabled: false, leaseExpiry: 5 }, t)).toBeNull();
  });

  it("remembers what the box said, and forgets it after six hours", () => {
    const storage = mem();
    expect(cachedDeadManView(S, { storage, now: () => t })).toBeUndefined();
    rememberDeadManView(S, { enabled: true, leaseExpiry: t + 1 }, { storage, now: () => t });
    expect(cachedDeadManView(S, { storage, now: () => t + 1000 })).toEqual({ enabled: true, leaseExpiry: t + 1 });
    expect(cachedDeadManView(S, { storage, now: () => t + 7 * 3_600_000 })).toBeUndefined();
    rememberDeadManView(S, null, { storage, now: () => t });
    expect(cachedDeadManView(S, { storage, now: () => t })).toEqual({ enabled: false, leaseExpiry: 0 });
  });
});

void markLockPending;
