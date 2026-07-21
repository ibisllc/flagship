/**
 * Graceful server-replacement decommission (docs/server-replacement-graceful-
 * decommission.md). A retiring box instance is EVICTED from a `podCanonical` by
 * an owner-IRK-signed `ServerDecommission` order; the chain of these (one per
 * retired STK for a pod) is the revoked-set the successor + hub consult, and the
 * §9 final-flush barrier the successor polls before it starts serving.
 *
 *   POST /api/server/:domain/decommission                deposit (owner mailbox-auth)
 *   GET  /api/server/:domain/decommission?stk=<hex>      box fetches its own order (PUBLIC, revoke-tolerant)
 *   GET  /api/server/:domain/eviction-chain              successor fetches the full chain (PUBLIC)
 *   POST /api/server/:domain/decommission/epoch-complete the §9 barrier report
 *   POST /api/server/:domain/decommission/ack-old        retiring box acked (advisory)
 *   POST /api/server/:domain/decommission/ack-new        successor acked (advisory)
 *
 * Auth model (mirrors the self-delete/pairing deposit):
 *   - The DEPOSIT is mailbox-authed as the domain's registered owner — the SAME
 *     IRK-signed `DeviceEndpointClaim` mechanism the secret-mailbox deposits use
 *     (`authPhoneMailbox`, re-exported here). The order itself is then verified
 *     under that owner's IRK (`verifyServerDecommission`).
 *   - The box-fetch + chain-fetch are PUBLIC and REVOKE-TOLERANT: the order is
 *     owner-IRK-signed (a relay can't forge it) and the box re-verifies it under
 *     its config-pinned owner IRK before acting, so serving it post-revoke (the
 *     decommission revokes the retiring instance) is harmless — and necessary,
 *     since a revoked box could otherwise never fetch its own eviction order.
 *   - The epoch-complete + acks mutate only advisory/barrier columns; they are
 *     public + non-destructive (they only advance GC / the §9 barrier).
 */

import { verifyServerDecommission, type ServerDecommission } from "@flagship/protocol";
import type {
  DeviceCapabilityGrantStorage,
  ServerEvictionStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX64, hexToBytes } from "./hex.js";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { authPhoneMailbox, type SecretMailboxDeps } from "./secretMailbox.js";
import { forbidden, malformed, notFound, ok, type HandlerResponse } from "./types.js";

export interface ServerDecommissionDeps {
  servers: ServerStorage;
  usernames: UsernameStorage;
  serverEvictions: ServerEvictionStorage;
  /** Slice D — device-grant store for the master-admin authority gate (§2 row
   *  27). Optional: absent ⇒ only the bare admin root satisfies the open gate. */
  grants?: DeviceCapabilityGrantStorage;
  /** The mailbox-auth deps (servers/usernames/secretMailbox/boxSealedLeases) used
   *  to authenticate the depositor as the domain's registered owner — reused as-is
   *  from the secret-mailbox surface. */
  mailbox: SecretMailboxDeps;
  now?: () => number;
}

const HEX_NONCE = /^[0-9a-f]{64}$/; // 32 bytes hex

function isDiskDisposition(v: unknown): v is ServerDecommission["diskDisposition"] {
  return v === "keep" || v === "wipe-after-handoff" || v === "wipe-now";
}

// ──────────────────────────────────────────────────────────────────────
// 1. POST /api/server/:domain/decommission  (owner mailbox-auth)
//
// The owner's phone mints an IRK-signed ServerDecommission order for the
// retiring instance's STK and deposits it. `.com` mailbox-auths the depositor
// as the domain's registered owner (SAME IRK-signed DeviceEndpointClaim the
// secret-mailbox deposits use), then verifies the order under that owner's IRK
// and records the eviction (upsert on podCanonical+retiredStkPubHex).
// ──────────────────────────────────────────────────────────────────────

export async function handlePostDecommission(
  deps: ServerDecommissionDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  // Mailbox-auth the depositor as the account that owns this domain.
  const auth = await authPhoneMailbox(deps.mailbox, body);
  if (!auth.ok) return auth.response;

  const reg = await deps.servers.get(host);
  if (!reg) return notFound("unknown server");
  if (reg.username.toLowerCase() !== auth.username) {
    return forbidden("server belongs to a different account");
  }

  const b = body as { order?: Record<string, unknown>; signature?: unknown };
  const o = b?.order ?? {};
  if (
    typeof o.podCanonical !== "string" ||
    typeof o.retiredStkPubHex !== "string" ||
    typeof o.finalBackup !== "boolean" ||
    !isDiskDisposition(o.diskDisposition) ||
    typeof o.backupEpoch !== "number" ||
    typeof o.nonce !== "string" ||
    typeof o.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return malformed("malformed order");
  }
  if (!HEX64.test(o.retiredStkPubHex.toLowerCase())) {
    return malformed("retiredStkPubHex must be 32 bytes hex");
  }
  if (!HEX_NONCE.test(o.nonce.toLowerCase())) {
    return malformed("nonce must be 32 bytes hex");
  }
  if (!/^[0-9a-f]{128}$/.test(b.signature.toLowerCase())) {
    return malformed("signature must be 64 bytes hex");
  }
  // The order MUST target the domain it's deposited under (no cross-pod orders).
  if (o.podCanonical.toLowerCase() !== host.toLowerCase()) {
    return forbidden("order podCanonical does not match the domain");
  }

  // The owner IRK is the account's registered identity key — the SAME source
  // the box-sealed lease deposit verifies against (usernames row for the
  // server's owning account).
  const userRec = await deps.usernames.get(reg.username);
  if (!userRec) return notFound("unknown user");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return malformed("invalid hex");
  }

  const order: ServerDecommission = {
    podCanonical: o.podCanonical,
    retiredStkPubHex: o.retiredStkPubHex,
    finalBackup: o.finalBackup,
    diskDisposition: o.diskDisposition,
    backupEpoch: o.backupEpoch,
    nonce: o.nonce,
    issuedAt: o.issuedAt,
  };
  // Slice D §2 row 27 — SENSITIVE: master-admin authority (legacy owner-IRK when
  // no admin root is pinned).
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: deps.now },
    {
      username: reg.username.toLowerCase(),
      userRec,
      verifyWith: (pub) => verifyServerDecommission(order, sig, hexToBytes(pub)),
    },
  );
  if (!authz.ok) {
    return forbidden("invalid signature");
  }

  await deps.serverEvictions.recordEviction({
    podCanonical: host.toLowerCase(),
    retiredStkPubHex: o.retiredStkPubHex.toLowerCase(),
    orderJson: JSON.stringify(order),
    orderSignatureHex: b.signature.toLowerCase(),
    issuedAt: o.issuedAt,
    oldAckedAt: null,
    newAckedAt: null,
    epochCompleteAt: null,
  });

  return ok({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────
// 2. GET /api/server/:domain/decommission?stk=<hex>  (box, PUBLIC, revoke-tolerant)
//
// The retiring box polls for ITS OWN eviction order. PUBLIC + revoke-tolerant —
// the order is owner-IRK-signed + the box re-verifies it, so there is no
// revokedAt gate (a revoked box must still be able to learn it was evicted).
// ──────────────────────────────────────────────────────────────────────

export async function handleGetDecommission(
  deps: ServerDecommissionDeps,
  host: string,
  stkHex: string | null,
): Promise<HandlerResponse> {
  if (!stkHex || !HEX64.test(stkHex.toLowerCase())) {
    return malformed("stk query param must be 32 bytes hex");
  }
  const row = await deps.serverEvictions.getEviction(host.toLowerCase(), stkHex.toLowerCase());
  if (!row) return notFound("no decommission order");
  return ok({ orderJson: row.orderJson, orderSignatureHex: row.orderSignatureHex });
}

// ──────────────────────────────────────────────────────────────────────
// 3. GET /api/server/:domain/eviction-chain  (successor, PUBLIC)
//
// The successor instance fetches the full revoked-set chain for the pod (every
// retired STK, ordered by issuedAt). Owner-IRK-signed orders ⇒ public is safe.
// ──────────────────────────────────────────────────────────────────────

export async function handleGetEvictionChain(
  deps: ServerDecommissionDeps,
  host: string,
): Promise<HandlerResponse> {
  const rows = await deps.serverEvictions.listEvictions(host.toLowerCase());
  return ok({
    evictions: rows.map((r) => ({
      orderJson: r.orderJson,
      orderSignatureHex: r.orderSignatureHex,
      epochCompleteAt: r.epochCompleteAt,
    })),
  });
}

// ──────────────────────────────────────────────────────────────────────
// 4. POST /api/server/:domain/decommission/epoch-complete  (retiring box)
//
// The retiring box reports it flushed its final-backup epoch — the §9 barrier
// the successor polls (#3, epochCompleteAt) before it starts serving. Public +
// non-destructive (it only stamps the barrier column).
// ──────────────────────────────────────────────────────────────────────

export async function handlePostEpochComplete(
  deps: ServerDecommissionDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const b = body as { stk?: unknown };
  if (typeof b?.stk !== "string" || !HEX64.test(b.stk.toLowerCase())) {
    return malformed("stk must be 32 bytes hex");
  }
  const marked = await deps.serverEvictions.markEpochComplete(
    host.toLowerCase(),
    b.stk.toLowerCase(),
    now(),
  );
  if (!marked) return notFound("no decommission order");
  return ok({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────
// 5. POST .../decommission/ack-old + .../decommission/ack-new  (advisory)
//
// Advisory, public, non-destructive acks that only advance GC: the retiring box
// confirms it consumed its order (ack-old, per-STK); the successor confirms it
// holds the chain (ack-new, per-pod). Neither tears anything down.
// ──────────────────────────────────────────────────────────────────────

export async function handlePostAckOld(
  deps: ServerDecommissionDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const b = body as { stk?: unknown };
  if (typeof b?.stk !== "string" || !HEX64.test(b.stk.toLowerCase())) {
    return malformed("stk must be 32 bytes hex");
  }
  const marked = await deps.serverEvictions.markOldAcked(
    host.toLowerCase(),
    b.stk.toLowerCase(),
    now(),
  );
  if (!marked) return notFound("no decommission order");
  return ok({ ok: true });
}

export async function handlePostAckNew(
  deps: ServerDecommissionDeps,
  host: string,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const marked = await deps.serverEvictions.markNewAcked(host.toLowerCase(), now());
  return ok({ ok: true, marked });
}
