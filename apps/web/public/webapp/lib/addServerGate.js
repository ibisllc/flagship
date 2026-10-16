// Adding a server to the account (create one, co-manage someone's running
// server, take over a box, import a backup) is for the account's admin devices
// only (owner rule 2026-10-15; docs/service-access-gating.md "Account
// members"): the device that holds the account's admin root. Every account is
// opened with one, so an account never lacks an admin device. A demo account's
// device stands in for its owner (it holds no keys; the operator runs the
// account). Home's button, every link into those flows and recipe minting all
// ask this one rule. Mirrors iOS AddServerGate.swift and Android
// core/AddServerGate.kt.

import { getSession } from "./state.js";
import { getActiveProfile } from "./profiles.js";
import { isAdminDevice } from "./memberRoles.js";

export const ADD_SERVERS_ADMIN_ONLY = "Only an admin device of this account can add servers.";

export function canAddServers(session = getSession(), profile = getActiveProfile()) {
  return isAdminDevice(session) || !!profile?.demoServer;
}

export class AddServerRefusedError extends Error {
  constructor() {
    super(ADD_SERVERS_ADMIN_ONLY);
    this.name = "AddServerRefusedError";
    this.code = "add-server-admin-only";
    this.userMessage = ADD_SERVERS_ADMIN_ONLY;
  }
}

/** The admin root a new server's recipe pins (its public key hex). Only
 *  opening the account mints one: a device without it is refused, never
 *  handed a fresh root the account's admins don't hold. A demo account pins
 *  none. `pubHexOf` turns the session's seed into its public key. */
export async function recipeAdminRootPin(session, { isDemo = false, pubHexOf } = {}) {
  const seed = session?.adminRootSeed;
  if (seed instanceof Uint8Array) return pubHexOf(seed);
  if (isDemo) return null;
  throw new AddServerRefusedError();
}

/** Tell this device why the flow it asked for isn't open to it. `home`
 *  lands a deep link on Home first, so the refusal never sits over an empty
 *  page. */
export async function refuseAddServer({ home = false } = {}) {
  if (home) {
    const { enterHome } = await import("../views/home.js");
    await enterHome();
  }
  const { inlineAlert } = await import("./modal.js");
  void inlineAlert({ title: "Admin devices only", message: ADD_SERVERS_ADMIN_ONLY });
}

/** `.com` enforces the rule too (owner rule 2026-10-16): a non-admin
 *  device's create, RCK or take-over is refused with a 403
 *  `{"error": …, "code": "add-server-admin-only"}`. */
export const ADD_SERVER_REFUSAL_CODE = "add-server-admin-only";

export function isAddServerRefusal(status, body) {
  return status === 403 && !!body && typeof body === "object" && body.code === ADD_SERVER_REFUSAL_CODE;
}

/** Throw the apps' own refusal for `.com`'s, reading a clone of the Response
 *  so the caller can still read the body when it is something else. */
export async function throwIfAddServerRefused(resp) {
  if (!resp || resp.status !== 403) return;
  let body = null;
  try {
    const copy = typeof resp.clone === "function" ? resp.clone() : resp;
    body = JSON.parse(await copy.text());
  } catch {
    return;
  }
  if (isAddServerRefusal(403, body)) throw new AddServerRefusedError();
}
