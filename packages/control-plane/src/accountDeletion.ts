/**
 * Account deletion (last-device self-delete) + the opt-in servers-self-delete
 * content-wipe bundle, and the sysadmin username-reclaim tool for long-inactive
 * names. Design: docs/account-deletion-and-name-reclaim.md.
 *
 * Three exported handlers:
 *   - handleAccountDeletionBundle — the public bundle-ingest endpoint. Accepts
 *     `{ accountSelfDelete, serversSelfDelete? }`. Enforces the §5 invariant:
 *     the servers-self-delete content-wipe is NEVER a standalone order — it is
 *     accepted/recorded ONLY when atomically bundled with a valid LAST-DEVICE
 *     account-self-delete. Verify-both-then-commit; a bad/absent companion or a
 *     non-last-device caller rejects the WHOLE bundle (neither order is
 *     recorded/forwarded).
 *   - handleAdminUsernameReclaim — admin-gated reclaim of a name inactive for
 *     ≥ RECLAIM_INACTIVE_MS (default 90 days). Dry-run supported. Never bulk.
 *
 * "Last device" (docs §0): the FOUNDING device is implicit
 * (`usernames.irk_pub_hex`) and never appears in `device_capability_grants`. So
 * the last-device test is: the caller proves the founding IRK AND there are
 * ZERO active (`revokedAt === null`) device grants for the account.
 */

import {
  verifyAccountSelfDelete,
  verifyServersSelfDelete,
  type AccountSelfDelete,
  type ServersSelfDelete,
} from "@flagship/protocol";
import type {
  AuthCodeStorage,
  AuditEventStorage,
  AutoUnlockLeaseStorage,
  BoxSealedLeaseStorage,
  DeviceCapabilityGrantStorage,
  LuksKeyStorage,
  PushTokenStorage,
  RoutingStorage,
  SecretMailboxStorage,
  ServerRecord,
  ServerStorage,
  UsernameStorage,
  WebauthnRecoveryStorage,
} from "@flagship/storage";
import { recordAuditEvent } from "./auditEvents.js";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import type { DnsDeleteClient } from "./cloudflareDns.js";
import { HEX128, hexToBytes } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

/** Default dormancy window for the admin reclaim tool: 90 days. */
export const RECLAIM_INACTIVE_MS = 90 * 24 * 60 * 60 * 1000;

export interface AccountDeletionDeps {
  usernames: UsernameStorage;
  servers: ServerStorage;
  routing: RoutingStorage;
  authCodes: AuthCodeStorage;
  deviceCapabilityGrants: DeviceCapabilityGrantStorage;
  auditEvents: AuditEventStorage;
  /** Optional teardown participants — all best-effort, mirroring
   *  serverRevocation/serverRelease. */
  autoUnlockLeases?: AutoUnlockLeaseStorage;
  boxSealedLeases?: BoxSealedLeaseStorage;
  luksKeys?: LuksKeyStorage;
  webauthnRecovery?: WebauthnRecoveryStorage;
  pushTokens?: PushTokenStorage;
  /** Mailbox the §5 content-wipe order is DEPOSITED into (one row per owned
   *  server), so an online box consumes it on its heartbeat and wipes. Absent
   *  ⇒ the content-wipe is recorded as an audit row only (no box-side delivery).
   */
  secretMailbox?: SecretMailboxStorage;
  dns?: DnsDeleteClient;
  freshnessMs?: number;
  /** TTL for a deposited self-delete order (ms). Default 14 days — long enough
   *  that an online-but-slow box still catches it; an offline box never polls
   *  (orphan-and-lapse, the accepted model). */
  selfDeleteTtlMs?: number;
  now?: () => number;
}

/** Default self-delete deposit TTL: 14 days (mirrors the pairing-deposit window). */
const DEFAULT_SELF_DELETE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function utf8ToHex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

interface BundleBody {
  accountSelfDelete?: {
    request?: { username?: string; issuedAt?: number };
    signature?: string;
  };
  serversSelfDelete?: {
    request?: { username?: string; issuedAt?: number };
    signature?: string;
  };
}

/**
 * Ordered teardown of ONE server the account owns: free the RCK routing record,
 * revoke active auth-codes, revoke the server record, tear down boot leases,
 * delete per-box DNS, drop the sealed LUKS blob. Best-effort throughout — a
 * teardown hiccup MUST NOT abort the account death that has already committed.
 */
async function teardownServer(
  deps: AccountDeletionDeps,
  server: ServerRecord,
  now: number,
): Promise<void> {
  const domain = server.serverDomain;
  try {
    await deps.routing.release(domain);
  } catch {
    /* swallow */
  }
  try {
    const active = await deps.authCodes.listActiveByServerDomain(domain);
    for (const code of active) {
      try {
        await deps.authCodes.markRevoked(code.serial, now);
      } catch {
        /* swallow */
      }
    }
  } catch {
    /* swallow */
  }
  try {
    await deps.servers.revoke(domain, "account-deleted", now);
  } catch {
    /* swallow */
  }
  if (deps.autoUnlockLeases) {
    try {
      const leases = await deps.autoUnlockLeases.list(domain, now);
      for (const l of leases) {
        try {
          await deps.autoUnlockLeases.revoke(domain, l.leaseId);
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
  }
  if (deps.boxSealedLeases) {
    try {
      const leases = await deps.boxSealedLeases.list(domain, now);
      for (const l of leases) {
        try {
          await deps.boxSealedLeases.revoke(domain, l.leaseId);
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
  }
  if (deps.dns) {
    const targets: Array<[string, string]> = [
      [domain, "A"],
      [domain, "AAAA"],
      [`*.${domain}`, "A"],
      [`*.${domain}`, "AAAA"],
    ];
    for (const [name, type] of targets) {
      try {
        await deps.dns.deleteByName(name, type);
      } catch {
        /* swallow */
      }
    }
  }
  if (deps.luksKeys) {
    try {
      await deps.luksKeys.deleteSealed(domain);
    } catch {
      /* swallow */
    }
  }
}

/**
 * Count ACTIVE (`revokedAt === null`) device grants. The founding device is NOT
 * in this table, so 0 active grants + a valid founding-IRK signature ⇒ the
 * caller IS the last device.
 */
async function activeGrantCount(
  grants: DeviceCapabilityGrantStorage,
  username: string,
): Promise<number> {
  const rows = await grants.listForUser(username);
  return rows.filter((r) => r.revokedAt === null).length;
}

/**
 * Hard-delete the account: tear down every owned server, purge related records,
 * then delete the username row (the name frees immediately). Returns the number
 * of servers torn down. The username-row delete is LAST so that, even if a
 * teardown step were to throw past our swallows, the name is never freed while
 * the account's artifacts still reference it.
 */
async function commitAccountHardDelete(
  deps: AccountDeletionDeps,
  username: string,
  now: number,
): Promise<{ serversTornDown: number }> {
  const servers = await deps.servers.listForUser(username);
  let serversTornDown = 0;
  for (const s of servers) {
    if (s.revokedAt) continue;
    await teardownServer(deps, s, now);
    serversTornDown++;
  }

  // Purge account-scoped credentials so a reclaimed name starts clean and no
  // stale credential outlives the account.
  if (deps.webauthnRecovery) {
    try {
      await deps.webauthnRecovery.delete(username);
    } catch {
      /* swallow */
    }
  }
  if (deps.pushTokens) {
    try {
      const tokens = await deps.pushTokens.listByUser(username);
      for (const t of tokens) {
        try {
          await deps.pushTokens.remove(t.tokenId);
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
  }
  try {
    const grants = await deps.deviceCapabilityGrants.listForUser(username);
    for (const g of grants) {
      if (g.revokedAt !== null) continue;
      try {
        await deps.deviceCapabilityGrants.revoke(g.grantId, now);
      } catch {
        /* swallow */
      }
    }
  } catch {
    /* swallow */
  }

  // The row delete is the irreversible act — name is claimable again at once.
  await deps.usernames.delete(username);
  return { serversTornDown };
}

/**
 * POST /api/account/self-delete — the bundle-ingest endpoint.
 *
 * Body: `{ accountSelfDelete, serversSelfDelete? }`. A bare account-self-delete
 * deletes the account; bundling serversSelfDelete ALSO records/forwards the
 * content-wipe order to the account's boxes — but ONLY all-or-nothing with a
 * valid last-device account-self-delete (§5).
 */
export async function handleAccountDeletionBundle(
  deps: AccountDeletionDeps,
  body: BundleBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const acct = body?.accountSelfDelete;
  // The account-self-delete is ALWAYS required. A standalone serversSelfDelete
  // (no account companion) is inert — reject the whole request.
  if (
    !acct ||
    !acct.request ||
    typeof acct.request.username !== "string" ||
    typeof acct.request.issuedAt !== "number" ||
    typeof acct.signature !== "string" ||
    !HEX128.test(acct.signature)
  ) {
    return malformed("malformed accountSelfDelete");
  }

  const userV = validateUserLabel(acct.request.username);
  if (!userV.ok) return malformed(userV.reason);
  const username = userV.label;

  if (Math.abs(now - acct.request.issuedAt) > freshnessMs) {
    return forbidden("stale request");
  }

  const userRec = await deps.usernames.get(username);
  if (!userRec) return notFound("username not registered");

  let acctSig: Uint8Array;
  try {
    acctSig = hexToBytes(acct.signature);
  } catch {
    return malformed("invalid hex");
  }

  const acctOrder: AccountSelfDelete = {
    username,
    issuedAt: acct.request.issuedAt,
  };
  // Slice D §2 row 25 — SENSITIVE: master-admin authority (legacy owner-IRK when
  // no admin root is pinned). The bundle's optional servers-self-delete below
  // must be signed by the SAME authority.
  const acctAuthz = await authorizeSensitiveComOp(
    { grants: deps.deviceCapabilityGrants, now: deps.now },
    {
      username,
      userRec,
      verifyWith: (pub) => verifyAccountSelfDelete(acctOrder, acctSig, hexToBytes(pub)),
      now,
    },
  );
  if (!acctAuthz.ok) {
    return forbidden("invalid accountSelfDelete signature");
  }

  // LAST-DEVICE enforcement: the founding-IRK signature above proves the caller
  // holds the founding device; there must be ZERO OTHER active device grants.
  const others = await activeGrantCount(deps.deviceCapabilityGrants, username);
  if (others > 0) {
    return forbidden("not the last device: other active devices exist");
  }

  // ── §5 bundle invariant — validate the (optional) servers-self-delete BEFORE
  //    any commit, so a bad companion rejects the WHOLE bundle (neither order
  //    is recorded/forwarded). ──────────────────────────────────────────────
  let serversOrder: ServersSelfDelete | null = null;
  let serversSigHex: string | null = null;
  const sd = body?.serversSelfDelete;
  if (sd !== undefined) {
    if (
      !sd.request ||
      typeof sd.request.username !== "string" ||
      typeof sd.request.issuedAt !== "number" ||
      typeof sd.signature !== "string" ||
      !HEX128.test(sd.signature)
    ) {
      return malformed("malformed serversSelfDelete");
    }
    // The companion must name the SAME account.
    if (sd.request.username.toLowerCase() !== username) {
      return forbidden("serversSelfDelete username mismatch");
    }
    if (Math.abs(now - sd.request.issuedAt) > freshnessMs) {
      return forbidden("stale serversSelfDelete");
    }
    let sdSig: Uint8Array;
    try {
      sdSig = hexToBytes(sd.signature);
    } catch {
      return malformed("invalid hex");
    }
    const candidate: ServersSelfDelete = {
      username,
      issuedAt: sd.request.issuedAt,
    };
    // Slice D §2 row 26 — SENSITIVE: same master-admin authority as the account
    // order (legacy owner-IRK when no admin root is pinned).
    const sdAuthz = await authorizeSensitiveComOp(
      { grants: deps.deviceCapabilityGrants, now: deps.now },
      {
        username,
        userRec,
        verifyWith: (pub) => verifyServersSelfDelete(candidate, sdSig, hexToBytes(pub)),
        now,
      },
    );
    if (!sdAuthz.ok) {
      return forbidden("invalid serversSelfDelete signature");
    }
    serversOrder = candidate;
    serversSigHex = sd.signature.toLowerCase();
  }

  // ── Commit. Record/forward the servers-self-delete order FIRST (while the
  //    server records + their boot channels still exist), then hard-delete the
  //    account. The whole thing only reaches here when every check passed, so
  //    the bundle is committed atomically (all-or-nothing). ──────────────────
  let serversSelfDeleteForwarded = 0;
  if (serversOrder && serversSigHex) {
    // The deposited carrier is the PUBLIC owner-IRK-signed order envelope, hex
    // of UTF-8 JSON — the same shape the daemon decodes + re-verifies. `.com`
    // can't forge it (a relay holds no IRK), so a public consume-once read is
    // harmless. The deposit nonce is the order signature truncated to 32 bytes;
    // the same nonce on different domains is fine (the row key is per-domain).
    const carrierHex = utf8ToHex(
      JSON.stringify({
        request: { username, issuedAt: serversOrder.issuedAt },
        signature: serversSigHex,
      }),
    );
    const nonceHex = serversSigHex.slice(0, 64);
    const ttlMs = deps.selfDeleteTtlMs ?? DEFAULT_SELF_DELETE_TTL_MS;
    const ownedServers = await deps.servers.listForUser(username);
    for (const s of ownedServers) {
      if (s.revokedAt) continue;
      // Deposit the wipe order for an online box to consume on its heartbeat.
      if (deps.secretMailbox) {
        try {
          await deps.secretMailbox.putSelfDeleteDeposit({
            serverDomain: s.serverDomain,
            username,
            requestNonceHex: nonceHex,
            stkPubHex: s.identityPubKeyHex,
            sealedHex: carrierHex,
            issuedAt: serversOrder.issuedAt,
            expiresAt: now + ttlMs,
          });
        } catch {
          /* swallow — delivery is best-effort; the account death still lands */
        }
      }
      try {
        await recordAuditEvent(
          { auditEvents: deps.auditEvents },
          {
            username,
            eventKind: "servers-self-delete-issued",
            detail: `Content-wipe order deposited for ${s.serverDomain}`,
            devicePrefix: s.serverDomain.slice(0, 8),
            postedAt: now,
          },
        );
        serversSelfDeleteForwarded++;
      } catch {
        /* swallow — recording is best-effort; the account death still lands */
      }
    }
  }

  const { serversTornDown } = await commitAccountHardDelete(deps, username, now);

  try {
    await recordAuditEvent(
      { auditEvents: deps.auditEvents },
      {
        username,
        eventKind: "account-deleted",
        detail: serversOrder
          ? `Account deleted (last device); content-wipe requested for ${serversSelfDeleteForwarded} server(s)`
          : "Account deleted (last device)",
        devicePrefix: "",
        postedAt: now,
      },
    );
  } catch {
    /* swallow */
  }

  return ok({
    ok: true,
    username,
    deletedAt: now,
    serversTornDown,
    serversSelfDeleteForwarded,
    contentWipeRequested: serversOrder !== null,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Admin: username reclaim (≥ 90-day-inactive names)
// ──────────────────────────────────────────────────────────────────────

export interface AdminUsernameReclaimDeps extends AccountDeletionDeps {
  /** Dormancy threshold in ms (default 90 days). */
  inactiveMs?: number;
}

/**
 * POST /api/admin/username/:u/reclaim  (admin-gated at the route layer).
 *
 * Frees a name whose account has been inactive ≥ inactiveMs (last_active, or
 * claimedAt when last_active was never recorded) AND has NO active device. With
 * `dryRun`, returns what WOULD be freed without mutating. Audit-logged; never
 * bulk (operates on exactly the one named account).
 */
export async function handleAdminUsernameReclaim(
  deps: AdminUsernameReclaimDeps,
  rawUsername: string,
  opts?: { dryRun?: boolean },
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const inactiveMs = deps.inactiveMs ?? RECLAIM_INACTIVE_MS;
  const dryRun = opts?.dryRun ?? false;

  const userV = validateUserLabel(rawUsername);
  if (!userV.ok) return malformed(userV.reason);
  const username = userV.label;

  const userRec = await deps.usernames.get(username);
  if (!userRec) return notFound("username not registered");

  // Eligibility: dormant past the window. last_active is the authority; fall
  // back to claimedAt when it was never recorded (a legacy / never-active row).
  const lastSeen = userRec.lastActive ?? userRec.claimedAt;
  const inactiveForMs = now - lastSeen;
  const eligibleByInactivity = inactiveForMs >= inactiveMs;

  // Never reclaim a name that still has an active device — that's a live
  // account, not a dormant one.
  const activeDevices = await activeGrantCount(
    deps.deviceCapabilityGrants,
    username,
  );

  const eligible = eligibleByInactivity && activeDevices === 0;

  if (dryRun) {
    return ok({
      dryRun: true,
      username,
      eligible,
      lastSeen,
      inactiveForMs,
      inactiveThresholdMs: inactiveMs,
      activeDevices,
      reason: eligible
        ? "would be reclaimed"
        : !eligibleByInactivity
          ? "not inactive long enough"
          : "account still has active devices",
    });
  }

  if (!eligibleByInactivity) {
    return forbidden(
      `username inactive for ${inactiveForMs}ms; threshold is ${inactiveMs}ms`,
    );
  }
  if (activeDevices > 0) {
    return forbidden("username still has active devices");
  }

  const { serversTornDown } = await commitAccountHardDelete(deps, username, now);

  try {
    await recordAuditEvent(
      { auditEvents: deps.auditEvents },
      {
        username,
        eventKind: "username-reclaimed",
        detail: `Reclaimed by admin (inactive ${Math.floor(
          inactiveForMs / 86_400_000,
        )}d); ${serversTornDown} server(s) torn down`,
        devicePrefix: "",
        postedAt: now,
      },
    );
  } catch {
    /* swallow */
  }

  return ok({
    ok: true,
    username,
    reclaimedAt: now,
    serversTornDown,
    inactiveForMs,
  });
}
