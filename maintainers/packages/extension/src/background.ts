/**
 * Service-worker background script (Manifest V3).
 *
 * Responsibilities:
 *  - Track overlay-state messages from content scripts and reflect alarm
 *    presence on the action badge.
 *  - Open the popup programmatically when the content script asks
 *    (clicking an alarm/Investigate button forwards here).
 *
 * Non-persistent: the worker spins up on message arrival and dies. We
 * keep no in-memory state between invocations; per-tab alarm info is
 * recomputed from the most recent overlay-state message.
 */
declare const chrome: any;
declare const browser: any;

const ext: any = typeof (globalThis as any).chrome !== "undefined"
  ? (globalThis as any).chrome
  : (globalThis as any).browser;

function setBadge(tabId: number, hasRed: boolean, count: number): void {
  if (!ext?.action) return;
  try {
    if (count === 0) {
      ext.action.setBadgeText({ tabId, text: "" });
      return;
    }
    ext.action.setBadgeText({ tabId, text: String(count) });
    ext.action.setBadgeBackgroundColor({
      tabId,
      color: hasRed ? "#88231b" : "#a07f23",
    });
  } catch { /* setBadgeBackgroundColor may not be tab-scoped on Firefox; ignore */ }
}

ext.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (r: any) => void) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "overlay-state") {
    const tabId = sender?.tab?.id;
    if (typeof tabId === "number") {
      setBadge(tabId, Boolean(msg.hasRed), Number(msg.alarmCount) || 0);
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "open-popup") {
    // openPopup() exists on Chrome 127+; on older Chrome and on
    // Firefox it's a no-op — the action button still opens the
    // popup when clicked.
    try {
      if (typeof ext.action?.openPopup === "function") {
        ext.action.openPopup();
      }
    } catch { /* ignore */ }
    sendResponse({ ok: true });
    return;
  }
});

// Clear badge when a tab navigates away from a repo (the next overlay-state
// message will re-set it).
ext.tabs?.onUpdated?.addListener((tabId: number, info: any) => {
  if (info.status === "loading" && ext?.action) {
    try { ext.action.setBadgeText({ tabId, text: "" }); } catch { /* ignore */ }
  }
});
