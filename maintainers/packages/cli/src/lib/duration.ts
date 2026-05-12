/**
 * Parse a human-readable duration like "60d", "30d", "12h", "90m", "45s" into milliseconds.
 *
 * The protocol's defaultMandateDuration is a free-form string, but the CLI needs
 * a deterministic number-of-ms when computing expiresAt from issuedAt.
 */

import { CliError } from "./args.js";

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

export function parseDurationMs(input: string): number {
  const m = /^(\d+)([smhdwy])$/.exec(input);
  if (!m) {
    throw new CliError(
      `invalid duration "${input}"; expected something like 60d, 12h, 90m, 1y`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2]!;
  const mult = UNITS[unit];
  if (mult === undefined) throw new CliError(`invalid duration unit "${unit}"`);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`duration must be positive`);
  return n * mult;
}

export function isoFromMsSince(startMs: number, durationMs: number): string {
  return new Date(startMs + durationMs).toISOString();
}
