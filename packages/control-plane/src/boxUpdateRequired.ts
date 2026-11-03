/**
 * "This server needs an update" (owner decision 2026-11-02). Under 0.3 a 0.2 box keeps its tunnel and control
 * name, but once the relay holds the serving key its app names stop (it pins no admin key), and its certificate
 * can no longer renew (DNS-01 answers 410 "Update this server.", which the box only logs), so it goes dark when
 * its certificate runs out. The apps say so on its Home row and server page, with the existing Update action.
 *
 * The signal is explicit: every 0.3 box sends `boxLevel` (protocol `BOX_LEVEL`) beside its signed daemon-status
 * report, and `.com` keeps it in the stored report JSON (no migration). A box whose stored heartbeat carries no
 * level, or one below `MIN_BOX_LEVEL`, needs an update. A box that never sent a heartbeat is not judged.
 *
 * Demo accounts are left out: Flagship updates their boxes itself (`/api/dev/sample-user/<u>/order-update`), and
 * the relay judges a demo box under the key `.com` holds, so it keeps serving meanwhile.
 */

/** The lowest box level that still works with this `.com`. */
export const MIN_BOX_LEVEL = 3;

export interface UpdateRequiredView {
  /** Why: the box runs a release from before the one this `.com` needs. */
  reason: "box-too-old";
  /** When its current certificate runs out (ms), as the box last reported it; after that it can't be reached
   *  until it is updated. Null when `.com` doesn't know. */
  certificateExpiresAt: number | null;
}

/** The heartbeat's `boxLevel`, or null when absent or malformed. */
export function parseBoxLevel(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The `/pods` `updateRequired` for one box, or null when it needs none (or `.com` can't tell). */
export function updateRequiredFor(args: {
  /** The parsed stored report: null when the box never sent a heartbeat (or it couldn't be read). */
  storedReport: Record<string, unknown> | null;
  certValidUntil: number | null;
  revoked: boolean;
  demo: boolean;
}): UpdateRequiredView | null {
  if (args.demo || args.revoked || !args.storedReport) return null;
  const level = parseBoxLevel(args.storedReport.boxLevel);
  if (level !== null && level >= MIN_BOX_LEVEL) return null;
  const until = args.certValidUntil;
  return {
    reason: "box-too-old",
    certificateExpiresAt: typeof until === "number" && Number.isFinite(until) && until > 0 ? until : null,
  };
}
