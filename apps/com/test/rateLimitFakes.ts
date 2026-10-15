import type { RateLimitNamespace } from "../src/rateLimit.js";
import { RateLimitCounter, type RateLimitCounterState } from "../src/rateLimitCounter.js";

function memoryState(): RateLimitCounterState & { alarmAt: number | null } {
  const data = new Map<string, unknown>();
  const state = {
    alarmAt: null as number | null,
    storage: {
      async get<T>(key: string) {
        return data.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T) {
        data.set(key, structuredClone(value));
      },
      async setAlarm(at: number) {
        state.alarmAt = at;
      },
      async deleteAll() {
        data.clear();
      },
    },
  };
  return state;
}

/**
 * A RATE_LIMITS namespace backed by real RateLimitCounter objects in memory.
 * `calls` records every object name hit. `policy`, when given, answers
 * instead of the counter (true = allow).
 */
export function memoryRateLimits(
  opts: {
    now?: () => number;
    policy?: (key: string, callsForKey: number) => boolean;
    fail?: boolean;
  } = {},
): { ns: RateLimitNamespace; calls: string[] } {
  const calls: string[] = [];
  const objects = new Map<string, RateLimitCounter>();
  const perKey = new Map<string, number>();
  const ns: RateLimitNamespace = {
    idFromName: (name) => name,
    get: (id: never) => ({
      async fetch(request: Request) {
        const key = id as unknown as string;
        calls.push(key);
        if (opts.fail) throw new Error("counter unreachable");
        if (opts.policy) {
          const n = (perKey.get(key) ?? 0) + 1;
          perKey.set(key, n);
          const ok = opts.policy(key, n);
          return Response.json({ ok, retryAfterSec: ok ? 0 : 60 });
        }
        let obj = objects.get(key);
        if (!obj) {
          obj = new RateLimitCounter(memoryState(), undefined, opts.now ?? Date.now);
          objects.set(key, obj);
        }
        return obj.fetch(request);
      },
    }),
  };
  return { ns, calls };
}
