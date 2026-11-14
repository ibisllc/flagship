/**
 * The hybrid companion of an admin-root rotation on `.com` (docs/architecture-v2/pq-suites.md §20):
 * checked under the old root's stored binding, relayed on the served lane, and the new root's
 * binding stored as the one the old root named.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalPqKeyBinding,
  hybridSign,
  hybridSigKeygen,
  signAdminRootRotation,
  signAdminRootRotationPq,
  type AdminRootRotation,
  type PqKeyBindingWire,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleApplyAdminRootRotation, handleListAdminRootRotations } from "../src/adminRootRotation.js";

const USER = "alice";
const NOW = 1_795_000_000_000;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function hybridKey(n: number) {
  const edSeed = new Uint8Array(32).fill(n);
  const { publicKey, secretKey } = hybridSigKeygen(edSeed, new Uint8Array(32).fill(n + 100));
  return { edSeed, publicKey: publicKey.subarray(0, 32), mldsaHex: hex(publicKey.subarray(32)), secret: secretKey };
}
type HK = ReturnType<typeof hybridKey>;

function binding(k: HK): PqKeyBindingWire {
  const st = { role: "admin-root" as const, subjectId: USER, ed25519PubHex: hex(k.publicKey), mldsaPubHex: k.mldsaHex, issuedAt: NOW - 1000 };
  return { v: 1, ...st, signature: hex(hybridSign(k.secret, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st))) };
}

async function setup(a: HK) {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: USER, irkPubHex: "11".repeat(32), claimedAt: 1, adminRootPubHex: hex(a.publicKey) });
  const b = binding(a);
  await storage.pqTrust.putBinding({ role: "admin-root", subjectId: USER, ed25519PubHex: b.ed25519PubHex, mldsaPubHex: b.mldsaPubHex, issuedAt: b.issuedAt, signatureHex: b.signature, storedAt: NOW });
  return { storage, deps: { usernames: storage.usernames, rotations: storage.adminRootRotations, pqTrust: storage.pqTrust, now: () => NOW } };
}

function body(from: HK, to: HK, pqSigner: HK = from) {
  const r: AdminRootRotation = { username: USER, oldAdminRootPub: from.publicKey, newAdminRootPub: to.publicKey, issuedAt: NOW - 10 };
  return {
    rotation: { username: USER, oldAdminRootPub: hex(from.publicKey), newAdminRootPub: hex(to.publicKey), issuedAt: r.issuedAt },
    signatureHex: hex(signAdminRootRotation(r, { privateKey: from.edSeed, publicKey: from.publicKey })),
    pq: signAdminRootRotationPq(r, pqSigner.secret, binding(to)),
  };
}

describe("hybrid admin-root rotation on .com", () => {
  it("stores and serves the companion, and takes the new root's binding", async () => {
    const a = hybridKey(1);
    const b = hybridKey(2);
    const { storage, deps } = await setup(a);
    const res = await handleApplyAdminRootRotation(deps, USER, body(a, b));
    expect(res.status).toBe(200);
    const listed = (await handleListAdminRootRotations(deps, USER)).body as { rotations: { pq?: { newRootBinding: PqKeyBindingWire } }[] };
    expect(listed.rotations[0]?.pq?.newRootBinding.mldsaPubHex).toBe(b.mldsaHex);
    expect((await storage.pqTrust.getBinding("admin-root", USER))?.mldsaPubHex).toBe(b.mldsaHex);
  });

  it("refuses a companion the old root's PQ half did not sign, and changes nothing", async () => {
    const a = hybridKey(1);
    const b = hybridKey(2);
    const { storage, deps } = await setup(a);
    const res = await handleApplyAdminRootRotation(deps, USER, body(a, b, b));
    expect(res.status).toBe(403);
    expect((await storage.usernames.get(USER))?.adminRootPubHex).toBe(hex(a.publicKey));
    expect(await storage.adminRootRotations.list(USER)).toHaveLength(0);
  });
});
