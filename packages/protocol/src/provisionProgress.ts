/**
 * Provisioning progress model — the single source of truth that the
 * "your server is being installed" UI on every surface mirrors.
 *
 * The fine-grained `PROVISION_PHASES` ladder (auth.ts) is what the box
 * actually pushes. A user-facing progress bar wants two derived things:
 *
 *   1. a 0..1 fraction so a thin determinate bar can render anywhere, and
 *   2. a small set of NAMED, grouped steps ("Booting", "Registering",
 *      "Securing (TLS certificate)", "Ready") with per-step state so a
 *      detail page can show a checklist and the user can say "my device
 *      is stuck at Securing".
 *
 * Both are derived here so iOS / Android / webapp stay byte-aligned (the
 * grouping + labels are reproduced verbatim on each surface and unit-
 * tested against this module's outputs via the shared phase ladder).
 */

import {
  PROVISION_PHASES,
  type ProvisionPhase,
  isProvisionPhase,
} from "./auth.js";

/** The ordered, non-terminal ladder (everything except `failed`). The
 *  fraction is computed against this so `ready` is exactly 1.0. */
export const PROVISION_LADDER: readonly ProvisionPhase[] =
  PROVISION_PHASES.filter((p) => p !== "failed");

/**
 * Map a phase to a 0..1 fraction for a determinate progress bar.
 *
 *   - `ready`              → 1
 *   - any ladder phase     → (index + 1) / ladderLength   (monotonic)
 *   - `failed`             → the fraction of the step it died ON, when
 *                            known. We don't track which phase preceded
 *                            `failed` here (the row only stores the
 *                            latest phase); callers that DO know the
 *                            pre-failure phase should pass it. With no
 *                            hint we return 0 so a bare `failed` renders
 *                            as "stalled at the start" rather than
 *                            falsely "almost done".
 *   - unknown / null       → 0
 */
export function provisionFraction(
  phase: string | null | undefined,
): number {
  if (!phase) return 0;
  if (phase === "ready") return 1;
  if (phase === "failed") return 0;
  if (!isProvisionPhase(phase)) return 0;
  const idx = PROVISION_LADDER.indexOf(phase);
  if (idx < 0) return 0;
  return (idx + 1) / PROVISION_LADDER.length;
}

/** The four user-facing groups, in order. The keys are stable ids the
 *  UI keys off; `label` is the human copy reproduced on each surface. */
export type ProvisionStepKey = "booting" | "registering" | "securing" | "ready";

export interface ProvisionStepGroup {
  key: ProvisionStepKey;
  label: string;
  /** The ladder phases that roll up into this group, in order. */
  phases: readonly ProvisionPhase[];
}

/** The grouping. `ready` is its own terminal group so the checklist's
 *  final row is the celebratory "Ready" rather than a sub-step. */
export const PROVISION_STEP_GROUPS: readonly ProvisionStepGroup[] = [
  {
    key: "booting",
    label: "Booting",
    phases: ["boot", "cloned", "deps", "built", "identity"],
  },
  {
    key: "registering",
    label: "Registering",
    phases: ["registered", "tunnel-online"],
  },
  {
    key: "securing",
    label: "Securing (TLS certificate)",
    phases: [
      "acme-order",
      "dns01-publish-attempt",
      "dns01-publish-ok",
      "dns01-propagation-wait",
      "tlsalpn-served",
      "acme-validating",
      "cert-issued",
    ],
  },
  {
    key: "ready",
    label: "Ready",
    phases: ["ready"],
  },
];

/** Per-step render state for the detail-page checklist. */
export type ProvisionStepState = "done" | "active" | "pending" | "failed";

export interface ProvisionStepView {
  key: ProvisionStepKey;
  label: string;
  state: ProvisionStepState;
  /** Sub-step copy for the ACTIVE (or FAILED) group — the fine-grained
   *  phase title, e.g. "Waiting for DNS". Null for non-active groups. */
  detail: string | null;
}

/** Human-readable title for each fine-grained phase. Kept in lockstep
 *  with PHASE_TITLES in packages/control-plane/src/provisionEvents.ts
 *  (the push fan-out's titles) so the in-app step copy matches the
 *  push the user just tapped. */
export const PROVISION_PHASE_TITLES: Record<ProvisionPhase, string> = {
  boot: "Server booting",
  cloned: "Code cloned",
  deps: "Installing dependencies",
  built: "Build complete",
  identity: "Identity generated",
  registered: "Registered with Flagship",
  "tunnel-online": "Tunnel online",
  "acme-order": "Requesting certificate",
  "dns01-publish-attempt": "Publishing DNS challenge",
  "dns01-publish-ok": "DNS challenge published",
  "dns01-propagation-wait": "Waiting for DNS",
  "tlsalpn-served": "Serving TLS challenge",
  "acme-validating": "Validating certificate",
  "cert-issued": "TLS certificate issued",
  ready: "Server is live",
  failed: "Provisioning failed",
};

/** Which group does a (non-terminal) phase belong to? */
function groupKeyForPhase(phase: ProvisionPhase): ProvisionStepKey {
  for (const g of PROVISION_STEP_GROUPS) {
    if ((g.phases as readonly string[]).includes(phase)) return g.key;
  }
  return "booting";
}

/**
 * Project a (phase, lastError, prevPhase) tuple into the per-group
 * checklist state every detail page renders.
 *
 *   - phase==='ready'  → all groups done.
 *   - phase==='failed' → the group that owns `prevPhase` (the last
 *     non-terminal phase, when known) is marked `failed` and carries
 *     `lastError`; groups before it are `done`, groups after `pending`.
 *     With no `prevPhase` hint the FIRST group fails (conservative —
 *     a bare `failed` means "stalled early").
 *   - any other phase  → the owning group is `active` (and carries the
 *     fine-grained phase title as `detail`); earlier groups `done`,
 *     later groups `pending`.
 *   - null phase       → first group `active` with no detail (just
 *     started; no checkpoint yet).
 *
 * NOTE: the daemon now RETRIES on ACME failures, so a UI should render
 * `failed` as "retrying — last error: …", not a dead end. This function
 * surfaces the failure state + error; the copy is the surface's job.
 */
export function provisionStepStates(
  phase: string | null | undefined,
  lastError?: string | null,
  prevPhase?: string | null,
): ProvisionStepView[] {
  const groups = PROVISION_STEP_GROUPS;

  if (phase === "ready") {
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      state: "done" as const,
      detail: null,
    }));
  }

  if (phase === "failed") {
    const failedPhase: ProvisionPhase =
      prevPhase && isProvisionPhase(prevPhase) && prevPhase !== "failed"
        ? prevPhase
        : "boot";
    const failedGroup = groupKeyForPhase(failedPhase);
    const failedIdx = groups.findIndex((g) => g.key === failedGroup);
    return groups.map((g, i) => {
      if (i < failedIdx) {
        return { key: g.key, label: g.label, state: "done" as const, detail: null };
      }
      if (i === failedIdx) {
        return {
          key: g.key,
          label: g.label,
          state: "failed" as const,
          detail: lastError && lastError.length > 0 ? lastError : PROVISION_PHASE_TITLES.failed,
        };
      }
      return { key: g.key, label: g.label, state: "pending" as const, detail: null };
    });
  }

  // No checkpoint yet → first group active, no detail.
  if (!phase || !isProvisionPhase(phase)) {
    return groups.map((g, i) => ({
      key: g.key,
      label: g.label,
      state: i === 0 ? ("active" as const) : ("pending" as const),
      detail: null,
    }));
  }

  const activeGroup = groupKeyForPhase(phase);
  const activeIdx = groups.findIndex((g) => g.key === activeGroup);
  return groups.map((g, i) => {
    if (i < activeIdx) {
      return { key: g.key, label: g.label, state: "done" as const, detail: null };
    }
    if (i === activeIdx) {
      return {
        key: g.key,
        label: g.label,
        state: "active" as const,
        detail: PROVISION_PHASE_TITLES[phase],
      };
    }
    return { key: g.key, label: g.label, state: "pending" as const, detail: null };
  });
}
