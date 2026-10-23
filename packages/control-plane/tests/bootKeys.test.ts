import { describe, expect, it } from "vitest";
import { bootKeyBindingToWire, ed, signBootKeyBinding, signAutoUnlockLeaseV2, buildAutoUnlockLeaseV2 } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetBootKey, handlePutBootKey } from "../src/bootKeys.js";
import { handlePostServerHealth } from "../src/serverHealth.js";
import { handlePostBoxSealedLease } from "../src/secretMailbox.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const S = "home.alice.flagship.services";
const stk = kp(0x0b);
const boot = kp(0x1b);
const other = kp(0x0c);
const owner = kp(0x07);
const T = 1_760_000_000_000;

async function world() {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stk.publicKey), registeredAt: T });
  return { storage, deps: { servers: storage.servers, serverBootKeys: storage.serverBootKeys, now: () => T } };
}
const binding = (signer = stk, issuedAt = T, bootPub = boot.publicKey) => {
  const b = { serverDomain: S, bootPubHex: hex(bootPub), issuedAt };
  return bootKeyBindingToWire(b, signBootKeyBinding(b, signer));
};

describe("/api/server/:host/boot-key", () => {
  it("stores a binding the registered STK signed and serves it back", async () => {
    const { deps } = await world();
    expect((await handlePutBootKey(deps, S, binding())).status).toBe(200);
    const got = await handleGetBootKey(deps, S);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(binding());
  });

  it("refuses a binding signed by another key, for another host, or older than the stored one", async () => {
    const { deps } = await world();
    expect((await handlePutBootKey(deps, S, binding(other))).status).toBe(403);
    expect((await handlePutBootKey(deps, "x.alice.flagship.services", binding())).status).toBe(403);
    expect((await handlePutBootKey(deps, S, { junk: 1 })).status).toBe(400);
    expect((await handlePutBootKey(deps, S, binding(stk, T + 5))).status).toBe(200);
    expect((await handlePutBootKey(deps, S, binding(stk, T, other.publicKey))).status).toBe(409);
  });

  it("stops serving the binding once the server's STK changes", async () => {
    const { storage, deps } = await world();
    await handlePutBootKey(deps, S, binding());
    await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(other.publicKey), registeredAt: T });
    expect((await handleGetBootKey(deps, S)).status).toBe(404);
  });

  it("accepts a health report signed by the bound boot key", async () => {
    const { storage, deps } = await world();
    await handlePutBootKey(deps, S, binding());
    const report = JSON.stringify({ v: 1, domain: S, at: T, uptimeS: 1, memTotalMB: 1, memAvailMB: 1, swapUsedMB: 0, oomKills: 0, daemon: { state: "active", restarts: 0, lastExit: 0 }, tunnel: true, diskUsedPct: 1 });
    const sign = (k: typeof boot) => hex(ed.sign(new TextEncoder().encode(report), k.privateKey));
    const h = { servers: storage.servers, serverHealth: storage.serverHealth, serverBootKeys: storage.serverBootKeys, now: () => T };
    expect((await handlePostServerHealth(h, S, { report, signature: sign(boot) })).status).toBe(200);
    expect((await handlePostServerHealth(h, S, { report, signature: sign(other) })).status).toBe(403);
  });

  it("takes a lease sealed to the bound boot key", async () => {
    const { storage, deps } = await world();
    await storage.usernames.put({ username: "alice", irkPubHex: hex(owner.publicKey), claimedAt: T });
    await handlePutBootKey(deps, S, binding());
    const lease = buildAutoUnlockLeaseV2({ serverDomain: S, stkPub: boot.publicKey, leaseId: "d".repeat(32), luksKey: new Uint8Array(64), issuedAt: T, expiresAt: T + 3_600_000 });
    const body = {
      lease: { serverDomain: S, stkPub: hex(boot.publicKey), leaseId: lease.leaseId, sealedKey: hex(lease.sealedKey), issuedAt: T, expiresAt: lease.expiresAt },
      signature: hex(signAutoUnlockLeaseV2(lease, owner)),
    };
    const mbox = { servers: storage.servers, usernames: storage.usernames, secretMailbox: storage.secretMailbox, boxSealedLeases: storage.boxSealedLeases, serverBootKeys: storage.serverBootKeys, now: () => T };
    const res = await handlePostBoxSealedLease(mbox, S, body);
    expect(res.status).toBe(200);
    const stranger = { ...body, lease: { ...body.lease, stkPub: hex(other.publicKey) } };
    expect((await handlePostBoxSealedLease(mbox, S, stranger)).status).toBe(403);
  });
});
