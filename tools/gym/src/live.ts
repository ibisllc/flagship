/**
 * The LIVE vertical slice (Tier-2, §12-G5/G6) — the ONE end-to-end scenario the
 * gym runs against a REAL backend: the isolated `gym.` test env
 * (docs/ui-test-gym.md §6.5). It proves the harness drives the real app against a
 * real box and asserts the D6 action→effect for real, not a mock:
 *
 *   onboarding → create a demo server (gym `.com` + the test Hetzner project)
 *   → it comes online → approve the boot-unlock → install a service
 *   → assert the real effect (the service runs / appears on the live `/pods`).
 *
 * WHY this lives OUTSIDE `ALL_SCENARIOS` (suites.ts): the every-merge + total
 * Tier-1 tranches are entirely `fixture`-backed and run with NO backend (a hard
 * invariant the harness test pins). The live slice is `backend:"live"`, needs the
 * deployed `gym.` env, and is selected separately — folded into `gym:total` (where
 * it SKIPS cleanly if the env is down) and runnable on its own via `gym live`.
 *
 * DETECT-AND-SKIP (the key property, §12-G6 "stays green today"): `liveEnvReachable`
 * pings `<control-apex>/api/health`. The runner SKIPS (never FAILS) every
 * `backend:"live"` scenario when the env is unreachable — so `npm run gym:total`
 * is green on a machine where the gym env was never deployed (the fixture
 * scenarios carry the verdict; a SKIP proves nothing but reddens nothing).
 *
 * LAUNCH SEAM (§7-F / §12-G2):
 *   - iOS: `-apex-host <control-apex>` launch arg → the live client base + the
 *     `flagship.dev.useLiveClient` toggle, pointed at the gym apex. The XCUITest
 *     class is GymLiveTests (built only when the env is reachable).
 *   - webapp (documented, not the default slice here): serve Playwright from the
 *     gym origin (web.gym.flagshipserver.com); the webapp derives its apex from
 *     window.location.origin (§12-G2) and talks to gym.flagship.services.
 *
 * DEMO-ONLY guardrail (§7-G): the create/install/approve run against the gym
 * demo user only (`gymdemo`, an ALLOWED_DEMO_USERNAMES member). A real account is
 * never a target.
 */

import type { Scenario } from "./scenario.js";

/** Default apexes for the live slice — the `gym.` test env (§6.5). */
export const DEFAULT_GYM_CONTROL_APEX = "gym.flagshipserver.com";
export const DEFAULT_GYM_SERVICES_APEX = "gym.flagship.services";

/** The gym demo username the live slice's destructive ops target (§7-G). */
export const GYM_LIVE_DEMO_USERNAME = "gymdemo";

/** Resolved live-env target (control + data apex). */
export interface LiveTarget {
  readonly controlApex: string;
  readonly servicesApex: string;
  /** The full health URL the reachability probe hits. */
  readonly healthUrl: string;
}

/**
 * Resolve the live target from the environment, defaulting to the `gym.` apex.
 *   GYM_LIVE_CONTROL_APEX  — the control plane host (default gym.flagshipserver.com)
 *   GYM_LIVE_SERVICES_APEX — the data plane host  (default gym.flagship.services)
 */
export function liveTarget(env: NodeJS.ProcessEnv = process.env): LiveTarget {
  const controlApex = env.GYM_LIVE_CONTROL_APEX?.trim() || DEFAULT_GYM_CONTROL_APEX;
  const servicesApex = env.GYM_LIVE_SERVICES_APEX?.trim() || DEFAULT_GYM_SERVICES_APEX;
  return { controlApex, servicesApex, healthUrl: `https://${controlApex}/api/health` };
}

/** Verdict of the env-reachability probe. */
export interface LiveEnvProbe {
  readonly reachable: boolean;
  readonly reason: string;
  readonly target: LiveTarget;
}

/**
 * Ping `<control-apex>/api/health` to decide whether the live env is deployed.
 * Returns `reachable:false` (with a reason) on ANY failure — DNS miss, connection
 * refused, timeout, or a non-2xx — so an absent env yields a clean SKIP, never a
 * thrown error into the gate. Bounded by `timeoutMs` (default 5s) so an
 * unreachable host can't hang the run.
 */
export async function liveEnvReachable(
  opts: { target?: LiveTarget; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LiveEnvProbe> {
  const target = opts.target ?? liveTarget();
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { reachable: false, reason: "no fetch implementation available", target };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await doFetch(target.healthUrl, { method: "GET", signal: ac.signal });
    if (!res.ok) {
      return {
        reachable: false,
        reason: `gym env health ${res.status} at ${target.healthUrl} (env not deployed / unhealthy)`,
        target,
      };
    }
    return { reachable: true, reason: `gym env healthy at ${target.healthUrl}`, target };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      reachable: false,
      reason: `gym env unreachable at ${target.healthUrl}: ${msg} (deploy it — docs/runbooks/gym-test-env.md)`,
      target,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The live vertical slice. ONE iOS scenario today (Phase-1 is iOS — the shortest
 * path: an XCUITest target + ~217 a11y ids already). It is `total` tier (so a
 * `gym:total` run considers it) + `backend:"live"` (so the runner gates it on
 * env reachability) + destructive (it creates/installs against the gym demo user,
 * guarded to that username).
 *
 * The webapp live leg is documented in the runbook (serve Playwright from the gym
 * origin) and is the obvious next entry here — it follows the same detect-and-skip
 * gate, so adding it never changes the green-today property.
 */
export const LIVE_SCENARIOS: readonly Scenario[] = [
  {
    id: "ios-live-vertical-slice",
    surface: "ios",
    tier: "total",
    backend: "live",
    goal:
      "Tier-2 (real gym box): onboard → create a demo server → online → approve unlock → " +
      "install a service → assert the real effect (service runs / appears on the live /pods).",
    steps: [
      {
        kind: "launch",
        describe:
          "Launch live against the gym apex (-apex-host gym.flagshipserver.com → live client + useLiveClient).",
      },
      { kind: "assert", describe: "Onboard / reach the live home shell.", handle: "home-add-server" },
      { kind: "tap", describe: "Create a server (provision a gym demo box).", handle: "home-add-server" },
      { kind: "type", describe: "Name the server.", handle: "cs-name-field" },
      { kind: "tap", describe: "Continue through create-server.", handle: "cs-next-button" },
      { kind: "wait", describe: "Provision → online ladder advances (real Hetzner boot)." },
      { kind: "assert", describe: "Box comes online on Home.", handle: "pod-card-online" },
      { kind: "tap", describe: "Approve the boot-unlock (sealed lease → box unlocks).", handle: "approve-unlock-btn" },
      { kind: "tap", describe: "Open the build chooser → scratch/git → install a service.", handle: "home-add-server" },
      { kind: "wait", describe: "Service deploys on the live daemon (real container)." },
      { kind: "screenshot", describe: "The installed service on the live box." },
      { kind: "assert", describe: "Service appears in the live services list (D6 effect).", handle: "service-row" },
    ],
    assertions: [
      // The deterministic goal: the REAL effects (D6 G8/G12), not a mock flip.
      { describe: "Box reached online on the live /pods", handle: "pod-card-online", expect: "present" },
      { describe: "The installed service appears (real container ran)", handle: "service-row", expect: "present" },
    ],
    screenshotPoints: [
      { id: "home-live", describe: "The live home shell." },
      { id: "provision", describe: "The provision ladder." },
      { id: "online", describe: "The box online." },
      { id: "service-installed", describe: "The service installed on the live box." },
    ],
    harness: "FlagshipAppUITests/GymLiveTests",
    // §7-G: this scenario creates + installs against the gym DEMO user only.
    destructive: { destructive: true, demoUsername: GYM_LIVE_DEMO_USERNAME },
  },
];
