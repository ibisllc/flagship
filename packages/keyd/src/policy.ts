import { checkIdentityAssertion, TAG_IDENTITY_HEADER, TAG_INJECT } from "@flagship/protocol";
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
  "flagship/server-revoke-by-self/v1",
  "flagship/server-migration-attach/v1",
  "flagship/server-migration-ack/v1",
  "flagship/pod-binding/v1",
  "flagship/pb-manifest/v1",
  "flagship/mint-reservation/v1",
  "flagship/lan-hint/v1",
  "flagship/dns01-publish/v1",
  "flagship/dns01-delete/v1",
  "flagship/box-trust-status/v1",
  "flagship/box-read-token-request/v1",
  "flagship/server-register/v1",
  "flagship/put-sealed-luks-key/v1",
  "flagship/boot-suspension/v1",
  "flagship/boot-auth/v1",
  // The STK vouching for the box's boot key (packages/protocol/src/bootKey.ts).
  "flagship/boot-key-binding/v1",
  // Architecture v2: the STK binding its ML-DSA-65 key, and the hybrid boot-key binding.
  // Signed with both keys only (`sign.hybrid`; HYBRID_ONLY_PURPOSES).
  "flagship/pq-key-binding/v1",
  "flagship/boot-key-binding/v2",
  // The PQ session (pq-suites.md §13): the box answers as the responder, and opens box-to-box
  // sessions (access sync) as the initiator. Hybrid only, naming this box.
  "flagship/pq-session-accept/v1",
  "flagship/pq-session-finish/v1",
  "flagship/inject/v1",
  "flagship/sibling-hello/v1",
  "flagship/sibling-sync/v1",
  "flagship/push-relay/v1",
  "flagship/app-copy-fetch/v1",
  "flagship/pb-http/v1",
  "flagship/app-release/v1",
  "flagship/identity-header/v1",
  "flagship/custom-domain-cert/v1",
  "flagship/pb-checkin/v1",
  "flagship/pb-directory/v1",
  "flagship/pb-tokens/v1",
  "flagship/pb-redeem/v1",
  "flagship/pb-filler-fetch/v1",
  "flagship/pb-filler-proof/v1",
  "flagship/pb-root-deposit/v1",
  // Older peer-backup messages that predate the tag convention.
  "pb-put",
  "pb-resp",
  "pb/request-peers/v1",
]);

/** Purposes keyd signs only with both keys (`sign.hybrid`): a classical-only form means nothing. */
export const HYBRID_ONLY_PURPOSES: ReadonlySet<string> = new Set([
  "flagship/pq-key-binding/v1",
  "flagship/boot-key-binding/v2",
  "flagship/pq-session-accept/v1",
  "flagship/pq-session-finish/v1",
]);

/** The only workload-key derivations keyd hands to the daemon (both unsalted). */
export const SWK_HKDF_LABELS: ReadonlySet<string> = new Set(["flagship.pb-manifest.v1", "flagship/peer-backup-key/v1", "flagship/reissue-journal-key/v1"]);

/** The sealed messages keyd opens and returns: pairing orders (the daemon must read the order). */
export const UNSEAL_PURPOSES: ReadonlySet<string> = new Set(["pairing-order"]);

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `{"request": {"type": "add-paired-session", …}, "signature": "<hex>", …}` as UTF-8 JSON. */
export function isPairingOrder(plain: Uint8Array): boolean {
  let v: unknown;
  try {
    v = JSON.parse(STRICT_UTF8.decode(plain));
  } catch {
    return false;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as { request?: unknown; signature?: unknown };
  const r = o.request;
  if (typeof r !== "object" || r === null || Array.isArray(r)) return false;
  return (r as { type?: unknown }).type === "add-paired-session" && typeof o.signature === "string";
}

// The manifest's slug rule (and a username fits it too).
const SERVICE_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A service id: `<creator>--<slug>` (or a bare `<slug>`), each half a lowercase label with no `--`. */
export function isServiceId(id: string): boolean {
  const parts = id.split("--");
  return parts.length <= 2 && parts.every((p) => SERVICE_LABEL.test(p));
}

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
export function checkSign(
  msg: Uint8Array,
  publicKeyHex: string,
  allowed: ReadonlySet<string> = BOX_SIGN_PURPOSES,
  hybrid?: { mldsaPubHex: string },
): string {
  if (msg.length === 0 || msg.length > MAX_SIGN_BYTES) throw new KeydError("bad-request", "message size out of range");
  const purpose = purposeOf(msg);
  if (!allowed.has(purpose)) throw new KeydError("forbidden", `the box does not sign ${purpose.slice(0, 64)}`);
  if (HYBRID_ONLY_PURPOSES.has(purpose) && !hybrid) throw new KeydError("forbidden", "the box signs that with both of its keys only");
  if (purpose === "flagship/pq-key-binding/v1") {
    // tag|role|subjectId|ed25519PubHex|mldsaPubHex|issuedAt
    const parts = new TextDecoder().decode(msg).split("|");
    if (parts.length !== 6 || parts[1] !== "box-stk" || parts[3] !== publicKeyHex || parts[4] !== hybrid?.mldsaPubHex) {
      throw new KeydError("forbidden", "the box binds only its own two keys, as the box");
    }
  }
  if (purpose === "flagship/pq-session-accept/v1" || purpose === "flagship/pq-session-finish/v1") {
    // tag|<server domain>|<128-hex transcript digest>: one transcript, nothing else.
    const parts = new TextDecoder().decode(msg).split("|");
    if (parts.length !== 3 || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(parts[1]!) || !/^[0-9a-f]{128}$/.test(parts[2]!)) {
      throw new KeydError("forbidden", "a session signature names a server and one transcript digest");
    }
  }
  if (purpose === TAG_INJECT || purpose === TAG_IDENTITY_HEADER) {
    // The identity the box asserts to an app: a member's rank, an anonymous visitor or an API
    // key, in one fixed shape each (identityAssertion.ts). No owner/admin role, no rank for an
    // anonymous visitor or a key.
    const refused = checkIdentityAssertion(msg);
    if (refused) throw new KeydError("forbidden", `the box asserts only a member, anonymous or an API key (${refused})`);
  }
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
  "sign.hybrid": { perSecond: 200, burst: 400 },
  unseal: { perSecond: 50, burst: 100 },
  "tls.sign": { perSecond: 500, burst: 1000 },
  "tls.createKey": { perSecond: 5 / 3600, burst: 5 },
  "tls.install": { perSecond: 0.2, burst: 10 },
  "acme.sign": { perSecond: 2, burst: 60 },
  "acme.importGranted": { perSecond: 1 / 60, burst: 3 },
  "acme.create": { perSecond: 1 / 60, burst: 3 },
  "provision.swk": { perSecond: 0.1, burst: 3 },
  "provision.cgk": { perSecond: 0.1, burst: 3 },
  "*": { perSecond: 5000, burst: 10000 },
};
