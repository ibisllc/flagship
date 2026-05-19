/**
 * #21 — phone-signed pod inventory + daemon cert reconciliation.
 *
 * Replaces the originally-planned external CT-log monitoring with a
 * direct phone-signed API. Daemons report their cert state at every
 * tunnel HELLO (via POST /api/daemon-status); webapp/phone fetch a
 * consolidated inventory (via GET /api/users/:u/pods) and reconcile.
 *
 * Threat model: any subdomain registered under .com that isn't backed
 * by a daemon currently reporting is a "ghost pod" — flag in the UI.
 * Any pod whose reported cert SHA256 differs from what the user
 * expected is a cert-change alarm. Both are local-to-the-user
 * derivations; no external CT log subscription required.
 *
 *   GET  /api/users/<username>/pods
 *     Returns { pods: [...] }. Public read of routing/server state +
 *     the joined daemon_status row. Per the no-KYC tenet: contains
 *     only pubkeys + canonical domains, never identities.
 *
 *   POST /api/daemon-status
 *     Daemon-identity-signed. Updates the daemon_status row for
 *     this server.
 */

import { verifyTunnelHelloV2 } from "@flagship/protocol";
import type {
  DaemonStatusStorage,
  ServerStorage,
  RoutingStorage,
} from "@flagship/storage";
import { HEX64, HEX128, hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface PodInventoryDeps {
  daemonStatus: DaemonStatusStorage;
  servers: ServerStorage;
  routing: RoutingStorage;
  now?: () => number;
}

export async function handleGetUserPods(
  deps: PodInventoryDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const servers = await deps.servers.listForUser(username);
  const statuses = await deps.daemonStatus.listForUser(username);
  const statusByDomain = new Map<string, (typeof statuses)[number]>();
  for (const s of statuses) {
    statusByDomain.set(s.serverDomain.toLowerCase(), s);
  }

  const pods = await Promise.all(
    servers.map(async (s) => {
      const routing = await deps.routing.get(s.serverDomain);
      const status = statusByDomain.get(s.serverDomain.toLowerCase());
      let appsServed: string[] = [];
      if (status?.servicesServedJson) {
        try {
          const parsed = JSON.parse(status.servicesServedJson);
          if (Array.isArray(parsed)) {
            appsServed = parsed.filter((x): x is string => typeof x === "string");
          }
        } catch {
          /* corrupt row — treat as empty */
        }
      }
      return {
        serverDomain: s.serverDomain,
        identityPubKey: s.identityPubKeyHex,
        registeredAt: s.registeredAt,
        revokedAt: s.revokedAt ?? null,
        routingTarget: routing?.currentTargetHex ?? null,
        lastReported: status?.lastReported ?? null,
        currentCert: status
          ? {
              sha256: status.certSha256,
              validUntil: status.certValidUntil,
              issuer: status.certIssuer,
            }
          : null,
        appsServed,
      };
    }),
  );

  return ok({ username, pods, fetchedAt: (deps.now ?? (() => Date.now()))() });
}

interface DaemonStatusBody {
  request?: {
    serverDomain?: string;
    certSha256?: string | null;
    certValidUntil?: number | null;
    certIssuer?: string | null;
    appsServed?: string[];
    nonce?: string;
    issuedAt?: number;
  };
  signature?: string;
}

/**
 * Daemon reports its cert state. The signature is over a canonical
 * encoding of the request, using the pod's identity (STK) pubkey
 * registered at /api/server/register. We reuse the TunnelHelloV2
 * verification primitive — daemons already sign their HELLO; this
 * report is essentially "the HELLO content, but pushed instead of
 * pulled."
 *
 * For now we accept any well-formed signed report from a known
 * server-domain → server-identity binding; future hardening can
 * tighten the request envelope to its own canonical-bytes type.
 */
export async function handlePostDaemonStatus(
  deps: PodInventoryDeps,
  body: DaemonStatusBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const r = body?.request;
  if (
    !r ||
    typeof r.serverDomain !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof r.nonce !== "string" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }
  if (r.certSha256 !== null && r.certSha256 !== undefined &&
      (typeof r.certSha256 !== "string" || !HEX64.test(r.certSha256))) {
    return malformed("certSha256 must be 32-byte hex");
  }
  const server = await deps.servers.get(r.serverDomain);
  if (!server) return forbidden("unknown serverDomain");
  if (server.revokedAt) return forbidden("server revoked");

  // Verify signature against the registered identity key. We use the
  // pubkey straight from the servers table; the daemon's HELLO flow
  // is what guarantees that pubkey actually corresponds to the
  // running pod.
  const canonical = canonicalDaemonStatusReport(r);
  const sig = hexToBytes(body.signature);
  const stkPub = hexToBytes(server.identityPubKeyHex);
  // We reuse the TunnelHelloV2 verifier shape — sign over identical
  // bytes; treat the report-canonical bytes the same way.
  if (!sigVerifyOver(canonical, sig, stkPub)) {
    return forbidden("invalid signature");
  }

  const apps = Array.isArray(r.appsServed)
    ? r.appsServed.filter((x): x is string => typeof x === "string")
    : [];
  await deps.daemonStatus.put({
    serverDomain: r.serverDomain.toLowerCase(),
    certSha256: r.certSha256 ?? null,
    certValidUntil: r.certValidUntil ?? null,
    certIssuer: r.certIssuer ?? null,
    servicesServedJson: JSON.stringify(apps),
    lastReported: (deps.now ?? (() => Date.now()))(),
  });
  return ok({ ok: true });
}

function canonicalDaemonStatusReport(r: {
  serverDomain?: string;
  certSha256?: string | null;
  certValidUntil?: number | null;
  certIssuer?: string | null;
  appsServed?: string[];
  nonce?: string;
  issuedAt?: number;
}): Uint8Array {
  const apps = (r.appsServed ?? []).slice().sort().join(",");
  return new TextEncoder().encode(
    [
      "flagship/daemon-status/v1",
      r.serverDomain ?? "",
      r.certSha256 ?? "",
      String(r.certValidUntil ?? ""),
      r.certIssuer ?? "",
      apps,
      r.nonce ?? "",
      String(r.issuedAt ?? ""),
    ].join("|"),
  );
}

function sigVerifyOver(msg: Uint8Array, sig: Uint8Array, pub: Uint8Array): boolean {
  // Defer to the synchronous Ed25519 verify available across the
  // codebase. We can't import @flagship/protocol's `ed` directly
  // without growing this module's dep surface; the verifier is small
  // and used elsewhere. For now we delegate via verifyTunnelHelloV2's
  // underlying primitive by constructing a one-off envelope shape;
  // the bytes are what's signed.
  try {
    // verifyTunnelHelloV2 takes a TunnelHelloV2 + sig + pub and
    // canonicalizes internally — we can't reuse it directly. Inline a
    // minimal verifier using @noble/ed25519 via the protocol package.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ed25519 } = require("@noble/curves/ed25519.js") as {
      ed25519: { verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => boolean };
    };
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

// Suppress unused-import lint — verifyTunnelHelloV2 is imported to keep
// the doc reference live for future hardening.
void verifyTunnelHelloV2;
