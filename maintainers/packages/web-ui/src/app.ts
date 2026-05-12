/**
 * Top-level UI mount.
 *
 * `mountApp(root, options)` is the single public entry point. It:
 *   - injects the stylesheet (once per document)
 *   - reads the URL hash and turns it into an initial Route
 *   - constructs the StateStore
 *   - subscribes a re-render hook so any update redraws the active view
 *   - returns a small handle for tests/integrators to drive the store
 *     externally (e.g. swap adapters, advance virtual time)
 *
 * Routing model: location.hash. Examples:
 *   #/              → home
 *   #/onboard       → onboarding wizard step 1
 *   #/p/github.com/foo/bar   → project view (health tab)
 *   #/p/github.com/foo/bar/roster  → project view (roster tab)
 *   #/p/github.com/foo/bar/renew/release  → renew the release track
 *   #/p/github.com/foo/bar/takeover/release  → take over the release track
 *
 * Query string `?repo=github.com/foo/bar` works too and is auto-rewritten
 * to a hash route on first load.
 */

import type { AdapterClient } from "./adapter.js";
import { ensureStylesInjected } from "./styles.js";
import { defaultDraft, StateStore, type AppState, type OnboardStep, type ProjectView, type Route } from "./state.js";
import { renderHome } from "./views/home.js";
import { renderOnboard, type OnboardDeps } from "./views/onboard.js";
import { renderProject } from "./views/project.js";
import { renderRenew, type RenewDeps } from "./views/renew.js";
import { renderTakeover, type TakeoverDeps } from "./views/takeover.js";
import { el } from "./dom.js";

export interface MountOptions {
  adapter: AdapterClient;
  rpId?: string;
  rpName?: string;
  /** For tests: override "now" so verifier sees a fixed clock. */
  now?: Date;
  onboardDeps?: OnboardDeps;
  renewDeps?: RenewDeps;
  takeoverDeps?: TakeoverDeps;
  /** Disable URL routing (tests). */
  noRouting?: boolean;
}

export interface MountHandle {
  store: StateStore;
  destroy: () => void;
}

export function mountApp(root: HTMLElement, options: MountOptions): MountHandle {
  ensureStylesInjected();
  root.classList.add("maintainers-ui");

  const state: AppState = {
    adapter: options.adapter,
    rpId: options.rpId ?? (typeof location !== "undefined" ? location.hostname : "localhost"),
    rpName: options.rpName ?? "maintainers",
    now: options.now ?? new Date(),
    route: options.noRouting ? { kind: "home" } : parseRoute(),
    loaded: null,
    loading: false,
    error: null,
    draft: defaultDraft(),
  };
  const store = new StateStore(state);

  let lastProjectLoadUrl = "";
  const ensureProjectLoaded = async (url: string): Promise<void> => {
    if (url === lastProjectLoadUrl) return;
    lastProjectLoadUrl = url;
    store.update({ loading: true, error: null });
    try {
      const loaded = await options.adapter.loadProject(url);
      store.update({ loaded, loading: false });
    } catch (e) {
      store.update({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const render = (s: AppState): void => {
    const r = s.route;
    switch (r.kind) {
      case "home":
        renderHome(root, store);
        break;
      case "onboard":
        renderOnboard(r.step, root, store, options.onboardDeps);
        break;
      case "project":
        if (!s.loading && (!s.loaded || s.loaded.ref.canonical !== r.repoUrl)) {
          void ensureProjectLoaded(r.repoUrl);
        }
        renderProject(r.view, root, store);
        break;
      case "renew":
        if (!s.loading && (!s.loaded || s.loaded.ref.canonical !== r.repoUrl)) {
          void ensureProjectLoaded(r.repoUrl);
        }
        renderRenew(r.repoUrl, r.track, root, store, options.renewDeps);
        break;
      case "takeover":
        if (!s.loading && (!s.loaded || s.loaded.ref.canonical !== r.repoUrl)) {
          void ensureProjectLoaded(r.repoUrl);
        }
        renderTakeover(r.repoUrl, r.track, root, store, options.takeoverDeps);
        break;
    }
    if (!options.noRouting) writeRoute(s.route);
    appendFooter(root, s);
  };

  const unsubscribe = store.subscribe(render);
  render(store.get());

  let hashListener: (() => void) | null = null;
  if (!options.noRouting && typeof window !== "undefined") {
    hashListener = () => {
      const r = parseRoute();
      if (!sameRoute(r, store.get().route)) store.update({ route: r });
    };
    window.addEventListener("hashchange", hashListener);
  }

  return {
    store,
    destroy: () => {
      unsubscribe();
      if (hashListener && typeof window !== "undefined") {
        window.removeEventListener("hashchange", hashListener);
      }
    },
  };
}

function appendFooter(root: HTMLElement, s: AppState): void {
  const footer = el(
    "footer",
    null,
    el("span", null, `Storage: ${s.adapter.displayName}`),
    el(
      "span",
      { style: { marginLeft: "12px" } },
      `Spec: maintainers protocol v1`,
    ),
  );
  root.appendChild(footer);
}

function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseRoute(): Route {
  if (typeof location === "undefined") return { kind: "home" };
  const hash = location.hash.replace(/^#/, "");
  if (!hash || hash === "/" || hash === "") {
    const params = new URLSearchParams(location.search);
    const repo = params.get("repo");
    if (repo) return { kind: "project", repoUrl: repo, view: "health" };
    return { kind: "home" };
  }
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "onboard") {
    const stepRaw = parts[1] ?? "project";
    const allowed: OnboardStep[] = [
      "project",
      "yubikey",
      "name-key",
      "cadence",
      "successor",
      "review",
      "commit",
      "done",
    ];
    const step = (allowed as string[]).includes(stepRaw) ? (stepRaw as OnboardStep) : "project";
    return { kind: "onboard", step };
  }
  if (parts[0] === "p" && parts.length >= 4) {
    // /p/<host>/<owner>/<repo>[...]
    const host = parts[1]!;
    const owner = parts[2]!;
    const repo = parts[3]!;
    const repoUrl = `${host}/${owner}/${repo}`;
    const tail = parts.slice(4);
    if (tail[0] === "renew" && tail[1]) {
      return { kind: "renew", repoUrl, track: tail[1] };
    }
    if (tail[0] === "takeover" && tail[1]) {
      return { kind: "takeover", repoUrl, track: tail[1] };
    }
    const tab = tail[0];
    const allowedTabs: ProjectView[] = ["health", "roster", "activity"];
    const view = tab && (allowedTabs as string[]).includes(tab) ? (tab as ProjectView) : "health";
    return { kind: "project", repoUrl, view };
  }
  return { kind: "home" };
}

function writeRoute(r: Route): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  let h = "";
  switch (r.kind) {
    case "home":
      h = "/";
      break;
    case "onboard":
      h = `/onboard/${r.step}`;
      break;
    case "project": {
      const url = r.repoUrl.replace(/^https?:\/\//, "");
      h = `/p/${url}/${r.view}`;
      break;
    }
    case "renew": {
      const url = r.repoUrl.replace(/^https?:\/\//, "");
      h = `/p/${url}/renew/${r.track}`;
      break;
    }
    case "takeover": {
      const url = r.repoUrl.replace(/^https?:\/\//, "");
      h = `/p/${url}/takeover/${r.track}`;
      break;
    }
  }
  const desired = `#${h}`;
  if (location.hash !== desired) {
    history.replaceState(null, "", desired);
  }
}
