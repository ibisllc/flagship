/**
 * Single-use WebSocket upgrade tickets (SECURITY-HARDENING-PLAN.md 18.6, N06).
 *
 * A browser cannot set headers on `new WebSocket()`, so the long-lived session token used to ride
 * in the URL, where proxies and logs keep it. Now the client asks for a ticket over an
 * authenticated request and puts only the ticket in the URL. A ticket is random, lives 30
 * seconds, is bound to one route and to the Origin that asked, and is consumed atomically by the
 * first upgrade that presents it. It exists only in this process's memory.
 */
import { randomBytes } from "node:crypto";

export const TICKET_TTL_MS = 30_000;
const MAX_OPEN = 512;

interface Entry {
  token: string;
  route: string;
  origin: string;
  expiresAt: number;
}

export class UpgradeTicketStore {
  private tickets = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Mint a ticket for `route` (a path without its query) for the session `token`. */
  issue(args: { token: string; route: string; origin: string | null }): string {
    this.sweep();
    if (this.tickets.size >= MAX_OPEN) {
      // Drop the oldest rather than refuse: tickets are 30 seconds long and cheap to re-ask for.
      const oldest = this.tickets.keys().next().value;
      if (oldest !== undefined) this.tickets.delete(oldest);
    }
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { token: args.token, route: args.route, origin: args.origin ?? "", expiresAt: this.now() + TICKET_TTL_MS });
    return ticket;
  }

  /** Consume a ticket. It is gone whether or not it matched, so a wrong guess cannot be retried. */
  consume(ticket: string, route: string, origin: string | null): string | null {
    const e = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!e) return null;
    if (e.expiresAt <= this.now()) return null;
    if (e.route !== route) return null;
    if (e.origin !== (origin ?? "")) return null;
    return e.token;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.tickets) if (e.expiresAt <= t) this.tickets.delete(k);
  }
}

/** The stream routes a ticket may be minted for. */
export const TICKETABLE_ROUTES: RegExp[] = [
  /^\/api\/screens\/vibe-code\/[^/]+\/stream$/,
  /^\/api\/screens\/browser-tabs\/[^/]+\/stream$/,
  /^\/api\/screens\/events$/,
];

export function isTicketableRoute(route: string): boolean {
  return TICKETABLE_ROUTES.some((re) => re.test(route));
}
