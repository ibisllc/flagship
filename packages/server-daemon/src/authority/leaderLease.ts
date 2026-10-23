/**
 * An exclusive lead term for cross-user work (SECURITY-HARDENING-PLAN.md 18.7, N07).
 *
 * The highest gossip rank is not a lead: two partitioned boxes can each believe they are it. A
 * lead term here needs a majority of an explicit membership to grant it a lease, a voter grants
 * one lease at a time (leases never overlap), and the lead may act only until the earliest expiry
 * in its majority minus a drift margin. Loss of quorum ends the term; planned handover has the old
 * lead release so the next can be granted at once. A singleton persists its term locally.
 *
 * Voter state (highest term seen, who holds its lease, until when) is kept outside restored app
 * data. A voter that loses it must not vote until its last possible lease has run out.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { keepCorruptAside, readStateFile, withFileLock } from "../durableFile.js";

export interface VoterState {
  highestTerm: number;
  holder: string | null;
  /** Authenticated-time ms at which the lease this voter granted ends. */
  leaseUntil: number;
}

export type GrantResult = { granted: true; leaseUntil: number } | { granted: false; reason: "old-term" | "leased-to-another" | "recovering" };

export class LeaseVoter {
  private state: VoterState = { highestTerm: 0, holder: null, leaseUntil: 0 };
  /** After losing its state a voter stays silent until every lease it could have granted has ended. */
  private silentUntil = 0;

  constructor(
    readonly id: string,
    private readonly path: string,
    private readonly now: () => number | null,
    private readonly maxLeaseMs: number,
  ) {}

  async load(): Promise<void> {
    const read = await readStateFile(this.path);
    if (read.kind === "missing") return;
    try {
      if (read.kind === "unreadable") throw read.error;
      const s = JSON.parse(read.text) as VoterState;
      if (!Number.isSafeInteger(s.highestTerm) || typeof s.leaseUntil !== "number") throw new Error("not voter state");
      this.state = s;
    } catch (e) {
      await keepCorruptAside(this.path, e, "This server will not vote for a leader until any lease it granted must have ended.");
      const t = this.now();
      this.silentUntil = (t ?? Date.now()) + this.maxLeaseMs;
    }
  }

  get snapshot(): VoterState {
    return { ...this.state };
  }

  /** Grant `candidate` a lease for `term`, unless another holder's lease is still running. */
  async grant(candidate: string, term: number, leaseMs: number): Promise<GrantResult> {
    const t = this.now();
    if (t === null || t < this.silentUntil) return { granted: false, reason: "recovering" };
    if (term < this.state.highestTerm) return { granted: false, reason: "old-term" };
    const others = this.state.holder !== null && this.state.holder !== candidate && t < this.state.leaseUntil;
    if (others && term <= this.state.highestTerm) return { granted: false, reason: "leased-to-another" };
    // A higher term does not cancel a running lease granted to someone else: leases never overlap.
    if (others) return { granted: false, reason: "leased-to-another" };
    const leaseUntil = t + Math.min(leaseMs, this.maxLeaseMs);
    this.state = { highestTerm: Math.max(term, this.state.highestTerm), holder: candidate, leaseUntil };
    await this.persist();
    return { granted: true, leaseUntil };
  }

  /** Planned handover: the holder gives its lease back so the next lead can be granted at once. */
  async release(holder: string): Promise<boolean> {
    if (this.state.holder !== holder) return false;
    this.state = { ...this.state, holder: null, leaseUntil: 0 };
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await withFileLock(this.path, (write) => write(JSON.stringify(this.state)));
  }
}

export interface LeaderState {
  term: number;
  /** The earliest lease expiry in the majority, less the drift margin; null = not leading. */
  actUntil: number | null;
}

export class LeaderCandidate {
  private term = 0;
  private acts: number | null = null;

  constructor(
    readonly id: string,
    private readonly members: string[],
    private readonly ask: (member: string, term: number, leaseMs: number) => Promise<GrantResult>,
    private readonly now: () => number | null,
    private readonly opts: { leaseMs: number; driftMs: number },
    private readonly persistTerm?: { load: () => Promise<number>; save: (t: number) => Promise<void> },
  ) {}

  async init(): Promise<void> {
    if (this.persistTerm) this.term = await this.persistTerm.load();
  }

  get state(): LeaderState {
    return { term: this.term, actUntil: this.acts };
  }

  private get majority(): number {
    return Math.floor(this.members.length / 2) + 1;
  }

  /** Try to become (or stay) lead. Returns whether this candidate may act as lead now. */
  async campaign(): Promise<boolean> {
    const t0 = this.now();
    if (t0 === null) {
      this.acts = null;
      return false;
    }
    const nextTerm = this.acts !== null && this.acts > t0 ? this.term : this.term + 1;
    if (this.persistTerm && nextTerm !== this.term) await this.persistTerm.save(nextTerm);
    const results = await Promise.all(this.members.map((m) => this.ask(m, nextTerm, this.opts.leaseMs).catch(() => ({ granted: false, reason: "recovering" }) as GrantResult)));
    const grants = results.filter((r): r is Extract<GrantResult, { granted: true }> => r.granted);
    this.term = nextTerm;
    if (grants.length < this.majority) {
      this.acts = null;
      return false;
    }
    // Act only until the earliest expiry in the majority, less a margin for clock drift, measured
    // from before the requests went out (the lease cannot have started before we asked).
    const earliest = Math.min(...grants.map((g) => g.leaseUntil));
    this.acts = Math.min(earliest - this.opts.driftMs, t0 + this.opts.leaseMs - this.opts.driftMs);
    return this.mayAct();
  }

  /** May cross-user admissions be made right now? */
  mayAct(): boolean {
    const t = this.now();
    return t !== null && this.acts !== null && t < this.acts;
  }

  /** Planned handover: stop acting, and ask every member to release. */
  async stepDown(release: (member: string, holder: string) => Promise<unknown>): Promise<void> {
    this.acts = null;
    await Promise.all(this.members.map((m) => release(m, this.id).catch(() => {})));
  }
}
