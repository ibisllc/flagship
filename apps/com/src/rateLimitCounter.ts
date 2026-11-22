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
 *
 * Two signals feed the owner's report (rateLimitLog.ts) without anything
 * about the caller leaving the object: `near` when a request takes a
 * window to 80% of its budget (its last slot for budgets under 5), and
 * `firstRefusal` on the first refusal after a pass, so a client retrying
 * against a full window counts as one refused source.
 */

export interface WindowRule {
  limit: number;
  windowSec: number;
}

export interface HitResult {
  ok: boolean;
  /** Seconds until the fullest window frees a slot (0 when ok). */
  retryAfterSec: number;
  /** This pass took a window to its near-limit mark. */
  near?: boolean;
  /** The first refusal since this identifier last passed. */
  firstRefusal?: boolean;
}

type Logs = Record<string, number[]>;

const LOGS_KEY = "logs";
const REFUSING_KEY = "refusing";

function ruleKey(rule: WindowRule): string {
  return `${rule.limit}/${rule.windowSec}`;
}

/** The count at which a window is close to full. */
export function nearMark(limit: number): number {
  return limit < 5 ? limit : Math.ceil(limit * 0.8);
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
  let near = false;
  for (const rule of rules) {
    const kept = next[ruleKey(rule)]!;
    kept.push(now);
    if (kept.length === nearMark(rule.limit)) near = true;
  }
  return { result: near ? { ok: true, retryAfterSec: 0, near } : { ok: true, retryAfterSec: 0 }, logs: next };
}

/** How far from the ring time a logged pass may be and still count as that ring's (the counter's clock is its own). */
export const REFUND_TOLERANCE_MS = 60_000;

/**
 * Pure core of a refund: from every stored window log, drop the one logged pass nearest `at` (within the tolerance).
 * The windows are the stored keys, which already carry RATE_LIMIT_SCALE, so the caller needs no rules. Answers the
 * new logs and how many windows gave a slot back.
 */
export function refundWindows(logs: Logs, at: number): { logs: Logs; refunded: number } {
  const next: Logs = {};
  let refunded = 0;
  for (const [key, log] of Object.entries(logs)) {
    let best = -1;
    for (let i = 0; i < log.length; i++) {
      const d = Math.abs(log[i]! - at);
      if (d <= REFUND_TOLERANCE_MS && (best < 0 || d < Math.abs(log[best]! - at))) best = i;
    }
    next[key] = best < 0 ? log : [...log.slice(0, best), ...log.slice(best + 1)];
    if (best >= 0) refunded++;
  }
  return { logs: next, refunded };
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
    let body: { rules?: unknown; op?: unknown; at?: unknown } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    if (body.op === "refund") {
      if (typeof body.at !== "number" || !Number.isSafeInteger(body.at)) return Response.json({ error: "bad refund" }, { status: 400 });
      return Response.json(await this.refund(body.at));
    }
    const rules = body.rules;
    if (!isWindowRules(rules)) return Response.json({ error: "bad rules" }, { status: 400 });
    return Response.json(await this.hit(rules));
  }

  /** Storage calls inside one event run under the object's input gate, so
   *  the read-modify-write below can't interleave with another request. */
  async hit(rules: readonly WindowRule[]): Promise<HitResult> {
    const now = this.now();
    const logs = (await this.state.storage.get<Logs>(LOGS_KEY)) ?? {};
    const out = hitWindows(logs, rules, now);
    const longest = Math.max(...rules.map((r) => r.windowSec));
    if (out.result.ok) {
      await this.state.storage.put(LOGS_KEY, out.logs);
      await this.state.storage.put(REFUSING_KEY, false);
      await this.state.storage.setAlarm(now + longest * 1000 + 1000);
      return out.result;
    }
    if (await this.state.storage.get<boolean>(REFUSING_KEY)) return out.result;
    await this.state.storage.put(REFUSING_KEY, true);
    await this.state.storage.setAlarm(now + longest * 1000 + 1000);
    return { ...out.result, firstRefusal: true };
  }

  /** Gives back the pass logged nearest `at` in every window (an answered voi.ci call, docs/voici-calls.md §6). */
  async refund(at: number): Promise<{ refunded: number }> {
    const logs = await this.state.storage.get<Logs>(LOGS_KEY);
    if (!logs) return { refunded: 0 };
    const out = refundWindows(logs, at);
    if (out.refunded > 0) await this.state.storage.put(LOGS_KEY, out.logs);
    return { refunded: out.refunded };
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
