import {
  authCodeCanonicalBytes,
  verifyAuthCode,
  verifyServerRegister,
  type AuthCode,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  AuthCodeStorage,
  InstallPolicyFanoutStorage,
  PushTokenStorage,
  RoutingStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, HEX128, equalBytes, hexToBytes, bytesToHex } from "./hex.js";
import { addServerRefused } from "./adminAuthorityGate.js";
import { SERIAL_RE, validateAndUseAuthCode } from "./authCode.js";
import { ensureAccountDns, type AccountDnsDeps } from "./accountDns.js";
import { userZoneOf } from "@flagship/services-zone";
/**
 * Minimum DNS-client surface `handleServerRegister` needs. Both
 * `CloudflareDnsClient` (direct CF token, dev/legacy) and
 * `BrokerDnsClient` (RPCs to the dns-broker Worker, production) satisfy
 * this; the difference is invisible to the registration handler.
 */
export interface DnsUpsertClient {
  upsert(opts: {
    name: string;
    type: "A" | "AAAA" | "TXT" | "CNAME";
    content: string;
    ttl?: number;
    proxied?: boolean;
  }): Promise<{ id: string; type: string; name: string; content: string; proxied: boolean; ttl: number }>;
}
import { setRoutingTargetFromRegistration } from "./routing.js";
import {
  conflict, forbidden, malformed, notFound, ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

const NONCE_HEX = /^[0-9a-f]{16,128}$/;

export interface ServerRegisterDeps {
  authCodes: AuthCodeStorage;
  servers: ServerStorage;
  /** When wired, a real account's AuthCode must still pin its admin root. */
  usernames?: UsernameStorage;
  /** Optional. When provided, server registration also: (a) sets the
   *  routing target if the user has registered an RCK for this subdomain,
   *  (b) makes sure the account's wildcard A/AAAA (and CAA) exist. */
  routing?: RoutingStorage;
  /** The account-wildcard DNS (A/AAAA + CAA) published at registration; see
   *  `accountDns.ts` for what it writes and `AccountDnsDeps.caa` for CAA. */
  dns?: AccountDnsDeps;
  /** N0d-2: when all three are provided, a successful new-server
   *  registration fans a category-only ("server-registered"),
   *  empty-payload push out to the user's device family so they
   *  reconcile their server list (the phone owns install policy; .com
   *  only nudges). At-most-once per server via installPolicyFanout.
   *  Entirely best-effort — a push failure never fails registration. */
  pushTokens?: PushTokenStorage;
  installPolicyFanout?: InstallPolicyFanoutStorage;
  /** Optional. When provided, a successful FIRST registration appends a
   *  `server-created` row to the account audit feed so the Activity tab
   *  shows the box's lifecycle (created → online). Best-effort: an audit
   *  failure never fails registration. The auth-code is consumed above, so
   *  this point is reached at most once per server. */
  auditEvents?: AuditEventStorage;
  forwardToProviders?: (args: {
    targets: Array<{ tokenId: string; platform: "apns" | "fcm" | "webpush"; providerToken: string }>;
    category: string;
    sealedPayloadHex: string;
    /** Web Push body; the others see the category only. */
    webpushPayloadBytes?: Uint8Array;
  }) => Promise<{ ok: boolean; sent: number; failed: number }>;
  /**
   * The data-plane apex these server names live under — `flagship.services`
   * in prod, `gym.flagship.services` in the test env (docs/ui-test-gym.md
   * §6.5). Used to derive the user-zone CAA anchor. Defaults to the prod
   * literal so prod behavior is byte-identical.
   */
  apex?: string;
  maxAgeMs?: number;
  now?: () => number;
}

interface RegisterBody {
  request?: {
    authCode?: {
      version?: number;
      serial?: string;
      username?: string;
      serverName?: string;
      serverDomain?: string;
      delegatedPubKey?: string;
      userPubKey?: string;
      issuedAt?: number;
      expiresAt?: number;
      /**
       * Slice D (docs/device-admin-tier-spec.md §D-1) — the account's pinned
       * ADMIN MASTER ROOT pubkey (hex). Part of the AuthCode's SIGNED canonical
       * bytes, so it MUST be reconstructed here or a client-signed AuthCode that
       * carries it fails signature re-verification. Optional + backward-
       * compatible: absent ⇒ byte-identical bytes (legacy AuthCodes verify).
       */
      adminRootPubKey?: string;
    };
    authCodeUserSignature?: string;
    serverIdentityPubKey?: string;
    issuedAt?: number;
    nonce?: string;
  };
  signature?: string;
}

export async function handleServerRegister(
  deps: ServerRegisterDeps,
  body: RegisterBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;

  const r = body?.request;
  if (
    !r ||
    !r.authCode ||
    typeof r.authCodeUserSignature !== "string" ||
    !HEX128.test(r.authCodeUserSignature) ||
    typeof r.serverIdentityPubKey !== "string" ||
    !HEX64.test(r.serverIdentityPubKey) ||
    typeof r.issuedAt !== "number" ||
    typeof r.nonce !== "string" ||
    !NONCE_HEX.test(r.nonce) ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const ac = r.authCode;
  if (
    ac.version !== 1 ||
    typeof ac.serial !== "string" ||
    !SERIAL_RE.test(ac.serial) ||
    typeof ac.username !== "string" ||
    typeof ac.serverName !== "string" ||
    typeof ac.serverDomain !== "string" ||
    typeof ac.delegatedPubKey !== "string" ||
    !HEX64.test(ac.delegatedPubKey) ||
    typeof ac.userPubKey !== "string" ||
    !HEX64.test(ac.userPubKey) ||
    typeof ac.issuedAt !== "number" ||
    typeof ac.expiresAt !== "number" ||
    (ac.adminRootPubKey !== undefined &&
      (typeof ac.adminRootPubKey !== "string" || !HEX64.test(ac.adminRootPubKey)))
  ) {
    return malformed("malformed authCode");
  }

  const authCode: AuthCode = {
    version: 1,
    serial: ac.serial,
    username: ac.username,
    serverName: ac.serverName,
    serverDomain: ac.serverDomain,
    delegatedPubKey: hexToBytes(ac.delegatedPubKey),
    userPubKey: hexToBytes(ac.userPubKey),
    issuedAt: ac.issuedAt,
    expiresAt: ac.expiresAt,
    // Slice D — reconstruct the signed admin master root so the AuthCode's
    // canonical bytes (and thus the signature re-verification below) match what
    // the phone signed. Absent ⇒ byte-identical to a legacy AuthCode.
    ...(ac.adminRootPubKey ? { adminRootPubKey: hexToBytes(ac.adminRootPubKey) } : {}),
  };
  const userSig = hexToBytes(r.authCodeUserSignature);
  if (!verifyAuthCode(authCode, userSig, authCode.userPubKey)) {
    return forbidden("invalid auth-code signature");
  }
  if (now > authCode.expiresAt) return forbidden("auth-code expired");
  // Anti-spam cap — the phone's TTL picker tops out at 24h; reject
  // anything longer regardless of what the signed envelope says.
  // Defense-in-depth: an outdated client could try to set arbitrarily
  // long expiries; .com enforces the ceiling unilaterally.
  const RECIPE_TTL_MAX_MS = 24 * 60 * 60_000;
  if (authCode.expiresAt - authCode.issuedAt > RECIPE_TTL_MAX_MS) {
    return forbidden("auth-code TTL exceeds the 24h server cap");
  }

  const identityPub = hexToBytes(r.serverIdentityPubKey);
  const nonce = hexToBytes(r.nonce);
  const sigBytes = hexToBytes(body.signature);
  const reqObj: ServerRegisterRequest = {
    authCode,
    authCodeUserSignature: userSig,
    serverIdentityPubKey: identityPub,
    issuedAt: r.issuedAt,
    nonce,
  };
  if (!verifyServerRegister(reqObj, sigBytes, identityPub)) {
    return forbidden("invalid server-identity signature");
  }
  const age = now - r.issuedAt;
  if (age > maxAgeMs || age < -60_000) return forbidden("stale registration");

  const useResult = await validateAndUseAuthCode(deps.authCodes, authCode.serial, now);
  if (!useResult.ok) {
    return useResult.reason === "unknown serial"
      ? notFound(useResult.reason)
      : conflict(useResult.reason);
  }
  if (useResult.code.serverDomain !== authCode.serverDomain) {
    return malformed("auth-code/registration serverDomain mismatch");
  }
  // The box pins the admin root and IRK from the AuthCode it presents, so it
  // must be the very AuthCode `.com` admitted at issue (where an admin device
  // approved it), not a re-signed variant under the same serial.
  if (!equalBytes(authCodeCanonicalBytes(useResult.code), authCodeCanonicalBytes(authCode))) {
    return forbidden("auth-code does not match the one issued");
  }
  // Adding a server is admin-only (owner rule 2026-10-16): the admin root the
  // AuthCode pins must still be the account's (a root rotated since issue, or
  // a code from before the rule pinning another root, no longer registers).
  // A demo account is the operator's and keeps its old path.
  if (deps.usernames) {
    const owner = await deps.usernames.get(authCode.username);
    const pinned = owner?.adminRootPubHex?.toLowerCase();
    const codeRoot = useResult.code.adminRootPubKey ? bytesToHex(useResult.code.adminRootPubKey) : undefined;
    if (owner && !owner.isDemo && (!pinned || codeRoot !== pinned)) {
      return addServerRefused();
    }
  }

  await deps.servers.put({
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    identityPubKeyHex: bytesToHex(identityPub),
    registeredAt: now,
  });

  // Activity feed: record the box's birth on the account audit log. The
  // auth-code was just consumed, so this fires exactly once per server.
  // Best-effort — an audit insert must never fail an otherwise-good
  // registration (the feed is informational, registration is load-bearing).
  if (deps.auditEvents) {
    try {
      await deps.auditEvents.append({
        username: authCode.username,
        eventKind: "server-created",
        detail: authCode.serverName || authCode.serverDomain,
        devicePrefix: "",
        postedAt: now,
      });
    } catch {
      // swallow — never break registration on an audit write
    }
  }

  // N0d-2: nudge the user's device family to reconcile their server
  // list. Empty-payload / category-only — .com never sees content
  // (the privacy invariant; mirrors the webapp empty-push model).
  // At-most-once via recordOnce (registration is one-shot, but a
  // double-submit must not double-notify). Fully best-effort: any
  // failure here must not fail an otherwise-good registration.
  if (deps.pushTokens && deps.installPolicyFanout) {
    try {
      const tokens = await deps.pushTokens.listByUser(authCode.username);
      const firstTime = await deps.installPolicyFanout.recordOnce({
        serverDomain: authCode.serverDomain,
        username: authCode.username,
        registeredAt: now,
        fanoutCount: tokens.length,
        notifiedAt: now,
      });
      if (firstTime && tokens.length > 0 && deps.forwardToProviders) {
        await deps.forwardToProviders({
          targets: tokens.map((t) => ({
            tokenId: t.tokenId,
            platform: t.platform,
            providerToken: t.providerToken,
          })),
          category: "server-registered",
          sealedPayloadHex: "",
          webpushPayloadBytes: new TextEncoder().encode(JSON.stringify({ category: "server-registered" })),
        });
      }
    } catch {
      // best-effort — swallow; the device family also reconciles via
      // the servers list + ETag on next foreground.
    }
  }

  // If RCK is registered for this subdomain, point routing at this
  // server identity. Failover/migration via SetRoutingTarget can later
  // override.
  if (deps.routing) {
    await setRoutingTargetFromRegistration(
      deps.routing,
      authCode.serverDomain,
      bytesToHex(identityPub),
      now,
    );
  }

  // DNS: one wildcard per ACCOUNT (docs/wildcard-dns.md). `*.<user>` A/AAAA
  // makes every name under the account resolve to the .services SNI
  // passthrough: this box (`<server>.<user>`), everything under it
  // (`<service>.<server>.<user>`, which closest-encloser synthesis answers
  // from the same record) and the tier-2 leader-routed `<svc>.<user>` names.
  // Nothing is published per box any more. The records are idempotent (a
  // second box of the account, or a registration that follows the auth-code
  // issue which already created them, is a no-op) and are removed with the
  // account's last server. CAA stays at the user zone: RFC 8659 tree-climbing
  // makes the one pair at `<user>` cover every name below it. PHASE-1 only —
  // no accounturi pinning yet (see caaPublish.ts / caaPin.ts TODO).
  // Best-effort: a DNS or CAA failure must never fail registration.
  //
  // CAA needs a CAA-capable client. The production `BrokerDnsClient` exposes
  // A/AAAA + ACME-TXT only and does NOT carry CAA — so the Worker wires its
  // CAA-capable `CloudflareDnsClient` here explicitly. When no `caa.client`
  // is configured we skip (no silent broker-throw).
  // TODO(broker-caa): teach the dns-broker a `publishCaa` RPC so production
  // can publish CAA through the broker's pinned credentials too, then default
  // `caa.client` to `deps.dns.client`.
  let dnsPublished: { type: string; name: string; content: string }[] = [];
  let dnsError: string | undefined;
  let caaPublished: { name: string; rdata: string }[] = [];
  let caaError: string | undefined;
  if (deps.dns) {
    const userZone = userZoneOf(authCode.serverDomain, deps.apex ?? "flagship.services");
    if (userZone) {
      const r2 = await ensureAccountDns(deps.dns, userZone);
      dnsPublished = r2.dnsPublished;
      dnsError = r2.dnsError;
      caaPublished = r2.caaPublished;
      caaError = r2.caaError;
    }
  }

  return ok({
    ok: true,
    serverDomain: authCode.serverDomain,
    registeredAt: now,
    dnsPublished,
    dnsError,
    caaPublished,
    caaError,
  });
}

export async function handleServerLookup(
  deps: ServerRegisterDeps,
  serverDomain: string,
): Promise<HandlerResponseWithHeaders> {
  const reg = await deps.servers.get(serverDomain);
  if (!reg) return notFound("unknown server");
  return ok({
    serverDomain: reg.serverDomain,
    username: reg.username,
    identityPubKey: reg.identityPubKeyHex,
    registeredAt: reg.registeredAt,
    // Public, so it says only that and when a server was revoked: why
    // (lost, stolen, deleted) is the owner's business.
    revoked: reg.revokedAt ? { at: reg.revokedAt } : null,
  });
}
