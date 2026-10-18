/**
 * What the admin devices hear when a copy of the server's data is taken
 * (docs/data-sovereignty.md): an `AlertInbox` entry that says which kind, and
 * a content-free push (category `generic`, an opaque body) that wakes the
 * phones to read it, at most once a minute. Nothing that leaves the box says
 * what was copied, by whom or from where. The Activity log already holds the
 * authoritative line for each event on the box itself, so a `.com` that drops
 * the push only delays the news.
 */
import type { PhoneAlert } from "../phoneAlerts.js";

export interface ExportNoticeDeps {
  alert: (a: Extract<PhoneAlert, { kind: "backup-exported" }>) => void;
  wake?: () => Promise<unknown>;
  minPushIntervalMs?: number;
  now?: () => number;
}

export function exportNotice(d: ExportNoticeDeps): (e: { stage: "rescue-opened" | "downloaded" | "browser-approved"; by?: string; ref?: string }) => void {
  const now = d.now ?? Date.now;
  const minInterval = d.minPushIntervalMs ?? 60_000;
  let lastPush = -Infinity;
  return (e) => {
    d.alert({ kind: "backup-exported", serviceId: "", stage: e.stage, by: e.by ?? "", ref: e.ref ?? "", at: now() });
    if (!d.wake) return;
    const t = now();
    if (t - lastPush < minInterval) return;
    lastPush = t;
    void d.wake().catch(() => {});
  };
}
