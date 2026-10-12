/**
 * Box-wide events for an open owner app, on the screens socket
 * (`GET /api/screens/events`, a WebSocket; paired-session token in
 * `?sessionToken=`; companions may listen). Each frame is one JSON event
 * with a `type`:
 *
 *   { type: "access-request", serviceId }
 *     A live app has a new request for a host its access list doesn't
 *     decide (docs/ai-privacy-and-staging.md §3a); fetch the details from
 *     GET /api/screens/access-requests or .../services/:id/access.
 */
import type { AccessRequestEvent } from "../egress/accessAlerts.js";

export type ScreensEvent = AccessRequestEvent;

export class ScreensEventBus {
  private readonly subs = new Set<(e: ScreensEvent) => void>();

  subscribe(fn: (e: ScreensEvent) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  publish(e: ScreensEvent): void {
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        // one broken subscriber must not starve the rest
      }
    }
  }

  get subscriberCount(): number {
    return this.subs.size;
  }
}
