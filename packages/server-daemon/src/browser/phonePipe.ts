/**
 * Phone-mediated input pipe for the pod-resident browser.
 *
 * Flow:
 *
 *   1. The daemon installs a small focus-watcher script in every page
 *      via `Page.addScriptToEvaluateOnNewDocument`. The script calls a
 *      `Runtime.addBinding` callback whenever a password / OTP field
 *      gains focus. The script is templated with the owning tabId so
 *      the binding payload carries it directly — no session-table
 *      reverse-lookup needed.
 *
 *   2. On a focus event, the daemon takes a viewport screenshot,
 *      stores it under a fresh `screenshotRef`, and emits a
 *      `browser-input-needed` alert to the AlertInbox.
 *
 *   3. The phone polls the inbox, fetches the screenshot bytes via
 *      `getScreenshot(ref)`, displays it next to a secure text input,
 *      and PSK-signs a `browser-input-response` order back. The
 *      OrderExecutor routes it to `applyInputResponse`.
 *
 *   4. `applyInputResponse` validates the screenshotRef is still
 *      pending and the tabId in the order matches the alert. Then
 *      it dispatches via CDP `Input.insertText`. The page sees
 *      synthesized input events; no Runtime.evaluate string ever
 *      carries the password or OTP.
 *
 * Pending refs expire after 5 min by default. AlertInbox dedupes
 * re-emit on (serviceId, tabId, inputKind) so a tight focus loop does
 * not flood.
 */

import { randomBytes } from "node:crypto";
import type { BrowserManager } from "./browserManager.js";
import type { TabRegistry } from "./tabRegistry.js";
import type { AlertInbox } from "../alertInbox.js";

export type InputKind = "password" | "otp" | "text";

export interface PhonePipeDeps {
  browser: BrowserManager;
  tabRegistry: TabRegistry;
  inbox: AlertInbox;
  /** Override the screenshot-ref generator (tests). Default 16-byte hex. */
  nextRef?: () => string;
  /** Pending-alert TTL. Default 5 min. */
  ttlMs?: number;
  now?: () => number;
}

interface PendingAlert {
  tabId: string;
  serviceId: string;
  inputKind: InputKind;
  screenshot: Buffer;
  expiresAt: number;
}

const BINDING_NAME = "flagshipInputFocused";

/**
 * Build the focus-watcher script for a specific tabId. The tabId is
 * embedded as a JSON literal so the binding payload carries it directly.
 */
function focusWatcherScript(tabId: string): string {
  return `
(() => {
  if (window.__flagship_focus_watcher_installed) return;
  window.__flagship_focus_watcher_installed = true;
  const TAB_ID = ${JSON.stringify(tabId)};
  function classify(el) {
    if (!el || el.tagName !== 'INPUT') return null;
    if (el.type === 'password') return 'password';
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'one-time-code') return 'otp';
    if (
      (el.type === 'tel' || el.type === 'text' || el.type === 'number') &&
      el.inputMode === 'numeric' &&
      el.maxLength > 0 && el.maxLength <= 8
    ) return 'otp';
    return null;
  }
  document.addEventListener('focusin', (ev) => {
    try {
      const kind = classify(ev.target);
      if (!kind) return;
      if (typeof window.${BINDING_NAME} !== 'function') return;
      window.${BINDING_NAME}(JSON.stringify({ tabId: TAB_ID, kind, host: location.host }));
    } catch (e) { /* swallow */ }
  }, true);
})();
`;
}

export class PhonePipe {
  private readonly browser: BrowserManager;
  private readonly tabRegistry: TabRegistry;
  private readonly inbox: AlertInbox;
  private readonly pending = new Map<string, PendingAlert>();
  private readonly subscriptions: Array<() => void> = [];
  private readonly nextRef: () => string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tabsEquipped = new Set<string>();

  constructor(deps: PhonePipeDeps) {
    this.browser = deps.browser;
    this.tabRegistry = deps.tabRegistry;
    this.inbox = deps.inbox;
    this.ttlMs = deps.ttlMs ?? 5 * 60_000;
    this.now = deps.now ?? Date.now;
    this.nextRef = deps.nextRef ?? (() => randomBytes(16).toString("hex"));
  }

  start(): void {
    if (this.subscriptions.length > 0) return;
    const u = this.browser.on("Runtime.bindingCalled", (params) => {
      const p = params as { name?: string; payload?: string };
      if (p.name !== BINDING_NAME || typeof p.payload !== "string") return;
      void this.onBindingCalled(p.payload);
    });
    this.subscriptions.push(u);
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
    this.pending.clear();
    this.tabsEquipped.clear();
  }

  /**
   * Install the focus-watcher binding + content script in `tabId`.
   * Idempotent. The apiHandler calls this every time it opens a tab
   * on behalf of an app.
   */
  async equipTab(tabId: string): Promise<void> {
    if (this.tabsEquipped.has(tabId)) return;
    const sessionId = await this.attachSession(tabId);
    await this.browser.sessionSend(sessionId, "Runtime.addBinding", { name: BINDING_NAME });
    const script = focusWatcherScript(tabId);
    await this.browser.sessionSend(sessionId, "Page.addScriptToEvaluateOnNewDocument", {
      source: script,
    });
    // Also evaluate now so the watcher applies to the page already loaded
    // (Page.addScriptToEvaluateOnNewDocument applies to FUTURE navigations only).
    await this.browser.sessionSend(sessionId, "Runtime.evaluate", { expression: script });
    this.tabsEquipped.add(tabId);
  }

  /**
   * Daemon-internal trigger — used when an app explicitly asks the user
   * to fill a (non-password, non-otp) text field. Apps reach this via
   * the apiHandler `requestInput` route.
   */
  async requestInput(args: {
    tabId: string;
    inputKind: InputKind;
    host?: string;
  }): Promise<{ screenshotRef: string }> {
    const serviceId = this.tabRegistry.appIdForTab(args.tabId);
    if (!serviceId) throw new Error("tab not owned");
    const screenshot = await this.browser.screenshot(args.tabId);
    const ref = this.nextRef();
    this.pending.set(ref, {
      tabId: args.tabId,
      serviceId,
      inputKind: args.inputKind,
      screenshot,
      expiresAt: this.now() + this.ttlMs,
    });
    this.inbox.emit({
      kind: "browser-input-needed",
      serviceId,
      tabId: args.tabId,
      domain: args.host ?? "unknown",
      inputKind: args.inputKind,
      screenshotRef: ref,
    });
    return { screenshotRef: ref };
  }

  /**
   * OrderExecutor.browserInputResponse handler. The order signature was
   * already PSK-verified upstream by the orders dispatcher; here we
   * additionally gate on:
   *
   *   - screenshotRef matches a live pending entry.
   *   - tabId in the order equals the tabId we issued the alert for.
   *   - inputKind matches.
   *   - The pending entry has not expired.
   *
   * On success, dispatches via CDP Input.insertText.
   */
  async applyInputResponse(args: {
    tabId: string;
    inputKind: InputKind;
    value: string;
    screenshotRef: string;
  }): Promise<void> {
    const pend = this.pending.get(args.screenshotRef);
    if (!pend) throw new Error("no pending input for that screenshotRef");
    // Drain on first match — even if the daemon will reject below, we
    // don't want a captured response retried with different fields.
    this.pending.delete(args.screenshotRef);
    if (pend.expiresAt < this.now()) {
      throw new Error("pending input has expired");
    }
    if (pend.tabId !== args.tabId) {
      throw new Error("tabId in response does not match the issued alert");
    }
    if (pend.inputKind !== args.inputKind) {
      throw new Error("inputKind in response does not match the issued alert");
    }
    await this.browser.insertText(args.tabId, args.value);
  }

  /** Phone fetches screenshot bytes via this. Returns null if the ref expired. */
  getScreenshot(ref: string): Buffer | null {
    const pend = this.pending.get(ref);
    if (!pend) return null;
    if (pend.expiresAt < this.now()) {
      this.pending.delete(ref);
      return null;
    }
    return pend.screenshot;
  }

  evictExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [ref, p] of this.pending) {
      if (p.expiresAt < now) {
        this.pending.delete(ref);
        removed++;
      }
    }
    return removed;
  }

  /** For tests + diagnostics. */
  pendingCount(): number {
    return this.pending.size;
  }

  // ──────────────────────────────────────────────────────────────────

  private async onBindingCalled(payload: string): Promise<void> {
    let parsed: { tabId?: string; kind?: string; host?: string };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const tabId = parsed.tabId;
    const kind = parsed.kind;
    if (typeof tabId !== "string") return;
    if (kind !== "password" && kind !== "otp" && kind !== "text") return;
    const serviceId = this.tabRegistry.appIdForTab(tabId);
    if (!serviceId) return; // unowned tab — daemon-internal, no app alert
    let screenshot: Buffer;
    try {
      screenshot = await this.browser.screenshot(tabId);
    } catch {
      return;
    }
    const ref = this.nextRef();
    this.pending.set(ref, {
      tabId,
      serviceId,
      inputKind: kind as InputKind,
      screenshot,
      expiresAt: this.now() + this.ttlMs,
    });
    this.inbox.emit({
      kind: "browser-input-needed",
      serviceId,
      tabId,
      domain: parsed.host ?? "unknown",
      inputKind: kind as InputKind,
      screenshotRef: ref,
    });
  }

  /** Attach a session for `tabId` (idempotent — Chromium returns the same id). */
  private async attachSession(tabId: string): Promise<string> {
    const r = (await this.browser.send("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    })) as { sessionId: string };
    return r.sessionId;
  }
}
