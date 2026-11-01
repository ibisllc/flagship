/**
 * Shared pieces of the 0.3 benchmarks (release plan G10, docs/architecture-v2/benchmarks-0.3.md): percentiles,
 * a process's CPU seconds and peak RSS, the host line every result carries, and the JSON-lines output.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";

export interface Result {
  bench: string;
  impl: string;
  metric: string;
  value: number;
  unit: string;
  n?: number;
  host?: string;
}

export function host(): string {
  const c = cpus();
  return `${platform()}/${arch()}/${c.length}cpu/${Math.round(totalmem() / 2 ** 30)}GiB/${(c[0]?.model ?? "?").trim()}`;
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Nearest-rank percentile of an unsorted sample. */
export function pct(sample: readonly number[], p: number): number {
  if (sample.length === 0) return Number.NaN;
  const s = [...sample].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

/** CPU seconds (user + system) and peak RSS in KiB of a running process; null once it is gone. */
export function procUsage(pid: number): { cpuSec: number; rssKiB: number; peakKiB: number } | null {
  if (existsSync(`/proc/${pid}/stat`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const hz = 100; // USER_HZ on every Linux the box runs
      const cpuSec = (Number(f[11]) + Number(f[12])) / hz;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kib = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
      return { cpuSec, rssKiB: kib("VmRSS"), peakKiB: kib("VmHWM") };
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const [rss, time] = out.split(/\s+/);
    const parts = (time ?? "0").split(":").map(Number);
    const cpuSec = parts.reduce((acc, v) => acc * 60 + v, 0);
    return { cpuSec, rssKiB: Number(rss), peakKiB: Number(rss) };
  } catch {
    return null;
  }
}

export class Recorder {
  readonly rows: Result[] = [];
  constructor(readonly bench: string, private readonly out = arg("out")) {}
  add(impl: string, metric: string, value: number, unit: string, n?: number): void {
    const r: Result = { bench: this.bench, impl, metric, value: Math.round(value * 1000) / 1000, unit, ...(n !== undefined ? { n } : {}), host: host() };
    this.rows.push(r);
    if (this.out) appendFileSync(this.out, JSON.stringify(r) + "\n");
  }
  /** p50/p95/p99 of a latency sample in ms. */
  latency(impl: string, metric: string, ms: readonly number[]): void {
    for (const p of [50, 95, 99]) this.add(impl, `${metric}_p${p}`, pct(ms, p), "ms", ms.length);
  }
  print(): void {
    const w = Math.max(...this.rows.map((r) => r.metric.length), 6);
    console.log(`\n${this.bench} on ${host()}`);
    for (const r of this.rows) console.log(`  ${r.impl.padEnd(5)} ${r.metric.padEnd(w)} ${String(r.value).padStart(12)} ${r.unit}${r.n ? `  (n=${r.n})` : ""}`);
  }
}

export const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
