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
  SecretMailboxStorage,
  SecretMailboxPurpose,
  UsernameStorage,
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
  /** The phone-as-unlock-endpoint mailbox. Used ONLY to derive the cheap,
   *  unauthenticated `pendingRequests` digest (the typed list of approvals a
   *  box has live) so a locked/awaiting box isn't misclassified "never came
   *  online" — the Box Request Inbox detection tier. */
  secretMailbox?: SecretMailboxStorage;
  /**
   * Account-deletion / name-reclaim (migration 0058) — when wired,
   * `handlePostDaemonStatus` coarsely bumps `usernames.last_active` for the
   * owning account after a VERIFIED heartbeat (a live box is the strongest
   * "account in use" signal for the reclaim tool). Coarse: only when the
   * stored value is older than ~1 day, so the 5-minutely heartbeat doesn't
   * hot-write the row. Optional + best-effort: a bump failure never blocks the
   * heartbeat. NOT consulted on the unauthenticated GET /pods read (that's any
   * knower-of-a-username and must not keep a name "active").
   */
  usernames?: UsernameStorage;
  now?: () => number;
}

/** Coarse last_active bump cadence: at most once per day. */
const LAST_ACTIVE_BUMP_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

/**
 * One un-answered box→owner approval request, for the cheap UNAUTHENTICATED
 * `/pods` digest that drives the Box Request Inbox (docs/box-request-inbox.md).
 * This is the detection tier only: `type` is the secret-request purpose; the
 * full signed request + deviceInfo is fetched over the authenticated
 * `/api/secret-requests` path when the owner taps to satisfy it.
 */
export interface PendingRequestSummary {
  /** requestNonceHex — the box's reply is keyed by (serverDomain, this). */
  id: string;
  /** Secret-request purpose: "unlock-key" | "entitlement" | …future types. */
  type: SecretMailboxPurpose;
  /** issuedAt from the signed SecretRequest (ms). */
  issuedAt: number;
  /** Row TTL (ms). */
  expiresAt: number;
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

/** A registered, online pod, shaped for the merged `/pods` list. */
export interface OnlinePodEntry {
  serverDomain: string;
  identityPubKey: string;
  registeredAt: number;
  revokedAt: number | null;
  routingTarget: string | null;
  lastReported: number | null;
  currentCert: { sha256: string | null; validUntil: number | null; issuer: string | null } | null;
  signedStatus: { report: unknown; signatureHex: string } | null;
  appsServed: string[];
  pendingRequests: PendingRequestSummary[];
  state: "online";
}

/** The full pod-inventory projection (the `/pods` payload, sans HTTP wrapper). */
export interface PodInventory {
  username: string;
  pods: OnlinePodEntry[];
  pending: PendingPodEntry[];
  fetchedAt: number;
}

/**
 * Build the consolidated pod inventory for a user. This is the SINGLE source
 * of the `/pods` payload — both `handleGetUserPods` (the unauthenticated GET)
 * and `handleUserStream` (the long-poll) call it, so they never drift. Cheap
 * to re-call in a loop: a handful of indexed storage reads, no external I/O.
 */
export async function buildPodInventory(
  deps: PodInventoryDeps,
  username: string,
): Promise<PodInventory> {
  const servers = await deps.servers.listForUser(username);
  const statuses = await deps.daemonStatus.listForUser(username);
  const statusByDomain = new Map<string, (typeof statuses)[number]>();
  for (const s of statuses) {
    statusByDomain.set(s.serverDomain.toLowerCase(), s);
  }

  const now = (deps.now ?? (() => Date.now()))();

  // Cheap, non-biometric digest of "what is each box asking its owner to
  // approve right now?" — the detection tier of the Box Request Inbox
  // (docs/box-request-inbox.md). A locked/awaiting box can't reach its daemon
  // BFF (disk sealed) and won't POST a daemon-status heartbeat, so without this
  // it falls through to "never came online" past the grace window — and the
  // phone's only other signal (the IRK-signed mailbox read) is biometric and
  // can't poll. Reading the mailbox here needs no auth: listPendingForUser
  // returns ONLY un-consumed, un-expired, un-answered REQUEST lanes (deposit
  // lanes are answered-by-construction and never surface), so this set is
  // exactly the inbox. Guarded so a failure never drops or fails the list.
  const pendingByDomain = new Map<string, PendingRequestSummary[]>();
  if (deps.secretMailbox) {
    try {
      const pendingReqs = await deps.secretMailbox.listPendingForUser(username, now);
      for (const r of pendingReqs) {
        const key = r.serverDomain.toLowerCase();
        const list = pendingByDomain.get(key) ?? [];
        list.push({
          id: r.requestNonceHex,
          type: r.purpose,
          issuedAt: r.requestIssuedAt,
          expiresAt: r.expiresAt,
        });
        pendingByDomain.set(key, list);
      }
    } catch {
      /* enrichment failure must never empty or 500 the authoritative list */
    }
  }

  const pods: OnlinePodEntry[] = await Promise.all(
    servers.map(async (s): Promise<OnlinePodEntry> => {
      const routing = await deps.routing.get(s.serverDomain);
      const status = statusByDomain.get(s.serverDomain.toLowerCase());
      const pendingRequests = pendingByDomain.get(s.serverDomain.toLowerCase()) ?? [];
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
        // The Box Request Inbox digest for this pod (docs/box-request-inbox.md):
        // the typed list of approvals this box is currently asking its owner
        // for. The generic client inbox is the flatMap of this across pods.
        // Every surface (webapp + iOS + Android) reads `pendingRequests`; the
        // old compat booleans (`awaitingUnlock` / `awaitingEntitlement`, a
        // `some(r.type === …)` projection of this) were dropped once all
        // surfaces cut over — a new request type is now one more entry here,
        // no boolean to add.
        pendingRequests,
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

  return { username, pods, pending, fetchedAt: now };
}

export async function handleGetUserPods(
  deps: PodInventoryDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  return ok(await buildPodInventory(deps, username));
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

  // Coarse "account in use" bump for the reclaim tool (migration 0058). A
  // verified heartbeat from a live box is the strongest signal the account is
  // alive. Best-effort + rate-limited to ≤ once/day so the 5-minutely
  // heartbeat doesn't hot-write the row; never blocks the heartbeat.
  if (deps.usernames) {
    try {
      const nowMs = (deps.now ?? (() => Date.now()))();
      const owner = await deps.usernames.get(server.username);
      if (
        owner &&
        (owner.lastActive === undefined ||
          nowMs - owner.lastActive >= LAST_ACTIVE_BUMP_MIN_INTERVAL_MS)
      ) {
        await deps.usernames.touchLastActive(server.username, nowMs);
      }
    } catch {
      // swallow — the heartbeat already landed.
    }
  }

  return ok({ ok: true });
}
