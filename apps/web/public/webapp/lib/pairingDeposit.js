// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): the FIRST
// recipe carries ZERO pairing secrets. The default (online) create flow stashes
// the create-time owner-IRK-signed `add-paired-session` order locally and, once
// the box registers with its IDENTITY pub, SEALS that order to the box identity
// and deposits it on `.com`'s blind `pairing-deposit` lane (the box unseals with
// its own key, verifies the owner-IRK order, and pairs — no manual tap, no
// `pairingKeyPrivHex`). This module is the device-local intent store + the
// reconcile helper, the twin of swkDeposit.js.
//
// Mirror of the mobile PendingPairingDepositStore + the SwkDepositCoordinator's
// pairing branch. Per server FQDN, keyed in localStorage:
//   absent              -> nothing owed (embed-secrets WAS on, or never created here).
//   "<pairingOrderJson>" -> owed: the stashed plaintext order to seal + deposit.
//   "deposited"         -> done: the order was accepted by `.com` (idempotency).

import { getSession } from "./state.js";
import { depositPairingOrder } from "./bootApproval.js";

const PREFIX = "flagship.pairingDeposit.";
const DEPOSITED = "deposited";

function key(serverDomain) {
  return PREFIX + String(serverDomain).toLowerCase();
}

/** Stash the create-time order JSON — a deposit is OWED (embed-secrets OFF). */
export function markPairingDepositPending(serverDomain, pairingOrderJson) {
  try {
    localStorage.setItem(key(serverDomain), pairingOrderJson);
  } catch {
    /* private mode / quota — the box can still be paired manually */
  }
}

/** Record that the order was accepted by `.com` — the idempotency marker. */
export function markPairingDeposited(serverDomain) {
  try {
    localStorage.setItem(key(serverDomain), DEPOSITED);
  } catch {
    /* ignore */
  }
}

/** Clear any record (e.g. embed-secrets was ON, or the server was cancelled). */
export function clearPairingDeposit(serverDomain) {
  try {
    localStorage.removeItem(key(serverDomain));
  } catch {
    /* ignore */
  }
}

/** The stashed order JSON iff a deposit is still owed, else null. */
export function pendingPairingOrder(serverDomain) {
  try {
    const v = localStorage.getItem(key(serverDomain));
    return v && v !== DEPOSITED ? v : null;
  } catch {
    return null;
  }
}

/** True iff the order was already deposited for this server. */
export function isPairingDeposited(serverDomain) {
  try {
    return localStorage.getItem(key(serverDomain)) === DEPOSITED;
  } catch {
    return false;
  }
}

/**
 * Deposit the stashed pairing order for a box that has registered (carrying
 * `identityPubKeyHex`) — IF a deposit is still owed. No-op otherwise.
 * Best-effort + idempotent: marks `deposited` only after `.com` accepts it; a
 * failure leaves the stashed order so the next reconcile retries (the device
 * just stays un-paired meanwhile, never bricked).
 *
 * @param {{ serverDomain: string, identityPubKeyHex: string }} args
 * @param {{ depositPairingOrder?: Function }} [deps]  (test seam)
 */
export async function depositPairingIfNeeded(args, deps = {}) {
  const { serverDomain, identityPubKeyHex } = args;
  if (!serverDomain || !identityPubKeyHex) return;
  const pairingOrderJson = pendingPairingOrder(serverDomain);
  if (!pairingOrderJson) return;
  const session = getSession();
  if (!session?.umk || !session?.username) return; // locked / signed out

  const doDeposit = deps.depositPairingOrder || depositPairingOrder;
  try {
    await doDeposit({
      serverDomain,
      identityPubKeyHex: String(identityPubKeyHex).toLowerCase(),
      pairingOrderJson,
    });
    markPairingDeposited(serverDomain);
  } catch {
    // Leave the stashed order so the next reconcile retries.
  }
}
