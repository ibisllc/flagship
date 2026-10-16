import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Replace one file through `<path>.tmp`, one write at a time. Two overlapping
 * writes through the same temp name both truncate it and both write from
 * offset 0, so the file left behind can be a torn mix of the two, and the
 * second rename fails with ENOENT. Each write takes its snapshot when its turn
 * comes, so the last write to finish holds the latest state. A failed write is
 * reported to its own caller only.
 */
export function serialFileWriter(path: string, snapshot: () => string, mode = 0o600): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const run = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, snapshot(), { mode });
      await rename(tmp, path);
    });
    tail = run.catch(() => {});
    return run;
  };
}
