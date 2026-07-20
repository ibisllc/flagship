import { controlApex } from "./apex.js";
import {
  canonicalAccountProfile,
  canonicalDeviceManagedProfile,
  canonicalDeviceSelfProfile,
  canonicalDirectoryRequest,
  decryptProfile,
  deriveAccountProfileKey,
  deriveDeviceDirectoryKey,
  encryptProfile,
} from "./accountMetadata.js";
import { getActiveProfile } from "./profiles.js";
import { getSession } from "./state.js";
import {
  adminRootPubHex,
  bytesToHex,
  deriveAccountDeviceKeyFromSeed,
  signWithAdminRoot,
} from "../keystore.js";

export async function signedDirectoryFetch(path, init = {}, deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  if (!(session?.umk instanceof Uint8Array) || !profile?.accountId || !/^[0-9a-f]{32}$/.test(profile.deviceId ?? "")) {
    throw new Error("unlock this account first");
  }
  const method = (init.method ?? "GET").toUpperCase();
  const key = await (deps.deriveDeviceKey ?? deriveAccountDeviceKeyFromSeed)(
    session.umk,
    profile.accountId,
    profile.deviceId,
  );
  const request = {
    accountId: profile.accountId,
    deviceId: profile.deviceId,
    signerPubHex: bytesToHex(key.publicKey),
    method,
    path,
    requestId: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    issuedAt: Date.now(),
  };
  const signature = deps.signDevice
    ? await deps.signDevice(key, canonicalDirectoryRequest(request))
    : new Uint8Array(await crypto.subtle.sign(
        { name: "Ed25519" },
        key.privateKey,
        canonicalDirectoryRequest(request),
      ));
  const fetchImpl = deps.fetch ?? fetch;
  return fetchImpl(`${deps.baseUrl ?? controlApex()}${path}`, {
    ...init,
    method,
    cache: "no-store",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
      "x-flagship-device-id": profile.deviceId,
      "x-flagship-device-pub": request.signerPubHex,
      "x-flagship-request-id": request.requestId,
      "x-flagship-issued-at": String(request.issuedAt),
      "x-flagship-signature": bytesToHex(signature),
    },
  });
}

export async function fetchDecryptedDirectory(deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  if (!(session?.umk instanceof Uint8Array) || !profile?.accountId) throw new Error("unlock this account first");
  const path = `/api/accounts/${encodeURIComponent(profile.accountId)}/directory`;
  const response = await signedDirectoryFetch(path, { method: "GET" }, { ...deps, session, profile });
  if (!response.ok) throw new Error(`Couldn't fetch trusted devices (${response.status})`);
  const body = await response.json();
  const accountKey = await deriveAccountProfileKey(session.umk);
  const directoryKey = await deriveDeviceDirectoryKey(session.umk);
  let accountDisplayName = null;
  try {
    if (body.accountProfile) {
      accountDisplayName = await decryptProfile({ ...body.accountProfile, recordType: "account-profile" }, accountKey);
    }
  } catch {
    accountDisplayName = null;
  }
  const selfById = new Map((body.selfProfiles ?? []).map((record) => [record.deviceId, record]));
  const managedById = new Map((body.managedProfiles ?? []).map((record) => [record.deviceId, record]));
  const devices = await Promise.all((body.devices ?? []).map(async (device) => {
    let selfDisplayName = null;
    let managedDisplayName = null;
    try {
      const self = selfById.get(device.deviceId);
      if (self) selfDisplayName = await decryptProfile({ ...self, recordType: "device-self-profile" }, directoryKey);
    } catch {
      selfDisplayName = null;
    }
    try {
      const managed = managedById.get(device.deviceId);
      if (managed) managedDisplayName = await decryptProfile({ ...managed, recordType: "device-managed-profile" }, directoryKey);
    } catch {
      managedDisplayName = null;
    }
    const managed = managedById.get(device.deviceId) ?? null;
    return {
      ...device,
      selfDisplayName,
      managedDisplayName,
      displayName: managedDisplayName ?? selfDisplayName ?? null,
      managed: !!managed,
      locked: managed?.locked === true,
      isCurrent: device.deviceId === profile.deviceId,
      grant: (body.grants ?? []).find((grant) => grant.deviceId === device.deviceId) ?? null,
    };
  }));
  return {
    accountId: body.accountId,
    accountDisplayName,
    accountProfile: body.accountProfile ?? null,
    devices,
    selfProfiles: body.selfProfiles ?? [],
    managedProfiles: body.managedProfiles ?? [],
  };
}

export async function updateAccountDisplayName(displayName, current, deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  if (!(session?.adminRootSeed instanceof Uint8Array)) throw new Error("administrator authorization required");
  const issuedAt = Date.now();
  const revision = (current?.revision ?? 0) + 1;
  const encrypted = await encryptProfile(displayName, await deriveAccountProfileKey(session.umk), {
    accountId: profile.accountId, recordType: "account-profile", revision, keyVersion: 1,
  });
  const unsigned = {
    accountId: profile.accountId, revision, keyVersion: 1, ...encrypted, issuedAt,
    signerPubHex: await adminRootPubHex(session.adminRootSeed),
  };
  const envelope = {
    ...unsigned,
    signatureHex: bytesToHex(await signWithAdminRoot(session.adminRootSeed, canonicalAccountProfile(unsigned))),
  };
  return putProfile(`/api/accounts/${encodeURIComponent(profile.accountId)}/profile`, {
    profile: envelope, expectedRevision: current?.revision ?? 0,
  }, { ...deps, session, profile });
}

export async function updateSelfDisplayName(displayName, current, deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  const key = await (deps.deriveDeviceKey ?? deriveAccountDeviceKeyFromSeed)(session.umk, profile.accountId, profile.deviceId);
  const issuedAt = Date.now();
  const revision = (current?.revision ?? 0) + 1;
  const encrypted = await encryptProfile(displayName, await deriveDeviceDirectoryKey(session.umk), {
    accountId: profile.accountId, deviceId: profile.deviceId,
    recordType: "device-self-profile", revision, keyVersion: 1,
  });
  const unsigned = {
    accountId: profile.accountId, deviceId: profile.deviceId, revision, keyVersion: 1,
    ...encrypted, issuedAt, signerPubHex: bytesToHex(key.publicKey),
  };
  const signature = deps.signDevice
    ? await deps.signDevice(key, canonicalDeviceSelfProfile(unsigned))
    : new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, canonicalDeviceSelfProfile(unsigned)));
  return putProfile(`/api/accounts/${encodeURIComponent(profile.accountId)}/devices/${profile.deviceId}/profile`, {
    profile: { ...unsigned, signatureHex: bytesToHex(signature) },
    expectedRevision: current?.revision ?? 0,
  }, { ...deps, session, profile });
}

export async function setManagedDeviceDisplayName(deviceId, displayName, locked, current, deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  if (!(session?.adminRootSeed instanceof Uint8Array)) throw new Error("administrator authorization required");
  const issuedAt = Date.now();
  const revision = (current?.revision ?? 0) + 1;
  const encrypted = await encryptProfile(displayName, await deriveDeviceDirectoryKey(session.umk), {
    accountId: profile.accountId, deviceId, recordType: "device-managed-profile", revision, keyVersion: 1,
  });
  const unsigned = {
    accountId: profile.accountId, deviceId, revision, keyVersion: 1, ...encrypted,
    locked: !!locked, issuedAt, signerPubHex: await adminRootPubHex(session.adminRootSeed),
  };
  const envelope = {
    ...unsigned,
    signatureHex: bytesToHex(await signWithAdminRoot(session.adminRootSeed, canonicalDeviceManagedProfile(unsigned))),
  };
  return putProfile(`/api/accounts/${encodeURIComponent(profile.accountId)}/devices/${deviceId}/managed-profile`, {
    profile: envelope, expectedRevision: current?.revision ?? 0,
  }, { ...deps, session, profile });
}

export async function removeManagedDeviceDisplayName(deviceId, current, deps = {}) {
  const session = deps.session ?? getSession();
  const profile = deps.profile ?? getActiveProfile();
  if (!(session?.adminRootSeed instanceof Uint8Array)) throw new Error("administrator authorization required");
  const path = `/api/accounts/${encodeURIComponent(profile.accountId)}/devices/${deviceId}/managed-profile`;
  const response = await signedDirectoryFetch(path, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: current?.revision ?? 0 }),
  }, { ...deps, session, profile });
  if (!response.ok) throw new Error(`Profile update failed (${response.status})`);
  return response.json();
}

async function putProfile(path, body, deps) {
  const response = await signedDirectoryFetch(path, { method: "PUT", body: JSON.stringify(body) }, deps);
  if (!response.ok) throw new Error(`Profile update failed (${response.status})`);
  return response.json();
}
