/**
 * "A device on your account invited someone to one of your apps." (owner
 * decision 2026-10-15, docs/service-access-gating.md "Who can invite").
 *
 * Any device of an account may invite someone to an app at Member; when a
 * non-admin device does, `.com` tells every admin device. The notice is
 * content-free: a fixed category, kind and the account-activity app link. No
 * app, person, server or device name rides it (AGENTS.md privacy rules); the
 * admin opens the app and reads the members list, which their own devices
 * decrypt.
 */
import { requireMasterAdmin, type AdminGrantView, type DeviceScope } from "@flagship/protocol";
import type {
  DeviceCapabilityGrantRecord,
  DeviceCapabilityGrantStorage,
  PushTokenStorage,
  UsernameStorage,
} from "@flagship/storage";
import { appRouteLink } from "./appLink.js";
import { bytesToHex, hexToBytes } from "./hex.js";

export const INVITE_CREATED_CATEGORY = "invite-created";
export const INVITE_CREATED_TEXT = "A device on your account invited someone to one of your apps.";

/** What an `invite-created` push carries besides its category. */
export function inviteCreatedDisplayData(apex = "flagshipserver.com"): Record<string, string> {
  return { kind: INVITE_CREATED_CATEGORY, deepLink: appRouteLink("account/activity", {}, apex) };
}

export interface InviteNoticeForward {
  targets: Array<{ tokenId: string; platform: "apns" | "fcm" | "webpush"; providerToken: string }>;
  category: string;
  sealedPayloadHex: string;
  webpushPayloadBytes?: Uint8Array;
  displayData?: Record<string, string>;
}

function grantView(rec: DeviceCapabilityGrantRecord): AdminGrantView | null {
  try {
    const scopes = JSON.parse(rec.scopesJson) as unknown;
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) return null;
    return {
      grant: {
        grantId: rec.grantId,
        username: rec.username,
        deviceId: rec.deviceId,
        devicePubKey: hexToBytes(rec.devicePubHex),
        scopes: scopes as DeviceScope[],
        issuedAt: rec.issuedAt,
        expiresAt: rec.expiresAt,
      },
      signatureHex: rec.signatureHex,
      signerRoot: rec.signerRoot ?? "membership",
      revokedAt: rec.revokedAt,
    };
  } catch {
    return null;
  }
}

/**
 * The account's admin devices: those holding a live, admin-root-signed
 * `admin` grant (the account's first device gets one at creation).
 */
export async function adminDeviceIds(
  grants: Pick<DeviceCapabilityGrantStorage, "listForUser">,
  username: string,
  adminRootPubHex: string,
  now: number,
): Promise<Set<string>> {
  const views = (await grants.listForUser(username))
    .filter((r) => r.revokedAt == null)
    .map(grantView)
    .filter((v): v is AdminGrantView => v !== null);
  const out = new Set<string>();
  for (const v of views) {
    const pub = bytesToHex(v.grant.devicePubKey);
    if (requireMasterAdmin(pub, username, adminRootPubHex.toLowerCase(), views, now).ok) out.add(v.grant.deviceId);
  }
  return out;
}

/**
 * Push the notice to every admin device of `username`. Returns how many push
 * targets it reached (0 when the account has no admin root, no admin device
 * with a push token, or no push provider). Never throws.
 */
export function buildNotifyAdminDevices(deps: {
  usernames: Pick<UsernameStorage, "get">;
  grants: Pick<DeviceCapabilityGrantStorage, "listForUser">;
  pushTokens: Pick<PushTokenStorage, "listByUser">;
  forward: (args: InviteNoticeForward) => Promise<unknown>;
  apex?: string;
  now?: () => number;
}): (username: string) => Promise<number> {
  return async (username) => {
    try {
      const user = await deps.usernames.get(username);
      if (!user?.adminRootPubHex) return 0;
      const admins = await adminDeviceIds(deps.grants, username, user.adminRootPubHex, (deps.now ?? Date.now)());
      if (admins.size === 0) return 0;
      const tokens = (await deps.pushTokens.listByUser(username)).filter((t) => admins.has(t.deviceId));
      if (tokens.length === 0) return 0;
      const displayData = inviteCreatedDisplayData(deps.apex);
      await deps.forward({
        targets: tokens.map((t) => ({ tokenId: t.tokenId, platform: t.platform, providerToken: t.providerToken })),
        category: INVITE_CREATED_CATEGORY,
        sealedPayloadHex: "",
        webpushPayloadBytes: new TextEncoder().encode(
          JSON.stringify({ category: INVITE_CREATED_CATEGORY, body: INVITE_CREATED_TEXT, ...displayData }),
        ),
        displayData,
      });
      return tokens.length;
    } catch {
      return 0;
    }
  };
}
