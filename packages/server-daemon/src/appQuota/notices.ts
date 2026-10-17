/**
 * What the owner hears when an app fills up (docs/app-runtimes.md §5.3): an
 * Activity entry, an `app-storage-full` phone alert, and a content-free
 * push (category `generic`, an opaque body) that wakes the phone to read
 * it, at most once per `minPushIntervalMs`. Nothing that leaves the box
 * says which app or how much.
 */
import type { BrakeState } from "./limits.js";
import type { AppQuotaManagerOptions, QuotaEvent } from "./manager.js";

export interface QuotaNoticeDeps {
  note: (kind: string, detail: string, opts: { ok?: boolean; target?: string }) => void;
  alert?: (a: { kind: "app-storage-full"; serviceId: string; store: "files" | "postgres" }) => void;
  wake?: () => Promise<unknown>;
  minPushIntervalMs?: number;
  now?: () => number;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

function what(e: QuotaEvent): string {
  return e.store === "files" ? "files folder" : "database";
}

export function quotaNotices(d: QuotaNoticeDeps): Pick<AppQuotaManagerOptions, "onFull" | "onRoom" | "onBrake"> {
  const now = d.now ?? Date.now;
  const minInterval = d.minPushIntervalMs ?? 10 * 60_000;
  let lastPush = -Infinity;
  const wake = () => {
    if (!d.wake) return;
    const t = now();
    if (t - lastPush < minInterval) return;
    lastPush = t;
    void d.wake().catch(() => {});
  };
  return {
    onFull: (e) => {
      const limit = e.limitBytes !== null ? ` of ${formatBytes(e.limitBytes)}` : "";
      const effect =
        e.store === "files" ? "it can't save more files" : "it can read and delete, but can't add or change data";
      d.note("app.storage.full", `Its ${what(e)} is full (${formatBytes(e.usedBytes)}${limit}): ${effect} until there's room.`, {
        ok: false,
        target: e.serviceId,
      });
      d.alert?.({ kind: "app-storage-full", serviceId: e.serviceId, store: e.store });
      wake();
    },
    onRoom: (e) => {
      d.note("app.storage.room", `Its ${what(e)} has room again.`, { target: e.serviceId });
    },
    onBrake: (state: BrakeState, prev: BrakeState) => {
      if (state === "off") {
        d.note("server.disk.room", "The server's disk has room again: apps can save as usual.", {});
        return;
      }
      if (prev === "off" || state === "hard") {
        d.note(
          "server.disk.full",
          state === "hard"
            ? "The server's disk is 95% full: apps' files folders are read-only until space is freed."
            : "The server's disk is 90% full: apps can't save more until space is freed.",
          { ok: false },
        );
        wake();
      }
    },
  };
}
