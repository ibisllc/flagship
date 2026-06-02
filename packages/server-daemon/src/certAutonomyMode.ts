/**
 * Cert-autonomy mode picker (per-user-cert design, box half).
 *
 * Reads the per-server `certAutonomy` policy off the signed InstallBlob and
 * maps the offline-autonomy window onto an LE cert profile. The phone signs
 * over `certAutonomy` (canonicalised in `@flagship/protocol` `auth.ts`), so a
 * compromised `.com` cannot silently weaken a box's policy.
 *
 *   - "managed" (DEFAULT when the field is absent): the box NEVER holds minting
 *     authority; an admin device renews. `offlineWindowDays` is the target
 *     before an admin must surface, and it drives the cert profile: a window of
 *     ≤6 days asks for LE's short-lived (~6-day) profile (tightest blast-radius
 *     bound for the shared `*.<user>` key), otherwise a standard ≤90-day cert.
 *   - "autonomous": the box holds a sealed, revocable ACME account key and
 *     renews itself. `offlineWindowDays` is not meaningful here.
 *
 * Absence of the whole field is backward-compatible: it canonicalises exactly
 * as a pre-certAutonomy blob, so existing signatures still verify, and consumers
 * treat it as { mode: "managed", offlineWindowDays: 90 }.
 */

/** Just the slice of InstallBlob this module reads — kept structural so we
 *  don't pull the whole protocol type in (and so a partial test fixture is
 *  assignable). */
export interface CertAutonomyBlob {
  certAutonomy?: {
    mode: "managed" | "autonomous";
    /** managed-mode only; ignored for "autonomous". */
    offlineWindowDays?: number;
  };
}

export interface CertAutonomy {
  mode: "managed" | "autonomous";
  offlineWindowDays: number;
}

/** Default window when `certAutonomy` is absent OR present-but-window-unset. */
export const DEFAULT_OFFLINE_WINDOW_DAYS = 90;

/** Window at or below which we ask LE for its short-lived (~6-day) profile. */
export const SHORT_LIVED_WINDOW_DAYS = 6;

export type CertProfile = "short-lived" | "standard";

/**
 * Resolve the effective cert-autonomy policy off a (possibly absent) blob
 * field. Absent ⇒ managed with the default 90-day window. A present field
 * without `offlineWindowDays` (or a non-finite/negative value) also falls back
 * to the default window so a malformed policy can never yield NaN downstream.
 */
export function readCertAutonomy(blob: CertAutonomyBlob | undefined): CertAutonomy {
  const ca = blob?.certAutonomy;
  if (!ca) {
    return { mode: "managed", offlineWindowDays: DEFAULT_OFFLINE_WINDOW_DAYS };
  }
  const raw = ca.offlineWindowDays;
  const offlineWindowDays =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0
      ? raw
      : DEFAULT_OFFLINE_WINDOW_DAYS;
  return { mode: ca.mode, offlineWindowDays };
}

/**
 * Map an offline-autonomy window (in days) onto the LE cert profile: a window
 * of ≤6 days takes the short-lived profile, everything else the standard
 * ≤90-day cert. Boundary: exactly 6 ⇒ "short-lived", 7 ⇒ "standard".
 */
export function certProfileForWindow(days: number): CertProfile {
  return days <= SHORT_LIVED_WINDOW_DAYS ? "short-lived" : "standard";
}
