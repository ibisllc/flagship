/**
 * What happens when a live app is denied a host no rule in its access list
 * matched (docs/ai-privacy-and-staging.md §3a "Alerts"): the box records a
 * request, tells any open owner app over the screens socket
 * (`{type:"access-request", serviceId}` for a NEW request), and wakes the
 * owner's phone with a push that says nothing about which app or host.
 *
 * The push rides `.com/api/push/relay` (category `generic`, an opaque marker
 * body, so Apple and Google only see that Flagship pinged the phone); the
 * phone fetches the details from the box over its paired session. At most one
 * push per app and host per day and five per hour per box
 * (AppAccessStore.takeAlert). With the owner's alerts switch off
 * (accessAlertSetting.ts) no push is sent at all. An explicit `deny` never
 * gets here.
 */
import type { AccessRequest, AppAccessStore } from "./accessStore.js";

/** The screens-socket frame: which app has a new request; the app then fetches the details. */
export interface AccessRequestEvent {
  type: "access-request";
  serviceId: string;
}

export interface AccessAlertSinks {
  /** Wake the owner's phone. Carries nothing about the app or host. */
  push?: () => Promise<unknown> | void;
  /** The owner's alerts switch; false means never push (requests and socket events still happen). */
  alertsEnabled?: () => boolean;
  /** The screens-socket `access-request` event. */
  emit?: (e: AccessRequestEvent) => void;
}

export interface AccessRequestRecorderOptions {
  store: AppAccessStore;
  /** The installed app's name; null when the container isn't an installed app. */
  appName: (serviceId: string) => string | null;
  sinks: () => AccessAlertSinks;
  log?: (m: string) => void;
}

export function buildAccessRequestRecorder(opts: AccessRequestRecorderOptions) {
  const log = opts.log ?? (() => {});
  const emit = (e: AccessRequestEvent) => {
    try {
      opts.sinks().emit?.(e);
    } catch {
      // a dead socket must not break the gateway
    }
  };

  return {
    /** The gateway's `onUnmatched`. */
    onUnmatched(serviceId: string, host: string): void {
      const appName = opts.appName(serviceId);
      if (appName === null) return;
      const rec = opts.store.recordAttempt(serviceId, host);
      if (!rec) return;
      const sinks = opts.sinks();
      const alertsOn = sinks.alertsEnabled?.() !== false;
      const alert = alertsOn && opts.store.takeAlert(serviceId, rec.request.host);
      if (rec.created) emit({ type: "access-request", serviceId });
      if (alert) {
        const push = sinks.push;
        if (push) {
          void Promise.resolve()
            .then(push)
            .catch((e: Error) => log(`[egress] access alert push failed: ${e.message}`));
        }
      }
    },
    /** At install (and when a new version declares more): the manifest's hosts become requests. */
    async onDeclared(serviceId: string, hosts: readonly string[]): Promise<AccessRequest[]> {
      const appName = opts.appName(serviceId);
      if (appName === null || hosts.length === 0) return [];
      const created = await opts.store.noteDeclared(serviceId, hosts);
      if (created.length > 0) emit({ type: "access-request", serviceId });
      return created;
    },
  };
}
