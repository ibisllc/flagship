/**
 * webapp gym scenarios: the confirm, prompt and menu dialogs on the app and build screens (apps/web/e2e/gym/gym-dialogs.spec.ts). Same rules as web.ts:
 * each `harness` is the exact title of a test in that spec.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_DIALOGS: readonly Scenario[] = [
  webTotal(
    "web-total-dialogs-refuse-cancel",
    "Access control: Refuse on a co-manager asks 'Refuse Mum?' with its explanation; Cancel keeps Mum at Manager, still refusable, and sends no rank order.",
    "gym dialogs Refuse Cancel keeps a co-manager's rank and sends nothing",
    {
      steps: [
        { kind: "tap", describe: "Refuse on Mum's row.", handle: '[data-action="sa-acct-refuse"]' },
        { kind: "tap", describe: "Cancel.", handle: "[data-modal-cancel]" },
      ],
      assertions: [{ describe: "Still Manager", handle: 'select[data-action="sa-acct-rank"]', expect: "present" }],
      screenshots: [shot("refuse-confirm", "The Refuse confirm.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-dialogs-runs-on-remove-cancel",
    "Runs on: unticking a server that holds a copy asks 'Remove from this server?'; Cancel re-ticks the box and nothing is deleted anywhere.",
    "gym dialogs Remove from this server Cancel re-ticks Runs on and deletes nothing",
    {
      steps: [
        { kind: "tap", describe: "Untick media.", handle: "[data-runs-on-toggle]" },
        { kind: "tap", describe: "Cancel.", handle: "[data-modal-cancel]" },
      ],
      assertions: [{ describe: "Media still ticked", handle: "[data-runs-on-toggle]", expect: "present" }],
      screenshots: [shot("runs-on-remove-confirm", "The remove confirm.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-dialogs-edit-refusals",
    "Edit this service with AI: 'Already being changed' → Open build sessions lands on Build sessions; 'Too big for the AI chat' → Use your IDE opens the IDE connection for this service.",
    "gym dialogs Edit's refusals open Build sessions or your IDE",
    {
      steps: [
        { kind: "tap", describe: "Start an edit the box refuses as busy; Open build sessions.", handle: "[data-modal-ok]" },
        { kind: "tap", describe: "Start an edit the box refuses as too big; Use your IDE.", handle: "[data-modal-ok]" },
      ],
      assertions: [{ describe: "IDE screen", handle: "#view-build-mcp", expect: "present" }],
      screenshots: [shot("edit-busy", "Already being changed."), shot("edit-too-big-ide", "The IDE screen.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-dialogs-model-menu-free-text",
    "Build chat model menu: Escape and a click outside close it; a key whose provider doesn't list models takes a typed model id, which stays chosen and rides the next reply with that key.",
    "gym dialogs the model menu takes a typed model id and closes on Escape and an outside click",
    {
      steps: [
        { kind: "tap", describe: "Open the menu; Escape; open; click outside.", handle: ".mm-trigger" },
        { kind: "type", describe: "Type a model id in the key's group.", handle: "[data-mm-free]" },
        { kind: "tap", describe: "Send a change.", handle: "#vc-send" },
      ],
      assertions: [{ describe: "Typed model chosen", handle: ".mm-trigger-text", expect: "text", text: "my-tuned-model" }],
      screenshots: [shot("model-free-text", "The free model field.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-dialogs-vision-cancel-blocked",
    "An image on a text-only model: Cancel on the switch offer keeps Medium and the attachment and starts nothing; on High, which has no image-capable alternative, the 'can't see images' alert's OK starts nothing.",
    "gym dialogs an image on a text-only model: Cancel keeps it, and with no alternative it's blocked",
    {
      steps: [
        { kind: "tap", describe: "Medium + an image → Send → Cancel.", handle: "[data-modal-cancel]" },
        { kind: "tap", describe: "High + an image → Send → OK.", handle: "[data-modal-ok]" },
      ],
      assertions: [{ describe: "Still on the chat form", handle: "#view-vibe-code", expect: "present" }],
      screenshots: [shot("vision-switch-offer", "The switch offer."), shot("vision-blocked", "Blocked.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-dialogs-git-name-conflict",
    "Git import name conflicts: another build session's name offers Pick another name (form stays) or Open build sessions (the list); an installed app's name offers only Pick another name.",
    "gym dialogs a git import's name conflict offers Build sessions or another name",
    {
      steps: [
        { kind: "tap", describe: "Check repo → Pick another name.", handle: "[data-modal-cancel]" },
        { kind: "tap", describe: "Check repo → Open build sessions.", handle: "[data-modal-ok]" },
        { kind: "tap", describe: "Check repo (installed app's name) → Pick another name.", handle: "[data-modal-ok]" },
      ],
      assertions: [{ describe: "Back on the git screen", handle: "#view-build-git", expect: "present" }],
      screenshots: [shot("git-conflict-session", "The conflict dialog.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-dialogs-relay-off",
    "A relay failure in a chat on a saved key shows the box's sentence and 'Turn the relay off for this key', which turns the saved key's relay off and goes; a git adapt failing the same way offers the same, then the adapt again.",
    "gym dialogs Turn the relay off after a relay failure, in a chat and a git import",
    {
      steps: [
        { kind: "tap", describe: "Chat on the Work key fails on the relay → Turn the relay off.", handle: "#vc-relay-off" },
        { kind: "tap", describe: "Git adapt on the Work key fails on the relay → Turn the relay off.", handle: "#build-git-relay-off" },
      ],
      assertions: [{ describe: "Adapt offered again", handle: "#build-git-adapt", expect: "present" }],
      screenshots: [shot("chat-relay-failure", "Chat relay failure."), shot("git-relay-failure", "Git relay failure.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-dialogs-runs-on-picker",
    "The Runs on picker sends each new build to the server picked: a chat's name check, pass and start to media, a git check to home, an IDE connection to media.",
    "gym dialogs the Runs on picker sends a new chat, a git check and an IDE connection to the server picked",
    {
      steps: [
        { kind: "tap", describe: "Chat: pick media, start.", handle: "#vc-runs-on [data-runs-on-select]" },
        { kind: "tap", describe: "Git: pick home, check.", handle: "#build-git-runs-on [data-runs-on-select]" },
        { kind: "tap", describe: "IDE: pick media, create.", handle: "#build-mcp-runs-on [data-runs-on-select]" },
      ],
      assertions: [{ describe: "IDE URL on media", handle: "#mcp-url", expect: "present" }],
      screenshots: [shot("runs-on-chat-media", "Chat on media."), shot("runs-on-mcp-media", "IDE on media.")],
      dimension: "D3",
    },
  ),
];
