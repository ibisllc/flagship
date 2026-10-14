/**
 * The owner's server order (docs/server-order.md).
 *
 * `POST /api/accounts/<u>/server-order` stores the newest order an account's
 * sensitive-order authority signed (the admin master root when pinned, else
 * the IRK). `.com` is a relay, not the authority: `/pods` hands the order to
 * the apps and the daemon-status reply hands it to the boxes, and each box
 * re-verifies it before acting on it.
 */
import {
  parseSignedServerOrder,
  verifyServerOrder,
  type SignedServerOrder,
} from "@flagship/protocol";
import type {
  DeviceCapabilityGrantStorage,
  ServerOrderStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { hexToBytes } from "./hex.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

const FRESHNESS_MS = 5 * 60_000;

export interface ServerOrderDeps {
  usernames: UsernameStorage;
  servers: ServerStorage;
  serverOrders: ServerOrderStorage;
  grants?: DeviceCapabilityGrantStorage;
  now?: () => number;
}

export async function handlePostServerOrder(
  deps: ServerOrderDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const now = (deps.now ?? (() => Date.now()))();
  const signed = parseSignedServerOrder(body);
  if (!signed) return malformed("malformed server order");
  const { order, signature } = signed;
  if (order.user.toLowerCase() !== u) return forbidden("order is for another account");
  if (Math.abs(now - order.issuedAt) > FRESHNESS_MS) return forbidden("stale request");

  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("unknown user");

  const servers = await deps.servers.listForUser(u);
  const live = new Set(
    servers.filter((s) => !s.revokedAt).map((s) => s.identityPubKeyHex.toLowerCase()),
  );
  if (!order.stks.every((stk) => live.has(stk))) {
    return forbidden("the order names a server this account doesn't have");
  }

  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: () => now },
    {
      username: u,
      userRec,
      verifyWith: (pub) => verifyServerOrder(order, signature, hexToBytes(pub)),
    },
  );
  if (!authz.ok) return forbidden("invalid server order signature");

  const put = await deps.serverOrders.putIfNewer({
    username: u,
    orderJson: JSON.stringify(order),
    signatureHex: signature,
    issuedAt: order.issuedAt,
  });
  if (!put.ok) return conflict(put.reason);
  return ok({ ok: true });
}

/** The account's stored order in its wire form, or null. */
export async function readServerOrder(
  serverOrders: ServerOrderStorage,
  username: string,
): Promise<SignedServerOrder | null> {
  const row = await serverOrders.get(username);
  if (!row) return null;
  try {
    return parseSignedServerOrder({ order: JSON.parse(row.orderJson), signature: row.signatureHex });
  } catch {
    return null;
  }
}
