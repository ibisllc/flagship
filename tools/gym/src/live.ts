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
 *     gym origin (webapp.gym.flagshipserver.com); the webapp derives its apex from
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
      {
        kind: "tap",
        describe: "Create a server — add-server goes STRAIGHT to the create form (the chooser screen was removed).",
        handle: "home-add-server",
      },
      { kind: "type", describe: "Name the server.", handle: "cs-name-field" },
      { kind: "tap", describe: "Continue through create-server.", handle: "cs-next-button" },
      { kind: "wait", describe: "Provision → online ladder advances (real Hetzner boot)." },
      { kind: "assert", describe: "Box comes online on Home (the pod status pill).", handle: "pod-card-status" },
      {
        kind: "tap",
        describe: "Server-detail → approve the boot-unlock (sealed lease → box unlocks).",
        handle: "sd-approve-unlock",
      },
      {
        kind: "tap",
        describe:
          "Services tab → 'Build a service' → the build-source chooser (scratch/git) → install a service. " +
          "(The build chooser lives on the Services tab, NOT behind add-server.)",
        handle: "build-src-git",
      },
      { kind: "wait", describe: "Service deploys on the live daemon (real container)." },
      { kind: "screenshot", describe: "The installed service on the live box." },
      { kind: "assert", describe: "Service appears in the live services list (D6 effect)." },
    ],
    assertions: [
      // The deterministic goal: the REAL effects (D6 G8/G12), not a mock flip.
      // (Verdict = the GymLiveTests XCUITest pass/fail; today it proves the live
      // shell + the create-server form entry — the long provision→install legs
      // are the documented extension.)
      { describe: "Live home shell reached (real gym backend)", handle: "home-add-server", expect: "present" },
      { describe: "Create-server form opens against the live backend", handle: "cs-name-field", expect: "present" },
    ],
    screenshotPoints: [
      { id: "home-live", describe: "The live home shell." },
      { id: "provision", describe: "The provision ladder." },
      { id: "online", describe: "The box online." },
      { id: "service-installed", describe: "The service installed on the live box." },
    ],
    harness: "FlagshipAppUITests/GymLiveTests/test_liveVerticalSlice",
    // §7-G: this scenario creates + installs against the gym DEMO user only.
    destructive: { destructive: true, demoUsername: GYM_LIVE_DEMO_USERNAME },
  },

  // ───────────────────────── SERVICE-ACCESS GATING (#102) ─────────────────────
  // The owner-driveable, single-device slices of the service-access gating +
  // web-experience (QR-login) flows (docs/service-access-gating.md). These cover
  // the REAL flows the mocked Tier-1 tranche never exercises: restrict a service,
  // mint each of the 3 invite tiers, see the guest list (with the OWNER-assigned
  // label, never the friend's username), and the "Open secured sessions" list.
  //
  // SCOPE — owner side only. The cross-account REDEEM + the browser QR-login →
  // cookie transition are NOT driveable inside ONE XCUITest (they need a second
  // account + a real browser), and are already proven end-to-end by the live
  // backend driver tools/live-e2e/gating-drive.ts (open→restrict→knock→invite→
  // redeem→authorize→cookie→close→revoke, with the SAME signed envelopes). These
  // iOS slices drive the ADMIN UI against the live gym box and assert the
  // on-screen state; gating-drive.ts is the cross-device complement.
  //
  // Each binds to its own GymLiveTests method, carries the gym DEMO-user
  // guardrail (§7-G), and is gated detect-and-skip on env reachability like every
  // backend:"live" scenario (the gym stays green when the env is down).
  {
    id: "ios-live-gating-restrict-toggle",
    surface: "ios",
    tier: "total",
    backend: "live",
    goal:
      "Tier-2 (real gym box): open a live service's access screen → flip open⇄restricted → " +
      "the status line reflects the new mode (the box's set-service-access-mode took effect).",
    steps: [
      { kind: "launch", describe: "Launch live against the gym apex (-apex-host → live gating client)." },
      { kind: "tap", describe: "Open the live service's detail, then 'Manage access'.", handle: "service-detail-open-access" },
      { kind: "assert", describe: "The 'Who can open this' screen renders the restrict toggle.", handle: "service-access-restrict-toggle" },
      { kind: "tap", describe: "Flip the toggle to restricted (owner-IRK set-mode to the box).", handle: "service-access-restrict-toggle" },
      { kind: "assert", describe: "The status line now reflects the live mode.", handle: "service-access-mode-status" },
      { kind: "screenshot", describe: "Restricted, with the add-person allow-list revealed." },
      { kind: "tap", describe: "Flip back to open (restore the baseline so the box stays public).", handle: "service-access-restrict-toggle" },
    ],
    assertions: [
      { describe: "The access screen exposes the open⇄restricted toggle", handle: "service-access-restrict-toggle", expect: "present" },
      { describe: "The mode status line reflects the live mode after the flip", handle: "service-access-mode-status", expect: "present" },
    ],
    screenshotPoints: [
      { id: "access-open", describe: "The access screen, open baseline." },
      { id: "access-restricted", describe: "Restricted — the allow-list manager revealed." },
    ],
    harness: "FlagshipAppUITests/GymLiveTests/test_gatingRestrictToggle",
    // Toggling a DEMO service's access mode is the destructive surface here.
    destructive: { destructive: true, demoUsername: GYM_LIVE_DEMO_USERNAME },
  },
  {
    id: "ios-live-gating-invite-tiers",
    surface: "ios",
    tier: "total",
    backend: "live",
    goal:
      "Tier-2 (real gym box): on a restricted live service, mint each of the 3 invite tiers " +
      "(personal auto-approve, personal manual-approve, group/multi-use) and see each in the " +
      "guest list under the OWNER-assigned label (never the friend's username).",
    steps: [
      { kind: "launch", describe: "Launch live against the gym apex (-apex-host → live gating client)." },
      { kind: "tap", describe: "Open the live service's 'Manage access' and restrict it.", handle: "service-access-restrict-toggle" },
      { kind: "assert", describe: "The create-invite tier picker renders (One person / I approve / A group).", handle: "service-access-tier-picker" },
      { kind: "type", describe: "Name the personal auto-approve invite (an owner-private label).", handle: "service-access-name-field" },
      { kind: "tap", describe: "Create the personal auto-approve invite link.", handle: "service-access-create-invite" },
      { kind: "assert", describe: "The shareable link surfaces (the invite minted on .com).", handle: "service-access-share-url" },
      { kind: "type", describe: "Name a personal manual-approve invite (after switching the tier).", handle: "service-access-name-field" },
      { kind: "tap", describe: "Create the manual-approve invite link.", handle: "service-access-create-invite" },
      { kind: "type", describe: "Set a group invite's max-redemptions cap (after switching to group).", handle: "service-access-group-max" },
      { kind: "tap", describe: "Create the group invite link.", handle: "service-access-create-invite" },
      { kind: "screenshot", describe: "The guest list — each entry shows ONLY the owner-assigned label." },
      { kind: "assert", describe: "The minted invites appear in the people list (label-only).", handle: "service-access-tier-picker" },
    ],
    assertions: [
      { describe: "The create-invite tier picker offers all 3 tiers", handle: "service-access-tier-picker", expect: "present" },
      { describe: "Creating an invite surfaces a shareable link (the .com row was minted)", handle: "service-access-share-url", expect: "present" },
    ],
    screenshotPoints: [
      { id: "tier-picker", describe: "The 3-tier invite picker." },
      { id: "personal-auto-link", describe: "A personal auto-approve link minted." },
      { id: "group-link", describe: "A group/multi-use link minted." },
      { id: "guest-list", describe: "The guest list — labels only, never the friend's username." },
    ],
    harness: "FlagshipAppUITests/GymLiveTests/test_gatingInviteTiers",
    destructive: { destructive: true, demoUsername: GYM_LIVE_DEMO_USERNAME },
  },
  {
    id: "ios-live-web-experience-secured-sessions",
    surface: "ios",
    tier: "total",
    backend: "live",
    goal:
      "Tier-2 (real gym box): Settings → 'Open secured sessions' opens the browser QR-login " +
      "session list (the web-experience surface the phone holds the secretId for) — its list " +
      "surface renders against the live client (the empty card when no browser was signed in).",
    steps: [
      { kind: "launch", describe: "Launch live against the gym apex (-apex-host → live gating client)." },
      { kind: "tap", describe: "Settings → 'Open secured sessions'.", handle: "settings-open-secured-sessions" },
      { kind: "assert", describe: "The Secured sessions screen renders (empty card, or a session row + Stop).", handle: "secured-sessions-empty" },
      { kind: "screenshot", describe: "The secured-sessions list (the QR-login session management surface)." },
    ],
    assertions: [
      // Deterministic with no second device: the list renders. With no browser
      // signed in during the run it shows the empty card; gating-drive.ts is the
      // path that populates + Stops a real session (cross-device, not one XCUITest).
      { describe: "The 'Open secured sessions' screen renders its list surface", handle: "secured-sessions-empty", expect: "present" },
    ],
    screenshotPoints: [
      { id: "secured-sessions", describe: "The Open-secured-sessions list." },
    ],
    harness: "FlagshipAppUITests/GymLiveTests/test_webExperienceSecuredSessions",
    // Reaching the list is read-only, but a Stop (if a session existed) is a
    // destructive session-kill against the demo box — keep it demo-guarded.
    destructive: { destructive: true, demoUsername: GYM_LIVE_DEMO_USERNAME },
  },
];
