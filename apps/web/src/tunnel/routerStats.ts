/**
 * What the SNI router has done since this machine started, in counters (not a log): how many
 * connections found their box at once, how many waited for a box to claim the name, how many
 * of those were dropped because nobody did (a missed redirection), and which names missed
 * lately. Read by `GET /api/stats` (x-usage-secret) and `npm run ops -- services`.
 * Restarting the machine resets it; nothing is persisted.
 */

export interface MissedName {
  at: string;
  domain: string;
  kind: "hold-timeout" | "no-box-registered" | "no-user";
}

const MAX_MISSED = 20;

class RouterStats {
  routed = 0;
  parked = 0;
  released = 0;
  holdTimeouts = 0;
  noBoxRegistered = 0;
  noUser = 0;
  bad = 0;
  private recent: MissedName[] = [];

  missed(kind: MissedName["kind"], domain: string, now: Date = new Date()): void {
    this.recent.push({ at: now.toISOString(), domain, kind });
    if (this.recent.length > MAX_MISSED) this.recent.shift();
  }

  snapshot(): Record<string, unknown> {
    return {
      routed: this.routed,
      parked: this.parked,
      released: this.released,
      holdTimeouts: this.holdTimeouts,
      noBoxRegistered: this.noBoxRegistered,
      noUser: this.noUser,
      bad: this.bad,
      recentMisses: [...this.recent],
    };
  }

  reset(): void {
    this.routed = this.parked = this.released = this.holdTimeouts = this.noBoxRegistered = this.noUser = this.bad = 0;
    this.recent = [];
  }
}

export const routerStats = new RouterStats();
