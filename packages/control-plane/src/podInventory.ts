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

import {
  verifyDaemonStatusReport,
  type DaemonStatusReport,
} from "@flagship/protocol";
import { sha256 } from "@noble/hashes/sha256";
import type {
  DaemonStatusStorage,
  ServerStorage,
  RoutingStorage,
  AuthCodeStorage,
  ProvisionStatusStorage,
} from "@flagship/storage";
import { HEX64, HEX128, bytesToHex, hexToBytes } from "./hex.js";
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
  /** #56 — outstanding (active, unexpired) install orders, surfaced in the
   *  same UNAUTHENTICATED list so a just-created, not-yet-registered server
   *  no longer rides the fragile biometric-IRK `outstanding-orders` path. */
  authCodes?: AuthCodeStorage;
  /** Latest provisioning phase per order (joined by serial). Each lookup is
   *  individually guarded so a `provision_status` failure can never empty or
   *  500 the authoritative list. */
  provisionStatus?: ProvisionStatusStorage;
  now?: () => number;
}

/**
 * Deterministic opaque reference for an install order, safe for the
 * UNAUTHENTICATED `/pods` list. The auth-code `serial` is a capability
 * (anyone who knows username+serial can POST fake provision phases to
 * `/api/order/<serial>/status` + `/api/install-events/<serial>`), so the
 * raw serial must never ride an unauthenticated response. A client that
 * minted the order knows the real serial and computes the same ref locally
 * to reconcile; deep-progress polling keeps using the LOCALLY-stored serial.
 */
export function orderRefForSerial(serial: string): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(`flagship/order-ref/v1|${serial}`)),
  );
}

/** A still-in-flight install order, shaped for the merged `/pods` list. */
export interface PendingPodEntry {
  /** `hex(sha256("flagship/order-ref/v1|" + serial))` — opaque order ref.
   *  NEVER the raw auth-code serial (that's a provision-status write
   *  capability and this list is unauthenticated). */
  orderRef: string;
  serverName: string;
  /** `<serverName>.<username>.flagship.services` — the reserved FQDN, identical
   *  whether or not the box has registered yet. */
  fqdn: string;
  /** Latest reported provisioning phase, or null on any lookup failure / when
   *  no provision-status storage is wired. */
  phase: string | null;
  createdAt: number;
  state: "pending";
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

  const now = (deps.now ?? (() => Date.now()))();

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
      // #56 liveness bridge — a genuinely-live, serving box does NOT populate
      // daemon_status (the daemon never POSTs the daemon-status report), so a
      // registered server whose install order reached phase "live" would
      // otherwise be wrongly shown as "never came online" (lastReported null).
      // When there's no daemon_status row, fall back to the provision-status
      // signal: join domain → latest auth-code serial (used-inclusive, since a
      // registered server's code is `used`) → provision_status(serial).phase;
      // if "live", treat the box as having come online by setting lastReported
      // to the provision-status updatedAt. Every lookup is guarded so a failure
      // NEVER drops a server or fails the list. Only runs when daemon_status is
      // absent — adds up to 2 extra queries per daemon_status-less server
      // (fine for small N; remove once daemons POST real heartbeats).
      let lastReported = status?.lastReported ?? null;
      if (!status && deps.authCodes && deps.provisionStatus) {
        try {
          const code = await deps.authCodes.latestByServerDomain(s.serverDomain);
          if (code) {
            const ps = await deps.provisionStatus.getProvisionStatus(code.serial);
            if (ps?.phase === "live") {
              lastReported = ps.updatedAt ?? now;
            }
          }
        } catch {
          /* enrichment failure must never drop the server */
        }
      }
      // Cert-fingerprint pinning (A′ phase 4a) — relay the VERBATIM
      // STK-signed report + signature so a client that derived the box STK
      // locally re-verifies the fingerprint end-to-end (a rogue .com can
      // drop it but not forge it). Parse is guarded: a corrupt row degrades
      // to null, never fails the list.
      let signedStatus: { report: unknown; signatureHex: string } | null = null;
      if (status?.reportJson && status.signatureHex) {
        try {
          signedStatus = {
            report: JSON.parse(status.reportJson) as unknown,
            signatureHex: status.signatureHex,
          };
        } catch {
          signedStatus = null;
        }
      }
      return {
        serverDomain: s.serverDomain,
        identityPubKey: s.identityPubKeyHex,
        registeredAt: s.registeredAt,
        revokedAt: s.revokedAt ?? null,
        routingTarget: routing?.currentTargetHex ?? null,
        lastReported,
        currentCert: status
          ? {
              sha256: status.certSha256,
              validUntil: status.certValidUntil,
              issuer: status.certIssuer,
            }
          : null,
        signedStatus,
        appsServed,
        // #56 — registered servers are always online; lets the unified client
        // reconciler key on `state` without a second authenticated fetch.
        state: "online" as const,
      };
    }),
  );

  // #56 — outstanding install orders, merged into the same unauthenticated
  // list. The per-order phase enrichment is individually try/catch-guarded:
  // a provision_status failure yields `phase: null` and NEVER drops the order
  // or fails the whole list (this list is the phone's authoritative reconciler
  // source — it must not be silently emptied by an enrichment hiccup).
  let pending: PendingPodEntry[] = [];
  if (deps.authCodes) {
    try {
      const codes = await deps.authCodes.listOutstandingByUsername(username, now);
      pending = await Promise.all(
        codes.map(async (c) => {
          let phase: string | null = null;
          if (deps.provisionStatus) {
            try {
              const ps = await deps.provisionStatus.getProvisionStatus(c.serial);
              phase = ps?.phase ?? null;
            } catch {
              phase = null;
            }
          }
          return {
            orderRef: orderRefForSerial(c.serial),
            serverName: c.serverName,
            fqdn: c.serverDomain,
            phase,
            createdAt: c.recordedAt,
            state: "pending" as const,
          };
        }),
      );
      // Newest first — the phone surfaces the freshest in-flight install on top.
      pending.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      // A failure to list outstanding orders must not break the registered
      // inventory; degrade to an empty pending list.
      pending = [];
    }
  }

  return ok({ username, pods, pending, fetchedAt: now });
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
 * Daemon reports its cert state. The signature is over the canonical
 * daemon-status bytes (@flagship/protocol `canonicalDaemonStatusReport`),
 * using the pod's identity (STK) pubkey registered at /api/server/register.
 *
 * Cert-fingerprint pinning (A′ phase 4a): besides the parsed fields, the
 * VERBATIM signed tuple + signature are persisted so /pods can relay the
 * raw report for client-side re-verification under the locally-derived STK
 * — .com relays the fingerprint but cannot forge it.
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
  if (r.certValidUntil !== null && r.certValidUntil !== undefined &&
      typeof r.certValidUntil !== "number") {
    return malformed("certValidUntil must be a number");
  }
  if (r.certIssuer !== null && r.certIssuer !== undefined &&
      typeof r.certIssuer !== "string") {
    return malformed("certIssuer must be a string");
  }
  if (r.appsServed !== undefined &&
      (!Array.isArray(r.appsServed) ||
        r.appsServed.some((x) => typeof x !== "string"))) {
    return malformed("appsServed must be a string array");
  }
  const server = await deps.servers.get(r.serverDomain);
  if (!server) return forbidden("unknown serverDomain");
  if (server.revokedAt) return forbidden("server revoked");

  // The exact signed tuple, normalized only in the ways the canonical bytes
  // already erase (absent optional → null encodes identically to null).
  // This object — not a re-derivation — is what gets stored and relayed.
  const report: DaemonStatusReport = {
    serverDomain: r.serverDomain,
    certSha256: r.certSha256 ?? null,
    certValidUntil: r.certValidUntil ?? null,
    certIssuer: r.certIssuer ?? null,
    appsServed: r.appsServed ?? [],
    nonce: r.nonce,
    issuedAt: r.issuedAt,
  };

  // Verify against the registered identity key. We use the pubkey straight
  // from the servers table; the daemon's HELLO flow is what guarantees that
  // pubkey actually corresponds to the running pod.
  const sig = hexToBytes(body.signature);
  const stkPub = hexToBytes(server.identityPubKeyHex);
  if (!verifyDaemonStatusReport(report, sig, stkPub)) {
    return forbidden("invalid signature");
  }

  await deps.daemonStatus.put({
    serverDomain: r.serverDomain.toLowerCase(),
    certSha256: report.certSha256,
    certValidUntil: report.certValidUntil,
    certIssuer: report.certIssuer,
    servicesServedJson: JSON.stringify(report.appsServed),
    lastReported: (deps.now ?? (() => Date.now()))(),
    reportJson: JSON.stringify(report),
    signatureHex: body.signature,
  });
  return ok({ ok: true });
}
