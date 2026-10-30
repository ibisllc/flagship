import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signDeviceCapabilityGrant, type DeviceCapabilityGrant } from "@flagship/protocol";
import { bytesToHex as hex } from "@noble/hashes/utils";
import { AccessPrincipals, AccountDeviceBook } from "../src/accessPrincipals.js";
import { ServiceAccessStore } from "../src/serviceAccess.js";

const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const ownerIrk = kp(1);
const adminRoot = kp(2);
const ownerAid = kp(3);
const adminDevice = kp(4);
const NOW = Date.now();

describe("the resolver the access store holds", () => {
  it("hands an admin device's own grant to keyd as the evidence for master (the book is behind the resolver)", async () => {
    const g: DeviceCapabilityGrant = {
      grantId: "0123456789abcdef0123456789abcdef",
      username: "alice",
      deviceId: "fedcba9876543210fedcba9876543210",
      devicePubKey: adminDevice.publicKey,
      scopes: ["admin", "browse", "view-directory"],
      issuedAt: NOW - 10,
      expiresAt: NOW + 3_600_000,
    };
    const book = new AccountDeviceBook({
      path: join(mkdtempSync(join(tmpdir(), "ev-")), "account-devices.json"),
      username: "alice",
      ownerIrkPub: () => ownerIrk.publicKey,
      adminRootPub: () => adminRoot.publicKey,
      fetchGrants: async () => ({
        grants: [
          {
            grantId: g.grantId, username: "alice", deviceId: g.deviceId, devicePubHex: hex(adminDevice.publicKey),
            scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt,
            signatureHex: hex(signDeviceCapabilityGrant(g, adminRoot)), signerRoot: "admin-root",
          },
        ],
      }),
    });
    await book.refresh();
    const principals = new AccessPrincipals(hex(ownerAid.publicKey));
    principals.book = book;
    const store = new ServiceAccessStore(join(mkdtempSync(join(tmpdir(), "ev-")), "service-access.json"), { principals });
    await store.load();
    const p = principals.classify(hex(adminDevice.publicKey));
    expect(p).toMatchObject({ kind: "device", tier: "admin" });
    const ev = store.masterEvidence("alice--shop", p!);
    expect(ev?.statement).toMatch(/^flagship\/device-capability-grant\/v2\|/);
    expect(ev?.signatureHex).toHaveLength(128);
  });
});
