import { describe, expect, it, beforeEach } from "vitest";
import {
  ed,
  buildAutoUnlockLeaseV2,
  signAutoUnlockLeaseV2,
  signSecretRequest,
  openSealedFromEd25519Recipient,
  type Keypair,
  type SecretRequest,
} from "@flagship/protocol";
import { InMemoryBootSuspensionStorage, InMemoryBoxSealedLeaseStorage, InMemorySecretMailboxStorage } from "@flagship/storage";
import { routeBoot, type BootRouteDeps } from "../src/routes.js";
import { gate, signBootRequest } from "../src/gate.js";
import { InMemoryNonceStore } from "../src/nonceStore.js";
import type { DirectoryClient } from "../src/directory.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const S = "kitchen.alice.flagship.services";
const stk = kp(1);
const owner = kp(2);
const bootKey = kp(5);
const stranger = kp(6);
let now = 1_000_000;
let n = 0;
const nonce = () => (++n).toString(16).padStart(64, "0");

function directory(withBootKey: boolean): DirectoryClient {
  return {
    async boxStkForDomain(d) { return d === S ? hex(stk.publicKey) : null; },
    async ownerIrkForDomain(d) { return d === S ? hex(owner.publicKey) : null; },
    async activeBootDelegatesForDomain() { return []; },
    async usernameForDomain(d) { return d === S ? "alice" : null; },
    ...(withBootKey ? { async boxBootKeyForDomain(d: string) { return d === S ? hex(bootKey.publicKey) : null; } } : {}),
  };
}

function deps(withBootKey = true): BootRouteDeps {
  const dir = directory(withBootKey);
  const susp = new InMemoryBootSuspensionStorage();
  return {
    boxSealedLeases: new InMemoryBoxSealedLeaseStorage(susp),
    bootSuspensions: susp,
    secretMailbox: new InMemorySecretMailboxStorage(),
    directory: dir,
    notify: { notifyOwner: async () => true },
    gate: { directory: dir, nonces: new InMemoryNonceStore(), now: () => now },
    now: () => now,
  };
}

const auth = (k: Keypair, role: "box" | "owner", method: string, path: string) =>
  signBootRequest({ role, serverDomain: S, method, path, pubKeyHex: hex(k.publicKey), nonceHex: nonce(), issuedAt: now }, k.privateKey);

function requestBody(k: Keypair, purpose: "unlock-key" | "entitlement" = "unlock-key") {
  const req: SecretRequest = { serverDomain: S, stkPub: k.publicKey, purpose, nonce: new Uint8Array(32).fill(9), issuedAt: now };
  return {
    request: { serverDomain: S, stkPub: hex(k.publicKey), purpose, nonce: hex(req.nonce), issuedAt: now },
    signature: hex(signSecretRequest(req, k)),
  };
}

describe("the boot key on the boot worker", () => {
  beforeEach(() => { now = 1_000_000; });

  it("lets the bound boot key announce an unlock request, poll, and fetch a lease sealed to it", async () => {
    const d = deps();
    const post = await routeBoot(d, "POST", "/api/boot/request", auth(bootKey, "box", "POST", "/api/boot/request"), requestBody(bootKey));
    expect(post?.status).toBe(200);
    const poll = `/api/boot/response/${S}/${"09".repeat(32)}`;
    expect((await routeBoot(d, "GET", poll, auth(bootKey, "box", "GET", poll), null))?.status).toBe(404);

    const luksKey = new Uint8Array(64).fill(0x42);
    const lease = buildAutoUnlockLeaseV2({ serverDomain: S, stkPub: bootKey.publicKey, leaseId: "b".repeat(32), luksKey, issuedAt: now, expiresAt: now + 3_600_000 });
    const body = {
      lease: { serverDomain: S, stkPub: hex(bootKey.publicKey), leaseId: lease.leaseId, sealedKey: hex(lease.sealedKey), issuedAt: now, expiresAt: lease.expiresAt },
      signature: hex(signAutoUnlockLeaseV2(lease, owner)),
    };
    expect((await routeBoot(d, "PUT", "/api/boot/lease", auth(owner, "owner", "PUT", "/api/boot/lease"), body))?.status).toBe(200);
    const get = `/api/boot/lease/${S}`;
    const got = await routeBoot(d, "GET", get, auth(bootKey, "box", "GET", get), null);
    expect(got?.status).toBe(200);
    const sealed = Buffer.from((got!.body as { sealedKey: string }).sealedKey, "hex");
    expect(hex(openSealedFromEd25519Recipient(sealed, bootKey.privateKey))).toBe(hex(luksKey));
  });

  it("refuses an entitlement request signed by the boot key", async () => {
    const d = deps();
    const res = await routeBoot(d, "POST", "/api/boot/request", auth(bootKey, "box", "POST", "/api/boot/request"), requestBody(bootKey, "entitlement"));
    expect(res?.status).toBe(403);
  });

  it("refuses a key no binding names, and the boot key when the directory has no binding", async () => {
    expect((await routeBoot(deps(), "POST", "/api/boot/request", auth(stranger, "box", "POST", "/api/boot/request"), requestBody(stranger)))?.status).toBe(403);
    expect((await routeBoot(deps(false), "POST", "/api/boot/request", auth(bootKey, "box", "POST", "/api/boot/request"), requestBody(bootKey)))?.status).toBe(403);
  });

  it("keeps the boot key off box routes that are not pre-unlock (the box's own lock)", async () => {
    const d = deps();
    const r = await gate(d.gate, { role: "box", serverDomain: S, method: "POST", path: "/api/boot/suspension/box" }, auth(bootKey, "box", "POST", "/api/boot/suspension/box"));
    expect(r.ok).toBe(false);
    const ok = await gate(d.gate, { role: "box", serverDomain: S, method: "POST", path: "/x", allowBootKey: true }, auth(bootKey, "box", "POST", "/x"));
    expect(ok).toMatchObject({ ok: true, boxKey: "boot-key" });
    const stkOk = await gate(d.gate, { role: "box", serverDomain: S, method: "POST", path: "/x", allowBootKey: true }, auth(stk, "box", "POST", "/x"));
    expect(stkOk).toMatchObject({ ok: true, boxKey: "stk" });
  });

  it("refuses a lease sealed to a key that is neither the STK nor the bound boot key", async () => {
    const d = deps();
    const lease = buildAutoUnlockLeaseV2({ serverDomain: S, stkPub: stranger.publicKey, leaseId: "c".repeat(32), luksKey: new Uint8Array(64), issuedAt: now, expiresAt: now + 3_600_000 });
    const body = {
      lease: { serverDomain: S, stkPub: hex(stranger.publicKey), leaseId: lease.leaseId, sealedKey: hex(lease.sealedKey), issuedAt: now, expiresAt: lease.expiresAt },
      signature: hex(signAutoUnlockLeaseV2(lease, owner)),
    };
    expect((await routeBoot(d, "PUT", "/api/boot/lease", auth(owner, "owner", "PUT", "/api/boot/lease"), body))?.status).toBe(403);
  });
});
