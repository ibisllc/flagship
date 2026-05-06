/**
 * Daemon-side outbox for events the phone needs to see (lineage break,
 * manual-pull approval pending, migration failed, etc.).
 *
 * The Flagship trust model has the phone always *initiating* contact —
 * the daemon never pushes to the phone. So "alert" really means "an
 * event that was queued here, waiting for the next time the phone
 * polls." The phone-paired session calls a daemon endpoint to drain
 * the queue (HTTP polling lives outside this module — see the
 * `phone_server_protocol.md` design note).
 *
 * v1 stays in-memory. The queue is small (capped at 100 events) and
 * loss-on-restart is acceptable: every alert source can re-emit on
 * its next tick (UpdateClient's pull schedule is every 6h, so a
 * lineage-break alert that was lost would re-appear within the next
 * pull cycle).
 *
 * For lineage-break alerts specifically we de-dupe on (appId, kind,
 * upstreamTip) so a daemon polling every 6h doesn't flood the phone
 * with the same alert until the user resolves it.
 */

import type { PhoneAlert } from "./phoneAlerts.js";

export interface AlertEnvelope {
  /** Monotonic event id assigned by the inbox. */
  id: number;
  /** When the alert was queued. */
  emittedAt: number;
  alert: PhoneAlert;
}

export interface AlertInbox {
  /** Queue an alert. Returns the assigned id; null if de-duplicated. */
  emit(alert: PhoneAlert): number | null;
  /** Drain — return all alerts since `sinceId` (exclusive), in id order. */
  list(sinceId?: number): AlertEnvelope[];
  /** Acknowledge / remove alerts up to and including this id. */
  ack(throughId: number): void;
  /** Pending count. */
  size(): number;
}

const MAX_INBOX = 100;

export class InMemoryAlertInbox implements AlertInbox {
  private nextId = 1;
  private events: AlertEnvelope[] = [];
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  emit(alert: PhoneAlert): number | null {
    if (this.isDuplicate(alert)) return null;
    if (this.events.length >= MAX_INBOX) {
      // Drop oldest to make room. Keeps unbounded daemons from leaking.
      this.events.shift();
    }
    const env: AlertEnvelope = {
      id: this.nextId++,
      emittedAt: this.now(),
      alert,
    };
    this.events.push(env);
    return env.id;
  }

  list(sinceId?: number): AlertEnvelope[] {
    const since = sinceId ?? 0;
    return this.events.filter((e) => e.id > since).map((e) => ({ ...e }));
  }

  ack(throughId: number): void {
    this.events = this.events.filter((e) => e.id > throughId);
  }

  size(): number {
    return this.events.length;
  }

  /**
   * De-dupe rule: for `lineage-break` and `manual-pending` we'd hammer
   * the queue on every poll cycle until the user resolves. So if there's
   * already an unacked event with the same identity (kind + appId +
   * salient field), drop the new one. `migration-failed` is also
   * deduped — re-emitting on every tick would mask other issues.
   */
  private isDuplicate(alert: PhoneAlert): boolean {
    return this.events.some((e) => sameIdentity(e.alert, alert));
  }
}

function sameIdentity(a: PhoneAlert, b: PhoneAlert): boolean {
  if (a.kind !== b.kind || a.appId !== b.appId) return false;
  if (a.kind === "lineage-break" && b.kind === "lineage-break") {
    return a.upstreamTip === b.upstreamTip;
  }
  if (a.kind === "manual-pending" && b.kind === "manual-pending") {
    return a.toCommit === b.toCommit;
  }
  if (a.kind === "migration-failed" && b.kind === "migration-failed") {
    return a.migrationFile === b.migrationFile;
  }
  if (a.kind === "browser-input-needed" && b.kind === "browser-input-needed") {
    // Dedupe per (appId, tabId, inputKind) — re-detection of the same
    // focused field on the same tab shouldn't flood the phone. New
    // input is needed only when the page transitions to a new field
    // (different inputKind) or a different tab focuses something.
    return a.tabId === b.tabId && a.inputKind === b.inputKind;
  }
  return false;
}
