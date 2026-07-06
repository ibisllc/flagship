import {
  verifyAuthCode,
  verifyServerRegister,
  type AuthCode,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  AuthCodeStorage,
  BoxSerialsStorage,
  InstallPolicyFanoutStorage,
  PushTokenStorage,
  RoutingStorage,
  ServerStorage,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes, bytesToHex } from "./hex.js";
import { SERIAL_RE, validateAndUseAuthCode } from "./authCode.js";
import { publishUserZoneCaa, type CaaUpsertClient } from "./caaPublish.js";
import type { CaRestrictionCaaOptions } from "@flagship/services-zone";
import { enforceActivated } from "./serialActivation.js";
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
  }) => Promise<{ ok: boolean; sent: number; failed: number }>;
  /**
   * N-CLOUD-2: branded box hardware-serial enforcement. When provided,
   * a registration that carries a top-level `boxSerial` is checked
   * against the box_serials table via `enforceActivated` BEFORE the
   * auth-code is consumed, so a failed check is retriable. When omitted,
   * the handler fails-closed for any registration claiming a boxSerial
   * — we'd rather 403 a misconfigured prod than silently accept a
   * branded-box claim no one verified. Self-built / Debian / Alpine
   * boxes (which never include boxSerial) pass through unchanged
   * either way.
   */
  boxSerials?: BoxSerialsStorage;
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
  /**
   * N-CLOUD-2: optional box hardware serial. Pre-allocated at
   * manufacture time, retailer-HMAC-activated via /api/serial/activate.
   * Branded retail boxes include it here; self-built boxes omit it.
   *
   * Carried unsigned at the top level in v1 so a future promotion into
   * the signed `request` envelope can change the canonical bytes
   * backward-compatibly. Integrity of the bind comes from `bindStk`'s
   * atomic first-claim semantic — the serial gets nailed to the
   * server's Ed25519 identity on first registration; subsequent
   * registrations with the same identity are idempotent rebinds, and a
   * different identity claiming the same serial is rejected.
   */
  boxSerial?: string;
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

  // N-CLOUD-2: branded box hardware-serial enforcement. Runs BEFORE
  // auth-code consumption so a failed serial check leaves the recipe
  // usable for a retry with the right box. Self-built / Debian / Alpine
  // boxes never include `boxSerial` and skip this block entirely.
  if (body.boxSerial !== undefined) {
    if (typeof body.boxSerial !== "string" || body.boxSerial.length === 0) {
      return malformed("malformed boxSerial");
    }
    if (!deps.boxSerials) {
      // Fail-closed: a branded-box claim landing at a server with no
      // box_serials storage configured shouldn't silently slip through.
      return forbidden("box serial enforcement not configured");
    }
    const identityHex = bytesToHex(identityPub);
    const bind = await enforceActivated(
      { serials: deps.boxSerials },
      {
        serial: body.boxSerial,
        stkPubHex: identityHex,
        suffix6: identityHex.slice(-6),
        at: now,
      },
    );
    if (!bind.ok) {
      // Translate storage-layer reasons to the registration-handler
      // vocabulary so the daemon error surface reads cleanly.
      const reason =
        bind.reason === "unknown serial"
          ? "unknown box serial"
          : bind.reason === "not activated"
            ? "box serial not activated"
            : bind.reason === "already bound"
              ? "box serial already bound to a different server identity"
              : `box serial check failed: ${bind.reason}`;
      return forbidden(reason);
    }
  }

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

  // Publish A/AAAA so the box's URLs resolve to the .services SNI
  // passthrough. PER-BOX DNS (cert model A′): TWO names per registration,
  // both scoped to THIS box (idempotent — DNS upsert is a no-op when the
  // record already exists with the right content):
  //   - <server>.<user>.flagship.services    (box apex — the canonical name)
  //   - *.<server>.<user>.flagship.services  (every service under the box:
  //                                           <service>.<server>.<user>)
  // These are exactly the SANs of the box's per-box wildcard cert, so each
  // registration publishes a distinct pair — no shared user-zone records
  // (the model-C user-zone pair is gone with the per-user wildcard cert).
  // Best-effort: a DNS failure shouldn't fail registration.
  let dnsPublished: { type: string; name: string; content: string }[] = [];
  let dnsError: string | undefined;
  let caaPublished: { name: string; rdata: string }[] = [];
  let caaError: string | undefined;
  if (deps.dns) {
    const podApex = authCode.serverDomain;
    const userZone = userZoneOf(podApex, deps.apex ?? "flagship.services");
    // PER-USER wildcard for TIER-2 leader-routed service names: a tier-2
    // canonical `<svc>.<user>.<apex>` is hardware-agnostic (no per-box wildcard
    // covers it — `*.<server>.<user>` only covers `<x>.<server>.<user>`). It
    // must resolve to the same `.services` SNI-passthrough hub IP so the hub can
    // route it to whichever box currently holds the `<svc>.<user>` leader slot.
    // One idempotent `*.<user>.<apex>` A/AAAA per user does that for EVERY tier-2
    // name under the user (RFC 1034 wildcard). The CAA at the user zone already
    // covers it (tree-climb). A second box under the same user re-asserts the
    // same record (no-op). The cert for each `<svc>.<user>` is still minted
    // box-local under phone authority (Phase 5) — this is purely the A-record so
    // the name resolves; routing + TLS are gated separately by the hub + cert.
    const names = [podApex, `*.${podApex}`];
    if (userZone) names.push(`*.${userZone}`);
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
    // restrict cert issuance for the user's names to Let's Encrypt. Certs are
    // PER-BOX (A′), but CAA stays at the USER zone — locked decision: RFC 8659
    // §3 tree-climbing means a CAA record at `<user>.flagship.services` covers
    // every name below it (`<server>.<user>` box apexes, `*.<server>.<user>`
    // wildcards, `<service>.<user>` shared-service names), so one user-zone
    // record set restricts issuance for ALL per-box and service certs and
    // per-box CAA would be redundant churn. Published once per user; each
    // record is idempotent (keyed by its exact rdata), so a re-register / a
    // second pod under the user is a no-op. PHASE-1 only — no accounturi
    // pinning yet (see caaPublish.ts / caaPin.ts TODO). Best-effort: a CAA
    // failure must never fail registration.
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
 * For a podApex of the form `<server>.<user>.<apex>`, return the user zone
 * `<user>.<apex>` (the CAA record-set anchor — A/AAAA publishing is
 * per-box). Parses apex-RELATIVE: strip the configured apex suffix, then
 * the user is the LAST remaining label — so a deeper apex like
 * `gym.flagship.services` resolves `home.alice.gym.flagship.services` to
 * `alice.gym.flagship.services`, not the wrong label. `apex` defaults to
 * the prod literal. Returns null on shape mismatch.
 */
function userZoneOf(podApex: string, apex = "flagship.services"): string | null {
  const lower = podApex.toLowerCase();
  const suffix = `.${apex}`;
  if (!lower.endsWith(suffix)) return null;
  const head = lower.slice(0, -suffix.length);
  const parts = head.split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(user)) return null;
  return `${user}.${apex}`;
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
