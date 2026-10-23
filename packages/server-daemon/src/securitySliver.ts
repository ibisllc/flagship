/**
 * The security sliver's record (SECURITY-HARDENING-PLAN.md 18.14, N14).
 *
 * One line per issue, independent of every other: CA expiry, a recovery attempt, a publisher key
 * waiting for approval, offline replicas delaying a policy, a schema that ran ahead of its code.
 * Each carries a platform-assigned severity (never the app's), the target, a state, when it last
 * changed, and a deadline and action when there is one. Lines are never merged or truncated.
 *
 * A line stays while its issue is active. Once resolved it stays visible for a time that depends
 * on its severity (critical 90 days, high 30, moderate 14, low 7); acknowledging or approving
 * neither shortens nor restarts that. A worse severity is a NEW event rather than an edit, so it is
 * seen as new. Expiry only removes the line from the sliver; the audit record keeps it.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepCorruptAside, readStateFile, withFileLock } from "./durableFile.js";

export type Severity = "critical" | "high" | "moderate" | "low";
const RANK: Record<Severity, number> = { low: 1, moderate: 2, high: 3, critical: 4 };
const DAY = 86_400_000;
export const RETENTION_MS: Record<Severity, number> = { critical: 90 * DAY, high: 30 * DAY, moderate: 14 * DAY, low: 7 * DAY };

export type IssueKind =
  | "ca-expiry"
  | "recovery-attempt"
  | "publisher-key"
  | "publisher-rejected"
  | "offline-replicas"
  | "schema-ahead"
  | "permission-change"
  | "other";

export interface SliverEvent {
  /** Unique per event; an escalation gets a new one. */
  eventId: string;
  /** The issue this event belongs to (stable while the same condition persists). */
  issueKey: string;
  kind: IssueKind;
  severity: Severity;
  /** What it affects: a server, a service, an account. */
  target: string;
  state: "active" | "resolved";
  summary: string;
  raisedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** Epoch ms by which something must happen, and what. */
  deadline: number | null;
  action: string | null;
  acknowledgedAt: number | null;
  /** Set when this event replaced a lower-severity one. */
  escalatedFrom: string | null;
}

export interface SliverLine extends SliverEvent {
  /** Milliseconds left until `deadline`, or null. */
  remainingMs: number | null;
}

interface Persisted {
  v: 1;
  seq: number;
  events: SliverEvent[];
}

export class SecuritySliver {
  private events: SliverEvent[] = [];
  private seq = 0;
  private failedClosed = false;

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const p = JSON.parse(read.text) as Persisted;
      if (p?.v !== 1 || !Array.isArray(p.events)) throw new Error("not a sliver file");
      this.events = p.events;
      this.seq = p.seq;
    } catch (e) {
      await keepCorruptAside(this.path, e, "The security notices list started over; check each service and your recovery settings.");
      this.failedClosed = true;
    }
  }

  /** True when the list was lost and started over, so the sliver says so rather than looking clean. */
  get lostHistory(): boolean {
    return this.failedClosed;
  }

  /**
   * Raise an issue, or refresh the active one with the same key. A higher severity ends the old
   * event and starts a new one; the same or lower severity just updates the line. Returns whether
   * a notification is warranted (a new issue or an escalation, never an unchanged condition).
   */
  async raise(i: { issueKey: string; kind: IssueKind; severity: Severity; target: string; summary: string; deadline?: number | null; action?: string | null }): Promise<{ event: SliverEvent; notify: boolean }> {
    const t = this.now();
    const active = this.events.find((e) => e.issueKey === i.issueKey && e.state === "active");
    if (active) {
      if (RANK[i.severity] > RANK[active.severity]) {
        active.state = "resolved";
        active.resolvedAt = t;
        active.updatedAt = t;
        const next = this.make(i, t, active.eventId);
        this.events.push(next);
        await this.persist();
        return { event: { ...next }, notify: true };
      }
      const changed = active.summary !== i.summary || active.deadline !== (i.deadline ?? null) || active.action !== (i.action ?? null);
      if (changed) {
        active.summary = i.summary;
        active.deadline = i.deadline ?? null;
        active.action = i.action ?? null;
        active.updatedAt = t;
        await this.persist();
      }
      return { event: { ...active }, notify: false };
    }
    const ev = this.make(i, t, null);
    this.events.push(ev);
    await this.persist();
    return { event: { ...ev }, notify: true };
  }

  /** The condition is gone. The line stays for its severity's retention. */
  async resolve(issueKey: string): Promise<boolean> {
    const e = this.events.find((x) => x.issueKey === issueKey && x.state === "active");
    if (!e) return false;
    const t = this.now();
    e.state = "resolved";
    e.resolvedAt = t;
    e.updatedAt = t;
    await this.persist();
    return true;
  }

  /** Mark seen. This does not resolve, shorten retention or change the severity. */
  async acknowledge(eventId: string): Promise<boolean> {
    const e = this.events.find((x) => x.eventId === eventId);
    if (!e) return false;
    e.acknowledgedAt = this.now();
    await this.persist();
    return true;
  }

  /** Lines to show: every active one, and resolved ones still inside their retention. Worst first. */
  lines(): SliverLine[] {
    const t = this.now();
    return this.events
      .filter((e) => e.state === "active" || (e.resolvedAt !== null && t < e.resolvedAt + RETENTION_MS[e.severity]))
      .map((e) => ({ ...e, remainingMs: e.deadline === null ? null : e.deadline - t }))
      .sort((a, b) => Number(b.state === "active") - Number(a.state === "active") || RANK[b.severity] - RANK[a.severity] || b.updatedAt - a.updatedAt);
  }

  /** The full audit history: expiry removes a line from the sliver, never from here. */
  history(): SliverEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  private make(i: { issueKey: string; kind: IssueKind; severity: Severity; target: string; summary: string; deadline?: number | null; action?: string | null }, t: number, from: string | null): SliverEvent {
    return {
      eventId: `sv${++this.seq}`,
      issueKey: i.issueKey,
      kind: i.kind,
      severity: i.severity,
      target: i.target,
      state: "active",
      summary: i.summary,
      raisedAt: t,
      updatedAt: t,
      resolvedAt: null,
      deadline: i.deadline ?? null,
      action: i.action ?? null,
      acknowledgedAt: null,
      escalatedFrom: from,
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body: Persisted = { v: 1, seq: this.seq, events: this.events };
    await withFileLock(this.path, (write) => write(JSON.stringify(body)));
  }
}
