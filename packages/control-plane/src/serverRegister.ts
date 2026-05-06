import {
  verifyAuthCode,
  verifyServerRegister,
  type AuthCode,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import type { AuthCodeStorage, RoutingStorage, ServerStorage } from "@flagship/storage";
import { HEX64, HEX128, hexToBytes, bytesToHex } from "./hex.js";
import { SERIAL_RE, validateAndUseAuthCode } from "./authCode.js";
import { CloudflareDnsClient } from "./cloudflareDns.js";
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
    client: CloudflareDnsClient;
    /** IPv4 address of .services SNI passthrough listener. */
    servicesIpv4: string;
    /** IPv6 address (optional). */
    servicesIpv6?: string;
  };
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

  // Publish A/AAAA so the subdomain resolves to the .services SNI
  // passthrough IP — both for the apex `<server>.<user>.<apex>` and for
  // `*.<server>.<user>.<apex>` so app subdomains (which the daemon's
  // wildcard cert covers) are reachable. Best-effort: a DNS failure
  // shouldn't fail registration.
  let dnsPublished: { type: string; name: string; content: string }[] = [];
  let dnsError: string | undefined;
  if (deps.dns) {
    const apex = authCode.serverDomain;
    const wildcard = `*.${apex}`;
    try {
      for (const name of [apex, wildcard]) {
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
  }

  return ok({
    ok: true,
    serverDomain: authCode.serverDomain,
    registeredAt: now,
    dnsPublished,
    dnsError,
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
    revoked: reg.revokedAt
      ? { reason: reg.revocationReason ?? "lost", at: reg.revokedAt }
      : null,
  });
}
