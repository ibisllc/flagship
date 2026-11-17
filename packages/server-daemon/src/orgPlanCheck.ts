/**
 * The org's Business plan as an org box can prove it (docs/plans-and-backup-offer.md "As built"): the newest
 * CA-signed `flagship/org-plan-attestation/v1` from `GET /api/orgs/<orgId>/plan-attestation`, verified through the
 * same CA chain as every CA artifact and kept on disk so a restart works offline.
 *
 * What the box enforces with it, as a backstop to `.com`'s own gate:
 *   - a seat that is new to this box is admitted only while the plan allows a new seat (trial or paid, under the
 *     seat limit; or granted before the org lapsed);
 *   - a directory connector proposes no new person while the org has lapsed (they wait, and are proposed once paid);
 *     removals, role changes and entry updates go on.
 * An attestation that is missing, expired or fails to verify means "plan unknown", which never blocks anything: a
 * box never turns a network failure into a lapse.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_PAYMENTS_CONFIG,
  parseOrgPlanAttestation,
  verifyCaSignedOrgPlanAttestation,
  type CaTrustChain,
  type OrgPlanAttestation,
  type OrgPlanAttestationStatus,
} from "@flagship/protocol";

export type OrgPlanBoxState = OrgPlanAttestationStatus | "unknown";

export interface OrgPlanCheckOptions {
  path: string;
  orgId: string;
  chain: () => CaTrustChain | null;
  /** `GET /api/orgs/<orgId>/plan-attestation`; null on any failure. */
  fetchAttestation: () => Promise<unknown | null>;
  pinnedMandateHash?: string;
  graceMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export class OrgPlanCheck {
  private held: OrgPlanAttestation | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: OrgPlanCheckOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private accept(v: unknown): OrgPlanAttestation | null {
    const a = parseOrgPlanAttestation(v);
    if (!a || a.orgId !== this.opts.orgId) return null;
    const ok =
      this.opts.pinnedMandateHash !== undefined
        ? verifyCaSignedOrgPlanAttestation(a, this.opts.chain(), this.now(), this.opts.pinnedMandateHash)
        : verifyCaSignedOrgPlanAttestation(a, this.opts.chain(), this.now());
    if (!ok.ok) {
      this.opts.log?.(`[org-plan] attestation refused: ${ok.reason}`);
      return null;
    }
    return a;
  }

  async load(): Promise<void> {
    try {
      this.held = this.accept(JSON.parse(await readFile(this.opts.path, "utf8")));
    } catch {
      this.held = null;
    }
  }

  async refresh(): Promise<OrgPlanBoxState> {
    const got = await this.opts.fetchAttestation().catch(() => null);
    const a = got ? this.accept(got) : null;
    if (a && (!this.held || a.issuedAt > this.held.issuedAt)) {
      this.held = a;
      await this.persist(a);
    }
    return this.state();
  }

  private inDate(): OrgPlanAttestation | null {
    const a = this.held;
    const now = this.now();
    return a && now >= a.issuedAt && now < a.expiresAt ? a : null;
  }

  state(): OrgPlanBoxState {
    return this.inDate()?.status ?? "unknown";
  }

  /** When the org lapsed (or will): the trial's end, or the paid end plus the grace, whichever is later. */
  private lapsesAt(a: OrgPlanAttestation): number {
    const grace = this.opts.graceMs ?? DEFAULT_PAYMENTS_CONFIG.graceHours * 3_600_000;
    return Math.max(a.trialEndsAt, a.paidSeats > 0 ? a.paidUntil + grace : 0);
  }

  /** Whether a seat new to this box, granted at `grantIssuedAt`, may join `liveSeats` live ones. */
  admitsNewSeat(grantIssuedAt: number, liveSeats: number): boolean {
    const a = this.inDate();
    if (!a) return true;
    if (a.status === "lapsed") return grantIssuedAt <= this.lapsesAt(a);
    return liveSeats < a.seatLimit;
  }

  /** Whether a directory connector may propose a new person now. */
  allowsNewPeople(): boolean {
    return this.state() !== "lapsed";
  }

  start(everyMs = 3_600_000): void {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => void this.refresh().catch(() => {}), everyMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async persist(a: OrgPlanAttestation): Promise<void> {
    try {
      await mkdir(dirname(this.opts.path), { recursive: true });
      const tmp = `${this.opts.path}.tmp`;
      await writeFile(tmp, JSON.stringify(a), { mode: 0o600 });
      await rename(tmp, this.opts.path);
    } catch (e) {
      this.opts.log?.(`[org-plan] could not keep the attestation: ${String((e as Error)?.message ?? e)}`);
    }
  }
}

let current: OrgPlanCheck | null = null;

/** The org box's plan check, once the org sync armed it (null on a personal box). */
export function currentOrgPlan(): OrgPlanCheck | null {
  return current;
}

export function setCurrentOrgPlan(c: OrgPlanCheck | null): void {
  current = c;
}
