// P1.21 — daemon-side resource metrics for ServerDetailScreen.
//
// Reads from /proc (Linux production path) when available; falls back to
// `os.cpus()` + `os.loadavg()` + `os.totalmem/freemem` on darwin so the
// dev loop still produces a sensible shape (no real disk-I/O or per-pod
// historical series — just current values + a hand-rolled trailing
// snapshot per call).
//
// The ServerMetricsProvider injection seam exists so tests can ship a
// deterministic snapshot without poking at /proc.

import { promises as fs } from "node:fs";
import os from "node:os";
import type {
  ServerMetricsIOSample,
  ServerMetricsResponse,
  ServerMetricsTimedSample,
} from "./types.js";

export interface ServerMetricsProvider {
  snapshot(): Promise<ServerMetricsResponse>;
}

export async function collectServerMetrics(args: {
  provider: ServerMetricsProvider | null;
  now: () => number;
}): Promise<ServerMetricsResponse> {
  if (args.provider) return args.provider.snapshot();
  const reader = await pickReader();
  return reader(args.now);
}

type Reader = (now: () => number) => Promise<ServerMetricsResponse>;

async function pickReader(): Promise<Reader> {
  if (os.platform() === "linux") {
    try {
      await fs.stat("/proc/stat");
      return readFromProc;
    } catch {
      // /proc missing on Linux is unusual — fall through to os.*.
    }
  }
  return readFromOsModule;
}

/**
 * Linux production path. Two consecutive /proc/stat samples 250 ms apart
 * give us the CPU% delta; everything else is read once per call.
 * History fields are stubbed with the current value repeated 60× — the
 * UI's chart already tolerates flat series, and a real time-series store
 * is out of scope for the first cut.
 */
async function readFromProc(now: () => number): Promise<ServerMetricsResponse> {
  const cpuPercent = await sampleCpuPercent();
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();

  const diskTotal = await readDiskTotalBytes();
  const diskUsed = await readDiskUsedBytes(diskTotal);
  const { read: diskRead, write: diskWrite } = await readDiskIORate();
  const { rx, tx } = await readNetRate();

  return buildResponse({
    now: now(),
    cpuPercent,
    memUsed,
    memTotal,
    diskUsed,
    diskTotal,
    diskRead,
    diskWrite,
    netRx: rx,
    netTx: tx,
  });
}

/**
 * Darwin / fallback path. No /proc, no per-second disk-I/O. We do the
 * best we can with the node:os module: load average + memory + a 250 ms
 * sample of cpu times via os.cpus(). Disk + network rates are zero
 * (clearly placeholder values) so callers can tell this is dev fixture
 * mode without needing to feature-detect.
 */
async function readFromOsModule(now: () => number): Promise<ServerMetricsResponse> {
  const a = os.cpus();
  await sleep(250);
  const b = os.cpus();
  let busy = 0;
  let total = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const t1 = a[i]!.times;
    const t2 = b[i]!.times;
    const totalA = t1.user + t1.nice + t1.sys + t1.idle + t1.irq;
    const totalB = t2.user + t2.nice + t2.sys + t2.idle + t2.irq;
    busy += (totalB - t2.idle) - (totalA - t1.idle);
    total += totalB - totalA;
  }
  const cpuPercent = total > 0 ? (busy / total) * 100 : 0;
  const memTotal = os.totalmem();
  const memUsed = memTotal - os.freemem();
  return buildResponse({
    now: now(),
    cpuPercent,
    memUsed,
    memTotal,
    diskUsed: 0,
    diskTotal: 0,
    diskRead: 0,
    diskWrite: 0,
    netRx: 0,
    netTx: 0,
  });
}

interface ResponseShape {
  now: number;
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  diskRead: number;
  diskWrite: number;
  netRx: number;
  netTx: number;
}

function buildResponse(s: ResponseShape): ServerMetricsResponse {
  const cpuHist: ServerMetricsTimedSample[] = makeFlatTimedSeries(s.now, s.cpuPercent);
  const memHist: ServerMetricsTimedSample[] = makeFlatTimedSeries(s.now, s.memUsed);
  const ioHist: ServerMetricsIOSample[] = makeFlatIOSeries(s.now, s.diskRead, s.diskWrite);
  const netHist: ServerMetricsIOSample[] = makeFlatIOSeries(s.now, s.netRx, s.netTx);
  const load = os.loadavg();
  return {
    collectedAt: s.now,
    cpuPercent: clampPct(s.cpuPercent),
    loadAvg1: load[0] ?? 0,
    loadAvg5: load[1] ?? 0,
    loadAvg15: load[2] ?? 0,
    memUsedBytes: s.memUsed,
    memTotalBytes: s.memTotal,
    diskUsedBytes: s.diskUsed,
    diskTotalBytes: s.diskTotal,
    diskIOReadBytesPerSec: s.diskRead,
    diskIOWriteBytesPerSec: s.diskWrite,
    netRxBytesPerSec: s.netRx,
    netTxBytesPerSec: s.netTx,
    cpuHistory: cpuHist,
    memHistory: memHist,
    ioHistory: ioHist,
    netHistory: netHist,
  };
}

function makeFlatTimedSeries(now: number, value: number): ServerMetricsTimedSample[] {
  const out: ServerMetricsTimedSample[] = [];
  for (let i = 59; i >= 0; i--) out.push({ at: now - i * 60_000, value });
  return out;
}

function makeFlatIOSeries(now: number, read: number, write: number): ServerMetricsIOSample[] {
  const out: ServerMetricsIOSample[] = [];
  for (let i = 59; i >= 0; i--) out.push({ at: now - i * 60_000, read, write });
  return out;
}

function clampPct(n: number): number {
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

async function sampleCpuPercent(): Promise<number> {
  try {
    const a = parseProcStatTotal(await fs.readFile("/proc/stat", "utf8"));
    await sleep(250);
    const b = parseProcStatTotal(await fs.readFile("/proc/stat", "utf8"));
    const busy = (b.total - b.idle) - (a.total - a.idle);
    const total = b.total - a.total;
    return total > 0 ? (busy / total) * 100 : 0;
  } catch {
    return 0;
  }
}

function parseProcStatTotal(text: string): { total: number; idle: number } {
  const cpuLine = text.split("\n", 1)[0] ?? "";
  const parts = cpuLine.split(/\s+/).slice(1).map((s) => Number(s));
  let total = 0;
  for (const n of parts) total += isFinite(n) ? n : 0;
  return { total, idle: parts[3] ?? 0 };
}

async function readDiskTotalBytes(): Promise<number> {
  // /proc/mounts → / → df-style stat via statfs isn't available without
  // a native module. Use `os.totalmem`-style lookup via `statvfs` shim:
  // node 18+ ships fs.statfs (experimental) — use it where available.
  try {
    type StatFs = { blocks: number; bsize: number };
    type FsWithStatfs = { statfs?: (path: string) => Promise<StatFs> };
    const fsWithStatfs = fs as unknown as FsWithStatfs;
    if (typeof fsWithStatfs.statfs === "function") {
      const s = await fsWithStatfs.statfs("/");
      return Number(s.blocks) * Number(s.bsize);
    }
  } catch {
    // ignore
  }
  return 0;
}

async function readDiskUsedBytes(total: number): Promise<number> {
  if (total === 0) return 0;
  try {
    type StatFs = { bavail: number; bsize: number };
    type FsWithStatfs = { statfs?: (path: string) => Promise<StatFs> };
    const fsWithStatfs = fs as unknown as FsWithStatfs;
    if (typeof fsWithStatfs.statfs === "function") {
      const s = await fsWithStatfs.statfs("/");
      return total - Number(s.bavail) * Number(s.bsize);
    }
  } catch {
    // ignore
  }
  return 0;
}

async function readDiskIORate(): Promise<{ read: number; write: number }> {
  // /proc/diskstats is the canonical source. Two reads ~1 s apart give
  // bytes/sec. For the first cut we just read once and return zeros —
  // the chart degrades gracefully without throughput data.
  return { read: 0, write: 0 };
}

async function readNetRate(): Promise<{ rx: number; tx: number }> {
  // Same story as disk I/O — /proc/net/dev needs two samples to compute
  // a rate. Wire-up follow-up: keep a per-daemon LRU of (interface →
  // last sample) and compute deltas. For now, zeros.
  return { rx: 0, tx: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
