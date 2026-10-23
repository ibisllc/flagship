/**
 * Two of the security sliver's lines (SECURITY-HARDENING-PLAN.md 18.14, N14) that come from state the
 * box already keeps: an account recovery under way (the re-pair watcher's view of `.com`'s pending
 * re-pair), and other servers that have not received a change to an app's access list yet (the
 * access-sync outbox). Each feed turns that state into raise/resolve calls; the sliver keeps the
 * lines, their retention and their notifications.
 */
import type { IssueKind, SecuritySliver, Severity } from "./securitySliver.js";
import type { RePairWatcherState } from "./postRecovery/rePairWatcher.js";

export interface SliverRaise {
  issueKey: string;
  kind: IssueKind;
  severity: Severity;
  target: string;
  summary: string;
  deadline: number | null;
  action: string | null;
}

export interface SliverPlan {
  raise: SliverRaise[];
  resolve: string[];
}

const RECOVERY_KEY = "recovery-attempt";
const RECOVERY_UNVERIFIED_KEY = "recovery-unverified";
const UNVERIFIED_KEEP_MS = 7 * 86_400_000;

/** The recovery lines for what the re-pair watcher last saw. Pure. */
export function recoverySliverPlan(account: string, s: RePairWatcherState | null, now: number): SliverPlan {
  const plan: SliverPlan = { raise: [], resolve: [] };
  const row = s?.lastSeen ?? null;
  const swapped = !!row && !!s?.lastSwapTo && s.lastSwapTo.toLowerCase() === row.newIrkPub.toLowerCase();
  if (row && !row.objectedAt && !swapped) {
    plan.raise.push({
      issueKey: RECOVERY_KEY,
      kind: "recovery-attempt",
      severity: "critical",
      target: account,
      summary:
        row.completesAt > now
          ? "Someone is recovering this account on a new device. When the waiting period ends, the new device takes over and this server's paired devices must pair again."
          : "A recovery of this account finished its waiting period. This server takes the new device key only once it has checked the recovery itself.",
      deadline: row.completesAt,
      action: "If this wasn't you, refuse the recovery from an admin device",
    });
  } else {
    plan.resolve.push(RECOVERY_KEY);
  }
  const u = s?.unverified ?? null;
  if (u && now - u.seenAt < UNVERIFIED_KEEP_MS) {
    plan.raise.push({
      issueKey: RECOVERY_UNVERIFIED_KEY,
      kind: "recovery-attempt",
      severity: "high",
      target: account,
      summary: "The control server says a recovery of this account finished, but this server could not verify it, so nothing changed here.",
      deadline: u.seenAt + UNVERIFIED_KEEP_MS,
      action: "Check Account security on an admin device",
    });
  } else {
    plan.resolve.push(RECOVERY_UNVERIFIED_KEY);
  }
  return plan;
}

export interface PendingHandOver {
  peer: string;
  serviceRef: string;
  entries: number;
  /** When the oldest entry still waiting for this peer was first queued. */
  since: number;
}

/** A push that fails for less than this is a blip, not a line. */
export const OFFLINE_REPLICA_AFTER_MS = 10 * 60_000;

/**
 * One line per app whose access-list change has waited at least OFFLINE_REPLICA_AFTER_MS for another
 * server; `known` names the apps that had a line, so one that caught up resolves. Pure.
 */
export function offlineReplicaSliverPlan(pending: PendingHandOver[], known: Iterable<string>, now: number): SliverPlan {
  const plan: SliverPlan = { raise: [], resolve: [] };
  const byRef = new Map<string, PendingHandOver[]>();
  for (const p of pending) {
    if (now - p.since < OFFLINE_REPLICA_AFTER_MS) continue;
    const l = byRef.get(p.serviceRef) ?? [];
    l.push(p);
    byRef.set(p.serviceRef, l);
  }
  for (const [ref, ps] of byRef) {
    const peers = [...new Set(ps.map((p) => p.peer))].sort();
    plan.raise.push({
      issueKey: `offline-replicas:${ref}`,
      kind: "offline-replicas",
      severity: "moderate",
      target: ref,
      summary: `A change to who can use this app has not reached ${peers.length === 1 ? "another server" : `${peers.length} other servers`} yet (${peers.join(", ")}). Until it does, ${peers.length === 1 ? "that server keeps" : "they keep"} the old list.`,
      deadline: null,
      action: peers.length === 1 ? "Start that server, or remove it" : "Start those servers, or remove them",
    });
  }
  for (const ref of known) if (!byRef.has(ref)) plan.resolve.push(`offline-replicas:${ref}`);
  return plan;
}

export async function applySliverPlan(sliver: Pick<SecuritySliver, "raise" | "resolve">, plan: SliverPlan): Promise<void> {
  for (const r of plan.raise) await sliver.raise(r);
  for (const k of plan.resolve) await sliver.resolve(k);
}
