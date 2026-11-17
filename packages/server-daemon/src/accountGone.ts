// When `.com` says the box's account no longer exists (docs/account-gone.md: `404 account-not-found`).
//
// A box whose account was deleted keeps running: each poller asked `.com` again on its own interval, every
// BoxReadToken minted again on every read, and each answer was charged to the account-resolve budget (rate check
// 2026-11-13, journal F15: thousands of refusals a month from boxes of removed accounts). After one such answer the
// box holds every read and write about its account for a while, growing from 15 minutes to 6 hours, and answers
// them locally with the same 404; any other answer from `.com` for the account ends the hold.

const FIRST_HOLD_MS = 15 * 60_000;
const MAX_HOLD_MS = 6 * 60 * 60_000;

export const ACCOUNT_GONE_CODE = "account-not-found";

interface Hold {
  until: number;
  lengthMs: number;
}

export class AccountGoneGate {
  private readonly holds = new Map<string, Hold>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True while calls about `username` stay on the box. */
  held(username: string): boolean {
    const h = this.holds.get(username.toLowerCase());
    return h !== undefined && this.now() < h.until;
  }

  /** How long the current hold lasts (0 when none), for logs and tests. */
  holdMs(username: string): number {
    return this.held(username) ? this.holds.get(username.toLowerCase())!.lengthMs : 0;
  }

  /** `.com` answered account-not-found: hold, twice as long as the last hold each time it says so again. */
  noteGone(username: string): void {
    const key = username.toLowerCase();
    const prev = this.holds.get(key);
    const lengthMs = prev ? Math.min(prev.lengthMs * 2, MAX_HOLD_MS) : FIRST_HOLD_MS;
    this.holds.set(key, { until: this.now() + lengthMs, lengthMs });
  }

  /** `.com` answered something else for the account: it exists. */
  noteAlive(username: string): void {
    this.holds.delete(username.toLowerCase());
  }

  /** Read a `.com` answer about `username`: a 404 whose code is account-not-found starts or lengthens the hold. */
  async observe(username: string, res: Response): Promise<void> {
    if (res.status !== 404) {
      if (res.status < 500 && res.status !== 429) this.noteAlive(username);
      return;
    }
    try {
      const body = (await res.clone().json()) as { code?: unknown };
      if (body?.code === ACCOUNT_GONE_CODE) this.noteGone(username);
    } catch {
      /* a 404 without the code is some other missing thing */
    }
  }

  /** The answer a held call gets: what `.com` said last. */
  static localAnswer(): Response {
    return new Response(JSON.stringify({ error: ACCOUNT_GONE_CODE, code: ACCOUNT_GONE_CODE }), {
      status: 404,
      headers: { "content-type": "application/json", "x-flagship-account-gone": "held" },
    });
  }
}

/** One gate for the whole daemon: every BoxReadToken and the doorbell share it. */
export const accountGoneGate = new AccountGoneGate();

/** The account a `.com` path is about (`/api/users/<u>/…`, `/api/accounts/<u>/…`), lower-cased, or null. */
export function accountOfPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/(?:users|accounts)\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toLowerCase();
  } catch {
    return null;
  }
}
