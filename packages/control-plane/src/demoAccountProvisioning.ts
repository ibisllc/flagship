import { sha256 } from "@noble/hashes/sha256";
import {
  deriveAccountProfileKey, deriveDeviceDirectoryKey, encryptAccountProfile, encryptDeviceProfile,
  signAccountProfile, signAuthCode, signDeviceCapabilityGrant, signDeviceSelfProfile, signInstallBlob,
  validateProfileDisplayName, type AuthCode, type DeviceCapabilityGrant, type DeviceScope, type InstallBlob,
} from "@flagship/protocol";
import type { AuthCodeStorage, DemoAccountProvisioningStorage, DemoUsersStorage } from "@flagship/storage";
import { bytesToHex } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import {
  deriveDemoAdminRoot, deriveDemoDelegatedKey, deriveDemoPrimaryDeviceId, deriveDemoPrimaryDeviceKey,
  deriveDemoRckKey, deriveDemoUmk, deriveDemoUserAid, deriveDemoUserIrk,
} from "./demoIdentity.js";
import { buildCloudConfigUserData, installBlobJsonShortString } from "./demoCloudConfig.js";
import type { ProvisioningHetznerClient } from "./demoProvisioningProvider.js";
import { conflict, malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

const PRIMARY_SCOPES: readonly DeviceScope[] = [
  "admin", "view-directory", "browse", "install-service", "vibe-code", "add-device",
  "manage-services", "revoke-others", "demo-provision",
];

export interface CreateDemoAccountBody {
  username?: unknown;
  accountName?: unknown;
  idempotencyKey?: unknown;
  region?: unknown;
  size?: unknown;
}

export interface CleanupDemoAccountBody {
  username?: unknown;
  idempotencyKey?: unknown;
}

export interface CleanupDemoAccountDeps {
  provisioning: DemoAccountProvisioningStorage;
  demos: DemoUsersStorage;
  destroyServer(serverId: string): Promise<void>;
  cleanupDns?: (username: string) => Promise<void>;
}

export interface DemoAccountProvisioningDeps {
  provisioning: DemoAccountProvisioningStorage;
  demos: DemoUsersStorage;
  authCodes: AuthCodeStorage;
  hetzner: ProvisioningHetznerClient & {
    findServerByName(name: string): Promise<{ serverId: string; ipv4: string | null } | null>;
  };
  demoIrkKek: Uint8Array;
  defaultRegion: string;
  defaultSize: string;
  fallbackServerTypes?: readonly string[];
  demoSshKeyId?: number;
  hetznerImage?: string;
  installerGitRef?: string;
  apex?: string;
  controlApex?: string;
  now?: () => number;
  random?: (length: number) => Uint8Array;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function stableHex(username: string, idempotencyKey: string, purpose: string, bytes: number): string {
  return bytesToHex(sha256(new TextEncoder().encode(
    `flagship/demo-provisioning-id/v1|${purpose}|${username}|${idempotencyKey}`,
  )).slice(0, bytes));
}

export async function handleCreateDemoAccount(
  deps: DemoAccountProvisioningDeps,
  body: CreateDemoAccountBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body || typeof body.username !== "string" || typeof body.accountName !== "string") {
    return malformed("username and accountName are required");
  }
  const usernameResult = validateUserLabel(body.username);
  if (!usernameResult.ok) return malformed(usernameResult.reason);
  const username = usernameResult.label;
  let accountName: string;
  try {
    accountName = validateProfileDisplayName(body.accountName);
  } catch {
    return malformed("accountName must be a valid 1-64 grapheme display name");
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 16 ||
      body.idempotencyKey.length > 128 || /[\u0000-\u001f\u007f]/u.test(body.idempotencyKey)) {
    return malformed("idempotencyKey must be a 16-128 character value");
  }
  const idempotencyKey = body.idempotencyKey;
  const now = (deps.now ?? (() => Date.now()))();
  const rand = deps.random ?? randomBytes;
  const umk = deriveDemoUmk(deps.demoIrkKek, username);
  const irk = deriveDemoUserIrk(deps.demoIrkKek, username);
  const aid = deriveDemoUserAid(deps.demoIrkKek, username);
  const admin = deriveDemoAdminRoot(deps.demoIrkKek, username);
  const primaryDevice = deriveDemoPrimaryDeviceKey(deps.demoIrkKek, username);
  const deviceId = deriveDemoPrimaryDeviceId(deps.demoIrkKek, username);
  const delegated = deriveDemoDelegatedKey(deps.demoIrkKek, username);
  const rck = deriveDemoRckKey(deps.demoIrkKek, username);
  const serverName = "home";
  const serverDomain = `${serverName}.${username}.${deps.apex ?? "flagship.services"}`;
  const serial = stableHex(username, idempotencyKey, "auth-code", 16);
  const grantId = stableHex(username, idempotencyKey, "primary-grant", 16);
  const issuedAt = now;
  const expiresAt = issuedAt + 24 * 3_600_000;
  const authCode: AuthCode = {
    version: 1, serial, username, serverName, serverDomain, delegatedPubKey: delegated.publicKey,
    userPubKey: irk.publicKey, issuedAt, expiresAt, adminRootPubKey: admin.publicKey,
  };
  const authCodeSignature = signAuthCode(authCode, irk);
  const grant: DeviceCapabilityGrant = {
    grantId, username, deviceId, devicePubKey: primaryDevice.publicKey, scopes: [...PRIMARY_SCOPES],
    issuedAt, expiresAt: issuedAt + 90 * 24 * 3_600_000,
  };
  const grantSignature = signDeviceCapabilityGrant(grant, admin);
  const accountEncrypted = encryptAccountProfile(accountName, deriveAccountProfileKey(umk), {
    accountId: username, revision: 1, keyVersion: 1, nonce: rand(12),
  });
  const accountUnsigned = { ...accountEncrypted, issuedAt, signerPubHex: bytesToHex(admin.publicKey) };
  const deviceEncrypted = encryptDeviceProfile("Demo provisioner", deriveDeviceDirectoryKey(umk), {
    accountId: username, deviceId, revision: 1, keyVersion: 1, nonce: rand(12),
  });
  const deviceUnsigned = {
    ...deviceEncrypted, deviceId, issuedAt, signerPubHex: bytesToHex(primaryDevice.publicKey),
  };
  const initialized = await deps.provisioning.initialize({
    username: {
      username, irkPubHex: bytesToHex(irk.publicKey), aidPubHex: bytesToHex(aid.publicKey),
      adminRootPubHex: bytesToHex(admin.publicKey), claimedAt: issuedAt, lastActive: issuedAt,
      isDemo: true, accountType: "demo", recoveryWipePolicy: "graceful",
    },
    primaryDevice: {
      accountId: username, deviceId, devicePubHex: bytesToHex(primaryDevice.publicKey),
      platformClass: "demo-provisioner", createdAt: issuedAt, lastSeenAt: issuedAt, revokedAt: null,
    },
    primaryGrant: {
      grantId, username, deviceId, devicePubHex: bytesToHex(primaryDevice.publicKey),
      scopesJson: JSON.stringify(grant.scopes), issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
      signatureHex: bytesToHex(grantSignature), revokedAt: null, signerRoot: "admin-root",
    },
    accountProfile: {
      ...accountUnsigned, signatureHex: signAccountProfile(accountUnsigned, admin), updatedAt: issuedAt,
    },
    primaryDeviceProfile: {
      ...deviceUnsigned, signatureHex: signDeviceSelfProfile(deviceUnsigned, primaryDevice), updatedAt: issuedAt,
    },
    authCode: {
      serial, username, serverName, serverDomain, delegatedPubKeyHex: bytesToHex(delegated.publicKey),
      userPubKeyHex: bytesToHex(irk.publicKey), userSignatureHex: bytesToHex(authCodeSignature),
      issuedAt, expiresAt, status: "active", recordedAt: issuedAt,
      adminRootPubKeyHex: bytesToHex(admin.publicKey),
    },
    demo: {
      username, idempotencyKey, snapshotId: null, isoR2Key: null, ttlIdleMinutes: 30,
      region: typeof body.region === "string" ? body.region : deps.defaultRegion,
      size: typeof body.size === "string" ? body.size : deps.defaultSize,
      activeServerId: null, activeServerIp: null, image: deps.hetznerImage ?? "debian-12",
      activeServerFqdn: serverDomain, lastActivityAt: issuedAt, state: "initializing",
      createdAt: issuedAt, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
    },
  });
  if (!initialized.ok) {
    return conflict(initialized.reason === "username-unavailable" ? "username unavailable" : "idempotency conflict");
  }
  let row = initialized.record;
  if (row.state === "ready") {
    return ok({ username, state: "ready", activeServerId: row.activeServerId, reused: true });
  }
  if (row.state === "cleanup-only") return conflict("demo account requires cleanup");
  if (row.state === "provisioning" && row.activeServerId) {
    return { status: 202, body: { username, state: "provisioning", activeServerId: row.activeServerId, reused: true } };
  }
  if (row.state === "initializing" || row.state === "failed") {
    const transitioned = await deps.demos.transition(username, row.state, "provisioning", {
      provisionLastError: null, lastActivityAt: now,
    });
    row = transitioned ?? (await deps.demos.get(username)) ?? row;
  }
  if (row.state !== "provisioning") return conflict("demo account cannot be provisioned from its current state");

  const persistedAuthCode = await deps.authCodes.get(serial);
  if (!persistedAuthCode) return conflict("demo bootstrap state is incomplete");
  const persistedAuth: AuthCode = {
    version: 1, serial, username, serverName, serverDomain, delegatedPubKey: delegated.publicKey,
    userPubKey: irk.publicKey, issuedAt: persistedAuthCode.issuedAt,
    expiresAt: persistedAuthCode.expiresAt, adminRootPubKey: admin.publicKey,
  };
  const persistedSignature = signAuthCode(persistedAuth, irk);
  const blob: InstallBlob = {
    version: 2, serverDomain, username, serverName, phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: `https://${deps.controlApex ?? "flagshipserver.com"}/api/server/register`,
    authCode: persistedAuth, authCodeUserSignature: persistedSignature,
    installerGitRef: deps.installerGitRef ?? "main", rckPubKey: rck.publicKey,
  };
  const blobSignature = signInstallBlob(blob, irk);
  const userData = buildCloudConfigUserData({
    installBlobJson: installBlobJsonShortString(blob, blobSignature),
    installerGitRef: blob.installerGitRef,
    demoUserIrkPrivHex: bytesToHex(irk.privateKey),
    ownerAidPubHex: bytesToHex(aid.publicKey),
  });
  const providerName = `flagship-demo-${username}-${stableHex(username, idempotencyKey, "provider", 4)}`;
  try {
    const existingProvider = await deps.hetzner.findServerByName(providerName);
    const provider = existingProvider ?? await deps.hetzner.createServerWithUserData({
      name: providerName, location: row.region, serverType: row.size,
      image: deps.hetznerImage ?? "debian-12", userData, username,
      ...(deps.demoSshKeyId !== undefined ? { sshKeyId: deps.demoSshKeyId } : {}),
      ...(deps.fallbackServerTypes ? { fallbackServerTypes: deps.fallbackServerTypes } : {}),
    });
    await deps.demos.update(username, {
      activeServerId: provider.serverId, activeServerIp: provider.ipv4,
      activeServerFqdn: serverDomain, state: "provisioning", lastActivityAt: now,
    });
    return {
      status: 202,
      body: { username, state: "provisioning", activeServerId: provider.serverId, reused: !!existingProvider },
      headers: { "cache-control": "private, no-store" },
    };
  } catch {
    await deps.demos.update(username, {
      state: "failed", provisionLastError: "provider provisioning failed", provisionPhaseAt: now,
    });
    return { status: 502, body: { error: "demo provisioning failed; retry with the same idempotency key" } };
  }
}

export const _demoProvisioningInternals = { stableHex, PRIMARY_SCOPES };

export async function handleCleanupDemoAccount(
  deps: CleanupDemoAccountDeps,
  body: CleanupDemoAccountBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body || typeof body.username !== "string" || typeof body.idempotencyKey !== "string") {
    return malformed("username and idempotencyKey are required");
  }
  const usernameResult = validateUserLabel(body.username);
  if (!usernameResult.ok) return malformed(usernameResult.reason);
  const username = usernameResult.label;
  const row = await deps.demos.get(username);
  if (!row || row.idempotencyKey !== body.idempotencyKey) return conflict("demo cleanup target does not match");
  await deps.demos.update(username, { state: "cleanup-only" });
  if (row.activeServerId) {
    try {
      await deps.destroyServer(row.activeServerId);
    } catch {
      return { status: 502, body: { error: "provider cleanup failed; retry with the same identifiers" } };
    }
  }
  try {
    await deps.cleanupDns?.(username);
  } catch {
    return { status: 502, body: { error: "DNS cleanup failed; retry with the same identifiers" } };
  }
  if (!(await deps.provisioning.cleanup(username, body.idempotencyKey))) {
    return conflict("demo cleanup target changed");
  }
  return ok({ username, deleted: true });
}
