/**
 * The counter behind every budget in rateLimit.ts: one Durable Object per
 * (endpoint, axis, identifier), so a budget is counted once worldwide and
 * applied exactly as the LIMITS table writes it, whatever the window.
 *
 * Each object keeps a sliding log (the times of the requests it let
 * through) per window. A request passes only if every window has room,
 * and only a passing request is recorded, so a client that keeps
 * retrying gets exactly `limit` per window, never a reset at a boundary.
 * The largest limit is a few hundred, so the log stays small. An alarm
 * clears the object once its longest window has passed with no traffic.
 */

export interface WindowRule {
  limit: number;
  windowSec: number;
}

export interface HitResult {
  ok: boolean;
  /** Seconds until the fullest window frees a slot (0 when ok). */
  retryAfterSec: number;
}

type Logs = Record<string, number[]>;

const LOGS_KEY = "logs";

function ruleKey(rule: WindowRule): string {
  return `${rule.limit}/${rule.windowSec}`;
}

/** Pure core: prune each window, admit only if all have room. */
export function hitWindows(
  logs: Logs,
  rules: readonly WindowRule[],
  now: number,
): { result: HitResult; logs: Logs } {
  const next: Logs = {};
  let retryAfterMs = 0;
  for (const rule of rules) {
    const windowMs = rule.windowSec * 1000;
    const kept = (logs[ruleKey(rule)] ?? []).filter((t) => t > now - windowMs);
    next[ruleKey(rule)] = kept;
    if (kept.length >= rule.limit) {
      const oldestThatMustExpire = kept[kept.length - rule.limit]!;
      retryAfterMs = Math.max(retryAfterMs, oldestThatMustExpire + windowMs - now);
    }
  }
  if (retryAfterMs > 0) {
    return { result: { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) }, logs: next };
  }
  for (const rule of rules) next[ruleKey(rule)]!.push(now);
  return { result: { ok: true, retryAfterSec: 0 }, logs: next };
}

export function isWindowRules(value: unknown): value is WindowRule[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        Number.isInteger((r as WindowRule).limit) &&
        (r as WindowRule).limit > 0 &&
        (r as WindowRule).limit <= 10_000 &&
        Number.isInteger((r as WindowRule).windowSec) &&
        (r as WindowRule).windowSec > 0 &&
        (r as WindowRule).windowSec <= 86_400,
    )
  );
}

export interface RateLimitCounterState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
}

export class RateLimitCounter {
  constructor(
    private readonly state: RateLimitCounterState,
    _env?: unknown,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(request: Request): Promise<Response> {
    let rules: unknown;
    try {
      rules = ((await request.json()) as { rules?: unknown }).rules;
    } catch {
      rules = undefined;
    }
    if (!isWindowRules(rules)) return Response.json({ error: "bad rules" }, { status: 400 });
    return Response.json(await this.hit(rules));
  }

  /** Storage calls inside one event run under the object's input gate, so
   *  the read-modify-write below can't interleave with another request. */
  async hit(rules: readonly WindowRule[]): Promise<HitResult> {
    const now = this.now();
    const logs = (await this.state.storage.get<Logs>(LOGS_KEY)) ?? {};
    const out = hitWindows(logs, rules, now);
    if (out.result.ok) {
      await this.state.storage.put(LOGS_KEY, out.logs);
      const longest = Math.max(...rules.map((r) => r.windowSec));
      await this.state.storage.setAlarm(now + longest * 1000 + 1000);
    }
    return out.result;
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
