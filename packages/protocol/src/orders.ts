/**
 * Phone-server orders — the discriminated-union command the phone signs and
 * the daemon verifies (noop / backup-policy / shut-down / power-off /
 * revoke-self / rotate-identity / deliver-bak / browser-input / subscriber
 * add+remove / paired-session add+remove / backup-app / set-front-page).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; per-variant tags,
 * field order, and guards are unchanged, so canonical bytes and signatures
 * remain byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

/**
 * Enum-style guard for the power action mode. The canonical bytes only
 * ever commit to a known literal; an unknown value throws at sign- AND
 * verify-time so a tampered mode can never canonicalize ambiguously
 * (and the Ed25519 verify on a tampered mode fails regardless).
 */
export type PowerOffMode = "off" | "restart";
function powerOffModeToken(mode: PowerOffMode): string {
  if (mode !== "off" && mode !== "restart") {
    throw new Error(`invalid power-off mode: ${String(mode)}`);
  }
  return mode;
}

/**
 * Phone-server order. Signed by the per-server PSK private key (held on
 * the phone); the daemon verifies against the PSK pubkey baked into the
 * install trailer.
 *
 * Each order is a discriminated union; the canonical-bytes function
 * tags by type so a captured signature for one variant can't be
 * replayed as a different variant.
 */
export type PhoneOrder =
  | { type: "noop"; serverId: ServerId; issuedAt: number }
  | { type: "set-backup-policy"; serverId: ServerId; enabled: boolean; issuedAt: number }
  | { type: "shut-down"; serverId: ServerId; issuedAt: number }
  | {
      /**
       * Real host power action — `systemctl poweroff` (mode "off") or
       * `systemctl reboot` (mode "restart"). Distinct from `shut-down`,
       * which only exits the daemon PROCESS. On a LUKS-from-phone box a
       * power-off drops the in-memory disk key, so the next boot lands at
       * the phone-approval unlock prompt ("lock"). The daemon suppresses
       * the silent auto-unlock before the host action so the box does not
       * quietly re-unlock on the way back up.
       */
      type: "power-off";
      serverId: ServerId;
      mode: "off" | "restart";
      issuedAt: number;
    }
  | { type: "revoke-self"; serverId: ServerId; reason: string; issuedAt: number }
  | { type: "rotate-server-identity"; serverId: ServerId; newIdentityPubKey: Bytes; issuedAt: number }
  | { type: "deliver-bak"; serverId: ServerId; bakPubKey: Bytes; issuedAt: number }
  | {
      /**
       * Phone-supplied input bound for the pod-resident browser. Sent
       * after the daemon emits a `browser-input-needed` alert for a
       * focused password / OTP / text field. The canonical bytes
       * cover everything including `value` so a captured response
       * cannot be diverted to a different field or tab.
       *
       * `screenshotRef` correlates back to a specific alert — the
       * daemon rejects responses whose ref doesn't match a live alert
       * (replay defense within the alert lifecycle).
       */
      type: "browser-input-response";
      serverId: ServerId;
      tabId: string;
      inputKind: "password" | "otp" | "text";
      value: string;
      screenshotRef: string;
      issuedAt: number;
    }
  | {
      /**
       * Add an FQDN to an app's update-pack subscriber list. Affects
       * `/.flagship/update`'s authorization check the next time the
       * named subscriber pulls. `fqdn` is normalized to lowercase by
       * the daemon.
       */
      type: "add-subscriber";
      serverId: ServerId;
      serviceId: string;
      fqdn: string;
      issuedAt: number;
    }
  | {
      type: "remove-subscriber";
      serverId: ServerId;
      serviceId: string;
      fqdn: string;
      issuedAt: number;
    }
  | {
      /**
       * Mint a paired-session token. The phone supplies the token bytes
       * (random 32 bytes is the usual choice — typed as hex) and the
       * daemon stores it in its PairedSessionStore so subsequent calls
       * carrying `Authorization: Flagship-Session <token>` are accepted.
       *
       * Sessions are presented and revoked using an opaque token-derived code.
       */
      type: "add-paired-session";
      serverId: ServerId;
      token: string;
      issuedAt: number;
    }
  | {
      type: "remove-paired-session";
      serverId: ServerId;
      token: string;
      issuedAt: number;
    }
  | {
      /**
       * Phone-driven app backup. Daemon bundles the app's source +
       * (optionally) its user data into a tar.gz, optionally encrypts
       * with a password-derived key, holds it on disk, and returns a
       * one-shot fetch URL the phone pulls bytes from. Phone owns the
       * archive afterwards — store it however, share it however.
       *
       * Modes:
       *   - includeUserData: false → manifest + source + Dockerfile
       *     only. Sharable archive (no user data).
       *   - includeUserData: true → adds dumped Postgres/MinIO/Redis
       *     namespaces. Personal restore archive only.
       *
       * `password` is an optional UTF-8 passphrase. Daemon derives an
       * AES-GCM key via PBKDF2 and encrypts the archive end-to-end.
       * Phone-side import recomputes the key from the same password.
       */
      type: "backup-app";
      serverId: ServerId;
      creator: string;
      slug: string;
      includeUserData: boolean;
      password?: string;
      issuedAt: number;
    }
  | {
      /**
       * Choose what the box's apex serves: a 302 to the named installed
       * service's tier-1 canonical (`https://<label>.<serverId>/`), or
       * the default Flagship page when `label` is "" (clear). The daemon
       * validates the label against its installed services at request
       * time and falls back to the default page if it disappears.
       */
      type: "set-front-page";
      serverId: ServerId;
      /** Service url-label to front-page; "" clears the assignment. */
      label: string;
      issuedAt: number;
    };

const TAG_ORDER_NOOP = "flagship/order/noop/v1";
const TAG_ORDER_SET_BACKUP_POLICY = "flagship/order/set-backup-policy/v1";
const TAG_ORDER_SHUT_DOWN = "flagship/order/shut-down/v1";
const TAG_ORDER_POWER_OFF = "flagship/order/power-off/v1";
const TAG_ORDER_REVOKE_SELF = "flagship/order/revoke-self/v1";
const TAG_ORDER_ROTATE_IDENTITY = "flagship/order/rotate-server-identity/v1";
const TAG_ORDER_DELIVER_BAK = "flagship/order/deliver-bak/v1";
const TAG_ORDER_BROWSER_INPUT = "flagship/order/browser-input-response/v1";
const TAG_ORDER_ADD_SUBSCRIBER = "flagship/order/add-subscriber/v1";
const TAG_ORDER_REMOVE_SUBSCRIBER = "flagship/order/remove-subscriber/v1";
const TAG_ORDER_ADD_PAIRED_SESSION = "flagship/order/add-paired-session/v2";
const TAG_ORDER_REMOVE_PAIRED_SESSION = "flagship/order/remove-paired-session/v1";
const TAG_ORDER_BACKUP_APP = "flagship/order/backup-app/v1";
const TAG_ORDER_SET_FRONT_PAGE = "flagship/order/set-front-page/v1";

function canonicalPhoneOrder(o: PhoneOrder): Bytes {
  const enc = new TextEncoder();
  switch (o.type) {
    case "noop":
      return enc.encode([TAG_ORDER_NOOP, o.serverId, o.issuedAt].join("|"));
    case "set-backup-policy":
      return enc.encode(
        [TAG_ORDER_SET_BACKUP_POLICY, o.serverId, o.enabled ? "1" : "0", o.issuedAt].join("|"),
      );
    case "shut-down":
      return enc.encode([TAG_ORDER_SHUT_DOWN, o.serverId, o.issuedAt].join("|"));
    case "power-off":
      return enc.encode(
        [TAG_ORDER_POWER_OFF, o.serverId, powerOffModeToken(o.mode), o.issuedAt].join("|"),
      );
    case "revoke-self":
      legacyFieldGuard("reason", o.reason);
      return enc.encode([TAG_ORDER_REVOKE_SELF, o.serverId, o.reason, o.issuedAt].join("|"));
    case "rotate-server-identity":
      return enc.encode(
        [TAG_ORDER_ROTATE_IDENTITY, o.serverId, hex(o.newIdentityPubKey), o.issuedAt].join("|"),
      );
    case "deliver-bak":
      return enc.encode(
        [TAG_ORDER_DELIVER_BAK, o.serverId, hex(o.bakPubKey), o.issuedAt].join("|"),
      );
    case "browser-input-response":
      legacyFieldGuard("tabId", o.tabId);
      legacyFieldGuard("value", o.value);
      legacyFieldGuard("screenshotRef", o.screenshotRef);
      return enc.encode(
        [
          TAG_ORDER_BROWSER_INPUT,
          o.serverId,
          o.tabId,
          o.inputKind,
          o.value,
          o.screenshotRef,
          o.issuedAt,
        ].join("|"),
      );
    case "add-subscriber":
      legacyFieldGuard("serviceId", o.serviceId);
      legacyFieldGuard("fqdn", o.fqdn);
      return enc.encode(
        [TAG_ORDER_ADD_SUBSCRIBER, o.serverId, o.serviceId, o.fqdn, o.issuedAt].join("|"),
      );
    case "remove-subscriber":
      legacyFieldGuard("serviceId", o.serviceId);
      legacyFieldGuard("fqdn", o.fqdn);
      return enc.encode(
        [TAG_ORDER_REMOVE_SUBSCRIBER, o.serverId, o.serviceId, o.fqdn, o.issuedAt].join("|"),
      );
    case "add-paired-session":
      legacyFieldGuard("token", o.token);
      return enc.encode(
        [TAG_ORDER_ADD_PAIRED_SESSION, o.serverId, o.token, o.issuedAt].join("|"),
      );
    case "remove-paired-session":
      legacyFieldGuard("token", o.token);
      return enc.encode(
        [TAG_ORDER_REMOVE_PAIRED_SESSION, o.serverId, o.token, o.issuedAt].join("|"),
      );
    case "backup-app":
      legacyFieldGuard("creator", o.creator);
      legacyFieldGuard("slug", o.slug);
      if (o.password !== undefined) legacyFieldGuard("password", o.password);
      return enc.encode(
        [
          TAG_ORDER_BACKUP_APP,
          o.serverId,
          o.creator,
          o.slug,
          o.includeUserData ? "1" : "0",
          o.password ?? "",
          o.issuedAt,
        ].join("|"),
      );
    case "set-front-page":
      legacyFieldGuard("label", o.label);
      return enc.encode(
        [TAG_ORDER_SET_FRONT_PAGE, o.serverId, o.label, o.issuedAt].join("|"),
      );
  }
}

export function signPhoneOrder(o: PhoneOrder, psk: Keypair): Bytes {
  return ed.sign(canonicalPhoneOrder(o), psk.privateKey);
}
export function verifyPhoneOrder(o: PhoneOrder, sig: Bytes, pskPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPhoneOrder(o), pskPub);
  } catch {
    return false;
  }
}
