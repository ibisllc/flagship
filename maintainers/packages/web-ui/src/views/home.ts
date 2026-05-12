/**
 * Home — a friendly landing page that branches into "set up a new
 * project" or "look up an existing one".
 */

import { el, mount } from "../dom.js";
import type { StateStore } from "../state.js";

export function renderHome(root: HTMLElement, store: StateStore): void {
  let lookup = "";
  mount(
    root,
    el(
      "div.home",
      null,
      el("h1", null, "maintainers"),
      el(
        "p.muted",
        null,
        "Cryptographic authority management for any git-versioned project. Your Yubikey signs, the repo stores, every consumer verifies.",
      ),
      el(
        "div.panel",
        null,
        el("h2", null, "Look up a project"),
        el("p.muted", null, "Already adopted? Enter the repo URL to see its current authority."),
        el("input", {
          type: "url",
          placeholder: "github.com/foo/bar",
          onInput: (e: Event) => {
            lookup = (e.target as HTMLInputElement).value.trim();
          },
        }),
        el(
          "div.row.end",
          null,
          el(
            "button.primary",
            {
              onClick: () => {
                if (!lookup) return;
                store.update({
                  route: { kind: "project", repoUrl: lookup, view: "health" },
                });
              },
            },
            "Look up",
          ),
        ),
      ),
      el(
        "div.panel",
        null,
        el("h2", null, "Set up a new project"),
        el(
          "p.muted",
          null,
          "Onboard your own repo in seven short steps. You'll need a Yubikey (or any FIDO2 key with PRF support).",
        ),
        el(
          "div.row.end",
          null,
          el(
            "button.primary",
            {
              onClick: () =>
                store.update({ route: { kind: "onboard", step: "project" } }),
            },
            "Start onboarding",
          ),
        ),
      ),
    ),
  );
}
