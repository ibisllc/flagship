import {
  verifyAuthCode,
  verifyServerRegister,
  type AuthCode,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import type {
  AuthCodeStorage,
  InstallPolicyFanoutStorage,
  PushTokenStorage,
  RoutingStorage,
  ServerStorage,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes, bytesToHex } from "./hex.js";
import { SERIAL_RE, validateAndUseAuthCode } from "./authCode.js";
import { publishUserZoneCaa, type CaaUpsertClient } from "./caaPublish.js";
import type { CaRestrictionCaaOptions } from "@flagship/services-zone";
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
  /** Optional. When provided, server registration also: (a) sets the
   *  routing target if the user has registered an RCK for this subdomain,
   *  (b) publishes A/AAAA records pointing the subdomain at the
   *  flagship.services anycast IP. */
  routing?: RoutingStorage;
  dns?: {
    client: DnsUpsertClient;
    /** IPv4 address of .services SNI passthrough listener. */
    servicesIpv4: string;
    /** IPv6 address (optional). */
    servicesIpv6?: string;
    /**
     * When the DNS client also supports CAA (`type:"CAA"` with a structured
     * `data` field — the `CloudflareDnsClient` does), the user-zone CAA
     * CA-restriction records are published alongside the A/AAAA records, once
     * per user. Defaults to the same `client`. Best-effort: a CAA failure
     * never fails registration. See `caaPublish.ts` for scope (PHASE-1
     * CA-restriction only; PHASE-2 accounturi pinning is a TODO).
     */
    caa?: {
      client: CaaUpsertClient;
      /** Override the CA domain / iodef. Defaults to LE + security@. */
      options?: CaRestrictionCaaOptions;
    };
  };
  /** N0d-2: when all three are provided, a successful new-server
   *  registration fans a category-only ("server-registered"),
   *  empty-payload push out to the user's device family so they
   *  reconcile their server list (the phone owns install policy; .com
   *  only nudges). At-most-once per server via installPolicyFanout.
   *  Entirely best-effort — a push failure never fails registration. */
  pushTokens?: PushTokenStorage;
  installPolicyFanout?: InstallPolicyFanoutStorage;
  forwardToProviders?: (args: {
    targets: Array<{ tokenId: string; platform: "apns" | "fcm" | "webpush"; providerToken: string }>;
    category: string;
    sealedPayloadHex: string;
  }) => Promise<{ ok: boolean; sent: number; failed: number }>;
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
    typeof ac.expiresAt !== "number"
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

  await deps.servers.put({
    serverDomain: authCode.serverDomain,
    username: authCode.username,
    identityPubKeyHex: bytesToHex(identityPub),
    registeredAt: now,
  });

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

  // Publish A/AAAA so the user's URLs resolve to the .services SNI
  // passthrough. PER-USER DNS (task #23): TWO names per registration — the
  // user zone only (idempotent — DNS upsert is a no-op when the record
  // already exists with the right content):
  //   - <user>.flagship.services             (apex of the user zone)
  //   - *.<user>.flagship.services           (every one-label-deep public
  //                                           name: the pod label
  //                                           <server>.<user>, app labels
  //                                           <label>.<user>, device labels)
  // The deprecated per-server pair (<server>.<user> + *.<server>.<user>) is
  // dropped — the pod apex resolves via the `*.<user>` wildcard. Degenerate
  // FQDNs that don't parse as <server>.<user> fall back to the pod apex.
  // Best-effort: a DNS failure shouldn't fail registration.
  let dnsPublished: { type: string; name: string; content: string }[] = [];
  let dnsError: string | undefined;
  let caaPublished: { name: string; rdata: string }[] = [];
  let caaError: string | undefined;
  if (deps.dns) {
    const podApex = authCode.serverDomain;
    const userZone = userZoneOf(podApex);
    const names = userZone ? [userZone, `*.${userZone}`] : [podApex, `*.${podApex}`];
    try {
      for (const name of names) {
        const a = await deps.dns.client.upsert({
          name,
          type: "A",
          content: deps.dns.servicesIpv4,
        });
        dnsPublished.push({ type: "A", name, content: a.content });
        if (deps.dns.servicesIpv6) {
          const aaaa = await deps.dns.client.upsert({
            name,
            type: "AAAA",
            content: deps.dns.servicesIpv6,
          });
          dnsPublished.push({ type: "AAAA", name, content: aaaa.content });
        }
      }
    } catch (e) {
      dnsError = String((e as Error).message ?? e);
    }

    // CAA CA-restriction (defense-in-depth against EXTERNAL mis-issuance):
    // restrict cert issuance for `<user>.flagship.services` + its wildcard to
    // Let's Encrypt. Published once per user, keyed on the user zone (NOT the
    // pod). Each record is idempotent (keyed by its exact rdata), so a
    // re-register / a second pod under the user is a no-op. PHASE-1 only — no
    // accounturi pinning yet (see caaPublish.ts / caaPin.ts TODO). Best-effort:
    // a CAA failure must never fail registration.
    //
    // Requires a CAA-capable client. The production `BrokerDnsClient` exposes
    // A/AAAA + ACME-TXT only and does NOT carry CAA — so the Worker wires its
    // CAA-capable `CloudflareDnsClient` here explicitly. When no `caa.client`
    // is configured we skip (no silent broker-throw).
    // TODO(broker-caa): teach the dns-broker a `publishCaa` RPC so production
    // can publish CAA through the broker's pinned credentials too, then default
    // `caa.client` to `deps.dns.client`.
    const caaClient: CaaUpsertClient | undefined = deps.dns.caa?.client;
    if (userZone && caaClient) {
      try {
        caaPublished = await publishUserZoneCaa({
          client: caaClient,
          userZone,
          options: deps.dns.caa?.options,
        });
      } catch (e) {
        caaError = String((e as Error).message ?? e);
      }
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

/**
 * For a podApex of the form `<server>.<user>.flagship.services`, return
 * the user zone `<user>.flagship.services`. Returns null on shape
 * mismatch.
 */
function userZoneOf(podApex: string): string | null {
  const lower = podApex.toLowerCase();
  if (!lower.endsWith(".flagship.services")) return null;
  const head = lower.slice(0, -".flagship.services".length);
  const parts = head.split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9]{3,30}$/.test(user)) return null;
  return `${user}.flagship.services`;
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
    revoked: reg.revokedAt
      ? { reason: reg.revocationReason ?? "lost", at: reg.revokedAt }
      : null,
  });
}
