/**
 * webapp gym scenarios: build chats, git and IDE builds, Build sessions
 * (apps/web/e2e/gym/gym-builds.spec.ts). Same rules as web.ts: each `harness`
 * is the exact title of a test in that spec.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_BUILDS: readonly Scenario[] = [
  webTotal(
    "web-total-build-chooser-controls",
    "The Build chooser (reached from the Services tab) counts the open chat on the Build sessions link, its help names the four options and Done closes it, Git and IDE open their screens and come Back, and Back returns to Services.",
    "gym builds the chooser's help, Build sessions badge and each tile open their screens",
    {
      steps: [
        { kind: "tap", describe: "Services tab → Build a service.", handle: "#services-list-open-vibe-code" },
        { kind: "tap", describe: "Help → Done.", handle: "#build-source-help" },
        { kind: "tap", describe: "Git → Back, IDE → Back, Back.", handle: "#build-src-git" },
      ],
      assertions: [
        { describe: "Active count", handle: "#build-source-active-count", expect: "text", text: "1" },
        { describe: "Back on Services", handle: "#view-services-list", expect: "present" },
      ],
      screenshots: [shot("build-help", "How building works.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-build-continue-ready-chat",
    "Continuing a chat (docs/build-modes.md): a ready-to-deploy chat reopened from Build sessions offers 'Ask for a change…'; Send posts /reply with the text, the model and a fresh Flagship pass minted for that box, and the composer waits while the AI writes.",
    "gym builds reopening a ready chat from Build sessions continues it with a change",
    {
      steps: [
        { kind: "tap", describe: "Build sessions → the ready chat (Continue).", handle: "[data-session]" },
        { kind: "type", describe: "Ask for a change.", handle: "#vc-prompt" },
        { kind: "tap", describe: "Send.", handle: "#vc-send" },
      ],
      assertions: [
        { describe: "Continue placeholder", handle: "#vc-prompt", expect: "present" },
        { describe: "Writing after the reply", handle: "#vc-status", expect: "text", text: "Writing…" },
      ],
      screenshots: [shot("sessions-ready-chat", "Build sessions."), shot("chat-ready-continue", "Ready, continuing."), shot("chat-continued", "After the reply.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-continue-failed-chat",
    "A failed chat shows the box's reason and takes 'what to try next' on /reply; a deployed chat keeps the composer off and shows its link.",
    "gym builds a failed chat takes what to try next, and a deployed one takes nothing",
    {
      steps: [
        { kind: "tap", describe: "Open the failed chat from Build sessions.", handle: "[data-session]" },
        { kind: "tap", describe: "Send what to try next.", handle: "#vc-send" },
      ],
      assertions: [
        { describe: "Failure reason", handle: "#vc-result", expect: "present" },
        { describe: "Composer off once deployed", handle: "#vc-send", expect: "disabled" },
      ],
      screenshots: [shot("chat-failed-continue", "Failed, continuing."), shot("chat-deployed-closed", "Deployed.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-switch-provider",
    "Switching provider mid-chat: the model menu groups Flagship Inference then the saved key; a smaller-context model shows the compaction notice, a model with effort levels shows the effort picker; the next reply carries that key, model and effort and mints no Flagship pass. The box's 'Earlier conversation summarised' shows.",
    "gym builds switching to a saved key's model sends that key, model and effort with the next message",
    {
      steps: [
        { kind: "tap", describe: "Open the model menu; pick GPT-5 mini (compaction notice).", handle: ".mm-trigger" },
        { kind: "tap", describe: "Pick GPT-5; set effort High.", handle: "[data-mm-effort]" },
        { kind: "tap", describe: "Send.", handle: "#vc-send" },
      ],
      assertions: [
        { describe: "Two groups", handle: ".mm-panel .mm-group", expect: "present" },
        { describe: "Compaction notice", handle: ".mm-context", expect: "text", text: "Older messages will be summarised to fit this model." },
        { describe: "Effort picker", handle: "[data-mm-effort]", expect: "present" },
      ],
      screenshots: [shot("model-menu-grouped", "Grouped menu."), shot("model-compaction-notice", "Compaction notice."), shot("model-effort", "Effort.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-deploy-chat",
    "A ready chat's Files disclosure lists what the AI wrote; Deploy posts the deploy, toasts Deployed and shows the live link with the left-open warning; New build brings back an empty first-turn form; Back returns to the chooser.",
    "gym builds Deploy puts a ready chat live, then New build and Back",
    {
      steps: [
        { kind: "tap", describe: "Files → server.js.", handle: "#vc-files-box summary" },
        { kind: "tap", describe: "Deploy.", handle: "#vc-deploy-go" },
        { kind: "tap", describe: "New build, then Back.", handle: "#vc-reset" },
      ],
      assertions: [
        { describe: "Live link", handle: "#vc-result a", expect: "present" },
        { describe: "Left-open warning", handle: ".vc-left-open", expect: "present" },
      ],
      screenshots: [shot("chat-files", "Files."), shot("chat-deployed", "Deployed.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-new-chat-fields",
    "A new chat: an example fills the description, 'Anyone with the link' explains itself and rides start, a name another session holds shows as taken, and Decline on the AI's env-var request answers declined without sending a value.",
    "gym builds a new chat's examples, visibility, a taken name and env Decline",
    {
      steps: [
        { kind: "tap", describe: "Example chip.", handle: "[data-example]" },
        { kind: "tap", describe: "Visibility: Anyone with the link.", handle: "#vc-visibility" },
        { kind: "tap", describe: "Build it.", handle: "#vc-send" },
        { kind: "tap", describe: "Decline the env var.", handle: "#vc-envvar-decline" },
      ],
      assertions: [{ describe: "Declined toast", handle: "#toast", expect: "text", text: "Declined" }],
      screenshots: [shot("chat-name-taken", "Taken name."), shot("chat-env-declined", "Declined.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-name-conflict-dialog",
    "When start finds the name taken by another build session (409), the 'That name is taken' dialog's Pick another name keeps the form, and Open build sessions opens the list.",
    "gym builds a name another build took at start opens Build sessions or lets the owner pick another",
    {
      steps: [
        { kind: "tap", describe: "Build it → Pick another name.", handle: "[data-modal-cancel]" },
        { kind: "tap", describe: "Build it → Open build sessions.", handle: "[data-modal-ok]" },
      ],
      assertions: [{ describe: "Build sessions", handle: "#view-build-journal", expect: "present" }],
      screenshots: [shot("chat-conflict-dialog", "The dialog.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-build-discard",
    "Build sessions' Discard… asks first (the name it frees); Cancel sends nothing, Discard build removes the chat (POST /api/llm/sessions/:id/discard) and the open git build (POST /api/build/sessions/:id/discard); Back returns to the chooser.",
    "gym builds Discard asks first, then removes a chat and an open build",
    {
      steps: [
        { kind: "tap", describe: "Discard the chat: Cancel, then confirm.", handle: "[data-discard]" },
        { kind: "tap", describe: "Discard the open build: confirm.", handle: "[data-discard-build]" },
      ],
      assertions: [{ describe: "Empty list", handle: "#build-journal-list", expect: "text", text: "No builds yet." }],
      screenshots: [shot("sessions-open", "Before."), shot("sessions-discarded", "After.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-build-git-restart-resume",
    "A git build a box restart cut off (adapt failed, 3cadd12da): opening it from Build sessions shows the box's reason with 'Use AI to adapt and deploy' and 'Install it'; running the AI again goes through the AI-key step and adapts THIS build to Installed.",
    "gym builds a git build a restart cut off reopens with the box's reason and runs the AI again",
    {
      steps: [
        { kind: "tap", describe: "Build sessions → the open git build.", handle: ".build-session-row[data-build]" },
        { kind: "tap", describe: "Use AI to adapt and deploy.", handle: "#build-git-adapt" },
      ],
      assertions: [
        { describe: "Box's reason", handle: "[data-build-failed] .err-text", expect: "present" },
        { describe: "Installed", handle: "#build-git-verdict", expect: "text", text: "Installed ✓" },
      ],
      screenshots: [shot("git-resumed-failed", "The reason and actions."), shot("git-resumed-installed", "Installed.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-sealed-and-ide-resume",
    "A sealed git build a restart cut off offers only Install it (which installs); an IDE build cut off shows the reason in its journal with Install it, which posts the deploy on its server.",
    "gym builds a sealed git build a restart cut off offers only Install it, and an IDE one deploys from Build sessions",
    {
      steps: [
        { kind: "tap", describe: "Open the sealed git build → Install it.", handle: "#build-git-deploy" },
        { kind: "tap", describe: "Open the IDE build → Install it.", handle: "#build-journal-deploy" },
      ],
      assertions: [
        { describe: "No AI on a sealed build", handle: "#build-git-adapt", expect: "absent" },
        { describe: "Deployed toast", handle: "#toast", expect: "text", text: "Deployed" },
      ],
      screenshots: [shot("git-sealed-resumed", "Sealed."), shot("ide-resumed-failed", "IDE build.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-git-install",
    "Git import: branch and name ride the check, ↻ checks again, Install it installs with the live link, Get flagship.app.json downloads the adapter file, and View build journal opens the build's timeline.",
    "gym builds a git import installs, checks again, exports its adapter and opens its journal",
    {
      steps: [
        { kind: "type", describe: "URL, branch, name; Check repo.", handle: "#build-git-check" },
        { kind: "tap", describe: "↻, Install it, Get flagship.app.json.", handle: "#build-git-deploy" },
        { kind: "tap", describe: "View build journal.", handle: "#build-git-journal" },
      ],
      assertions: [
        { describe: "Installed", handle: "#build-git-verdict", expect: "text", text: "Installed ✓" },
        { describe: "Journal", handle: ".build-journal-timeline", expect: "present" },
      ],
      screenshots: [shot("git-installed", "Installed.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-git-adapt-retry",
    "Git adapt: the share switch's state rides the adapt; a tested copy that didn't go live shows the box's reason and Try again (a fresh check, adapted again); a sealed failure closes the build to the AI and Check again starts afresh.",
    "gym builds a git adapt carries the share switch, offers Try again when not live, and closes when sealed",
    {
      steps: [
        { kind: "tap", describe: "Share off → Use AI to adapt and deploy.", handle: "#build-git-share" },
        { kind: "tap", describe: "Try again.", handle: "#build-git-retry" },
        { kind: "tap", describe: "Check again (closed).", handle: "#build-git-recheck-full" },
      ],
      assertions: [{ describe: "Adapt offered again", handle: "#build-git-adapt", expect: "present" }],
      screenshots: [shot("git-not-live", "Not live."), shot("git-closed", "Closed.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-mcp-controls",
    "Connect your IDE: Copy IDE config puts the JSON on the clipboard, Regenerate key shows the new key, Refresh updates the value-free env requests, Deploy now posts the deploy, View journal opens the timeline.",
    "gym builds an IDE connection copies its config, regenerates its key, deploys and refreshes its requests",
    {
      steps: [
        { kind: "tap", describe: "Create a connection; Copy IDE config.", handle: "#mcp-copy-cfg" },
        { kind: "tap", describe: "Regenerate key; Refresh; Deploy now; View journal.", handle: "#mcp-rotate" },
      ],
      assertions: [
        { describe: "New key", handle: "#mcp-key", expect: "text", text: "mcpk_second" },
        { describe: "Request set", handle: "#mcp-env-requests", expect: "text", text: "set ✓" },
      ],
      screenshots: [shot("mcp-deployed", "Deployed.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-build-key-step-controls",
    "The AI-key step: Back, + Add an API key and Cancel, adding a key with base URL, label and the relay off, a saved key's relay switch, Delete with Cancel and confirm, and Use this opening the chat on that key.",
    "gym builds the AI-key step adds, cancels, relays, deletes and uses saved keys",
    {
      steps: [
        { kind: "tap", describe: "Back; + Add; Cancel.", handle: "#build-key-add" },
        { kind: "type", describe: "Provider, base URL, key, label, relay off; Add key.", handle: "#bk-add" },
        { kind: "tap", describe: "Relay switch; Delete → Cancel / Delete key; Use this.", handle: "[data-use-id]" },
      ],
      assertions: [{ describe: "Chat on the key", handle: "#vc-model-bar .mm-trigger-text", expect: "text", text: "Work key" }],
      screenshots: [shot("build-key-added", "Key added."), shot("build-key-used", "Chat on the key.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-install-tracker",
    "The install tracker (Activity → Open install tracker): Watch needs a serial, then shows the phase and the server; Reset clears; a failed status read shows the reason with Try again (re-reads) and Go to Home; Back returns Home.",
    "gym builds the install tracker follows a serial and offers a way out when the status read fails",
    {
      steps: [
        { kind: "tap", describe: "Activity → Open install tracker.", handle: "#activity-open-install-progress" },
        { kind: "type", describe: "Serial; Watch; Reset.", handle: "#ip-go" },
        { kind: "tap", describe: "Try again; Go to Home; Back.", handle: "#ip-escape-retry" },
      ],
      assertions: [{ describe: "Home", handle: "#view-home", expect: "present" }],
      screenshots: [shot("install-progress", "Installing."), shot("install-progress-escape", "The way out.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-builds-resume-open-git",
    "Build sessions reopens any open git build where it stands: one the AI hasn't touched shows its not-ready card with the AI offered; one still adapting is followed (no new adapt is started) until the box says it's live.",
    "gym builds an open git build reopens where it stands: its verdict, or the adapt still running",
    {
      steps: [
        { kind: "tap", describe: "Build sessions → the untouched git build.", handle: ".build-session-row[data-build]" },
        { kind: "tap", describe: "Back → Build sessions → the build still adapting.", handle: ".build-session-row[data-build]" },
      ],
      assertions: [
        { describe: "Verdict card", handle: "#build-git-adapt", expect: "present" },
        { describe: "Installed after following", handle: "#build-git-verdict", expect: "text", text: "Installed ✓" },
      ],
      screenshots: [shot("git-resumed-verdict", "The verdict again."), shot("git-resumed-running", "Following the adapt.")],
      dimension: "D3",
    },
  ),
];
