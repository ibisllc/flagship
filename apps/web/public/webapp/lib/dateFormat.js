// One date/time formatter for the whole webapp (S2).
//
// Every user-facing timestamp routes through here — never a raw
// `Date.toLocaleString()` in the UI. Rules:
//   < 60s              → "just now"
//   < 60m              → "{n}m ago"   (future: "in {n}m")
//   < 24h              → "{n}h ago"   (future: "in {n}h")
//   same calendar year → "MMM d"      (e.g. "Jul 4")
//   older              → "MMM d, yyyy"
// Month names are locale-aware. `formatDateTime` is the same but always
// carries a precise "h:mm a" clock (forensic logs / exact-event rows).
// `formatDuration` / `formatDays` render a raw elapsed span (uptime,
// "renews in {n}d") rather than an absolute instant.

const MS_MIN = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

function isInstant(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0;
}

function monthDay(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function monthDayYear(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function clock(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function calendar(d, nowMs) {
  return d.getFullYear() === new Date(nowMs).getFullYear() ? monthDay(d) : monthDayYear(d);
}

/** Relative-then-calendar per S2. Handles past and future instants. */
export function formatWhen(ms, nowMs = Date.now()) {
  if (!isInstant(ms)) return "—";
  const d = new Date(ms);
  const diff = nowMs - ms; // positive = past
  const abs = Math.abs(diff);
  if (abs < MS_MIN) return "just now";
  if (diff >= 0) {
    if (abs < MS_HOUR) return `${Math.floor(abs / MS_MIN)}m ago`;
    if (abs < MS_DAY) return `${Math.floor(abs / MS_HOUR)}h ago`;
  } else {
    if (abs < MS_HOUR) return `in ${Math.ceil(abs / MS_MIN)}m`;
    if (abs < MS_DAY) return `in ${Math.ceil(abs / MS_HOUR)}h`;
  }
  return calendar(d, nowMs);
}

/** Calendar date with a precise clock — for exact-event / log rows. */
export function formatDateTime(ms, nowMs = Date.now()) {
  if (!isInstant(ms)) return "—";
  const d = new Date(ms);
  return `${calendar(d, nowMs)}, ${clock(d)}`;
}

/** Bare elapsed span: "{n}s" / "{n}m" / "{n}h" / "{n}d". Callers that
 *  append " ago" / "renews in " want a bare span, not a phrase. */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < MS_MIN) return `${Math.round(ms / 1000)}s`;
  if (ms < MS_HOUR) return `${Math.round(ms / MS_MIN)}m`;
  if (ms < MS_DAY) return `${Math.round(ms / MS_HOUR)}h`;
  return `${Math.round(ms / MS_DAY)}d`;
}

/** Whole-day span, floored at 1d — for "renews in {n}d". */
export function formatDays(ms) {
  return `${Math.max(1, Math.round(ms / MS_DAY))}d`;
}
