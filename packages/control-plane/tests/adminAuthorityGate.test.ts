/**
 * Slice D — Phase 1 enforcement: the clean-slate master-admin gate on `.com`
 * SENSITIVE ops (docs/device-admin-tier-spec.md §2/§3).
 *
 * Representative coverage of the gate's three regimes on two ops (custom-domain
 * set + release-server-name):
 *   - GATE CLOSED (no admin root pinned): the LEGACY owner-IRK verify works
 *     unchanged (existing accounts are unaffected).
 *   - GATE OPEN (admin root pinned): an ADMIN-ROOT-signed order is accepted; the
 *     membership-IRK-signed order is REJECTED (the authority split).
 *   - GATE OPEN + a delegated device holding an admin-root-signed `admin` grant:
 *     the device-signed order is accepted (least-privilege promotion §4.2).
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signSetCustomDomain,
  signReleaseServerName,
  signDeviceCapabilityGrant,
  type DeviceCapabilityGrant,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleSetCustomDomain } from "../src/customDomain.js";
import { handleServerReleaseName } from "../src/serverRevoke.js";

const USER = "alice";
const APP = "alice-game1";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

async function seedAccount(
  s: InMemoryStorage,
  irk: Keypair,
  adminRoot?: Keypair,
): Promise<void> {
  await s.usernames.put({
    username: USER,
    irkPubHex: hex(irk.publicKey),
    claimedAt: 1,
    ...(adminRoot ? { adminRootPubHex: hex(adminRoot.publicKey) } : {}),
  });
  await s.servers.put({
    serverDomain: "home.alice.flagship.services",
    username: USER,
    identityPubKeyHex: "11".repeat(32),
    registeredAt: 1,
  });
}

// ── custom-domain (§2 row 20) ────────────────────────────────────────────
function customDomainBody(signer: Keypair, fqdn: string, issuedAt: number) {
  const claim = { username: USER, serviceId: APP, fqdn, issuedAt };
  return { request: claim, signature: hex(signSetCustomDomain(claim, signer)) };
}

describe("Slice D gate — set-custom-domain (§2 row 20)", () => {
  const NOW = 1_000_000;

  it("GATE CLOSED (no admin root): the legacy owner-IRK verify still works", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seedAccount(s, irk); // no admin root
    const r = await handleSetCustomDomain(
      { usernames: s.usernames, customDomainOrders: s.customDomainOrders, now: () => NOW },
      USER,
      APP,
      customDomainBody(irk, "shop.example.com", NOW),
    );
    expect(r.status).toBe(200);
  });

  it("GATE OPEN: admin-root-signed accepted, owner-IRK-signed REJECTED", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const adminRoot = makeKey();
    await seedAccount(s, irk, adminRoot);
    const deps = {
      usernames: s.usernames,
      customDomainOrders: s.customDomainOrders,
      grants: s.deviceCapabilityGrants,
      now: () => NOW,
    };

    // The membership IRK can no longer authorize a sensitive op.
    const rejected = await handleSetCustomDomain(
      deps, USER, APP, customDomainBody(irk, "shop.example.com", NOW),
    );
    expect(rejected.status).toBe(403);

    // The admin master root can.
    const accepted = await handleSetCustomDomain(
      deps, USER, APP, customDomainBody(adminRoot, "shop.example.com", NOW),
    );
    expect(accepted.status).toBe(200);
  });

  it("GATE OPEN: a device with an admin-root-signed `admin` grant is accepted", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const adminRoot = makeKey();
    const device = makeKey();
    await seedAccount(s, irk, adminRoot);

    // Mint an admin-root-signed `admin` grant for the device.
    const grant: DeviceCapabilityGrant = {
      grantId: "g-admin-1",
      username: USER,
      deviceLabel: "ipad",
      devicePubKey: device.publicKey,
      scopes: ["admin"],
      issuedAt: NOW - 1000,
      expiresAt: NOW + 10_000_000,
    };
    const grantSig = signDeviceCapabilityGrant(grant, adminRoot); // signed by the ADMIN ROOT
    await s.deviceCapabilityGrants.put({
      grantId: grant.grantId,
      username: USER,
      deviceLabel: grant.deviceLabel,
      devicePubHex: hex(device.publicKey),
      scopesJson: JSON.stringify(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: hex(grantSig),
      revokedAt: null,
      signerRoot: "admin-root",
    });

    const r = await handleSetCustomDomain(
      {
        usernames: s.usernames,
        customDomainOrders: s.customDomainOrders,
        grants: s.deviceCapabilityGrants,
        now: () => NOW,
      },
      USER,
      APP,
      customDomainBody(device, "shop.example.com", NOW),
    );
    expect(r.status).toBe(200);
  });

  it("GATE OPEN: a MEMBERSHIP-signed `admin` grant does NOT satisfy the gate", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const adminRoot = makeKey();
    const device = makeKey();
    await seedAccount(s, irk, adminRoot);

    // A grant that lists `admin` but is signed by the membership IRK (forged) +
    // stamped `membership` must be rejected by requireMasterAdmin.
    const grant: DeviceCapabilityGrant = {
      grantId: "g-forged-1",
      username: USER,
      deviceLabel: "ipad",
      devicePubKey: device.publicKey,
      scopes: ["admin"],
      issuedAt: NOW - 1000,
      expiresAt: NOW + 10_000_000,
    };
    const grantSig = signDeviceCapabilityGrant(grant, irk); // membership IRK, NOT admin root
    await s.deviceCapabilityGrants.put({
      grantId: grant.grantId,
      username: USER,
      deviceLabel: grant.deviceLabel,
      devicePubHex: hex(device.publicKey),
      scopesJson: JSON.stringify(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: hex(grantSig),
      revokedAt: null,
      signerRoot: "membership",
    });

    const r = await handleSetCustomDomain(
      {
        usernames: s.usernames,
        customDomainOrders: s.customDomainOrders,
        grants: s.deviceCapabilityGrants,
        now: () => NOW,
      },
      USER,
      APP,
      customDomainBody(device, "shop.example.com", NOW),
    );
    expect(r.status).toBe(403);
  });
});

// ── release-server-name (§2 row 30) ──────────────────────────────────────
function releaseBody(signer: Keypair, issuedAt: number) {
  const claim = {
    username: USER,
    serverDomain: "home.alice.flagship.services",
    issuedAt,
  };
  return { request: claim, signature: hex(signReleaseServerName(claim, signer)) };
}

describe("Slice D gate — release-server-name (§2 row 30)", () => {
  const NOW = 2_000_000;

  function deps(s: InMemoryStorage) {
    return {
      usernames: s.usernames,
      routing: s.routing,
      authCodes: s.authCodes,
      servers: s.servers,
      grants: s.deviceCapabilityGrants,
      now: () => NOW,
    };
  }

  it("GATE CLOSED (no admin root): owner-IRK release works", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    await seedAccount(s, irk);
    const r = await handleServerReleaseName(deps(s), releaseBody(irk, NOW));
    expect(r.status).toBe(200);
  });

  it("GATE OPEN: admin-root release accepted, owner-IRK REJECTED", async () => {
    const s = new InMemoryStorage();
    const irk = makeKey();
    const adminRoot = makeKey();
    await seedAccount(s, irk, adminRoot);

    const rejected = await handleServerReleaseName(deps(s), releaseBody(irk, NOW));
    expect(rejected.status).toBe(403);

    const accepted = await handleServerReleaseName(deps(s), releaseBody(adminRoot, NOW));
    expect(accepted.status).toBe(200);
  });
});
