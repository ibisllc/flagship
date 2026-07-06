/**
 * Tests for the v2 demo-user admin handlers (S3.3):
 *   - handleAdminClaimAndIssue
 *   - handleAdminMintDeviceGrant
 *
 * Coverage matrix:
 *   - happy path round-trip: claim-and-issue returns code + blob +
 *     primaryGrant; blob signature verifies under derived User IRK;
 *     grant signature verifies; the auth-code + build-ticket + grant
 *     rows all land in storage.
 *   - determinism: calling twice (with the same fixed KEK) produces
 *     identical derived pub keys for the blob's phoneDelegatedPubKey /
 *     rckPubKey / userPubKey / serverDomain.
 *   - mint-device-grant: happy path; grant verifies; devicePub matches
 *     the HKDF derivation.
 *   - mint-device-grant: re-issuance revokes the old row.
 *   - both reject 404 when the demo_users row doesn't exist.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  ed,
  verifyDeviceCapabilityGrant,
  verifyInstallBlob,
  type DeviceCapabilityGrant,
  type InstallBlob,
} from "@flagship/protocol";
import {
  InMemoryAuditEventStorage,
  InMemoryAuthCodeStorage,
  InMemoryDemoUsersStorage,
  InMemoryDeviceCapabilityGrantStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleAdminClaimAndIssue,
  handleAdminMintDeviceGrant,
  deriveDemoUserIrk,
  deriveDemoUserAid,
  deriveDemoDeviceIrk,
  _internalDefaultDemoPrimaryScopes,
  type DemoAdminDeps,
} from "../src/demoUsersAdmin.js";
import type { HetznerProvisioner } from "../src/demoUsers.js";

const KEK_BYTES = new Uint8Array(32).fill(0x42);

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeStubHetzner(): HetznerProvisioner {
  return {
    async createServerFromSnapshot() {
      throw new Error("not used in admin tests");
    },
    async getServerStatus() {
      throw new Error("not used in admin tests");
    },
    async destroyServer() {
      // no-op
    },
  };
}

interface Harness {
  deps: DemoAdminDeps;
  clock: { now: number };
  serial: number;
}

async function mkHarness(opts: { seed?: boolean } = {}): Promise<Harness> {
  const clock = { now: 1_000_000 };
  let counter = 0;
  const random = (n: number): Uint8Array => {
    // Deterministic but distinct counter-based bytes, useful for
    // making the auth-code serial + UUID + build-code reproducible.
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (counter + i) & 0xff;
    counter += n;
    return out;
  };
  const deps: DemoAdminDeps = {
    storage: new InMemoryDemoUsersStorage(),
    usernames: new InMemoryUsernameStorage(),
    hetzner: makeStubHetzner(),
    sshKeyId: 42,
    audit: new InMemoryAuditEventStorage(),
    authCodes: new InMemoryAuthCodeStorage(),
    deviceCapabilityGrants: new InMemoryDeviceCapabilityGrantStorage(),
    demoIrkKek: KEK_BYTES,
    random,
    now: () => clock.now,
  };
  if (opts.seed) {
    await deps.storage.insert({
      username: "demoalice",
      display: "Demo Alice",
      snapshotId: null,
      isoR2Key: null,
      ttlIdleMinutes: 30,
      region: "fsn1",
      size: "cx22",
      activeServerId: null,
      activeServerFqdn: null,
      lastActivityAt: 0,
      state: "none",
      createdAt: 1,
    });
  }
  return { deps, clock, serial: 0 };
}

// ──────────────────────────────────────────────────────────────────────
// handleAdminClaimAndIssue
// ──────────────────────────────────────────────────────────────────────

describe("handleAdminClaimAndIssue", () => {
  it("rejects when demo_users row doesn't exist", async () => {
    const h = await mkHarness();
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "ghost-user",
      serverName: "home",
    });
    expect(r.status).toBe(404);
  });

  it("rejects malformed username", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "UPPER",
      serverName: "home",
    });
    expect(r.status).toBe(400);
  });

  it("rejects malformed serverName", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "h",
    });
    expect(r.status).toBe(400);
  });

  it("happy path: claims username, mints auth-code + blob + primary grant, all signatures verify", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
    });
    expect(r.status).toBe(200);

    const body = r.body as {
      code: string;
      // The blob MUST be a structured object (NOT a JSON-encoded
      // string). personalize-iso --blob-json reads it back via
      // JSON.parse(file) and feeds it to installBlobFromJson, which
      // rejects strings as "unsupported InstallBlob version". The
      // S3.3 implementation initially stringified this field and
      // shipped to prod; the regression assertion below would have
      // caught it.
      blob: {
        version: 1;
        serverDomain: string;
        username: string;
        serverName: string;
        phoneDelegatedPubKey: string;
        registrationUrl: string;
        authCode: {
          version: 1;
          serial: string;
          username: string;
          serverName: string;
          serverDomain: string;
          delegatedPubKey: string;
          userPubKey: string;
          issuedAt: number;
          expiresAt: number;
        };
        authCodeUserSignature: string;
        issuedAt: number;
        expiresAt: number;
        installerGitRef: string;
        rckPubKey: string;
      };
      blobSignature: string;
      primaryGrant: {
        grantId: string;
        username: string;
        deviceLabel: string;
        devicePubKey: string;
        scopes: string[];
        issuedAt: number;
        expiresAt: number;
        signature: string;
      };
    };

    // 0. Regression: `blob` is a structured object with `version: 2`
    //    at the top level — NOT a JSON-encoded string. The
    //    personalize-iso CLI requires this shape.
    expect(typeof body.blob).toBe("object");
    expect(body.blob.version).toBe(2);
    expect(body.blob.authCode.version).toBe(1);

    const userIrk = deriveDemoUserIrk(KEK_BYTES, "demoalice");
    const userPubHex = hex(userIrk.publicKey);

    // 1. The usernames row is now stamped.
    const userRec = await h.deps.usernames.get("demoalice");
    expect(userRec).toBeDefined();
    expect(userRec!.irkPubHex).toBe(userPubHex);
    expect(userRec!.isDemo).toBe(true);
    // gating v2 — the stable AID is registered too (deterministic-from-KEK).
    expect(userRec!.aidPubHex).toBe(hex(deriveDemoUserAid(KEK_BYTES, "demoalice").publicKey));

    // 2. Blob signature verifies under the derived User IRK pub.
    const blobJson = body.blob;
    const blob: InstallBlob = {
      version: 2,
      serverDomain: blobJson.serverDomain,
      username: blobJson.username,
      serverName: blobJson.serverName,
      phoneDelegatedPubKey: hexToBytes(blobJson.phoneDelegatedPubKey),
      registrationUrl: blobJson.registrationUrl,
      authCode: {
        version: 1,
        serial: blobJson.authCode.serial,
        username: blobJson.authCode.username,
        serverName: blobJson.authCode.serverName,
        serverDomain: blobJson.authCode.serverDomain,
        delegatedPubKey: hexToBytes(blobJson.authCode.delegatedPubKey),
        userPubKey: hexToBytes(blobJson.authCode.userPubKey),
        issuedAt: blobJson.authCode.issuedAt,
        expiresAt: blobJson.authCode.expiresAt,
      },
      authCodeUserSignature: hexToBytes(blobJson.authCodeUserSignature),
      installerGitRef: blobJson.installerGitRef,
      rckPubKey: hexToBytes(blobJson.rckPubKey),
    };
    expect(verifyInstallBlob(blob, hexToBytes(body.blobSignature), userIrk.publicKey)).toBe(true);
    expect(blob.serverDomain).toBe("home.demoalice.flagship.services");
    expect(blob.installerGitRef).toBe("main");

    // 3. AuthCode row stamped.
    const ac = await h.deps.authCodes.get(blob.authCode.serial);
    expect(ac).toBeDefined();
    expect(ac!.username).toBe("demoalice");
    expect(ac!.status).toBe("active");

    // BuildTicket flow removed — QR-pipe is the only path; the
    // signed blob is returned inline and never stored at rest on .com.

    // 4. Primary grant verifies AND is persisted.
    expect(body.primaryGrant.deviceLabel).toBe("primary");
    expect(body.primaryGrant.devicePubKey).toBe(userPubHex);
    expect(body.primaryGrant.scopes).toEqual([..._internalDefaultDemoPrimaryScopes]);
    const grant: DeviceCapabilityGrant = {
      grantId: body.primaryGrant.grantId,
      username: body.primaryGrant.username,
      deviceLabel: body.primaryGrant.deviceLabel,
      devicePubKey: hexToBytes(body.primaryGrant.devicePubKey),
      scopes: body.primaryGrant.scopes as DeviceCapabilityGrant["scopes"],
      issuedAt: body.primaryGrant.issuedAt,
      expiresAt: body.primaryGrant.expiresAt,
    };
    expect(
      verifyDeviceCapabilityGrant(grant, hexToBytes(body.primaryGrant.signature), userIrk.publicKey),
    ).toBe(true);
    const persisted = await h.deps.deviceCapabilityGrants.get(body.primaryGrant.grantId);
    expect(persisted).toBeDefined();
    expect(persisted!.revokedAt).toBeNull();
  });

  it("deterministic: same KEK + username produces identical derived pubkeys + serverDomain", async () => {
    const h1 = await mkHarness({ seed: true });
    const h2 = await mkHarness({ seed: true });
    const r1 = await handleAdminClaimAndIssue(h1.deps, {
      username: "demoalice",
      serverName: "home",
    });
    const r2 = await handleAdminClaimAndIssue(h2.deps, {
      username: "demoalice",
      serverName: "home",
    });
    const b1 = (r1.body as { blob: { version: 2; serverDomain: string; serverName: string; username: string; phoneDelegatedPubKey: string; rckPubKey: string; authCode: { userPubKey: string; delegatedPubKey: string } }}).blob;
    const b2 = (r2.body as { blob: { version: 2; serverDomain: string; serverName: string; username: string; phoneDelegatedPubKey: string; rckPubKey: string; authCode: { userPubKey: string; delegatedPubKey: string } }}).blob;
    expect(b1.username).toBe(b2.username);
    expect(b1.serverName).toBe(b2.serverName);
    expect(b1.serverDomain).toBe(b2.serverDomain);
    expect(b1.phoneDelegatedPubKey).toBe(b2.phoneDelegatedPubKey);
    expect(b1.rckPubKey).toBe(b2.rckPubKey);
    expect(b1.authCode.userPubKey).toBe(b2.authCode.userPubKey);
    expect(b1.authCode.delegatedPubKey).toBe(b2.authCode.delegatedPubKey);
  });

  it("rejects re-issue when the row exists under a DIFFERENT IRK (409)", async () => {
    const h = await mkHarness({ seed: true });
    // Pre-claim the username under a different IRK.
    const stranger = new Uint8Array(32);
    crypto.getRandomValues(stranger);
    const strangerPub = ed.getPublicKey(stranger);
    await h.deps.usernames.put({
      username: "demoalice",
      irkPubHex: hex(strangerPub),
      claimedAt: 1,
    });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
    });
    expect(r.status).toBe(409);
  });

  it("honors a caller-supplied scopes override", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
      scopes: ["browse"],
    });
    expect(r.status).toBe(200);
    const grantId = (r.body as { primaryGrant: { grantId: string } }).primaryGrant.grantId;
    const stored = await h.deps.deviceCapabilityGrants.get(grantId);
    expect(JSON.parse(stored!.scopesJson)).toEqual(["browse"]);
  });

  it("rejects empty / unknown scopes array", async () => {
    const h = await mkHarness({ seed: true });
    const r1 = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
      scopes: [],
    });
    expect(r1.status).toBe(400);
    const r2 = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
      scopes: ["not-a-scope"],
    });
    expect(r2.status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────
// handleAdminMintDeviceGrant
// ──────────────────────────────────────────────────────────────────────

describe("handleAdminMintDeviceGrant", () => {
  it("rejects when demo_users row doesn't exist", async () => {
    const h = await mkHarness();
    const r = await handleAdminMintDeviceGrant(h.deps, "ghost-user", {
      deviceLabel: "reviewer",
      scopes: ["browse"],
    });
    expect(r.status).toBe(404);
  });

  it("rejects malformed deviceLabel", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminMintDeviceGrant(h.deps, "demoalice", {
      deviceLabel: "INVALID",
      scopes: ["browse"],
    });
    expect(r.status).toBe(400);
  });

  it("rejects reserved deviceLabel", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminMintDeviceGrant(h.deps, "demoalice", {
      deviceLabel: "admin",
      scopes: ["browse"],
    });
    expect(r.status).toBe(400);
  });

  it("rejects empty / non-array scopes", async () => {
    const h = await mkHarness({ seed: true });
    const r1 = await handleAdminMintDeviceGrant(h.deps, "demoalice", {
      deviceLabel: "reviewer",
      scopes: [],
    });
    expect(r1.status).toBe(400);
    const r2 = await handleAdminMintDeviceGrant(h.deps, "demoalice", {
      deviceLabel: "reviewer",
      scopes: "browse",
    });
    expect(r2.status).toBe(400);
  });

  it("happy path: signature verifies, devicePub matches HKDF derivation", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminMintDeviceGrant(h.deps, "demoalice", {
      deviceLabel: "reviewer",
      scopes: ["browse"],
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      grant: {
        grantId: string;
        username: string;
        deviceLabel: string;
        devicePubKey: string;
        scopes: string[];
        issuedAt: number;
        expiresAt: number;
      };
      signature: string;
      devicePubHex: string;
    };
    const userIrk = deriveDemoUserIrk(KEK_BYTES, "demoalice");
    const deviceIrk = deriveDemoDeviceIrk(KEK_BYTES, "demoalice", "reviewer");
    expect(body.devicePubHex).toBe(hex(deviceIrk.publicKey));

    const grant: DeviceCapabilityGrant = {
      grantId: body.grant.grantId,
      username: body.grant.username,
      deviceLabel: body.grant.deviceLabel,
      devicePubKey: hexToBytes(body.grant.devicePubKey),
      scopes: body.grant.scopes as DeviceCapabilityGrant["scopes"],
      issuedAt: body.grant.issuedAt,
      expiresAt: body.grant.expiresAt,
    };
    expect(
      verifyDeviceCapabilityGrant(grant, hexToBytes(body.signature), userIrk.publicKey),
    ).toBe(true);
  });

  it("re-issuance: second call for same (user, label) revokes prior + mints new", async () => {
    const h = await mkHarness({ seed: true });
    const a = await handleAdminMintDeviceGrant(h.deps, "demoalice", {
      deviceLabel: "reviewer",
      scopes: ["browse"],
    });
    const aId = (a.body as { grant: { grantId: string } }).grant.grantId;

    h.clock.now += 1_000;
    const b = await handleAdminMintDeviceGrant(h.deps, "demoalice", {
      deviceLabel: "reviewer",
      scopes: ["browse", "install-service"],
    });
    expect(b.status).toBe(200);
    const bId = (b.body as { grant: { grantId: string } }).grant.grantId;
    expect(bId).not.toBe(aId);

    const oldRow = await h.deps.deviceCapabilityGrants.get(aId);
    expect(oldRow!.revokedAt).not.toBeNull();
    const newRow = await h.deps.deviceCapabilityGrants.get(bId);
    expect(newRow!.revokedAt).toBeNull();

    const active = await h.deps.deviceCapabilityGrants.getActiveForUserLabel(
      "demoalice",
      "reviewer",
    );
    expect(active!.grantId).toBe(bId);
  });
});

// ──────────────────────────────────────────────────────────────────────
// FEATURE B — diskEncryption ("don't encrypt my disk") threads through the
// demo/dev mint path into the SIGNED recipe.
// ──────────────────────────────────────────────────────────────────────

/** Reconstruct a verifiable InstallBlob from the returned JSON, carrying
 *  diskEncryption iff the JSON did (so the `de=` token is part of the
 *  canonical bytes when present). */
function blobFromJson(blobJson: {
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: string;
  registrationUrl: string;
  authCode: {
    serial: string;
    username: string;
    serverName: string;
    serverDomain: string;
    delegatedPubKey: string;
    userPubKey: string;
    issuedAt: number;
    expiresAt: number;
  };
  authCodeUserSignature: string;
  installerGitRef: string;
  rckPubKey: string;
  diskEncryption?: "luks" | "none";
}): InstallBlob {
  const blob: InstallBlob = {
    version: 2,
    serverDomain: blobJson.serverDomain,
    username: blobJson.username,
    serverName: blobJson.serverName,
    phoneDelegatedPubKey: hexToBytes(blobJson.phoneDelegatedPubKey),
    registrationUrl: blobJson.registrationUrl,
    authCode: {
      version: 1,
      serial: blobJson.authCode.serial,
      username: blobJson.authCode.username,
      serverName: blobJson.authCode.serverName,
      serverDomain: blobJson.authCode.serverDomain,
      delegatedPubKey: hexToBytes(blobJson.authCode.delegatedPubKey),
      userPubKey: hexToBytes(blobJson.authCode.userPubKey),
      issuedAt: blobJson.authCode.issuedAt,
      expiresAt: blobJson.authCode.expiresAt,
    },
    authCodeUserSignature: hexToBytes(blobJson.authCodeUserSignature),
    installerGitRef: blobJson.installerGitRef,
    rckPubKey: hexToBytes(blobJson.rckPubKey),
  };
  if (blobJson.diskEncryption !== undefined) blob.diskEncryption = blobJson.diskEncryption;
  return blob;
}

type ClaimBody = {
  blob: Parameters<typeof blobFromJson>[0];
  blobSignature: string;
};

describe("handleAdminClaimAndIssue — diskEncryption (FEATURE B)", () => {
  it("diskEncryption:'none' carries the field into the signed recipe + verifies", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
      diskEncryption: "none",
    });
    expect(r.status).toBe(200);
    const body = r.body as ClaimBody;
    // The recipe JSON echoes the field.
    expect(body.blob.diskEncryption).toBe("none");
    // And the returned signature verifies over a blob that carries de=none
    // (i.e. the field is part of the SIGNED canonical bytes).
    const userIrk = deriveDemoUserIrk(KEK_BYTES, "demoalice");
    const blob = blobFromJson(body.blob);
    expect(blob.diskEncryption).toBe("none");
    expect(verifyInstallBlob(blob, hexToBytes(body.blobSignature), userIrk.publicKey)).toBe(true);
    // Stripping the field would change the canonical bytes ⇒ verify fails.
    const stripped = { ...blob };
    delete stripped.diskEncryption;
    expect(verifyInstallBlob(stripped, hexToBytes(body.blobSignature), userIrk.publicKey)).toBe(false);
  });

  it("absent diskEncryption ⇒ no field in the recipe; legacy bytes still verify", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
    });
    expect(r.status).toBe(200);
    const body = r.body as ClaimBody;
    expect(body.blob.diskEncryption).toBeUndefined();
    const userIrk = deriveDemoUserIrk(KEK_BYTES, "demoalice");
    const blob = blobFromJson(body.blob);
    expect(blob.diskEncryption).toBeUndefined();
    expect(verifyInstallBlob(blob, hexToBytes(body.blobSignature), userIrk.publicKey)).toBe(true);
  });

  it("explicit diskEncryption:'luks' is treated as the default (omitted ⇒ legacy bytes)", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
      diskEncryption: "luks",
    });
    expect(r.status).toBe(200);
    const body = r.body as ClaimBody;
    // "luks" is the absent-field default — it MUST NOT appear (keeps the
    // signed bytes byte-identical to a legacy recipe).
    expect(body.blob.diskEncryption).toBeUndefined();
    const userIrk = deriveDemoUserIrk(KEK_BYTES, "demoalice");
    expect(
      verifyInstallBlob(blobFromJson(body.blob), hexToBytes(body.blobSignature), userIrk.publicKey),
    ).toBe(true);
  });

  it("rejects an unknown diskEncryption value (400)", async () => {
    const h = await mkHarness({ seed: true });
    const r = await handleAdminClaimAndIssue(h.deps, {
      username: "demoalice",
      serverName: "home",
      diskEncryption: "aes",
    });
    expect(r.status).toBe(400);
  });
});

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
