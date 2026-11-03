/**
 * The box health report's signed bytes (control-plane serverHealth.ts, server-daemon healthReporter.ts).
 *
 *   flagship/box-health/v1|<report JSON, verbatim>
 *
 * A 0.3 box signs these; a 0.2 box signed the bare report JSON, which `.com` takes only from a box that never
 * reported `boxLevel` >= 3 and never sent a tagged report.
 */
import type { Bytes } from "./types.js";

export const TAG_BOX_HEALTH = "flagship/box-health/v1";

export function canonicalBoxHealthReport(reportJson: string): Bytes {
  return new TextEncoder().encode(`${TAG_BOX_HEALTH}|${reportJson}`);
}
