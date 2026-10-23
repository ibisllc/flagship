/**
 * The app browser under policy (SECURITY-HARDENING-PLAN.md 10.4, SEC-BROWSER-002).
 *
 * `BrowserManager` is the raw CDP client. This wraps it so nothing an app can ask for reaches the
 * browser unjudged:
 *
 *   - One browser context per service (cookies, storage, cache, workers and history are not shared with
 *     any other app or the owner's browser). Downloads are denied in it.
 *   - Browser-level auto-attach with the target PAUSED. Before it resumes, `ContextRegistry` decides who
 *     owns it (its context, or its opener's); a target nobody owns is closed, never raced. Child frames
 *     and workers attach the same way.
 *   - `Fetch` interception on every attached session. Each request is judged by `BrowserJudge` with what
 *     the BROWSER saw (resource type, redirect chain, the initiating document), never what an app says.
 *     A refusal fails the request as blocked by the client.
 *   - Every action (click, fill, read, screenshot, typing) runs under `guardedAction`: the live URL must be
 *     in scope before and after, or the tab is closed and the result withheld.
 *
 * Connecting to the addresses the judge resolved is the pinning proxy's job (pinningProxy.ts): CDP cannot
 * pin a destination address, so without the proxy a name that changes answers between the judge and the
 * connection is narrowed, not closed.
 */
import { BrowserManager } from "./browserManager.js";
import { guardedAction } from "./policy/actionGuard.js";
import { ContextRegistry, PolicyError } from "./policy/contexts.js";
import type { BrowserJudge, Decision, RequestKind } from "./policy/judge.js";
import type { BrowserCapability } from "./policy/grants.js";
import { contextSession } from "./egress.js";

interface Sess {
  sessionId: string;
  targetId: string;
  type: string;
  serviceId: string;
  /** The document URL requests from this session count as coming from. */
  docUrl: string;
}

export interface PolicedBrowserOptions {
  cdp: BrowserManager;
  contexts: ContextRegistry;
  judge: BrowserJudge;
  /** Told of every refusal (for the owner's activity view); never carries a page body. */
  onDenied?: (e: { serviceId: string; url: string; kind: RequestKind; code: string; reason: string }) => void;
  /** Told of every allowed destination with the addresses the judge resolved, and for which app (its pinning proxy connects only to these). */
  onApproved?: (host: string, addresses: string[], serviceId: string) => void;
  /** Extra `Target.createBrowserContext` parameters for an app's context: its own proxy (`egress.ts`). */
  contextOptions?: (serviceId: string) => Promise<Record<string, unknown>>;
  /** The app's context was disposed: its session grants and its proxy end with it. */
  onContextGone?: (serviceId: string) => void;
  /** How long each look at a navigating tab waits. Default 250 ms. */
  settleMs?: number;
  /** How long to wait for a new target to be adopted before giving up. */
  adoptTimeoutMs?: number;
}

type CdpEvent = { sessionId?: string; targetInfo?: { targetId: string; type: string; url?: string; openerId?: string; browserContextId?: string }; waitingForDebugger?: boolean };

export class PolicedBrowser {
  private readonly sessions = new Map<string, Sess>(); // by CDP sessionId
  private readonly sessionOfTarget = new Map<string, string>(); // page targetId -> policy sessionId
  private readonly chains = new Map<string, string[]>(); // Fetch requestId -> urls so far
  private readonly lastDenial = new Map<string, string>(); // targetId -> reason
  private readonly offs: Array<() => void> = [];
  private started = false;

  constructor(private readonly o: PolicedBrowserOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    const { cdp } = this.o;
    this.offs.push(cdp.on("Target.attachedToTarget", (p, parent) => void this.onAttached(p as CdpEvent, parent)));
    this.offs.push(cdp.on("Fetch.requestPaused", (p, sid) => void this.onPaused(p as Record<string, unknown>, sid)));
    this.offs.push(cdp.on("Page.frameNavigated", (p, sid) => this.onFrameNavigated(p as { frame?: { url?: string; parentId?: string } }, sid)));
    this.offs.push(cdp.on("Target.targetDestroyed", (p) => this.onDestroyed((p as { targetId?: string }).targetId)));
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    this.started = false;
  }

  // ── what the app-facing API calls ────────────────────────────────────────

  /** Open a tab in the service's own context and navigate it; throws `PolicyError` if the first page is refused. */
  async openTab(serviceId: string, url: string): Promise<{ tabId: string }> {
    const { cdp, contexts } = this.o;
    const contextId = await contexts.contextFor(serviceId, async () => {
      const extra = (await this.o.contextOptions?.(serviceId)) ?? {};
      const r = (await cdp.send("Target.createBrowserContext", { ...extra, disposeOnDetach: false })) as { browserContextId: string };
      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: r.browserContextId }).catch(() => {});
      return r.browserContextId;
    });
    const r = (await cdp.send("Target.createTarget", { url: "about:blank", browserContextId: contextId })) as { targetId: string };
    await this.adopted(r.targetId);
    try {
      await this.navigate(serviceId, r.targetId, url);
    } catch (e) {
      await this.closeTab(serviceId, r.targetId).catch(() => {});
      throw e;
    }
    return { tabId: r.targetId };
  }

  async navigate(serviceId: string, tabId: string, url: string): Promise<void> {
    this.o.contexts.assertOwned(serviceId, tabId);
    const sid = this.sessionOfTarget.get(tabId);
    if (!sid) throw new PolicyError("unowned-target", "that tab is not one of this app's");
    this.lastDenial.delete(tabId);
    const r = (await this.o.cdp.sessionSend(sid, "Page.navigate", { url })) as { errorText?: string };
    if (r.errorText) throw new PolicyError("out-of-scope", this.lastDenial.get(tabId) ?? "that page could not be opened");
  }

  async closeTab(serviceId: string, tabId: string): Promise<void> {
    this.o.contexts.assertOwned(serviceId, tabId);
    await this.dropTab(tabId);
  }

  click(serviceId: string, tabId: string, selector: string): Promise<void> {
    return this.act(serviceId, tabId, "input", () => this.o.cdp.click(tabId, selector));
  }

  fill(serviceId: string, tabId: string, selector: string, value: string): Promise<void> {
    return this.act(serviceId, tabId, "input", () => this.o.cdp.fill(tabId, selector, value));
  }

  insertText(serviceId: string, tabId: string, text: string): Promise<void> {
    return this.act(serviceId, tabId, "input", () => this.o.cdp.insertText(tabId, text));
  }

  readDOM(serviceId: string, tabId: string, selector: string): Promise<string | null> {
    return this.act(serviceId, tabId, "read-dom", () => this.o.cdp.readDOM(tabId, selector));
  }

  screenshot(serviceId: string, tabId: string): Promise<Buffer> {
    return this.act(serviceId, tabId, "screenshot", () => this.o.cdp.screenshot(tabId));
  }

  tabsOf(serviceId: string): string[] {
    return this.o.contexts.targetsOf(serviceId).filter((t) => this.sessionOfTarget.has(t));
  }

  /** Uninstall or revocation: close everything the service owned and dispose its context. */
  async revokeService(serviceId: string): Promise<void> {
    const { targets, contextId } = this.o.contexts.destroyService(serviceId);
    for (const t of targets) await this.dropTab(t, true);
    if (contextId) await this.o.cdp.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => {});
    try {
      this.o.onContextGone?.(serviceId);
    } catch {
      // an observer's failure never keeps a context alive
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private act<T>(serviceId: string, tabId: string, capability: BrowserCapability, action: () => Promise<T>): Promise<T> {
    return guardedAction(
      {
        contexts: this.o.contexts,
        judge: this.o.judge,
        currentUrl: async (id) => ((await this.o.cdp.send("Target.getTargetInfo", { targetId: id })) as { targetInfo: { url: string } }).targetInfo.url,
        closeTab: (id) => this.dropTab(id),
      },
      { serviceId, tabId, capability, sessionId: contextSession(serviceId) },
      async () => {
        const r = await action();
        // An action can start a navigation that has not committed yet; judge where the tab ends up, not where it was.
        if (capability === "input") await this.settle(tabId);
        return r;
      },
    );
  }

  /** Wait until the tab's URL stops changing (a few short looks), so the guard's second reading is the landing page. */
  private async settle(tabId: string): Promise<void> {
    const read = async () => ((await this.o.cdp.send("Target.getTargetInfo", { targetId: tabId }).catch(() => ({ targetInfo: { url: "" } }))) as { targetInfo: { url: string } }).targetInfo.url;
    let last = await read();
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, this.o.settleMs ?? 250));
      const now = await read();
      if (now === last) return;
      last = now;
    }
  }

  private async dropTab(tabId: string, ownershipAlreadyDropped = false): Promise<void> {
    await this.o.cdp.send("Target.closeTarget", { targetId: tabId }).catch(() => {});
    const sid = this.sessionOfTarget.get(tabId);
    this.sessionOfTarget.delete(tabId);
    if (sid) this.sessions.delete(sid);
    if (!ownershipAlreadyDropped) this.o.contexts.forget(tabId);
  }

  private async adopted(targetId: string): Promise<void> {
    const until = Date.now() + (this.o.adoptTimeoutMs ?? 5000);
    while (Date.now() < until) {
      if (this.sessionOfTarget.has(targetId)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    await this.o.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    throw new PolicyError("unowned-target", "the browser did not adopt the new tab");
  }

  /** A target arrived paused: decide who owns it before it runs anything. */
  private async onAttached(p: CdpEvent, parentSession: string | undefined): Promise<void> {
    const info = p.targetInfo;
    const sessionId = (p as { sessionId?: string }).sessionId;
    if (!info || !sessionId) return;
    const { cdp, contexts } = this.o;
    const verdict = contexts.attach({ targetId: info.targetId, ...(info.browserContextId ? { browserContextId: info.browserContextId } : {}), ...(info.openerId ? { openerId: info.openerId } : {}) });
    if (!verdict.allow) {
      // Not an app's: never resume it, close it. (Targets that were already open are not ours to touch.)
      if (p.waitingForDebugger) await cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
      return;
    }
    const parent = parentSession ? this.sessions.get(parentSession) : undefined;
    this.sessions.set(sessionId, { sessionId, targetId: info.targetId, type: info.type, serviceId: verdict.serviceId, docUrl: parent?.docUrl ?? info.url ?? "" });
    try {
      await cdp.sessionSend(sessionId, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      // Sent in order but not awaited: a paused popup answers renderer-side commands only once it runs, and
      // the child-target rule must be in place before it does, so an out-of-process frame cannot be missed.
      void cdp.sessionSend(sessionId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
      if (info.type === "page") void cdp.sessionSend(sessionId, "Page.enable", {}).catch(() => {});
      if (info.type === "page") this.sessionOfTarget.set(info.targetId, sessionId);
      if (p.waitingForDebugger) await cdp.sessionSend(sessionId, "Runtime.runIfWaitingForDebugger", {});
    } catch {
      this.sessions.delete(sessionId);
      await cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
    }
  }

  private onFrameNavigated(p: { frame?: { url?: string; parentId?: string } }, sessionId: string | undefined): void {
    const s = sessionId ? this.sessions.get(sessionId) : undefined;
    if (s && p.frame && !p.frame.parentId && typeof p.frame.url === "string") s.docUrl = p.frame.url;
  }

  private onDestroyed(targetId: string | undefined): void {
    if (!targetId) return;
    const sid = this.sessionOfTarget.get(targetId);
    this.sessionOfTarget.delete(targetId);
    if (sid) this.sessions.delete(sid);
    this.lastDenial.delete(targetId);
    this.o.contexts.forget(targetId);
  }

  private async onPaused(p: Record<string, unknown>, sessionId: string | undefined): Promise<void> {
    const { cdp } = this.o;
    const requestId = String(p.requestId ?? "");
    const url = String((p.request as { url?: string } | undefined)?.url ?? "");
    const sess = sessionId ? this.sessions.get(sessionId) : undefined;
    const fail = () => cdp.sessionSend(sessionId!, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    if (!sess || !sessionId) {
      if (sessionId) await fail();
      return;
    }
    try {
      const redirectedFrom = typeof p.redirectedRequestId === "string" ? p.redirectedRequestId : undefined;
      const prior = redirectedFrom ? this.chains.get(redirectedFrom) ?? [] : [];
      this.chains.set(requestId, [...prior, url]);
      if (this.chains.size > 4096) this.chains.delete(this.chains.keys().next().value!);
      const kind = this.kindOf(p, sess);
      const decision: Decision = await this.o.judge.judge({
        serviceId: sess.serviceId,
        url,
        kind,
        sessionId: contextSession(sess.serviceId),
        ...(prior.length ? { redirectChain: prior } : {}),
        ...(kind === "subresource" || kind === "worker" || kind === "websocket" ? { initiatorUrl: sess.docUrl } : {}),
      });
      if (!decision.allow) {
        this.lastDenial.set(sess.targetId, decision.reason);
        this.o.onDenied?.({ serviceId: sess.serviceId, url, kind, code: decision.code, reason: decision.reason });
        await fail();
        return;
      }
      try {
        this.o.onApproved?.(new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""), decision.addresses, sess.serviceId);
      } catch {
        // an observer's failure never decides a request
      }
      await cdp.sessionSend(sessionId, "Fetch.continueRequest", { requestId });
    } catch {
      await fail();
    }
  }

  private kindOf(p: Record<string, unknown>, sess: Sess): RequestKind {
    const type = String(p.resourceType ?? "");
    if (type === "Document") return String(p.frameId ?? "") === sess.targetId ? "document" : "subframe";
    if (type === "WebSocket") return "websocket";
    if (sess.type === "worker" || sess.type === "service_worker" || sess.type === "shared_worker") return "worker";
    return "subresource";
  }
}
