/**
 * The NOTIFY PIPE — how an alert reaches the owner's phone when the
 * boot worker holds NO push secrets.
 *
 * The boot worker holds no push tokens / APNs / FCM / VAPID keys (that's
 * what makes it cleanly cloneable). When a box announces it needs
 * approval, the boot worker makes an AUTHENTICATED server-to-server call
 * to the identity plane:
 *
 *   POST {IDENTITY_PLANE_URL}/api/internal/notify-owner
 *   x-boot-notify-secret: <NOTIFY_SHARED_SECRET>
 *   { serverDomain, signedRequest, purpose }
 *
 * `signedRequest` is the box's STK-signed SecretRequest (the same
 * `{ request, signature, deviceInfo }` shape the box posted). The
 * identity plane RE-VERIFIES it against its own directory — it does NOT
 * trust the boot worker's echo — then resolves the owning account, looks
 * up its push tokens, and sends the RFC-8291 encrypted Web Push.
 *
 * The notify call is fire-and-forget from the box's perspective: a push
 * failure never blocks the boot handshake (the box polls regardless).
 */

import type { SecretMailboxPurpose } from "@flagship/storage";

export interface NotifyPipe {
  /**
   * Ask the identity plane to push the owner. Resolves true on a 2xx,
   * false otherwise (including when not configured). Never throws.
   */
  notifyOwner(args: {
    serverDomain: string;
    signedRequest: unknown;
    purpose: SecretMailboxPurpose;
  }): Promise<boolean>;
}

export interface HttpNotifyPipeOpts {
  identityPlaneUrl: string;
  sharedSecret: string;
  fetchImpl?: typeof fetch;
}

export class HttpNotifyPipe implements NotifyPipe {
  private readonly url: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpNotifyPipeOpts) {
    this.url = `${opts.identityPlaneUrl.replace(/\/$/, "")}/api/internal/notify-owner`;
    this.secret = opts.sharedSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async notifyOwner(args: {
    serverDomain: string;
    signedRequest: unknown;
    purpose: SecretMailboxPurpose;
  }): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-boot-notify-secret": this.secret,
        },
        body: JSON.stringify({
          serverDomain: args.serverDomain,
          signedRequest: args.signedRequest,
          purpose: args.purpose,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** A no-op notify pipe — used when NOTIFY_SHARED_SECRET / IDENTITY_PLANE_URL
 *  are unset, so the worker still runs (box polling works; no push fires). */
export class NoopNotifyPipe implements NotifyPipe {
  async notifyOwner(): Promise<boolean> {
    return false;
  }
}
