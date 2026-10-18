/**
 * Leftover installer logs. The `/api/dev/late-log/<label>` endpoint and the
 * installers' posts to it are gone (GA close-out 5); this only deletes the
 * `late-log/` chunks it already stored in ISO_TEMP_BUCKET once they pass the
 * old TTL. Delete this file, its cron call in scheduled.ts and its test on or
 * after 2026-10-31, when every chunk the last write could have left has expired.
 */

export const LATE_LOG_PREFIX = "late-log/";
export const LATE_LOG_TTL_DAYS = 7;

export interface LateLogBucket {
  list(options: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated?: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

const KEY_RE = /^late-log\/[A-Za-z0-9._-]{1,128}\/(\d{13})-[a-z0-9]+\.txt$/;

/** Delete installer-log chunks older than the TTL. Returns how many went. */
export async function pruneLateLogs(bucket: LateLogBucket, now: Date): Promise<number> {
  const cutoff = now.getTime() - LATE_LOG_TTL_DAYS * 86_400_000;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: LATE_LOG_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    const stale = (page.objects ?? [])
      .map((o) => o.key)
      .filter((k) => {
        const m = k.match(KEY_RE);
        return m ? Number(m[1]) < cutoff : false;
      });
    if (stale.length > 0) {
      await bucket.delete(stale);
      deleted += stale.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
