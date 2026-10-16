/**
 * A build's own disk limit (docs/app-runtimes.md §5.3). A `docker build`
 * writes its layers to Docker's own storage, which no per-app image can
 * hold, so the box watches the disk while it runs and stops the build when
 * it has added more than `quotaBytes`, or when the disk reaches the brake.
 */
import { BRAKE_ON, BUILD_DISK_QUOTA_BYTES, usedFraction, type DiskUse } from "./limits.js";
import { formatBytes } from "./notices.js";

/** Start watching; `exceeded` is called once with the owner's sentence. Returns stop. */
export type BuildDiskWatch = (exceeded: (reason: string) => void) => () => void;

export function buildDiskWatcher(opts: {
  disk: () => Promise<DiskUse | null>;
  quotaBytes?: number;
  intervalMs?: number;
}): BuildDiskWatch {
  const quota = opts.quotaBytes ?? BUILD_DISK_QUOTA_BYTES;
  const every = opts.intervalMs ?? 2000;
  return (exceeded) => {
    let start: number | null = null;
    let done = false;
    const check = async (): Promise<void> => {
      const d = await opts.disk().catch(() => null);
      if (!d || done) return;
      const used = d.totalBytes - d.availBytes;
      if (start === null) {
        start = used;
        return;
      }
      if (used - start > quota) {
        done = true;
        exceeded(`the build wrote more than ${formatBytes(quota)} to the server's disk, so it was stopped`);
      } else if (usedFraction(d) >= BRAKE_ON) {
        done = true;
        exceeded("the server's disk is nearly full, so the build was stopped");
      }
    };
    void check();
    const timer = setInterval(() => void check(), every);
    (timer as { unref?: () => void }).unref?.();
    return () => {
      done = true;
      clearInterval(timer);
    };
  };
}
