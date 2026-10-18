/**
 * Pure helpers behind the `free-plan` live group (docs/runbooks/workers-cpu-budget.md):
 * summarising cold and warm latencies and finding missing security headers.
 */

export interface LatencyStats {
  n: number;
  coldMs: number;
  warmMedianMs: number;
  warmMaxMs: number;
}

/** The first sample is the cold one; the rest are warm. */
export function latencyStats(samplesMs: readonly number[]): LatencyStats {
  if (samplesMs.length === 0) throw new Error("no samples");
  const [cold, ...warm] = samplesMs as [number, ...number[]];
  const sorted = [...warm].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : cold;
  return { n: samplesMs.length, coldMs: cold, warmMedianMs: median, warmMaxMs: sorted.length ? sorted[sorted.length - 1]! : cold };
}

export function describeLatency(name: string, s: LatencyStats): string {
  return `${name} cold ${s.coldMs} ms, warm median ${s.warmMedianMs} ms (max ${s.warmMaxMs}, n=${s.n})`;
}

/**
 * Security headers every `.com` response carries (`withSecurityHeaders` in
 * apps/com/src/route.ts): framing refused, nosniff, HSTS, a referrer policy.
 * Returns what is missing.
 */
export function securityHeaderGaps(headers: { get(name: string): string | null }): string[] {
  const gaps: string[] = [];
  const csp = headers.get("content-security-policy") ?? "";
  const xfo = (headers.get("x-frame-options") ?? "").toUpperCase();
  if (!/frame-ancestors\s+('none'|none)/i.test(csp) && xfo !== "DENY") gaps.push("framing is not refused (frame-ancestors 'none' / X-Frame-Options DENY)");
  if ((headers.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") gaps.push("x-content-type-options: nosniff");
  if (!/max-age=\d+/i.test(headers.get("strict-transport-security") ?? "")) gaps.push("strict-transport-security");
  if (!(headers.get("referrer-policy") ?? "")) gaps.push("referrer-policy");
  return gaps;
}

/** A static URL that cannot be cached or matched by anything real: the same file, a query nobody sends. */
export function uncachedProbe(url: string, tag: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}fp=${tag}`;
}
