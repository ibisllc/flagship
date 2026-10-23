/**
 * Check the live page before and after every action (SECURITY-HARDENING-PLAN.md 10.4).
 *
 * The URL the browser is really on is read at the moment of the action, never taken from the app or
 * from an earlier answer: a page can navigate between a check and the click. So an action runs only
 * when the tab is the service's, the current main frame is inside the effective grant, and it still
 * is afterwards; the result of an action that ended elsewhere is withheld and the tab is closed.
 */
import { PolicyError, type ContextRegistry } from "./contexts.js";
import type { BrowserJudge } from "./judge.js";
import type { BrowserCapability } from "./grants.js";

export const MAX_ACTION_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface GuardDeps {
  contexts: ContextRegistry;
  judge: BrowserJudge;
  /** The tab's current main-frame URL, read from the live browser now. */
  currentUrl: (tabId: string) => Promise<string>;
  /** Close the tab and drop its session. */
  closeTab: (tabId: string) => Promise<void>;
}

export async function guardedAction<T>(
  deps: GuardDeps,
  a: { serviceId: string; tabId: string; capability: BrowserCapability; sessionId?: string; maxBytes?: number },
  action: () => Promise<T>,
): Promise<T> {
  deps.contexts.assertOwned(a.serviceId, a.tabId);
  const before = await deps.currentUrl(a.tabId);
  if (!deps.judge.inScope(a.serviceId, before, a.capability, a.sessionId)) {
    await quarantine(deps, a.tabId);
    throw new PolicyError("origin-changed", "the page is no longer inside what was approved");
  }
  const result = await action();
  // Re-read after: the action may have navigated. An out-of-scope end state withholds the result.
  const after = await deps.currentUrl(a.tabId);
  if (!deps.judge.inScope(a.serviceId, after, a.capability, a.sessionId)) {
    await quarantine(deps, a.tabId);
    throw new PolicyError("origin-changed", "the page left what was approved while this ran");
  }
  const size = typeof result === "string" ? Buffer.byteLength(result) : result instanceof Uint8Array ? result.byteLength : 0;
  if (size > (a.maxBytes ?? MAX_ACTION_OUTPUT_BYTES)) throw new PolicyError("out-of-scope", "that output is too large to hand to an app");
  return result;
}

async function quarantine(deps: GuardDeps, tabId: string): Promise<void> {
  deps.contexts.quarantine(tabId);
  await deps.closeTab(tabId).catch(() => {});
}
