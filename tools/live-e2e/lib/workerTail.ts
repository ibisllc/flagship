/**
 * A watch on the gym Worker's own log (`wrangler tail flagship-com-gym --format
 * json`) for the length of a live run. The Workers Free plan gives a request
 * 10 ms of CPU and 50 subrequests (docs/runbooks/workers-cpu-budget.md); a
 * request that goes over ends with outcome `exceededCpu` (error 1102) or
 * `exceededResources`, and nothing else on the client side tells apart from a
 * slow answer. The tail sees it. It also shows which requests reached the
 * Worker at all, which is how "static files are served without the Worker" is
 * checked.
 *
 * It reads only; a tail that cannot start (no wrangler login, no network) is
 * reported as `unavailable` and never fails a run by itself.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface TailEvent {
  at: number;
  outcome: string;
  method: string;
  /** Path only, ids and long tokens replaced (so routes group). */
  route: string;
  url: string;
  status: number | null;
  /** CPU time in ms when wrangler reports it. */
  cpuMs: number | null;
  wallMs: number | null;
  exceptions: string[];
}

export const BAD_OUTCOMES = new Set(["exceededCpu", "exceededResources", "exceededMemory"]);

/** `/api/users/alice/pods` and `/api/users/bob/pods` are one route. */
export function routeKey(pathname: string): string {
  return pathname
    .split("/")
    .map((seg, i, all) => {
      if (/^[0-9a-f]{16,}$/i.test(seg) || /^\d{6,}$/.test(seg)) return ":id";
      const prev = all[i - 1];
      if (prev && ["users", "accounts", "apps", "server", "order", "by-domain", "services"].includes(prev) && seg && !["aliases"].includes(seg)) return ":x";
      return seg;
    })
    .join("/");
}

/** One JSON line of `wrangler tail --format json`, or null when it is not an event. */
export function parseTailLine(line: string, now = Date.now()): TailEvent | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  let j: any;
  try {
    j = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null || typeof j.outcome !== "string") return null;
  let method = "";
  let url = "";
  let pathname = "";
  const req = j.event?.request;
  if (req && typeof req.url === "string") {
    url = req.url;
    method = String(req.method ?? "");
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      pathname = req.url;
    }
  } else if (typeof j.event?.cron === "string" || j.event?.scheduledTime !== undefined) {
    method = "CRON";
    pathname = String(j.event.cron ?? "scheduled");
    url = pathname;
  }
  const exceptions = Array.isArray(j.exceptions) ? j.exceptions.map((e: any) => `${e?.name ?? "Error"}: ${String(e?.message ?? "").slice(0, 160)}`) : [];
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    at: typeof j.eventTimestamp === "number" ? j.eventTimestamp : now,
    outcome: j.outcome,
    method,
    route: method === "CRON" ? pathname : routeKey(pathname),
    url,
    status: num(j.event?.response?.status),
    cpuMs: num(j.cpuTime),
    wallMs: num(j.wallTime),
    exceptions,
  };
}

export interface TailSummary {
  available: boolean;
  reason?: string;
  events: number;
  outcomes: Record<string, number>;
  exceeded: Array<{ at: string; method: string; route: string; outcome: string; status: number | null; exceptions: string[] }>;
  error1102: number;
  routes: Array<{ route: string; method: string; n: number; cpuMsMax: number | null; wallMsMax: number | null; statuses: Record<string, number> }>;
  /** Routes whose slowest request used more than 8 of the Free plan's 10 ms CPU (only when wrangler reports cpuTime). */
  nearBudget: Array<{ route: string; method: string; cpuMsMax: number }>;
}

export class WorkerTail {
  private events: TailEvent[] = [];
  private child: ChildProcess | null = null;
  private buf = "";
  private reason: string | undefined;
  private started = false;

  constructor(
    private readonly opts: {
      cwd: string;
      script?: string;
      config?: string;
      /** Test seam: lines instead of a process. */
      source?: (onLine: (l: string) => void) => { stop(): void };
    },
  ) {}

  /** Resolves true once wrangler says it is connected (or after `waitMs`), false when it could not start. */
  async start(waitMs = 20_000): Promise<boolean> {
    if (this.opts.source) {
      this.opts.source((l) => this.ingest(l));
      this.started = true;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const args = ["wrangler", "tail", this.opts.script ?? "flagship-com-gym", "--format", "json"];
      if (this.opts.config) args.push("--config", this.opts.config);
      let done = false;
      const finish = (ok: boolean, reason?: string): void => {
        if (done) return;
        done = true;
        if (!ok) this.reason = reason;
        this.started = ok;
        resolve(ok);
      };
      try {
        this.child = spawn("npx", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        finish(false, String(e));
        return;
      }
      const onData = (d: Buffer): void => {
        this.buf += d.toString();
        let i: number;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          if (/Connected to|Successfully created tail/i.test(line)) finish(true);
          if (/not authenticated|You are not logged in|authentication error|Authentication/i.test(line)) finish(false, line.slice(0, 160));
          this.ingest(line);
        }
      };
      this.child.stdout?.on("data", onData);
      this.child.stderr?.on("data", onData);
      this.child.on("error", (e) => finish(false, String(e)));
      this.child.on("exit", (code) => finish(false, `wrangler tail exited ${code}`));
      setTimeout(() => finish(true), waitMs);
    });
  }

  /** Lines of a pretty-printed object (`wrangler tail --format json` prints one over many lines). */
  private pending: string[] | null = null;

  ingest(line: string): void {
    // Wrangler prints each event indented over many lines: "{" ... "}" at column 0.
    if (this.pending) {
      this.pending.push(line);
      if (line === "}") {
        const e = parseTailLine(this.pending.join("\n"));
        this.pending = null;
        if (e) this.events.push(e);
      }
      return;
    }
    if (line === "{") {
      this.pending = [line];
      return;
    }
    const e = parseTailLine(line);
    if (e) this.events.push(e);
  }

  /** Requests that reached the Worker since `sinceMs` whose URL contains `needle`. */
  seen(needle: string, sinceMs: number): TailEvent[] {
    return this.events.filter((e) => e.at >= sinceMs && e.url.includes(needle));
  }

  stop(): void {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // already gone
    }
    this.child = null;
  }

  summary(): TailSummary {
    if (!this.started) return { available: false, reason: this.reason ?? "not started", events: 0, outcomes: {}, exceeded: [], error1102: 0, routes: [], nearBudget: [] };
    const outcomes: Record<string, number> = {};
    const routes = new Map<string, TailSummary["routes"][number]>();
    const exceeded: TailSummary["exceeded"] = [];
    let error1102 = 0;
    for (const e of this.events) {
      outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
      const k = `${e.method} ${e.route}`;
      const r = routes.get(k) ?? { route: e.route, method: e.method, n: 0, cpuMsMax: null, wallMsMax: null, statuses: {} };
      r.n += 1;
      if (e.cpuMs !== null) r.cpuMsMax = Math.max(r.cpuMsMax ?? 0, e.cpuMs);
      if (e.wallMs !== null) r.wallMsMax = Math.max(r.wallMsMax ?? 0, e.wallMs);
      if (e.status !== null) r.statuses[String(e.status)] = (r.statuses[String(e.status)] ?? 0) + 1;
      routes.set(k, r);
      const is1102 = e.exceptions.some((x) => /1102|exceeded.*cpu|CPU time limit/i.test(x));
      if (is1102) error1102 += 1;
      if (BAD_OUTCOMES.has(e.outcome) || is1102) {
        exceeded.push({ at: new Date(e.at).toISOString(), method: e.method, route: e.route, outcome: e.outcome, status: e.status, exceptions: e.exceptions });
      }
    }
    return {
      available: true,
      events: this.events.length,
      outcomes,
      exceeded,
      error1102,
      routes: [...routes.values()].sort((a, b) => b.n - a.n).slice(0, 60),
      nearBudget: [...routes.values()]
        .filter((r) => r.cpuMsMax !== null && r.cpuMsMax > 8)
        .map((r) => ({ route: r.route, method: r.method, cpuMsMax: r.cpuMsMax! }))
        .sort((a, b) => b.cpuMsMax - a.cpuMsMax),
    };
  }
}

let current: WorkerTail | null = null;
/** The run's tail, for groups that want to ask what reached the Worker. */
export const setCurrentTail = (t: WorkerTail | null): void => {
  current = t;
};
export const currentTail = (): WorkerTail | null => current;
