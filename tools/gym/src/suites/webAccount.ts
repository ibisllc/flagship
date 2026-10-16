/**
 * webapp gym scenarios: Settings, account, Activity and rate limits
 * (apps/web/e2e/gym/gym-account.spec.ts + gym-activity.spec.ts). Same rules as
 * web.ts: each `harness` is the exact title of a test in that spec.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

type Check = { describe: string; handle?: string; expect: "present" | "absent" | "enabled" | "disabled" | "text"; text?: string };

/** One total-gym row: a launch step, the taps that matter, and what must hold. */
function row(
  id: string,
  goal: string,
  title: string,
  taps: Array<[describe: string, handle: string]>,
  assertions: Check[],
  shots: Array<[id: string, describe: string]>,
  dimension: "D1" | "D3" | "D4" = "D1",
): Scenario {
  return webTotal(id, goal, title, {
    steps: [
      { kind: "launch", describe: "Reach Home (gymKit reachHome), then click into the screen." },
      ...taps.map(([describe, handle]) => ({ kind: "tap" as const, describe, handle })),
    ],
    assertions,
    screenshots: shots.map(([i, d]) => shot(i, d)),
    dimension,
  });
}

export const WEB_ACCOUNT: readonly Scenario[] = [
  row(
    "web-total-activity-merged-feed",
    "Activity merges the server's own log (backup, update, import, migration, share, a failed backup as a warning card; generic owner writes left out) with the account events from .com, newest first, plus the post-recovery report card.",
    "gym activity merges every server's log with account events, newest first",
    [["Open the Activity tab.", '[data-tab-target="activity"]']],
    [
      { describe: "Feed", handle: "#activity-feed", expect: "text", text: "Backup ready" },
      { describe: "Failed entry as a warning", handle: "#activity-feed .card.warning", expect: "text", text: "Backup failed" },
    ],
    [["activity-merged", "The merged feed."]],
    "D3",
  ),
  row(
    "web-total-activity-server-chips",
    "Activity's server chips: the current server's log by default, one server's log when its chip is tapped, and every server's log with each row naming its server under All servers.",
    "gym activity server chips scope the log to one server or show all of them",
    [
      ["Tap office.", "[data-pod-switch]"],
      ["Tap All servers.", '[data-pod-switch=""]'],
    ],
    [{ describe: "Three chips", handle: "#activity-feed [data-pod-switch]", expect: "present" }],
    [
      ["activity-office", "office's log."],
      ["activity-all-servers", "Every server's log."],
    ],
  ),
  row(
    "web-total-activity-account-history",
    "See all account history opens Account history (30 newest), Load more widens it until everything is shown, Refresh reads it again, Back returns to Activity.",
    "gym activity See all account history pages through the account events and comes back",
    [
      ["See all account history.", "#activity-see-all-audit"],
      ["Load more.", "#account-audit-load-more"],
      ["Refresh.", "#account-audit-refresh"],
      ["Back.", "#account-audit-back"],
    ],
    [{ describe: "Audit cards", handle: "#account-audit-content [data-audit-seq]", expect: "present" }],
    [["account-history", "Account history."]],
  ),
  row(
    "web-total-activity-report-and-install",
    "Activity's View report opens the post-recovery report (its Back goes Home) and Open install tracker opens Install progress.",
    "gym activity View report opens the post-recovery report and the install tracker opens",
    [
      ["View report.", "#activity-feed-open-recovery"],
      ["Open install tracker.", "#activity-open-install-progress"],
    ],
    [{ describe: "Install progress", handle: "#view-install-progress", expect: "present" }],
    [
      ["activity-recovery-report", "The post-recovery report."],
      ["activity-install-tracker", "The install tracker."],
    ],
  ),
  row(
    "web-total-settings-rows",
    "Every Settings row, clicked from Home → Settings, opens its screen and its Back leaves it (to Settings where it should); Scan a pairing code refuses a link that isn't one and Cancel closes it.",
    "gym account every Settings row opens its screen from Home and Back leaves it",
    [
      ["Each row in turn, then its Back.", "#view-settings-tab .fs-row"],
      ["Scan a pairing code → bad link → Cancel.", "#settings-tab-join-account"],
    ],
    [{ describe: "Join refusal", handle: "dialog [data-join-error]", expect: "present" }],
    [
      ["settings-rows-walked", "After the walk."],
      ["settings-join-refused", "The refused pairing link."],
    ],
    "D3",
  ),
  row(
    "web-total-settings-appearance-privacy-about",
    "Appearance, Privacy and About say what they should and their links open flagshipserver.com pages in a new tab with rel=noopener.",
    "gym account Appearance, Privacy and About carry their text and links",
    [
      ["Appearance → Back.", "#appearance-back"],
      ["Privacy → Back.", "#privacy-back"],
      ["About → Back.", "#about-back"],
    ],
    [{ describe: "Security report link", handle: '#view-about a[href="https://flagshipserver.com/security#report"]', expect: "present" }],
    [["settings-about", "About."]],
  ),
  row(
    "web-total-settings-developer-toggle",
    "Show developer tools reveals Send order and Create a server, is remembered in localStorage, and unticking hides them again.",
    "gym account the developer toggle shows Send order and is remembered",
    [
      ["Tick the toggle.", "#settings-debug-toggle"],
      ["Send order.", "#settings-tab-orders-debug"],
      ["Create a server.", "#settings-tab-create-server"],
    ],
    [{ describe: "Orders debug view", handle: "#view-orders-debug", expect: "present" }],
    [["settings-orders-debug", "Send order (debug)."]],
  ),
  row(
    "web-total-settings-sign-out-enrolled",
    "With cloud recovery set up, Sign out isn't greyed; it asks 'Sign out?' (Cancel keeps the key), and OK erases this device's key, lands on Welcome and toasts 'Signed out', sending nothing.",
    "gym account sign out with cloud recovery asks first, then erases this device's key",
    [["Sign out → Cancel → Sign out → OK.", "#settings-signout"]],
    [{ describe: "Welcome", handle: "#view-bootstrap", expect: "present" }],
    [
      ["signout-confirm", "The Sign out? confirm."],
      ["signed-out", "Welcome after sign-out."],
    ],
    "D4",
  ),
  row(
    "web-total-settings-remove-device-enrolled",
    "With cloud recovery set up, Remove this device asks 'Reset this device?' and OK drops the key and the session token and returns to Welcome.",
    "gym account Remove this device with cloud recovery confirms and returns to Welcome",
    [["Remove this device → Reset.", "#settings-reset"]],
    [{ describe: "Welcome", handle: "#view-bootstrap", expect: "present" }],
    [["remove-device-confirm", "The reset confirm."]],
    "D4",
  ),
  row(
    "web-total-settings-delete-account",
    "Delete account: the button waits for the typed username, Cancel goes back with nothing sent, and the delete (with 'also wipe my servers') is signed under the admin root (the mock refuses the IRK as .com does), then the device lands on Welcome.",
    "gym account Delete account: the typed name gates it, Cancel keeps the account, then it signs under the admin root",
    [
      ["Delete account → type a wrong name → the right one → Cancel.", "#account-delete-back"],
      ["Delete account → wipe servers → type → Delete.", "#account-delete-go"],
    ],
    [{ describe: "Welcome", handle: "#view-bootstrap", expect: "present" }],
    [["delete-account-gated", "The gated ceremony."]],
    "D4",
  ),
  row(
    "web-total-settings-demo-account",
    "A demo account's Settings marks the key rows hidden and its Delete account and Sign out explain the demo and only remove it from this browser, sending nothing.",
    "gym account a demo account hides the key rows and Sign out only removes it from this browser",
    [["Delete account (Cancel), then Sign out → Remove from this browser.", "#settings-signout"]],
    [{ describe: "Welcome", handle: "#view-bootstrap", expect: "present" }],
    [["settings-demo", "A demo account's Settings."]],
    "D4",
  ),
  row(
    "web-total-settings-browser-sessions",
    "Browser sessions lists only kind:remote sessions (not the devices' own), revoke asks first and sends DELETE /api/screens/paired-sessions/<prefix>; an older box without kind hides only this device's session.",
    "gym account Browser sessions lists only browsers opened through Remote and revokes one",
    [
      ["Browser sessions.", "#settings-tab-sessions"],
      ["revoke → Cancel → revoke → OK.", '[data-action="revoke"]'],
      ["Refresh.", "#paired-sessions-refresh"],
    ],
    [{ describe: "One remote session", handle: "#paired-sessions-content", expect: "text", text: "Session aaaa1111" }],
    [["browser-sessions", "Browser sessions."]],
    "D4",
  ),
  row(
    "web-total-settings-remote-browsers",
    "Settings → Remote lists the connected browsers (with the link to open the remote page) and disconnecting one asks first and posts the revoke.",
    "gym account Remote lists the connected browsers and disconnects one",
    [["Remote → revoke → Disconnect.", '#companion-dock-content [data-action="revoke"]']],
    [{ describe: "Empty after revoke", handle: "#companion-dock-content", expect: "text", text: "no browsers connected" }],
    [["remote-browsers", "Connected browsers."]],
    "D4",
  ),
  row(
    "web-total-settings-two-factor",
    "Account security two-factor: begin shows the secret, Cancel drops it, an empty and a wrong code are refused, the right one shows the recovery codes, Done waits for 'I've saved these', the badge turns multi, and Disable asks twice and posts the live code.",
    "gym account two-factor enrolment shows the secret, refuses a wrong code, saves the codes and disables",
    [
      ["Enable → Cancel → Enable.", "#account-security-enable"],
      ["Verify (empty, wrong, right).", "#account-security-verify"],
      ["Saved → Done.", "#account-security-done"],
      ["Disable → confirm → code.", "#account-security-disable"],
    ],
    [{ describe: "Back to single", handle: '[data-account-security-badge="single"]', expect: "present" }],
    [
      ["totp-wrong-code", "A wrong code."],
      ["totp-recovery-codes", "The recovery codes."],
    ],
    "D4",
  ),
  row(
    "web-total-settings-profiles",
    "Profiles lists each account on this browser and Switch makes another the active one (toast, active row, stored), Refresh keeps it.",
    "gym account Profiles lists each account and switches the active one",
    [["Switch to work.", '[data-action="switch"]']],
    [{ describe: "Active row", handle: ".profiles-row-active", expect: "present" }],
    [["profiles", "Profiles."]],
  ),
  row(
    "web-total-settings-secured-sessions",
    "Open secured sessions lists a held session; Refresh asks the box with the secret in the body (never the URL); Stop asks first, closes it and the list empties.",
    "gym account Open secured sessions refreshes and stops a held session",
    [
      ["Refresh the session.", '[data-action="refresh"]'],
      ["Stop → OK.", '[data-action="stop"]'],
    ],
    [{ describe: "Empty", handle: "#secured-sessions-content", expect: "text", text: "No secured sessions." }],
    [["secured-sessions", "A held session."]],
    "D4",
  ),
  row(
    "web-total-settings-trusted-devices-danger",
    "Trusted devices: Replace device starts its 3-second countdown and Cancel stops it with nothing sent; Wipe & restart opens the same sheet; Add device opens pairing.",
    "gym account Trusted devices: Replace device counts down and Cancel stops it, Add device opens pairing",
    [
      ["Replace device → Replace → Cancel.", "#replace-device-btn"],
      ["Wipe & restart → Cancel.", "#wipe-restart-btn"],
      ["Add device.", "#trusted-devices-add"],
    ],
    [{ describe: "Add device", handle: "#view-add-device", expect: "present" }],
    [["replace-countdown", "The countdown."]],
    "D4",
  ),
  row(
    "web-total-settings-ai-keys",
    "AI keys: Cancel saves nothing, a key needs a label, an OpenAI key saves with its base URL, model and the relay off (masked), the relay switch flips it, use makes it active, and remove asks first; the key is never sent anywhere.",
    "gym account AI keys: Cancel, add a key with its options, the relay switch, use it and remove it",
    [
      ["Add provider → Cancel.", "#np-cancel"],
      ["Add provider → fill → Save.", "#np-save"],
      ["Relay switch.", '[data-action="relay"]'],
      ["use.", '[data-action="set-active"]'],
      ["remove → Cancel → remove → OK.", '[data-action="remove"]'],
    ],
    [{ describe: "No entries left", handle: "#providers-list .provider-entry", expect: "absent" }],
    [["ai-keys-saved", "A saved key."]],
  ),
  row(
    "web-total-rate-limited-sign-in",
    "A rate-limited sign-in (429 rate-limited, limit ip, 720 s) toasts 'Too many tries from your network. Try again in about 12 minutes.' and stays on the cover.",
    "gym account a rate-limited sign-in says who is limited and when to try again",
    [["Type harry → Sign in.", "#bootstrap-continue"]],
    [{ describe: "Still on the cover", handle: "#view-bootstrap", expect: "present" }],
    [["rate-limited-sign-in", "The sentence."]],
    "D4",
  ),
  row(
    "web-total-rate-limited-totp-free-ai",
    "A rate-limited two-factor verify says 'Too many tries from this account. Try again in about 12 minutes.' and a rate-limited Flagship Inference read says '... in a minute.' with Add your own key.",
    "gym account rate-limited two-factor and Flagship Inference reads say who is limited and when",
    [
      ["Enable → code → Verify.", "#account-security-verify"],
      ["AI keys.", "#settings-tab-providers"],
    ],
    [
      { describe: "TOTP sentence", handle: "[data-account-security-failed-msg]", expect: "text", text: "Too many tries from this account" },
      { describe: "Free AI sentence", handle: "#free-ai-line", expect: "text", text: "Try again in a minute." },
    ],
    [
      ["rate-limited-totp", "Two-factor."],
      ["rate-limited-free-ai", "Flagship Inference."],
    ],
    "D4",
  ),
  row(
    "web-total-rate-limited-delete",
    "A rate-limited account deletion leaves everything local: the ceremony stays, the button comes back and the key stays in memory.",
    "gym account a rate-limited account deletion keeps the account and this device's key",
    [["Delete account → type → Delete.", "#account-delete-go"]],
    [{ describe: "Still in the ceremony", handle: "#view-account-delete", expect: "present" }],
    [["rate-limited-delete", "After the refusal."]],
    "D4",
  ),
];
