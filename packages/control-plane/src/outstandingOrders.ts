import { ed } from "@flagship/protocol";
import type {
  AuthCodeStorage,
  ProvisionStatusStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX128, hexToBytes } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

/**
 * `POST /api/users/:u/outstanding-orders` — IRK-signed list of the
 * account's IN-FLIGHT install orders.
 *
 * Why this exists (task #43): the phone reconstructs "pending servers"
 * from a LOCAL UserDefaults cache. That cache drifts from server truth two
 * ways:
 *   - an order minted server-side whose in-app onDelivered callback never
 *     fired is INVISIBLE on the phone (the box installs + registers but the
 *     app never shows it), and
 *   - a stale local record whose order was wiped/expired spins forever at
 *     "booting" because the phone can't tell "unknown serial" from "no
 *     checkpoint yet".
 *
 * This endpoint is the authority that resolves both: it returns every
 * auth-code that is still `active` AND unexpired for the account — i.e.
 * every order the box could still legitimately register against. The phone
 * reconciles its local cache against THIS plus the registered `/pods`
 * inventory: surface orders here it doesn't know about, drop local records
 * absent from both.
 *
 * Auth: the body carries an IRK signature over
 * `flagship/outstanding-orders/v1|<username>|<issuedAt>`, verified against
 * the username's REGISTERED `irkPubHex` — the same authority that gates the
 * release / revoke paths. A read, but POST-with-signed-body is the
 * codebase's IRK-auth shape (a GET can't carry the signature cleanly).
 *
 * Despite being a read it returns 403 (not 404) for an unknown/ wrong-IRK
 * caller so it doesn't double as a "does this account exist" oracle, and
 * never leaks another account's orders.
 */
export interface OutstandingOrdersDeps {
  authCodes: AuthCodeStorage;
  usernames: UsernameStorage;
  /** Latest provisioning phase per order (joined by serial). Absent ⇒
   *  `phase` is null (the phone falls back to polling order-status). */
  provisionStatus?: ProvisionStatusStorage;
  freshnessMs?: number;
  now?: () => number;
}

interface OutstandingOrdersBody {
  request?: { username?: string; issuedAt?: number };
  signature?: string;
}

const TAG = "flagship/outstanding-orders/v1";

function canonicalBytes(username: string, issuedAt: number): Uint8Array {
  return new TextEncoder().encode([TAG, username, issuedAt].join("|"));
}

export interface OutstandingOrder {
  serial: string;
  serverName: string;
  /** `<serverName>.<username>.flagship.services` — the predicted FQDN. It's
   *  the same value the auth-code reserved; identical whether or not the box
   *  has registered yet. */
  fqdn: string;
  /** Latest reported provisioning phase, or null if none reported / no
   *  provision-status storage wired. */
  phase: string | null;
  createdAt: number;
}

export async function handleListOutstandingOrders(
  deps: OutstandingOrdersDeps,
  pathUsername: string,
  body: OutstandingOrdersBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const userV = validateUserLabel(r.username);
  if (!userV.ok) return malformed(userV.reason);
  // The signed username MUST equal the path username — the signature
  // authorizes a read of THIS account's orders, not an arbitrary one.
  if (userV.label !== pathUsername.toLowerCase()) {
    return forbidden("username mismatch");
  }
  if (Math.abs(now - r.issuedAt) > freshnessMs) return forbidden("stale request");

  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return notFound("username not registered");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }
  let verified = false;
  try {
    verified = ed.verify(
      sig,
      canonicalBytes(userV.label, r.issuedAt),
      hexToBytes(userRec.irkPubHex),
    );
  } catch {
    verified = false;
  }
  if (!verified) return forbidden("invalid signature");

  const codes = await deps.authCodes.listOutstandingByUsername(userV.label, now);

  const orders: OutstandingOrder[] = await Promise.all(
    codes.map(async (c) => {
      let phase: string | null = null;
      if (deps.provisionStatus) {
        const status = await deps.provisionStatus.getProvisionStatus(c.serial);
        phase = status?.phase ?? null;
      }
      return {
        serial: c.serial,
        serverName: c.serverName,
        fqdn: c.serverDomain,
        phase,
        createdAt: c.recordedAt,
      };
    }),
  );

  // Newest first — the phone surfaces the freshest in-flight install on top.
  orders.sort((a, b) => b.createdAt - a.createdAt);

  return ok({ username: userV.label, orders, fetchedAt: now });
}
