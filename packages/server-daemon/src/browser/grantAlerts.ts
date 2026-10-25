/**
 * What happens when an app asks for browser access beyond its manifest (grantRequests.ts): like an
 * internet-access request (egress/accessAlerts.ts), an open owner app hears it on the screens socket
 * (`{type:"browser-grant-request", serviceId}`) and the owner's phone gets a content-free `generic`
 * push through `.com`'s relay, saying nothing about which app or which sites. The details come from
 * `GET /api/browser/owner/grant-requests` over the paired session. With the owner's alerts switch off
 * no push is sent. At most one push per app every ten minutes and five an hour per box, so an app
 * that keeps asking cannot keep waking the phone (the box already holds at most five asks per app
 * and cools down a denied one).
 */

export interface BrowserGrantRequestEvent {
  type: "browser-grant-request";
  serviceId: string;
}

export interface BrowserGrantAlertSinks {
  emit?: (e: BrowserGrantRequestEvent) => void;
  push?: () => Promise<unknown> | void;
  alertsEnabled?: () => boolean;
}

const PER_APP_MS = 10 * 60_000;
const PER_HOUR = 5;

export function buildBrowserGrantAlerts(o: { sinks: () => BrowserGrantAlertSinks; now?: () => number; log?: (m: string) => void }) {
  const now = o.now ?? (() => Date.now());
  const lastByApp = new Map<string, number>();
  let recent: number[] = [];
  return function onGrantRequest(serviceId: string): void {
    const sinks = o.sinks();
    try {
      sinks.emit?.({ type: "browser-grant-request", serviceId });
    } catch {
      // a dead socket must not lose the request
    }
    if (!sinks.push || sinks.alertsEnabled?.() === false) return;
    const t = now();
    if (t - (lastByApp.get(serviceId) ?? -Infinity) < PER_APP_MS) return;
    recent = recent.filter((x) => t - x < 3_600_000);
    if (recent.length >= PER_HOUR) return;
    lastByApp.set(serviceId, t);
    recent.push(t);
    const push = sinks.push;
    void Promise.resolve()
      .then(push)
      .catch((e: Error) => o.log?.(`[browser] grant request push failed: ${e.message}`));
  };
}
