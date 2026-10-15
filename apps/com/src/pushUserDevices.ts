import { secretRequestDisplayData, type PushFanoutResult } from "@flagship/control-plane";
import type { PushTokenStorage } from "@flagship/storage";

export interface UserDevicesForward {
  targets: Array<{ tokenId: string; platform: "apns" | "fcm" | "webpush"; providerToken: string }>;
  category: string;
  sealedPayloadHex: string;
  webpushPayloadBytes?: Uint8Array;
  displayData?: Record<string, string>;
}

/**
 * The `pushUserDevices` closure the boot-secret relay handlers fire. A
 * `secret-request` wake carries only its fixed `kind` and the approvals app
 * link to APNs/FCM (`secretRequestDisplayData`); without them iOS and Android
 * had nothing to route a tap by. Web Push keeps the plaintext payload, which
 * RFC 8291 encrypts to the browser. Errors are swallowed: a failed push is
 * not an unlock failure, and the mailbox row stays for the next poll.
 */
export function buildPushUserDevices(
  pushTokens: Pick<PushTokenStorage, "listByUser">,
  forwarder: (args: UserDevicesForward) => Promise<PushFanoutResult | unknown>,
  apex = "flagshipserver.com",
): (username: string, category: string, payload?: Uint8Array) => Promise<void> {
  return async (username, category, payload) => {
    try {
      const tokens = await pushTokens.listByUser(username);
      if (tokens.length === 0) return;
      await forwarder({
        targets: tokens.map((t) => ({
          tokenId: t.tokenId,
          platform: t.platform,
          providerToken: t.providerToken,
        })),
        category,
        sealedPayloadHex: "",
        ...(payload ? { webpushPayloadBytes: payload } : {}),
        ...(category === "secret-request" ? { displayData: secretRequestDisplayData(apex) } : {}),
      });
    } catch {
      // A failed push isn't a boot failure.
    }
  };
}
