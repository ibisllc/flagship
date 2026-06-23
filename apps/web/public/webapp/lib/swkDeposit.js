// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): when a server
// is created WITHOUT embedding the SWK in the recipe (the default), the webapp
// must deposit the SWK to `.com` AFTER the box registers (so the box claims it
// and turns on its service platform). This module is the device-local intent
// store + the reconcile helper that runs the deposit once a box appears in the
// directory with its identity pub.
//
// Mirror of the mobile PendingSwkDepositStore + SwkDepositCoordinator. Three
// states per server FQDN, keyed in localStorage:
//   absent      -> nothing owed (embed-secrets WAS on, or never created here).
//   "pending"   -> owed: the box hasn't come online yet OR the deposit failed.
//   "deposited" -> done: the SWK was accepted by `.com` (idempotency marker).

import { getSession } from "./state.js";
import { deriveSwkFromSeed } from "../keystore.js";
import { depositSwk } from "./bootApproval.js";

const PREFIX = "flagship.swkDeposit.";

function key(serverDomain) {
  return PREFIX + String(serverDomain).toLowerCase();
}

/** Record that a deposit is OWED for this server (embed-secrets was OFF). */
export function markSwkDepositPending(serverDomain) {
  try {
    localStorage.setItem(key(serverDomain), "pending");
  } catch {
    /* private mode / quota — the box can still request via the inbox fallback */
  }
}

/** Record that the SWK was accepted by `.com` — the idempotency marker. */
export function markSwkDeposited(serverDomain) {
  try {
    localStorage.setItem(key(serverDomain), "deposited");
  } catch {
    /* ignore */
  }
}

/** Clear any record (e.g. the server was cancelled before it came online). */
export function clearSwkDeposit(serverDomain) {
  try {
    localStorage.removeItem(key(serverDomain));
  } catch {
    /* ignore */
  }
}

/** True iff a deposit is still owed (recorded pending, not yet deposited). */
export function isSwkDepositPending(serverDomain) {
  try {
    return localStorage.getItem(key(serverDomain)) === "pending";
  } catch {
    return false;
  }
}

/** True iff the SWK was already deposited for this server. */
export function isSwkDeposited(serverDomain) {
  try {
    return localStorage.getItem(key(serverDomain)) === "deposited";
  } catch {
    return false;
  }
}

/**
 * Deposit the SWK for a box that has registered (carrying `identityPubKeyHex`)
 * — IF a deposit is still owed for it. No-op otherwise. Best-effort + idempotent:
 * marks `deposited` only after `.com` accepts it; a failure leaves the `pending`
 * marker so the next reconcile retries (the box just stays platform-less
 * meanwhile, never bricked).
 *
 * @param {{ serverDomain: string, identityPubKeyHex: string }} args
 * @param {{ depositSwk?: Function, deriveSwk?: Function }} [deps]  (test seams)
 */
export async function depositSwkIfNeeded(args, deps = {}) {
  const { serverDomain, identityPubKeyHex } = args;
  if (!serverDomain || !identityPubKeyHex) return;
  if (!isSwkDepositPending(serverDomain)) return;
  const session = getSession();
  if (!session?.umk || !session?.username) return; // locked / signed out

  const doDeriveSwk = deps.deriveSwk || deriveSwkFromSeed;
  const doDeposit = deps.depositSwk || depositSwk;
  try {
    // The box SWK = the SAME deterministic DOTS derivation used at create
    // (serverId = serverDomain). The box can't derive it (no UMK).
    const swkHex = await doDeriveSwk(session.umk, serverDomain);
    await doDeposit({
      serverDomain,
      stkPubHex: String(identityPubKeyHex).toLowerCase(),
      swkHex,
    });
    markSwkDeposited(serverDomain);
  } catch {
    // Leave the `pending` marker so the next reconcile retries.
  }
}
