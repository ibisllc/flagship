// GET /api/users/:u/devices
//
// Lists the peer-class devices (push-token holders) on the user's
// account so the "Trusted devices" surface in mobile + webapp can
// render a per-device list with platform, label, addedAt, lastSeenAt,
// and a current-device flag.
//
// The handler returns:
//
//   {
//     "devices": [
//       { "tokenId": "ab12…",
//         "tokenPrefix": "ab12cd34",
//         "label": "Harry's iPhone",
//         "platform": "apns",
//         "addedAt": 1700000000000,
//         "lastSeenAt": 1700100000000 },
//       …
//     ]
//   }
//
// `tokenPrefix` is the first 8 hex chars of `tokenId`. Surfaces that
// would otherwise need the full token to reference a device (e.g. an
// audit log "Disconnected by abc12345") can show the prefix instead
// — same prefix uniqueness story as git short-hashes. The full
// `tokenId` is also returned so revoke flows can DELETE
// /api/push/<tokenId> without an extra lookup.
//
// **ETag.** The response carries a stable `ETag` header over a
// canonicalized snapshot of the rows. Subsequent revoke / re-pair
// requests can submit `If-Match: <etag>` and the Worker rejects
// (412 Precondition Failed) if the device list has shifted since
// the client last saw it — protecting against the "another device
// registered between fetch and action" race.
//
// **Deliberately excluded from the ETag:** `lastSeenAt`. If we hashed
// that, every push-token use would invalidate the client's cache and
// destabilise revocation flows. Identity-significant columns only.

import type { PushTokenStorage } from "@flagship/storage";
import { ok, malformed, type HandlerResponseWithHeaders } from "./types.js";

export interface UsersDevicesDeps {
  pushTokens: PushTokenStorage;
}

export interface DeviceSummary {
  tokenId: string;
  tokenPrefix: string;
  label: string;
  platform: "apns" | "fcm" | "webpush";
  addedAt: number;
  lastSeenAt: number;
  /**
   * v1.2 Phase 4 — wall-clock ms before which this device can't
   * revoke other devices on the account (14-day quarantine on
   * freshly-admitted devices). 0 (or absent) means already-trusted.
   * Surfaced so iOS / Android / webapp can render a clock icon +
   * disable the Remove/Replace actions until the window elapses.
   */
  quarantineUntil?: number;
}

export interface UsersDevicesResponse {
  devices: DeviceSummary[];
}

const USERNAME_RE = /^[a-z0-9]{1,63}$/; // no hyphens — see labels.ts

export async function handleGetUsersDevices(
  deps: UsersDevicesDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const norm = username.toLowerCase();
  if (!USERNAME_RE.test(norm)) return malformed("malformed username");

  const rows = await deps.pushTokens.listByUser(norm);
  // Sort by addedAt ascending then by tokenId for tie-breaks, so the
  // ETag computation is deterministic for the same row set regardless
  // of storage-layer return order.
  const devices: DeviceSummary[] = rows
    .map((r) => {
      const base: DeviceSummary = {
        tokenId: r.tokenId,
        tokenPrefix: r.tokenId.slice(0, 8),
        label: r.label || `Untitled ${r.platform}`,
        platform: r.platform,
        addedAt: r.registeredAt,
        lastSeenAt: r.lastSeenAt,
      };
      // Phase 4 — surface the quarantine clock to the UI. We omit
      // the key entirely when 0 / absent so existing clients that
      // didn't yet decode the field don't see a confusing zero.
      if (r.quarantineUntil && r.quarantineUntil > 0) {
        base.quarantineUntil = r.quarantineUntil;
      }
      return base;
    })
    .sort((a, b) => a.addedAt - b.addedAt || a.tokenId.localeCompare(b.tokenId));

  const etag = await computeDevicesEtag(devices);

  return ok<UsersDevicesResponse>(
    { devices },
    {
      "etag": etag,
      // The list IS auth-dependent (only the IRK-holder should
      // browse it), but the Worker doesn't yet gate this endpoint
      // on a signature. We mark `private, no-cache` so a CDN
      // doesn't cache it across users while we wire the auth layer
      // in the next commit.
      "cache-control": "private, no-cache",
    },
  );
}

/**
 * Compute the ETag over the identity-significant subset of the
 * device list. `lastSeenAt` is deliberately excluded so push-delivery
 * activity doesn't flutter the ETag. Returns `W/"<hex>"` so callers
 * can string-compare directly against an `If-Match` header.
 */
export async function computeDevicesEtag(devices: DeviceSummary[]): Promise<string> {
  const stable = devices.map((d) => ({
    tokenId: d.tokenId,
    label: d.label,
    platform: d.platform,
    addedAt: d.addedAt,
  }));
  const enc = new TextEncoder().encode(JSON.stringify(stable));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const hex = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  return `W/"${hex}"`;
}
