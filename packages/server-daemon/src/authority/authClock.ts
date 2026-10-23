/**
 * Time that privileged deadlines may rely on (SECURITY-HARDENING-PLAN.md 18.5, N05/N07).
 *
 * Wall-clock time can be set by anyone with a shell and by NTP or an HTTP Date header an attacker
 * answers. So deadlines are never read from it. Instead the box anchors to an AUTHENTICATED time
 * (a signed `.com` response, a lease from a verified peer) and counts forward with the monotonic
 * clock. After a restart the monotonic clock is gone, so the box has no trusted time until it
 * observes a new authenticated one: time-sensitive authority pauses, and local owner control goes on.
 */
export interface AuthClockOptions {
  /** Monotonic milliseconds (process.hrtime based in production). */
  mono: () => number;
}

export class AuthClock {
  private anchor: { authMs: number; monoMs: number } | null = null;
  /** The highest authenticated time ever observed in this process: it never goes back. */
  private high = 0;

  constructor(private readonly opts: AuthClockOptions) {}

  /**
   * Record an authenticated time. An observation older than what we already know is ignored (a
   * replayed signed response cannot wind the clock back); a newer one re-anchors.
   */
  observe(authMs: number): void {
    const estimate = this.now();
    if (estimate !== null && authMs < estimate - 1_000) return;
    if (authMs < this.high) return;
    this.high = authMs;
    this.anchor = { authMs, monoMs: this.opts.mono() };
  }

  /** The trusted time, or null when none has been observed since this process started. */
  now(): number | null {
    if (!this.anchor) return null;
    return this.anchor.authMs + (this.opts.mono() - this.anchor.monoMs);
  }

  get synced(): boolean {
    return this.anchor !== null;
  }
}
