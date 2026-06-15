// Build-a-service source chooser — the first question of the create-a-
// service flow: "how do you want to build it?". Fans out to the build
// modes; each mode converges on the same deploy + journal on the box.
//
//   - scratch     → describe it, the AI writes + deploys it (existing vibe flow)
//   - git         → import a repo; if Flagship-ready install as-is, else AI-adapt
//   - mcp         → connect Cursor/Cline; build from your editor with your own AI

import { $, registerView, show } from "../lib/router.js";
import { enterVibeCode } from "./vibe-code.js";
import { enterBuildGit } from "./build-git.js";
import { enterBuildMcp } from "./build-mcp.js";
import { enterBuildJournal } from "./build-journal.js";
import { enterBuildKey } from "./build-key.js";

registerView("view-build-source");

export function initBuildSourceView() {
  // Scratch uses the box's model — the next screen asks for / confirms the
  // AI key, then opens the chat seeded with the in-memory credential.
  $("build-src-scratch").addEventListener("click", () =>
    enterBuildKey({
      contextLabel: "Start from scratch with AI",
      onChosen: (credential) => enterVibeCode({ credential }),
    }),
  );
  $("build-src-git").addEventListener("click", () => enterBuildGit());
  $("build-src-mcp").addEventListener("click", () => enterBuildMcp());
  $("build-source-journal-link").addEventListener("click", (e) => {
    e.preventDefault();
    enterBuildJournal();
  });
  $("build-source-back").addEventListener("click", () => show("view-services-list"));
}

export function enterBuildSource() {
  show("view-build-source");
}
