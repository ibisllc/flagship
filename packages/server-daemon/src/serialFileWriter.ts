import { withFileLock } from "./durableFile.js";

/**
 * A store's "save now": each call queues one durable replace of `path` (see
 * durableFile.ts), and takes its snapshot when its turn comes, so the last
 * write to finish holds the latest state. A failed write is reported to its
 * own caller only.
 */
export function serialFileWriter(path: string, snapshot: () => string, mode = 0o600): () => Promise<void> {
  return () => withFileLock(path, (write) => write(snapshot(), mode));
}
