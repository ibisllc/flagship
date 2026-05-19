/**
 * Tab → app ownership map. The browser is a single Chromium with one
 * cookie jar shared across all apps (the user's identity); isolation
 * between tenants is at the **tab level**, enforced by this registry.
 *
 * Rules:
 *
 *   - When an app's API call creates a tab, the apiHandler calls
 *     `assignTab(tabId, serviceId)` immediately after openTab returns.
 *   - When a tab opens a popup or window.open child, Chromium emits
 *     `Target.targetCreated` with `openerId`. We walk the chain to
 *     find the root app and inherit ownership. So `appA.tabs[0].open()
 *     popup → popup.open() popup_of_popup → ...` all belong to appA.
 *   - When a tab is destroyed (Target.targetDestroyed), we drop the
 *     entry.
 *   - Cross-tenant lookup queries return null — the apiHandlers
 *     translate that into HTTP 404 (NOT 403, to avoid leaking that
 *     a tab belongs to a different app).
 *
 * Callers MUST start() before browser activity flows; without it,
 * popups won't inherit and TabRegistry won't observe lifecycle events.
 */

import type { BrowserManager, TargetInfo } from "./browserManager.js";

export class TabRegistry {
  private byTab = new Map<string, string>();
  private subscriptions: Array<() => void> = [];

  constructor(private readonly browser: BrowserManager) {}

  /** Subscribe to Target.targetCreated / targetDestroyed. Idempotent. */
  start(): void {
    if (this.subscriptions.length > 0) return;
    const onCreated = this.browser.on("Target.targetCreated", (params) => {
      const p = params as { targetInfo?: TargetInfo };
      const info = p.targetInfo;
      if (!info || info.type !== "page") return;
      if (this.byTab.has(info.targetId)) return; // already known (assigned by apiHandler)
      if (info.openerId) {
        const ownerApp = this.byTab.get(info.openerId);
        if (ownerApp) {
          this.byTab.set(info.targetId, ownerApp);
        }
      }
      // No opener / unknown opener: the tab is unowned. Daemon-internal
      // ops (e.g., the PhonePipe screenshot tab) live in this state.
    });
    const onDestroyed = this.browser.on("Target.targetDestroyed", (params) => {
      const p = params as { targetId?: string };
      if (p.targetId) this.byTab.delete(p.targetId);
    });
    this.subscriptions.push(onCreated, onDestroyed);
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions = [];
  }

  /** Assign a tab to an app explicitly. Overrides any prior owner. */
  assignTab(tabId: string, serviceId: string): void {
    this.byTab.set(tabId, serviceId);
  }

  /** Forget a tab — the daemon called closeTab and we don't want to wait
   *  for the targetDestroyed event to clean up. */
  forgetTab(tabId: string): void {
    this.byTab.delete(tabId);
  }

  /** Return the serviceId that owns this tab, or null. */
  appIdForTab(tabId: string): string | null {
    return this.byTab.get(tabId) ?? null;
  }

  /** Return all tab ids belonging to an app (snapshot — not live). */
  tabsForApp(serviceId: string): string[] {
    const out: string[] = [];
    for (const [t, a] of this.byTab) if (a === serviceId) out.push(t);
    return out;
  }

  /** Pending count — diagnostic. */
  size(): number {
    return this.byTab.size;
  }

  /**
   * Close every tab owned by the given app via the BrowserManager and
   * forget them locally. Best-effort; closeTab errors are swallowed.
   * Called on ServicePlatform.uninstall and on app-token revocation.
   */
  async closeAllForApp(serviceId: string): Promise<{ closed: number }> {
    const tabs = this.tabsForApp(serviceId);
    for (const t of tabs) {
      await this.browser.closeTab(t).catch(() => {});
      this.byTab.delete(t);
    }
    return { closed: tabs.length };
  }
}
