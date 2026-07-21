import {
  verifyAccountProfile,
  verifyClaimUsername,
  verifyDeviceCapabilityGrant,
  verifyDeviceSelfProfile,
  type AccountProfileEnvelope,
  type ClaimUsername,
  type DeviceCapabilityGrant,
  type DeviceSelfProfileEnvelope,
} from "@flagship/protocol";
import type {
  AccountProvisioningStorage,
  UsernameOfferStorage,
  UsernameStorage,
} from "@flagship/storage";
import { bytesToHex, HEX128, HEX64, hexToBytes } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import { conflict, forbidden, malformed, ok, type HandlerResponseWithHeaders } from "./types.js";

const DEVICE_ID = /^[0-9a-f]{32}$/;
const PLATFORM_CLASSES = new Set(["ios", "android", "web", "macos", "windows", "linux", "other"]);

export interface AccountBootstrapBody {
  claim?: {
    request?: { username?: unknown; irkPub?: unknown; issuedAt?: unknown };
    signature?: unknown;
  };
  aidPub?: unknown;
  adminRootPub?: unknown;
  device?: {
    deviceId?: unknown;
    devicePubHex?: unknown;
    platformClass?: unknown;
  };
  grant?: unknown;
  accountProfile?: unknown;
  deviceProfile?: unknown;
}

export interface AccountBootstrapDeps {
  provisioning: AccountProvisioningStorage;
  usernames: UsernameStorage;
  offers?: UsernameOfferStorage;
  offerTtlMs?: number;
  freshnessMs?: number;
  now?: () => number;
}

export async function handleAccountBootstrap(
  deps: AccountBootstrapDeps,
  body: AccountBootstrapBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const request = body?.claim?.request;
  if (!request || typeof request.username !== "string" || typeof request.irkPub !== "string" ||
      !HEX64.test(request.irkPub) || typeof request.issuedAt !== "number" ||
      typeof body?.claim?.signature !== "string" || !HEX128.test(body.claim.signature) ||
      typeof body.aidPub !== "string" || !HEX64.test(body.aidPub) ||
      typeof body.adminRootPub !== "string" || !HEX64.test(body.adminRootPub)) {
    return malformed("malformed account bootstrap");
  }
  const validated = validateUserLabel(request.username);
  if (!validated.ok) return malformed(validated.reason);
  const username = validated.label;
  if (Math.abs(now - request.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) return forbidden("stale request");

  const irkPub = hexToBytes(request.irkPub);
  const claim: ClaimUsername = { username, irkPub, issuedAt: request.issuedAt };
  if (!verifyClaimUsername(claim, hexToBytes(body.claim.signature), irkPub)) return forbidden("invalid signature");

  const device = body.device;
  if (!device || typeof device.deviceId !== "string" || !DEVICE_ID.test(device.deviceId) ||
      typeof device.devicePubHex !== "string" || !HEX64.test(device.devicePubHex) ||
      typeof device.platformClass !== "string" || !PLATFORM_CLASSES.has(device.platformClass)) {
    return malformed("invalid device identity");
  }

  const grant = parseGrant(body.grant);
  const accountProfile = parseAccountProfile(body.accountProfile);
  const deviceProfile = parseDeviceProfile(body.deviceProfile);
  if (!grant || !accountProfile || !deviceProfile) return malformed("invalid encrypted profile bootstrap");
  if (grant.username !== username || grant.deviceId !== device.deviceId ||
      bytesToHex(grant.devicePubKey) !== device.devicePubHex ||
      !grant.scopes.includes("admin") || !grant.scopes.includes("view-directory") ||
      grant.issuedAt !== request.issuedAt || grant.expiresAt <= now) {
    return malformed("invalid primary device grant");
  }
  const adminRootPub = hexToBytes(body.adminRootPub);
  if (!verifyDeviceCapabilityGrant(grant, hexToBytes((body.grant as Record<string, unknown>).signatureHex as string), adminRootPub)) {
    return forbidden("invalid grant signature");
  }
  if (accountProfile.accountId !== username || accountProfile.revision !== 1 ||
      accountProfile.signerPubHex !== body.adminRootPub || accountProfile.issuedAt !== request.issuedAt ||
      !verifyAccountProfile(accountProfile, adminRootPub)) {
    return forbidden("invalid account profile");
  }
  if (deviceProfile.accountId !== username || deviceProfile.deviceId !== device.deviceId ||
      deviceProfile.revision !== 1 || deviceProfile.signerPubHex !== device.devicePubHex ||
      deviceProfile.issuedAt !== request.issuedAt ||
      !verifyDeviceSelfProfile(deviceProfile, hexToBytes(device.devicePubHex))) {
    return forbidden("invalid device profile");
  }

  if (deps.offers) {
    const offered = await deps.offers.isOffered(username, now - (deps.offerTtlMs ?? 60 * 60_000));
    if (!offered) {
      const existing = await deps.usernames.get(username);
      if (!existing || existing.irkPubHex.toLowerCase() !== request.irkPub.toLowerCase()) {
        return forbidden("that name isn't available — pick one of the suggested handles");
      }
    }
  }

  const initialized = await deps.provisioning.initialize({
    username: {
      username,
      irkPubHex: request.irkPub,
      aidPubHex: body.aidPub,
      adminRootPubHex: body.adminRootPub,
      claimedAt: request.issuedAt,
      lastActive: request.issuedAt,
      isDemo: false,
      accountType: "single",
      recoveryWipePolicy: "graceful",
    },
    primaryDevice: {
      accountId: username,
      deviceId: device.deviceId,
      devicePubHex: device.devicePubHex,
      platformClass: device.platformClass,
      createdAt: request.issuedAt,
      lastSeenAt: request.issuedAt,
      revokedAt: null,
    },
    primaryGrant: {
      grantId: grant.grantId,
      username,
      deviceId: device.deviceId,
      devicePubHex: device.devicePubHex,
      scopesJson: JSON.stringify(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: (body.grant as Record<string, unknown>).signatureHex as string,
      revokedAt: null,
      signerRoot: "admin-root",
    },
    accountProfile: { ...accountProfile, updatedAt: request.issuedAt },
    primaryDeviceProfile: { ...deviceProfile, updatedAt: request.issuedAt },
  });
  if (!initialized.ok) return conflict(initialized.reason.replaceAll("-", " "));
  if (initialized.created && deps.offers) await deps.offers.consume(username);
  return ok({ ok: true, username, accountId: username, deviceId: device.deviceId, created: initialized.created }, {
    "cache-control": "private, no-store",
  });
}

function parseGrant(value: unknown): DeviceCapabilityGrant | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.grantId !== "string" || typeof v.username !== "string" || typeof v.deviceId !== "string" ||
      typeof v.devicePubHex !== "string" || !HEX64.test(v.devicePubHex) || !Array.isArray(v.scopes) ||
      !v.scopes.every((scope) => typeof scope === "string") || typeof v.issuedAt !== "number" ||
      typeof v.expiresAt !== "number" || typeof v.signatureHex !== "string" || !HEX128.test(v.signatureHex)) return null;
  return {
    grantId: v.grantId,
    username: v.username,
    deviceId: v.deviceId,
    devicePubKey: hexToBytes(v.devicePubHex),
    scopes: v.scopes as DeviceCapabilityGrant["scopes"],
    issuedAt: v.issuedAt,
    expiresAt: v.expiresAt,
  };
}

function parseAccountProfile(value: unknown): AccountProfileEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return hasProfileFields(v) ? v as unknown as AccountProfileEnvelope : null;
}

function parseDeviceProfile(value: unknown): DeviceSelfProfileEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return hasProfileFields(v) && typeof v.deviceId === "string" && DEVICE_ID.test(v.deviceId)
    ? v as unknown as DeviceSelfProfileEnvelope
    : null;
}

function hasProfileFields(v: Record<string, unknown>): boolean {
  return typeof v.accountId === "string" && typeof v.revision === "number" && typeof v.keyVersion === "number" &&
    typeof v.nonceHex === "string" && /^[0-9a-f]{24}$/.test(v.nonceHex) &&
    typeof v.ciphertextHex === "string" && /^[0-9a-f]+$/.test(v.ciphertextHex) &&
    typeof v.signerPubHex === "string" && HEX64.test(v.signerPubHex) &&
    typeof v.signatureHex === "string" && HEX128.test(v.signatureHex) && typeof v.issuedAt === "number";
}
