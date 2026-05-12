/**
 * Content script entry point.
 *
 * 1. Detect "this URL is a repo page".
 * 2. Fetch `.maintainers/` via raw-content URLs (with 30s cache).
 * 3. Verify the chain using @maintainers/protocol.
 * 4. Render the Shadow-DOM overlay.
 *
 * Re-runs on SPA navigation (github, gitlab use turbolinks-style nav)
 * by listening for the History API + DOMContentLoaded.
 */
import { detectRepo, type RepoLocation } from "./repo-detect.js";
import { fetchMaintainers, type KVStore, type FetcherDeps } from "./fetcher.js";
import { computeOverlayState } from "./verifier-logic.js";
import { mountOverlay, unmountOverlay, type OverlayCallbacks } from "./overlay.js";

declare const chrome: typeof globalThis extends { chrome: infer C } ? C : any;
declare const browser: typeof globalThis extends { browser: infer B } ? B : any;

const ext: any = typeof (globalThis as any).chrome !== "undefined"
  ? (globalThis as any).chrome
  : (globalThis as any).browser;

const storage: KVStore = {
  async get(key: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      try {
        ext.storage.local.get(key, (items: Record<string, string>) => {
          resolve(items[key]);
        });
      } catch {
        resolve(undefined);
      }
    });
  },
  async set(key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        ext.storage.local.set({ [key]: value }, () => resolve());
      } catch {
        resolve();
      }
    });
  },
};

const deps: FetcherDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  storage,
  now: () => Date.now(),
};

let lastUrl = "";
let activeRepo: RepoLocation | null = null;

async function tick(): Promise<void> {
  if (location.href === lastUrl) return;
  lastUrl = location.href;

  const whitelist = await getWhitelist();
  const repo = detectRepo(location.href, whitelist);
  if (!repo) {
    unmountOverlay(document);
    activeRepo = null;
    return;
  }
  activeRepo = repo;

  let state;
  try {
    const data = await fetchMaintainers(repo, deps);
    state = computeOverlayState({
      policy: data.policy,
      trackPolicies: data.trackPolicies,
      mandates: data.mandates,
      keys: data.keys,
      endorsements: data.endorsements,
      now: new Date(),
    });
  } catch (err) {
    // Render a degraded panel so users still know we tried.
    state = {
      projectName: `${repo.owner}/${repo.repo}`,
      policyPresent: false,
      tracks: [],
      recentEndorsements: [],
      endorsementRejections: [],
      alarms: [
        {
          level: "yellow" as const,
          kind: "chain-gap" as const,
          message: "Failed to fetch .maintainers/",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      computedAt: Date.now(),
    };
  }

  mountOverlay(document, state, callbacks);
  // Tell the background worker about alarms so it can update the badge.
  try {
    ext.runtime.sendMessage({
      type: "overlay-state",
      repoUrl: repo.repoUrl,
      alarmCount: state.alarms.length,
      hasRed: state.alarms.some((a: any) => a.level === "red"),
    });
  } catch { /* no background available; ignore */ }
}

const callbacks: OverlayCallbacks = {
  onAlarmClick(_alarm) {
    openPopup();
  },
  onInvestigate() {
    openPopup();
  },
  onCollapse(_collapsed) {},
};

function openPopup(): void {
  try {
    ext.runtime.sendMessage({ type: "open-popup", repoUrl: activeRepo?.repoUrl });
  } catch { /* ignore */ }
}

async function getWhitelist(): Promise<string[]> {
  const raw = await storage.get("maintainers:whitelist");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed;
    }
  } catch { /* fall through */ }
  return [];
}

// Initial run + SPA-navigation hooks
document.addEventListener("DOMContentLoaded", () => { void tick(); });
window.addEventListener("popstate", () => { void tick(); });
window.addEventListener("hashchange", () => { void tick(); });

// Monkey-patch pushState/replaceState to fire a custom event; this is
// the cheapest way to catch GitHub's turbo-frame navigation.
const origPush = history.pushState;
const origReplace = history.replaceState;
history.pushState = function (...args: any[]) {
  const r = origPush.apply(this, args as any);
  void tick();
  return r;
};
history.replaceState = function (...args: any[]) {
  const r = origReplace.apply(this, args as any);
  void tick();
  return r;
};

// Run immediately if we missed DOMContentLoaded
if (document.readyState !== "loading") {
  void tick();
}
