/**
 * webapp gym scenarios: the browser's admin key under a passkey (apps/web/e2e/gym/gym-custody.spec.ts,
 * docs/webapp-key-custody.md items 2, 5 and 6), with a virtual authenticator that has PRF. Each
 * `harness` is the exact title of a test in that spec.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_CUSTODY: readonly Scenario[] = [
  webTotal(
    "web-total-custody-protect",
    "A browser admin key held under the passphrase only is moved under a passkey from Account security; the card then reads Browser: software key, unlocked with a passkey.",
    "gym custody Account security protects a passphrase-only admin key with a passkey",
    {
      steps: [
        { kind: "launch", describe: "Reach Home with a passphrase-only admin root and open Account security." },
        { kind: "tap", describe: "Protect with a passkey.", handle: "#account-security-protect-key" },
      ],
      assertions: [{ describe: "Custody label", handle: "[data-account-security-custody=passkey]", expect: "text", text: "Browser: software key, unlocked with a passkey" }],
      screenshots: [shot("custody-protected", "Account security showing the passkey-protected admin key.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-custody-per-signature",
    "The first admin signature moves a passphrase-only key under a passkey; every later signature asks the authenticator again, and the passphrase alone no longer opens the key.",
    "gym custody the first signature moves the key under a passkey and every signature asks again",
    {
      steps: [
        { kind: "launch", describe: "Reach Home with a passphrase-only admin root." },
        { kind: "assert", describe: "Three admin signatures each verify and each raise the authenticator's sign count." },
      ],
      assertions: [{ describe: "Still signed in on Home", handle: "#view-home", expect: "present" }],
      screenshots: [shot("custody-signed", "Home after three passkey-unlocked admin signatures.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-custody-unsigned-shell",
    "While signed shells are required, a shell without Flagship's signature cannot open the admin key and says why.",
    "gym custody while signed shells are required an unsigned shell can't open the admin key",
    {
      steps: [
        { kind: "launch", describe: "Serve the shell with the signature requirement on and no signature." },
        { kind: "assert", describe: "An admin signature is refused with the unsigned-shell sentence; the key is untouched." },
      ],
      assertions: [{ describe: "Still signed in on Home", handle: "#view-home", expect: "present" }],
      screenshots: [shot("custody-unsigned-shell", "Home after the unsigned shell refused to open the admin key.")],
      dimension: "D4",
    },
  ),
];
