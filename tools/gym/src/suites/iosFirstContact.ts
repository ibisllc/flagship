/**
 * iOS gym scenarios: first contact (apps/mobile/ios/App/UITests/GymFirstContactTests.swift,
 * docs/first-contact.md). Mock tier: `-smoke-approval-pending` has Home ask to serve, signed by its
 * own key; `-smoke-fc-*` decides what the phone holds (the recipe's secret, a pin, Studio's report).
 */

import type { Scenario } from "../scenario.js";
import { iosTotal, shot } from "./helpers.js";

const N = "FlagshipAppUITests/GymFirstContactTests/";

export const IOS_FIRST_CONTACT: readonly Scenario[] = [
  iosTotal(
    "ios-total-first-contact-code",
    "The first blessing of a server made from this phone's recipe: the proof checks out, the six-digit code computed on the phone sits in a small box directly above Approve, and approving pins the key and hands the server its app-name grant.",
    N + "test_firstBlessingShowsTheCodeAboveApproveAndPins",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-approval-pending -smoke-fc-recipe on Activity." },
        { kind: "assert", describe: "Server approvals shows the code box above Yes, this is my server.", handle: "first-contact-code" },
        { kind: "tap", describe: "Approve." },
      ],
      assertions: [
        { describe: "Code sentence", handle: "first-contact-code", expect: "text", text: "If your machine has a monitor, it is showing this code: " },
      ],
      screenshots: [shot("first-contact-code", "The code box above Approve.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-first-contact-studio",
    "Studio reported the same key from the server's console under the key this phone gave it: Confirmed by Studio shows in place of the code.",
    N + "test_studioConfirmationReplacesTheCode",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-approval-pending -smoke-fc-recipe -smoke-fc-studio on Activity." },
        { kind: "assert", describe: "Confirmed by Studio shows, no code.", handle: "first-contact-studio" },
      ],
      assertions: [
        { describe: "Studio line", handle: "first-contact-studio", expect: "text", text: "Confirmed by Studio" },
        { describe: "No code", handle: "first-contact-code", expect: "absent" },
      ],
      screenshots: [shot("first-contact-studio", "Confirmed by Studio above Approve.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-first-contact-not-from-recipe",
    "A server whose enrollment proof fails is refused and said so: This server was not built from your recipe. Do not approve it. No Approve is offered.",
    N + "test_aServerNotBuiltFromTheRecipeIsRefused",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-approval-pending -smoke-fc-bad-proof on Activity." },
        { kind: "assert", describe: "The refusal shows; no Approve.", handle: "first-contact-refused" },
      ],
      assertions: [
        { describe: "Refusal", handle: "first-contact-refused", expect: "text", text: "This server was not built from your recipe. Do not approve it." },
      ],
      screenshots: [shot("first-contact-not-from-recipe", "The refusal in Server approvals.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-first-contact-key-changed",
    "A pinned server asking under another key is refused and shown: This server's key changed. If you did not rebuild it, do not approve anything for it.",
    N + "test_aChangedKeyIsRefused",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-approval-pending -smoke-fc-key-changed on Activity." },
        { kind: "assert", describe: "The refusal shows; no Approve.", handle: "first-contact-refused" },
      ],
      assertions: [
        { describe: "Refusal", handle: "first-contact-refused", expect: "text", text: "This server's key changed. If you did not rebuild it, do not approve anything for it." },
      ],
      screenshots: [shot("first-contact-key-changed", "The changed-key refusal.")],
      dimension: "D4",
    },
  ),
];
