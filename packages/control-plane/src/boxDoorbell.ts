/**
 * The box doorbell: what a box would find if it polled `.com` right now,
 * answered on the heartbeat reply it already reads.
 *
 * Why: a box used to poll about a dozen `.com` lanes every 5 minutes (and the
 * alias list every minute), thousands of requests a day each, nearly all
 * answered "nothing". The Workers Free plan allows 100,000 requests a day for
 * everybody, so boxes alone capped it at about twenty accounts. The heartbeat
 * reply now carries this doorbell; a box that has a fresh one skips a poll the
 * doorbell says is empty (packages/server-daemon/src/doorbell.ts).
 *
 * Two kinds of answer:
 *
 *   lanes   Names of lanes with something waiting. A lane absent from the list
 *           would answer the box's poll with a 404 (nothing to collect), by the
 *           same rule the lane's own handler applies.
 *   stamps  A short digest of the body a list endpoint would return right now
 *           (aliases, admin-root rotations). The digest is of the
 *           real handler's own answer, so anything that changes what the box
 *           would read changes the stamp. A box refetches only when its stamp
 *           differs from the one it fetched under.
 *
 * Nothing here decides anything for the box: it only tells it when a poll can
 * be skipped, and the box still polls on a slow safety interval and whenever the
 * doorbell is missing or stale, so a doorbell that is wrong costs delay, never
 * a lost order.
 */

import { sha256 } from "@noble/hashes/sha256";
import type {
  AdminRootRotationStorage,
  SecretMailboxStorage,
  ServerEvictionStorage,
  ServerMigrationStorage,
  ServerRecord,
  ServerTransferStorage,
  UserServiceAliasStorage,
  UsernameStorage,
} from "@flagship/storage";
import { bytesToHex } from "./hex.js";
import { handleListAdminRootRotations } from "./adminRootRotation.js";
import { handleListAppAliases } from "./serviceRename.js";
import { findMigrationAssignment } from "./serverMigration.js";
import { isRehomeReady } from "./serverTransfer.js";

export interface BoxDoorbell {
  v: 1;
  /** Lanes with something waiting: any of `swk`, `cgk`, `pairing`, `entitlement-deposit`,
   *  `update`, `self-delete`, `rehome`, `migration`, `decommission`. */
  lanes: string[];
  stamps: { aliases: string; rotations: string };
}

export interface BoxDoorbellDeps {
  secretMailbox: Pick<SecretMailboxStorage, "pendingDepositPurposes">;
  serverMigrations: Pick<ServerMigrationStorage, "listForUser">;
  serverTransfers: Pick<ServerTransferStorage, "getOffer">;
  serverEvictions: Pick<ServerEvictionStorage, "getEviction">;
  userServiceAliases: UserServiceAliasStorage;
  usernames: UsernameStorage;
  rotations: AdminRootRotationStorage;
  now?: () => number;
}

/** A short, stable digest of a handler's JSON answer. */
function stampOf(body: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(body)))).slice(0, 24);
}

/** Everything is read together (one round trip through RequestD1). */
export async function buildBoxDoorbell(
  deps: BoxDoorbellDeps,
  server: Pick<ServerRecord, "serverDomain" | "username" | "identityPubKeyHex">,
): Promise<BoxDoorbell> {
  const now = (deps.now ?? (() => Date.now()))();
  const host = server.serverDomain.toLowerCase();
  const user = server.username.toLowerCase();
  const [purposes, sessions, transfer, eviction, aliases, rotations] = await Promise.all([
    deps.secretMailbox.pendingDepositPurposes(server.serverDomain, now),
    deps.serverMigrations.listForUser(server.username),
    deps.serverTransfers.getOffer(server.serverDomain, now),
    deps.serverEvictions.getEviction(host, server.identityPubKeyHex.toLowerCase()),
    handleListAppAliases({ userServiceAliases: deps.userServiceAliases }, user),
    handleListAdminRootRotations({ usernames: deps.usernames, rotations: deps.rotations }, user),
  ]);
  const lanes = new Set<string>(purposes);
  if (findMigrationAssignment(sessions, host)) lanes.add("migration");
  if (isRehomeReady(transfer)) lanes.add("rehome");
  if (eviction) lanes.add("decommission");
  return {
    v: 1,
    lanes: [...lanes].sort(),
    stamps: {
      aliases: stampOf(aliases.body),
      rotations: stampOf(rotations.body),
    },
  };
}
