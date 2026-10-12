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
 * gets here. A suggested list (a draft made from the manifest's
 * `network.egress`) alerts the same way.
 */
import type { EgressSuggestion } from "@flagship/protocol";
import type { AccessDraft, AppAccessStore } from "./accessStore.js";

/** The alert-limit key a draft counts under (never a host name). */
const DRAFT_ALERT_KEY = "(draft)";

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
    /**
     * At install and on each update: the manifest's suggested hosts become a
     * draft list when one is new (AppAccessStore.draftFromDeclared). A draft
     * alerts like a request does.
     */
    async onDeclared(serviceId: string, suggestions: readonly EgressSuggestion[]): Promise<AccessDraft | null> {
      const appName = opts.appName(serviceId);
      if (appName === null || suggestions.length === 0) return null;
      const draft = await opts.store.draftFromDeclared(serviceId, suggestions);
      if (!draft) return null;
      emit({ type: "access-request", serviceId });
      const sinks = opts.sinks();
      if (sinks.alertsEnabled?.() !== false && sinks.push && opts.store.takeAlert(serviceId, DRAFT_ALERT_KEY)) {
        const push = sinks.push;
        void Promise.resolve()
          .then(push)
          .catch((e: Error) => log(`[egress] access alert push failed: ${e.message}`));
      }
      return draft;
    },
  };
}
