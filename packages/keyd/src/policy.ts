import { KeydError } from "./wire.js";

/**
 * What the box identity key (STK) may sign. keyd never signs "these bytes": a message must
 * start with one of these purposes (everything before the first `|`), and some purposes carry
 * their own rules. The list is the set of messages the box signs today; a purpose the box
 * should not sign (anything an owner, admin or the account key signs) is not here, so a
 * compromised daemon cannot ask keyd for it.
 */
export const BOX_SIGN_PURPOSES: ReadonlySet<string> = new Set([
  "flagship/install-service/v1",
  "flagship/update-pull/v1",
  "flagship/secret-request/v1",
  "flagship/tunnel-hello/v2",
  "flagship/daemon-status/v1",
  "flagship/service-invite-list/v1",
  "flagship/service-invite-create-fetch/v1",
  "flagship/service-invite-co-manager/v1",
  "flagship/service-grant/v1",
  "flagship/server-revoke-by-self/v1",
  "flagship/server-migration-attach/v1",
  "flagship/server-migration-ack/v1",
  "flagship/pod-binding/v1",
  "flagship/pb-manifest/v1",
  "flagship/mint-reservation/v1",
  "flagship/membership/v1",
  "flagship/lan-hint/v1",
  "flagship/dns01-publish/v1",
  "flagship/dns01-delete/v1",
  "flagship/box-trust-status/v1",
  "flagship/box-read-token-request/v1",
  "flagship/server-register/v1",
  "flagship/put-sealed-luks-key/v1",
  "flagship/boot-suspension/v1",
  "flagship/boot-auth/v1",
  "flagship/inject/v1",
  "flagship/sibling-hello/v1",
  "flagship/sibling-sync/v1",
  "flagship/push-relay/v1",
  "flagship/app-copy-fetch/v1",
  "flagship/pb-http/v1",
  // Older peer-backup messages that predate the tag convention.
  "pb-put",
  "pb-resp",
  "pb/request-peers/v1",
]);

export const MAX_SIGN_BYTES = 256 * 1024;

const DECODER = new TextDecoder("utf-8", { fatal: true });

export function purposeOf(msg: Uint8Array): string {
  let text: string;
  try {
    text = DECODER.decode(msg.subarray(0, Math.min(msg.length, 256)));
  } catch {
    // The head is not text; a binary message is never a box purpose.
    throw new KeydError("forbidden", "the message does not start with a purpose");
  }
  const bar = text.indexOf("|");
  if (bar <= 0) throw new KeydError("forbidden", "the message does not start with a purpose");
  return text.slice(0, bar);
}

/**
 * Decide whether the box key may sign `msg`. `publicKeyHex` is keyd's own public key, used by
 * purposes that name the signer. Throws KeydError("forbidden") with a short, non-secret reason.
 */
export function checkSign(msg: Uint8Array, publicKeyHex: string, allowed: ReadonlySet<string> = BOX_SIGN_PURPOSES): string {
  if (msg.length === 0 || msg.length > MAX_SIGN_BYTES) throw new KeydError("bad-request", "message size out of range");
  const purpose = purposeOf(msg);
  if (!allowed.has(purpose)) throw new KeydError("forbidden", `the box does not sign ${purpose.slice(0, 64)}`);
  if (purpose === "flagship/boot-suspension/v1" || purpose === "flagship/boot-auth/v1") {
    const parts = new TextDecoder().decode(msg).split("|");
    if (purpose === "flagship/boot-suspension/v1") {
      // tag|serverDomain|epoch|seq|action|reason|signer|issuedAt
      if (parts.length !== 8 || parts[6] !== "box" || parts[4] !== "suspend" || !(Number(parts[3]) >= 1)) {
        throw new KeydError("forbidden", "the box key may only sign a suspend, as the box");
      }
    } else {
      // tag|role|serverDomain|method|path|pubKeyHex|nonceHex|issuedAt
      if (parts.length !== 8 || parts[1] !== "box" || parts[5] !== publicKeyHex) {
        throw new KeydError("forbidden", "the box key signs boot requests as the box only");
      }
    }
  }
  return purpose;
}

/** Token bucket per operation class. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limits: Record<string, { perSecond: number; burst: number }>,
    private readonly now: () => number = Date.now,
  ) {}

  take(op: string): boolean {
    const cfg = this.limits[op] ?? this.limits["*"];
    if (!cfg) return true;
    const t = this.now();
    const b = this.buckets.get(op) ?? { tokens: cfg.burst, at: t };
    b.tokens = Math.min(cfg.burst, b.tokens + ((t - b.at) / 1000) * cfg.perSecond);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(op, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(op, b);
    return true;
  }
}

export const DEFAULT_RATE_LIMITS: Record<string, { perSecond: number; burst: number }> = {
  sign: { perSecond: 2000, burst: 4000 },
  unseal: { perSecond: 50, burst: 100 },
  "provision.swk": { perSecond: 0.1, burst: 3 },
  "provision.cgk": { perSecond: 0.1, burst: 3 },
  "*": { perSecond: 5000, burst: 10000 },
};
