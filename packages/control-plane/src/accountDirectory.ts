import {
  accountDirectoryKeyGrantId,
  deviceSupportCode,
  verifyAccountDirectoryRequestFast,
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
  PushTokenRecord,
  PushTokenStorage,
  UsernameStorage,
  VoiciCallStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { requireDeviceScope } from "./deviceCapabilityGrants.js";
import { dropVoiciCallKeysOfRevokedDevices } from "./voiciCallKeyCleanup.js";
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
  pushTokens: PushTokenStorage;
  nonces: DirectoryNonceStore;
  /** voi.ci calls: a removed device's call-key binding is dropped. */
  callKeys?: Pick<VoiciCallStorage, "deleteCallKeyForDevice">;
  /**
   * Wake a device another device just removed, on its own push tokens, before they are dropped
   * (docs/revocation-ui.md). The push is content-free: the device asks `.com` and erases the
   * account's keys only on `.com`'s own `device-removed` answer, never on the push.
   */
  notifyDeviceRemoved?: (targets: PushTokenRecord[]) => Promise<void>;
  now?: () => number;
  freshnessMs?: number;
}

export interface DirectoryAuthorization {
  request?: Partial<AccountDirectoryRequest>;
  signature?: string;
}

export type AuthorizedDevice = {
  accountId: string;
  deviceId: string;
  signerPubHex: string;
};

/** What `.com` answers a device that was removed from its account (docs/revocation-ui.md). */
export const DEVICE_REMOVED_CODE = "device-removed";

export const deviceRemoved = (): HandlerResponseWithHeaders => ({
  status: 403,
  body: { error: DEVICE_REMOVED_CODE, code: DEVICE_REMOVED_CODE },
  headers: { "cache-control": "private, no-store" },
});

/**
 * Why a signed device request was refused: `device-removed` when the signature is fresh and verifies under the
 * key of a device this account has removed, so only that device (holding its own key) ever hears it and it may
 * erase the account's keys on that answer; the usual `not authorized` for everything else. Asked only after
 * `authorizeActiveDevice` refused, so a working device never pays for it.
 */
export async function deviceRefusal(
  deps: Pick<AccountDirectoryDeps, "identities" | "now" | "freshnessMs">,
  auth: DirectoryAuthorization | undefined,
  expected: { accountId: string; method: string; path: string },
): Promise<HandlerResponseWithHeaders> {
  return (await isRemovedDeviceRequest(deps, auth, expected)) ? deviceRemoved() : forbidden("not authorized");
}

async function isRemovedDeviceRequest(
  deps: Pick<AccountDirectoryDeps, "identities" | "now" | "freshnessMs">,
  auth: DirectoryAuthorization | undefined,
  expected: { accountId: string; method: string; path: string },
): Promise<boolean> {
  const request = auth?.request;
  const signature = auth?.signature;
  if (
    !request || typeof signature !== "string" ||
    typeof request.accountId !== "string" || typeof request.deviceId !== "string" ||
    typeof request.signerPubHex !== "string" || typeof request.method !== "string" ||
    typeof request.path !== "string" || typeof request.requestId !== "string" ||
    typeof request.issuedAt !== "number"
  ) return false;
  const accountId = expected.accountId.toLowerCase();
  if (request.accountId.toLowerCase() !== accountId || request.method !== expected.method || request.path !== expected.path) return false;
  const now = (deps.now ?? (() => Date.now()))();
  if (Math.abs(now - request.issuedAt) > (deps.freshnessMs ?? 5 * 60_000)) return false;
  const identity = await deps.identities.get(accountId, request.deviceId);
  if (!identity || identity.revokedAt === null || identity.devicePubHex !== request.signerPubHex.toLowerCase()) return false;
  return await verifyAccountDirectoryRequestFast(request as AccountDirectoryRequest, signature, hexToBytes(identity.devicePubHex));
}

export async function authorizeActiveDevice(
  deps: Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">,
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
  if (!(await verifyAccountDirectoryRequestFast(fullRequest, signature, hexToBytes(identity.devicePubHex)))) return null;
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
      acceptAdminDeviceKey: true,
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
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "GET", path });
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
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "PUT", path });
  if (!(await isAdministrator(deps, caller))) return forbidden("not authorized");
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
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "GET", path });
  // Allowed when the device is an administrator OR holds a view-directory
  // grant; the two checks are independent reads, so the order only changes what
  // they cost. An admin device is answered by its admin grant alone, without
  // first failing the membership-root check its admin-root-signed grant can
  // never pass.
  if (
    !(await isAdministrator(deps, caller)) &&
    !(
      await requireDeviceScope(
        { storage: deps.grants, identities: deps.identities, usernames: deps.usernames, now: deps.now },
        caller.signerPubHex,
        account,
        "view-directory",
      )
    ).ok
  ) {
    return forbidden("not authorized");
  }
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
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "PUT", path });
  if (!(await isAdministrator(deps, caller))) return forbidden("not authorized");
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
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "PUT", path });
  if (caller.deviceId !== id) return forbidden("not authorized");
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
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "PUT", path });
  if (!(await isAdministrator(deps, caller))) return forbidden("not authorized");
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
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "DELETE", path });
  if (!(await isAdministrator(deps, caller))) return forbidden("not authorized");
  if (typeof body?.expectedRevision !== "number") return malformed("malformed body");
  if (!(await deps.managedProfiles.delete(account, id, body.expectedRevision))) return conflict("revision conflict");
  return ok({ ok: true }, { "cache-control": "private, no-store" });
}

export async function handleRevokeAccountDevice(
  deps: AccountDirectoryDeps,
  accountId: string,
  deviceId: string,
  auth: DirectoryAuthorization | undefined,
): Promise<HandlerResponseWithHeaders> {
  const account = accountId.toLowerCase();
  const id = deviceId.toLowerCase();
  const path = `/api/accounts/${account}/devices/${id}`;
  const caller = await authorizeActiveDevice(deps, auth, { accountId: account, method: "DELETE", path });
  if (!caller) return await deviceRefusal(deps, auth, { accountId: account, method: "DELETE", path });
  if (caller.deviceId !== id) {
    const scoped = await requireDeviceScope(
      { storage: deps.grants, identities: deps.identities, usernames: deps.usernames, now: deps.now },
      caller.signerPubHex,
      account,
      "revoke-others",
    );
    if (!scoped.ok && !(await isAdministrator(deps, caller))) return forbidden("not authorized");
  }
  const target = await deps.identities.get(account, id);
  if (!target) return forbidden("not authorized");
  const revokedAt = (deps.now ?? (() => Date.now()))();
  if (target.revokedAt === null) await deps.identities.revoke(account, id, revokedAt);
  const grants = await deps.grants.listForUser(account);
  await Promise.all(
    grants.filter((grant) => grant.deviceId === id && grant.revokedAt === null)
      .map((grant) => deps.grants.revoke(grant.grantId, revokedAt)),
  );
  await dropVoiciCallKeysOfRevokedDevices({ grants: deps.grants, callKeys: deps.callKeys }, account, [id]);
  const tokens = (await deps.pushTokens.listByUser(account)).filter((token) => token.deviceId === id);
  // Removing itself, a device erases its own keys; another device's removal wakes it to check (and erase) now.
  if (caller.deviceId !== id && tokens.length > 0 && deps.notifyDeviceRemoved) {
    try {
      await deps.notifyDeviceRemoved(tokens);
    } catch {
      // A push that fails changes nothing: the device hears `device-removed` on its next call to `.com`.
    }
  }
  await Promise.all(tokens.map((token) => deps.pushTokens.remove(token.tokenId)));
  return ok({ ok: true, deviceId: id, revokedAt }, { "cache-control": "private, no-store" });
}
