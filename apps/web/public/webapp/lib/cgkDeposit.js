// CGK provisioning (docs/multi-pod-liveness-session-leadership.md, Phase 6) — the
// per-cloud Cloud Gossip Key twin of swkDeposit.js. The secret-free recipe carries
// NO CGK; a box runs per-service-leadership gossip ONLY once it has a CGK (else
// gossip stays disabled — no brick). So AFTER a box registers (carrying its
// identity pub in `/pods`), the webapp derives the CGK (per-cloud, NO serverId),
// seals it to the box identity, IRK-signs a `cgk-delivery` wrapper, and deposits
// the sealed carrier on `.com`'s blind `cgk-deposit` lane. The box claims it on
// boot and enables gossip.
//
// Unlike the SWK (one secret per server, embedded-or-deposited at create), the CGK
// is ONE key for the WHOLE account. So there is no "embed vs deposit" choice and no
// create-time toggle: EVERY registered box of the account is owed a CGK so it can
// gossip with its siblings. The idempotency marker is per-server-FQDN (each box
// claims its own deposit once). Best-effort: a failure leaves no marker so the next
// reconcile retries (gossip just stays dark on that box meanwhile, never bricked).
//
// State per server FQDN in localStorage: "deposited" (idempotency marker) or absent.

import { getSession } from "./state.js";
import { deriveCgkFromSeed } from "../keystore.js";
import { depositCgk } from "./bootApproval.js";

const PREFIX = "flagship.cgkDeposit.";

function key(serverDomain) {
  return PREFIX + String(serverDomain).toLowerCase();
}

/** Record that the CGK was accepted by `.com` for this box — the idempotency marker. */
export function markCgkDeposited(serverDomain) {
  try {
    localStorage.setItem(key(serverDomain), "deposited");
  } catch {
    /* private mode / quota — the next reconcile retries (harmless re-deposit) */
  }
}

/** Clear the record (e.g. the box was decommissioned). */
export function clearCgkDeposit(serverDomain) {
  try {
    localStorage.removeItem(key(serverDomain));
  } catch {
    /* ignore */
  }
}

/** True iff the CGK was already deposited for this box. */
export function isCgkDeposited(serverDomain) {
  try {
    return localStorage.getItem(key(serverDomain)) === "deposited";
  } catch {
    return false;
  }
}

/**
 * Deposit the CGK for a box that has registered (carrying `identityPubKeyHex`) —
 * UNLESS it was already deposited for this box. No-op otherwise. Best-effort +
 * idempotent: marks `deposited` only after `.com` accepts it; a failure leaves no
 * marker so the next reconcile retries (gossip stays dark meanwhile, never bricked).
 *
 * @param {{ serverDomain: string, identityPubKeyHex: string }} args
 * @param {{ depositCgk?: Function, deriveCgk?: Function }} [deps]  (test seams)
 */
export async function depositCgkIfNeeded(args, deps = {}) {
  const { serverDomain, identityPubKeyHex } = args;
  if (!serverDomain || !identityPubKeyHex) return;
  if (isCgkDeposited(serverDomain)) return;
  const session = getSession();
  if (!session?.umk || !session?.username) return; // locked / signed out

  const doDeriveCgk = deps.deriveCgk || deriveCgkFromSeed;
  const doDeposit = deps.depositCgk || depositCgk;
  try {
    // The per-cloud CGK — same deterministic HKDF the box's gossip keys off (no
    // serverId). The box can't derive it (no UMK).
    const cgkHex = await doDeriveCgk(session.umk);
    await doDeposit({
      serverDomain,
      stkPubHex: String(identityPubKeyHex).toLowerCase(),
      cgkHex,
    });
    markCgkDeposited(serverDomain);
  } catch {
    // Leave no marker so the next reconcile retries.
  }
}
