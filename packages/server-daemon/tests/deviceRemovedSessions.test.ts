/**
 * A device removed from the account (docs/revocation-ui.md) leaves the box's device book on the next refresh, and
 * the box ends what it had open: its app sign-ins (`ServiceSessionStore`) and its quantum-safe sessions.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ed, signDeviceCapabilityGrant, type DeviceCapabilityGrant } from "@flagship/protocol";
import { bytesToHex as hex } from "@noble/hashes/utils";
import { AccountDeviceBook, type DroppedDevice } from "../src/accessPrincipals.js";
import { ServiceSessionStore } from "../src/serviceAccess.js";

const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const ownerIrk = kp(1);
const adminRoot = kp(2);
const phone = kp(4);
const tablet = kp(5);
const NOW = Date.now();

function listed(device: ReturnType<typeof kp>, deviceId: string, grantId: string) {
  const g: DeviceCapabilityGrant = {
    grantId,
    username: "alice",
    deviceId,
    devicePubKey: device.publicKey,
    scopes: ["browse", "view-directory"],
    issuedAt: NOW - 10,
    expiresAt: NOW + 3_600_000,
  };
  return {
    grantId, username: "alice", deviceId, devicePubHex: hex(device.publicKey),
    scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(g, adminRoot)), signerRoot: "admin-root",
  };
}

const PHONE_ID = "a".repeat(32);
const TABLET_ID = "b".repeat(32);

function world() {
  let grants = [listed(phone, PHONE_ID, "1".repeat(32)), listed(tablet, TABLET_ID, "2".repeat(32))];
  const dir = mkdtempSync(join(tmpdir(), "removed-"));
  const book = new AccountDeviceBook({
    path: join(dir, "account-devices.json"),
    username: "alice",
    ownerIrkPub: () => ownerIrk.publicKey,
    adminRootPub: () => adminRoot.publicKey,
    fetchGrants: async () => ({ grants }),
  });
  const seen: DroppedDevice[][] = [];
  book.onDropped((d) => void seen.push(d));
  return {
    book,
    seen,
    dir,
    removeTablet: () => (grants = grants.filter((g) => g.deviceId !== TABLET_ID)),
    unreachable: () => (grants = null as never),
  };
}

describe("a device removed from the account", () => {
  it("is reported once when a refresh no longer lists it, never at start-up", async () => {
    const w = world();
    await w.book.refresh();
    expect(w.seen).toEqual([]);
    w.removeTablet();
    await w.book.refresh();
    expect(w.seen).toEqual([[{ pub: hex(tablet.publicKey), deviceId: TABLET_ID }]]);
    await w.book.refresh();
    expect(w.seen).toHaveLength(1);

    const again = new AccountDeviceBook({
      path: join(w.dir, "account-devices.json"),
      username: "alice",
      ownerIrkPub: () => ownerIrk.publicKey,
      adminRootPub: () => adminRoot.publicKey,
    });
    const fresh: DroppedDevice[][] = [];
    again.onDropped((d) => void fresh.push(d));
    await again.load();
    expect(fresh).toEqual([]);
    expect(again.classify(hex(phone.publicKey))?.deviceId).toBe(PHONE_ID);
  });

  it("is not reported when `.com` can't be reached (the book is kept)", async () => {
    const w = world();
    await w.book.refresh();
    w.unreachable();
    await w.book.refresh();
    expect(w.seen).toEqual([]);
    expect(w.book.classify(hex(tablet.publicKey))).not.toBeNull();
  });

  it("is reported when the admin root revokes its grant on the box", async () => {
    const w = world();
    await w.book.refresh();
    await w.book.dropGrant("2".repeat(32));
    expect(w.seen).toEqual([[{ pub: hex(tablet.publicKey), deviceId: TABLET_ID }]]);
    await w.book.dropGrant("9".repeat(32));
    expect(w.seen).toHaveLength(1);
  });

  it("loses its app sign-ins; the other devices keep theirs", async () => {
    const store = new ServiceSessionStore(join(mkdtempSync(join(tmpdir(), "sess-")), "service-sessions.json"));
    await store.load();
    const t1 = await store.issue("alice--shop", hex(tablet.publicKey), NOW, 60_000);
    const t2 = await store.issue("alice--notes", hex(tablet.publicKey).toUpperCase(), NOW, 60_000);
    const p1 = await store.issue("alice--shop", hex(phone.publicKey), NOW, 60_000);
    expect(await store.closeAllForAid(hex(tablet.publicKey))).toBe(2);
    expect(store.lookup(t1, NOW)).toBeNull();
    expect(store.lookup(t2, NOW)).toBeNull();
    expect(store.lookup(p1, NOW)).toEqual({ serviceRef: "alice--shop", aid: hex(phone.publicKey) });
    expect(await store.closeAllForAid(hex(tablet.publicKey))).toBe(0);
  });
});
