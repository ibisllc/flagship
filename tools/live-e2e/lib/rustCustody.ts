// What the live gym asserts about which implementation served a Rust-path component (G8 / R8,
// docs/architecture-v2/rust-consolidation.md row 1). The box reports it on `GET /api/stack` as
// `components` (server-daemon rustStack/componentStatus.ts, from /run/flagship-rust/<c>.status that
// flagship-rust-select writes). Pure: the groups and lanes feed it what the box answered.

export interface ComponentStatus {
  component: string;
  choice: "rust" | "ts";
  reason: string;
  sha256: string;
  pinned: string;
  switch: "on" | "off";
  at: number;
}

export type Stack = "arch-v2" | "classic";

/** The stack a gym pass builds its boxes on (GYM_BOX_STACK; the release gym's default is arch-v2). */
export function gymStack(env: string | undefined = process.env.GYM_BOX_STACK): Stack {
  return env === "classic" ? "classic" : "arch-v2";
}

/** The Rust binary is what served: the selector chose it because the release pins exactly this binary. */
export function rustServedProblem(s: ComponentStatus | null | undefined): string | null {
  if (!s) return "no status (the box did not report the component, or its status file is missing)";
  if (s.choice !== "rust") return `the TypeScript fallback served (${s.reason})`;
  if (s.reason !== "pinned" && s.reason !== "running") return `rust but ${s.reason}`;
  if (!/^[0-9a-f]{64}$/.test(s.sha256) || s.sha256 !== s.pinned) return `binary ${s.sha256.slice(0, 12) || "-"} is not the pinned ${s.pinned.slice(0, 12) || "-"}`;
  if (s.switch !== "on") return `the Rust switch is ${s.switch}`;
  return null;
}

/** A classic box runs the TypeScript keyd because its Rust switch is off (nothing else). */
export function tsServedProblem(s: ComponentStatus | null | undefined, reason = "switched-off"): string | null {
  if (!s) return "no status";
  if (s.choice !== "ts") return `the Rust binary served (${s.reason})`;
  if (s.reason !== reason) return `ts, but because ${s.reason}, not ${reason}`;
  return null;
}

/** What one component's status says, in one line for the gym's detail column. */
export function describeStatus(s: ComponentStatus | null | undefined): string {
  if (!s) return "unreported";
  return `${s.choice} (${s.reason}${s.sha256 ? `, ${s.sha256.slice(0, 12)}` : ""})`;
}

/** The selector's own count of failed Rust runs, from its journal lines ("…; failed runs: N"); the highest seen. */
export function failedRunsFromJournal(lines: readonly string[], component = "keyd"): number {
  const re = new RegExp(`\\[rust-path\\] ${component}: the Rust binary stopped .*failed runs: (\\d+)`);
  let max = 0;
  for (const l of lines) {
    const m = re.exec(l);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** The selector switched the component to its fallback because the Rust binary kept failing. */
export function fellBack(s: ComponentStatus | null | undefined): boolean {
  return !!s && s.choice === "ts" && s.reason === "failed-to-start";
}

/** `lastReported` on a /pods row as Unix ms (it is a number or an ISO date); 0 when absent. */
export function reportedAtMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}
