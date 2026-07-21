// "Set as preferred server" owner-vote — webapp client
// (docs/multi-pod-liveness-session-leadership.md, Phase 6).
//
// There is NO global "leader of all servers" — only per-service leads (computed
// by clout) plus a frontend "preferred server" default the owner picks. The owner
// vote is the `flagship/set-leader/v1` envelope: owner IRK over
// (user|preferredStkPubHex|issuedAt|nonce), naming the selected pod's STK. It is
// DEPOSITED on `.com`'s set-leader lane addressed to the pod's domain; the box
// rides it on its gossip frame (newest vote = highest clout). The actual signing +
// deposit lives in bootApproval.js `depositSetLeader` (the `{auth,…}` mailbox
// wrapper, byte-identical to the SWK/CGK deposits + the @flagship/protocol
// canonical bytes). This module:
//   - resolves the selected pod's STK from the directory (the vote payload),
//   - records the preferred pod locally so the UI flips immediately, and
//   - exposes a thin `setPreferredServer` the view calls.

import { getSession } from "./state.js";
import { depositSetLeader } from "./bootApproval.js";
import { controlApex } from "./apex.js";

const PREFERRED_KEY = "flagship.preferredServer";

/** Record (locally) which server FQDN the owner chose as preferred — so the UI
 *  shows it as preferred immediately, before the gossip round propagates. */
export function markPreferredServer(serverDomain) {
  try {
    localStorage.setItem(PREFERRED_KEY, String(serverDomain).toLowerCase());
  } catch {
    /* private mode / quota — the vote still lands; only the local hint is lost */
  }
}

/** The locally-recorded preferred server FQDN (lowercased), or "" if none. */
export function getPreferredServer() {
  try {
    return localStorage.getItem(PREFERRED_KEY) || "";
  } catch {
    return "";
  }
}

/** True iff `serverDomain` is the locally-recorded preferred server. */
export function isPreferredServer(serverDomain) {
  return getPreferredServer() === String(serverDomain).toLowerCase();
}

/**
 * Resolve a registered pod's STK pubkey (its directory identity pub) from
 * `/api/users/:u/pods`. The set-leader vote names this STK as `preferredStkPubHex`.
 * Returns the lowercased hex, or "" if the box isn't in the directory yet.
 *
 * @param {string} serverDomain
 * @param {{ fetch?: typeof fetch, comBase?: string }} [deps]
 */
export async function resolvePodStk(serverDomain, deps = {}) {
  const session = getSession();
  const username = session?.username;
  if (!username) return "";
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const want = String(serverDomain).toLowerCase();
  const resp = await f(
    `${comBase}/api/users/${encodeURIComponent(username)}/pods`,
    { cache: "no-store" },
  );
  if (!resp.ok) return "";
  const body = await resp.json().catch(() => ({}));
  for (const p of body.pods ?? []) {
    if (
      p.revokedAt == null &&
      String(p.serverDomain ?? "").toLowerCase() === want &&
      p.identityPubKey
    ) {
      return String(p.identityPubKey).toLowerCase();
    }
  }
  return "";
}

/**
 * Set `serverDomain` as the owner's preferred server: resolve its STK from the
 * directory, sign + deposit the owner-IRK set-leader vote (addressed to that
 * pod), and record it locally so the UI flips immediately.
 *
 * @param {{ serverDomain: string }} args
 * @param {{ fetch?: typeof fetch, comBase?: string, signWithIrk?: Function, now?: () => number, depositSetLeader?: Function, resolvePodStk?: Function }} [deps]
 */
export async function setPreferredServer(args, deps = {}) {
  const { serverDomain } = args;
  const session = getSession();
  if (!session?.username) throw new Error("sign in first");
  if (!session?.umk) throw new Error("unlock the webapp first");

  const doResolve = deps.resolvePodStk || resolvePodStk;
  const doDeposit = deps.depositSetLeader || depositSetLeader;
  const stkHex = await doResolve(serverDomain, deps);
  if (!stkHex) {
    throw new Error("this server isn't registered yet — wait for it to come online");
  }
  await doDeposit(
    { serverDomain: String(serverDomain), preferredStkPubHex: stkHex },
    deps,
  );
  markPreferredServer(serverDomain);
  return { ok: true, preferredStkPubHex: stkHex };
}
