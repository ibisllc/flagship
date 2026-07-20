import {
  accountDirectoryKeyGrantId,
  deviceSupportCode,
  verifyAccountDirectoryRequest,
  verifyAccountProfile,
  verifyAccountDirectoryKeyGrant,
  verifyDeviceManagedProfile,
  verifyDeviceSelfProfile,
  type AccountDirectoryRequest,
  type AccountDirectoryKeyGrant,
  type AccountProfileEnvelope,
  type DeviceManagedProfileEnvelope,
  type DeviceSelfProfileEnvelope,
} from "@flagship/protocol";
import type {
  AccountProfileStorage,
  AccountDirectoryKeyGrantStorage,
  DeviceCapabilityGrantStorage,
  DeviceIdentityStorage,
  DeviceManagedProfileStorage,
  DeviceSelfProfileStorage,
  UsernameStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { requireDeviceScope } from "./deviceCapabilityGrants.js";
import { hexToBytes } from "./hex.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

export interface DirectoryNonceStore {
  claim(key: string, expiresAt: number, now: number): Promise<boolean>;
}

export interface AccountDirectoryDeps {
  usernames: UsernameStorage;
  identities: DeviceIdentityStorage;
  grants: DeviceCapabilityGrantStorage;
  accountProfiles: AccountProfileStorage;
  selfProfiles: DeviceSelfProfileStorage;
  managedProfiles: DeviceManagedProfileStorage;
  keyGrants: AccountDirectoryKeyGrantStorage;
  nonces: DirectoryNonceStore;
  now?: () => number;
  freshnessMs?: number;
}

export interface DirectoryAuthorization {
  request?: Partial<AccountDirectoryRequest>;
  signature?: string;
}

type AuthorizedDevice = {
  accountId: string;
  deviceId: string;
  signerPubHex: string;
};

async function authorizeActiveDevice(
  deps: AccountDirectoryDeps,
  auth: DirectoryAuthorization | undefined,
  expected: { accountId: string; method: string; path: string },
): Promise<AuthorizedDevice | null> {
  const request = auth?.request;
  const signature = auth?.signature;
  if (
    !request || typeof signature !== "string" ||
    typeof request.accountId !== "string" || typeof request.deviceId !== "string" ||
    typeof request.signerPubHex !== "string" || typeof request.method !== "string" ||
    typeof request.path !== "string" || typeof request.requestId !== "string" ||
    typeof request.issuedAt !== "number"
  ) return null;
  const accountId = expected.accountId.toLowerCase();
  if (request.accountId.toLowerCase() !== accountId || request.method !== expected.method || request.path !== expected.path) {
    return null;
  }
  const now = (deps.now ?? (() => Date.now()))();
  const freshness = deps.freshnessMs ?? 5 * 60_000;
  if (Math.abs(now - request.issuedAt) > freshness) return null;
  const identity = await deps.identities.get(accountId, request.deviceId);
  if (!identity || identity.revokedAt !== null || identity.devicePubHex !== request.signerPubHex.toLowerCase()) return null;
  const fullRequest = request as AccountDirectoryRequest;
  if (!verifyAccountDirectoryRequest(fullRequest, signature, hexToBytes(identity.devicePubHex))) return null;
  const claimed = await deps.nonces.claim(
    `directory|${accountId}|${identity.deviceId}|${request.requestId}`,
    now + freshness,
    now,
  );
  if (!claimed) return null;
  return { accountId, deviceId: identity.deviceId, signerPubHex: identity.devicePubHex };
}

async function isAdministrator(
  deps: AccountDirectoryDeps,
  device: AuthorizedDevice,
): Promise<boolean> {
  const user = await deps.usernames.get(device.accountId);
  if (!user?.adminRootPubHex) return false;
  const decision = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: device.accountId,
      userRec: user,
      verifyWith: (candidate) => candidate.toLowerCase() === device.signerPubHex,
    },
  );
  return decision.ok;
}

export async function handleGetAccountProfile(
  deps: AccountDirectoryDeps,
  accountId: string,
  auth: DirectoryAuthorization | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const path = `/api/accounts/${account}/profile`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "GET", path });
  if (!caller) return forbidden("not authorized");
  const profile = await deps.accountProfiles.get(account);
  const keyGrants = await deps.keyGrants.listActiveForDevice(account, caller.deviceId, (deps.now ?? (() => Date.now()))());
  return ok({ accountId: account, profile: profile ?? null, keyGrants }, { "cache-control": "private, no-store" });
}

export async function handlePutAccountDirectoryKeyGrant(
  deps: AccountDirectoryDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
  body: { grant?: AccountDirectoryKeyGrant; signature?: string } | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${account}/devices/${id}/directory-key-grant`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "PUT", path });
  if (!caller || !(await isAdministrator(deps, caller))) return forbidden("not authorized");
  const [user, target] = await Promise.all([deps.usernames.get(account), deps.identities.get(account, id)]);
  const grant = body?.grant;
  const signature = body?.signature;
  if (!user?.adminRootPubHex || !target || target.revokedAt !== null || !grant || typeof signature !== "string") {
    return malformed("malformed body");
  }
  if (
    grant.accountId.toLowerCase() !== account || grant.recipientDeviceId !== id ||
    grant.signerPubHex !== user.adminRootPubHex.toLowerCase() ||
    !verifyAccountDirectoryKeyGrant(grant, signature, hexToBytes(user.adminRootPubHex))
  ) return forbidden("not authorized");
  const grantId = accountDirectoryKeyGrantId(signature);
  const stored = await deps.keyGrants.put({
    grantId,
    ...grant,
    accountId: account,
    recipientDeviceId: id,
    signatureHex: signature,
    revokedAt: null,
  });
  if (!stored.ok) {
    const existing = await deps.keyGrants.get(grantId);
    if (!existing || existing.signatureHex !== signature) return conflict("grant conflict");
  }
  return ok({ grantId }, { "cache-control": "private, no-store" });
}

export async function handleGetAccountDirectory(
  deps: AccountDirectoryDeps,
  accountId: string,
  auth: DirectoryAuthorization | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const path = `/api/accounts/${account}/directory`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "GET", path });
  if (!caller) return forbidden("not authorized");
  const scoped = await requireDeviceScope(
    { storage: deps.grants, identities: deps.identities, usernames: deps.usernames, now: deps.now },
    caller.signerPubHex,
    account,
    "view-directory",
  );
  if (!scoped.ok && !(await isAdministrator(deps, caller))) return forbidden("not authorized");
  const [accountProfile, devices, grants, selfProfiles, managedProfiles] = await Promise.all([
    deps.accountProfiles.get(account),
    deps.identities.listForAccount(account),
    deps.grants.listForUser(account),
    deps.selfProfiles.listForAccount(account),
    deps.managedProfiles.listForAccount(account),
  ]);
  return ok(
    {
      accountId: account,
      accountProfile: accountProfile ?? null,
      devices: devices.map((device) => ({
        ...device,
        supportCode: deviceSupportCode(account, device.deviceId, device.devicePubHex),
      })),
      grants: grants.filter((grant) => grant.revokedAt === null),
      selfProfiles,
      managedProfiles,
    },
    { "cache-control": "private, no-store" },
  );
}

export async function handlePutAccountProfile(
  deps: AccountDirectoryDeps,
  accountId: string,
  auth: DirectoryAuthorization | undefined,
  body: { profile?: AccountProfileEnvelope; expectedRevision?: number } | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const path = `/api/accounts/${account}/profile`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "PUT", path });
  if (!caller || !(await isAdministrator(deps, caller))) return forbidden("not authorized");
  const user = await deps.usernames.get(account);
  const profile = body?.profile;
  if (!user?.adminRootPubHex || !profile || typeof body?.expectedRevision !== "number") return malformed("malformed body");
  if (profile.accountId.toLowerCase() !== account || profile.signerPubHex !== user.adminRootPubHex.toLowerCase()) {
    return forbidden("not authorized");
  }
  if (!verifyAccountProfile(profile, hexToBytes(user.adminRootPubHex))) return forbidden("not authorized");
  const stored = await deps.accountProfiles.put(
    { ...profile, accountId: account, updatedAt: (deps.now ?? (() => Date.now()))() },
    body.expectedRevision,
  );
  if (!stored.ok) return conflict("revision conflict");
  return ok({ profile: stored.record }, { "cache-control": "private, no-store" });
}

export async function handlePutDeviceSelfProfile(
  deps: AccountDirectoryDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
  body: { profile?: DeviceSelfProfileEnvelope; expectedRevision?: number } | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${account}/devices/${id}/profile`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "PUT", path });
  if (!caller || caller.deviceId !== id) return forbidden("not authorized");
  const profile = body?.profile;
  if (!profile || typeof body?.expectedRevision !== "number") return malformed("malformed body");
  if (profile.accountId.toLowerCase() !== account || profile.deviceId !== id || profile.signerPubHex !== caller.signerPubHex) {
    return forbidden("not authorized");
  }
  if (!verifyDeviceSelfProfile(profile, hexToBytes(caller.signerPubHex))) return forbidden("not authorized");
  const stored = await deps.selfProfiles.put(
    { ...profile, accountId: account, deviceId: id, updatedAt: (deps.now ?? (() => Date.now()))() },
    body.expectedRevision,
  );
  if (!stored.ok) return conflict("revision conflict");
  return ok({ profile: stored.record }, { "cache-control": "private, no-store" });
}

export async function handlePutDeviceManagedProfile(
  deps: AccountDirectoryDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
  body: { profile?: DeviceManagedProfileEnvelope; expectedRevision?: number } | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${account}/devices/${id}/managed-profile`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "PUT", path });
  if (!caller || !(await isAdministrator(deps, caller))) return forbidden("not authorized");
  const user = await deps.usernames.get(account);
  const target = await deps.identities.get(account, id);
  const profile = body?.profile;
  if (!user?.adminRootPubHex || !target || !profile || typeof body?.expectedRevision !== "number") return malformed("malformed body");
  if (profile.accountId.toLowerCase() !== account || profile.deviceId !== id || profile.signerPubHex !== user.adminRootPubHex.toLowerCase()) {
    return forbidden("not authorized");
  }
  if (!verifyDeviceManagedProfile(profile, hexToBytes(user.adminRootPubHex))) return forbidden("not authorized");
  const stored = await deps.managedProfiles.put(
    { ...profile, accountId: account, deviceId: id, updatedAt: (deps.now ?? (() => Date.now()))() },
    body.expectedRevision,
  );
  if (!stored.ok) return conflict("revision conflict");
  return ok({ profile: stored.record }, { "cache-control": "private, no-store" });
}

export async function handleDeleteDeviceManagedProfile(
  deps: AccountDirectoryDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
  body: { expectedRevision?: number } | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${account}/devices/${id}/managed-profile`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "DELETE", path });
  if (!caller || !(await isAdministrator(deps, caller))) return forbidden("not authorized");
  if (typeof body?.expectedRevision !== "number") return malformed("malformed body");
  if (!(await deps.managedProfiles.delete(account, id, body.expectedRevision))) return conflict("revision conflict");
  return ok({ ok: true }, { "cache-control": "private, no-store" });
}
