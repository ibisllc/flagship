/**
 * Daemon-side wrapper around the pod-resident Chromium's CDP socket.
 *
 * Architecture:
 *
 *   - One WebSocket to the browser-level endpoint
 *     (`ws://127.0.0.1:9222/devtools/browser/<id>`).
 *   - Per-tab sessions are attached via `Target.attachToTarget` with
 *     `flatten: true`. Every per-tab command carries `sessionId` at
 *     the top level of the CDP envelope.
 *   - Single `nextId` counter for request/response correlation.
 *
 * The high-level API is intentionally narrow: openTab / navigate /
 * fill / click / readDOM / screenshot / closeTab / dispatchKeyEvent.
 * Apps reach these through the daemon's HTTP surface (next task) —
 * they never see the WebSocket directly. Cookies, localStorage, and
 * raw Runtime.evaluate stay daemon-local.
 *
 * Event subscriptions exist for the TabRegistry's appId tagging
 * (Target.targetCreated, Target.targetDestroyed) and for PhonePipe's
 * focus detection (DOM.attributeModified or page-level events from
 * within a session).
 */

import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

export interface ScreencastOptions {
  format?: "jpeg" | "png";
  quality?: number;        // 0..100, JPEG only
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

export interface ScreencastFrameMetadata {
  offsetTop?: number;
  pageScaleFactor?: number;
  deviceWidth?: number;
  deviceHeight?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  timestamp?: number;
}

export type InputEvent =
  | { kind: "mouseDown" | "mouseUp" | "mouseMove"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; eventType?: "keyDown" | "keyUp" | "char"; key: string; code?: string; text?: string }
  | { kind: "text"; text: string };

export interface BrowserManagerOptions {
  /** CDP HTTP endpoint that lists targets, e.g. `http://127.0.0.1:9222`. */
  endpoint: string;
  /** Connect retry interval in ms. Default 500. */
  retryDelayMs?: number;
  /** Max connect attempts before failing start(). Default 30 (~15s). */
  maxConnectAttempts?: number;
  /** Override fetch for /json/version (tests). */
  fetchVersion?: (endpoint: string) => Promise<{ webSocketDebuggerUrl: string }>;
  /** Override WebSocket constructor (tests use a fake). */
  wsFactory?: (url: string) => WebSocket;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  /** When set, the target was opened by another target (popup / window.open). */
  openerId?: string;
  browserContextId?: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type EventHandler = (params: unknown, sessionId: string | undefined) => void;

export class BrowserManager {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionByTab = new Map<string, string>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private started = false;

  constructor(private readonly opts: BrowserManagerOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    const wsUrl = await this.discoverWsUrl();
    this.ws = await this.connectWs(wsUrl);
    this.installMessageHandler(this.ws);
    // Auto-attach to all current and future targets so we get
    // Target.targetCreated events via flattened sessions.
    await this.send("Target.setDiscoverTargets", { discover: true });
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    // Reject any in-flight commands so callers don't hang.
    for (const p of this.pending.values()) {
      p.reject(new Error("BrowserManager stopped"));
    }
    this.pending.clear();
    this.sessionByTab.clear();
  }

  /**
   * Subscribe to a CDP event. Returns an unsubscribe function. Event
   * names are CDP-style ("Target.targetCreated", "Page.frameNavigated").
   */
  on(event: string, handler: EventHandler): () => void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // High-level tab operations
  // ──────────────────────────────────────────────────────────────────

  /** Open a new tab. Returns the targetId Chromium assigned. */
  async openTab(url: string): Promise<{ tabId: string }> {
    const r = (await this.send("Target.createTarget", { url })) as {
      targetId: string;
    };
    return { tabId: r.targetId };
  }

  async closeTab(tabId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId: tabId });
    this.sessionByTab.delete(tabId);
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const sessionId = await this.ensureSession(tabId);
    await this.sessionSend(sessionId, "Page.navigate", { url });
  }

  /**
   * Fill an input matching `selector` with `value`. App-callable; runs
   * via Runtime.evaluate, so the page sees JS-bound input events. NOT
   * used for password entry — see dispatchKeyEvent for that path.
   */
  async fill(tabId: string, selector: string, value: string): Promise<void> {
    const sessionId = await this.ensureSession(tabId);
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    const r = (await this.sessionSend(sessionId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result: { value: unknown } };
    if (r.result.value !== true) {
      throw new Error(`fill: selector ${JSON.stringify(selector)} not found`);
    }
  }

  /** Click the first element matching `selector`. */
  async click(tabId: string, selector: string): Promise<void> {
    const sessionId = await this.ensureSession(tabId);
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`;
    const r = (await this.sessionSend(sessionId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result: { value: unknown } };
    if (r.result.value !== true) {
      throw new Error(`click: selector ${JSON.stringify(selector)} not found`);
    }
  }

  /** Read `outerHTML` of the first element matching `selector`, or null. */
  async readDOM(tabId: string, selector: string): Promise<string | null> {
    const sessionId = await this.ensureSession(tabId);
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.outerHTML : null;
    })()`;
    const r = (await this.sessionSend(sessionId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result: { value: string | null } };
    return r.result.value;
  }

  /** Capture a PNG screenshot of the tab. Returns raw bytes. */
  async screenshot(tabId: string): Promise<Buffer> {
    const sessionId = await this.ensureSession(tabId);
    const r = (await this.sessionSend(sessionId, "Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    return Buffer.from(r.data, "base64");
  }

  /**
   * Dispatch a synthetic key event into the focused element of `tabId`.
   * This is the **password / OTP entry path**: the daemon types each
   * char via Input.dispatchKeyEvent, which Chromium delivers as if a
   * real user typed it. The page sees normal keydown/keypress/input
   * events; no Runtime.evaluate is used so the value never transits
   * a string the page could intercept before delivery.
   *
   * Caller is responsible for splitting `text` into individual chars
   * if needed; we use Input.insertText which handles strings of any
   * length in one shot (faster than per-char dispatchKeyEvent).
   */
  async insertText(tabId: string, text: string): Promise<void> {
    const sessionId = await this.ensureSession(tabId);
    await this.sessionSend(sessionId, "Input.insertText", { text });
  }

  /**
   * Subscribe to a continuous JPEG screencast for the given tab.
   *
   * Calls `Page.startScreencast` with reasonable defaults (jpeg, 60% q,
   * 1024px max edge), then forwards every `Page.screencastFrame` event
   * matching the tab's session through `onFrame`. Each frame must be
   * acked back to Chromium via `Page.screencastFrameAck` or the stream
   * pauses; we ack synchronously after the callback returns. The
   * caller-returned promise resolves once startScreencast acks; the
   * returned `unsubscribe` stops the stream and detaches the listener.
   */
  async subscribeScreencast(
    tabId: string,
    onFrame: (args: { dataBase64: string; metadata: ScreencastFrameMetadata }) => void,
    opts?: ScreencastOptions,
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    const sessionId = await this.ensureSession(tabId);
    const handlerOff = this.on("Page.screencastFrame", (params, frameSessionId) => {
      if (frameSessionId !== sessionId) return;
      const p = params as {
        data?: string;
        sessionId?: number;
        metadata?: ScreencastFrameMetadata;
      };
      if (typeof p.data !== "string" || typeof p.sessionId !== "number") return;
      try {
        onFrame({ dataBase64: p.data, metadata: p.metadata ?? {} });
      } catch {
        // swallow user-side errors so a bad consumer doesn't kill the stream
      }
      // Ack so the next frame ships. The CDP-protocol sessionId here
      // is a frame-counter, not the attach sessionId.
      void this.sessionSend(sessionId, "Page.screencastFrameAck", {
        sessionId: p.sessionId,
      }).catch(() => {});
    });
    await this.sessionSend(sessionId, "Page.startScreencast", {
      format: opts?.format ?? "jpeg",
      quality: opts?.quality ?? 60,
      maxWidth: opts?.maxWidth ?? 1024,
      maxHeight: opts?.maxHeight ?? 1024,
      everyNthFrame: opts?.everyNthFrame ?? 1,
    });
    let stopped = false;
    return {
      unsubscribe: async () => {
        if (stopped) return;
        stopped = true;
        handlerOff();
        try {
          await this.sessionSend(sessionId, "Page.stopScreencast", {});
        } catch {
          /* tab may already be gone */
        }
      },
    };
  }

  /**
   * Dispatch a single input event into a tab. Supports the common
   * cases the framebuffer view needs: mouse click / move / scroll +
   * key press + bulk text insertion. Each call attaches the per-tab
   * session if needed.
   */
  async dispatchInput(tabId: string, input: InputEvent): Promise<void> {
    const sessionId = await this.ensureSession(tabId);
    switch (input.kind) {
      case "mouseDown":
      case "mouseUp":
      case "mouseMove":
        await this.sessionSend(sessionId, "Input.dispatchMouseEvent", {
          type: input.kind === "mouseDown" ? "mousePressed"
            : input.kind === "mouseUp" ? "mouseReleased" : "mouseMoved",
          x: input.x,
          y: input.y,
          button: input.button ?? "left",
          clickCount: input.clickCount ?? 1,
        });
        return;
      case "scroll":
        await this.sessionSend(sessionId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
        });
        return;
      case "key":
        await this.sessionSend(sessionId, "Input.dispatchKeyEvent", {
          type: input.eventType ?? "keyDown",
          key: input.key,
          code: input.code,
          text: input.text,
        });
        return;
      case "text":
        await this.sessionSend(sessionId, "Input.insertText", { text: input.text });
        return;
    }
  }

  /** List all open targets (page targets only). */
  async listTabs(): Promise<TargetInfo[]> {
    const r = (await this.send("Target.getTargets", {})) as {
      targetInfos: TargetInfo[];
    };
    return r.targetInfos.filter((t) => t.type === "page");
  }

  // ──────────────────────────────────────────────────────────────────
  // CDP plumbing
  // ──────────────────────────────────────────────────────────────────

  private async ensureSession(tabId: string): Promise<string> {
    const existing = this.sessionByTab.get(tabId);
    if (existing) return existing;
    const r = (await this.send("Target.attachToTarget", {
      targetId: tabId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionByTab.set(tabId, r.sessionId);
    // Page domain needs to be enabled before navigations / screenshots
    // emit the lifecycle events callers expect.
    await this.sessionSend(r.sessionId, "Page.enable", {});
    await this.sessionSend(r.sessionId, "Runtime.enable", {});
    return r.sessionId;
  }

  /** Send a browser-level CDP command. Returns the result payload. */
  async send(method: string, params: unknown = {}): Promise<unknown> {
    return this.sendInternal({ method, params });
  }

  /** Send a target-level CDP command on a specific session. */
  async sessionSend(sessionId: string, method: string, params: unknown = {}): Promise<unknown> {
    return this.sendInternal({ method, params, sessionId });
  }

  private async sendInternal(args: {
    method: string;
    params: unknown;
    sessionId?: string;
  }): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("BrowserManager not connected");
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = {
      id,
      method: args.method,
      params: args.params,
    };
    if (args.sessionId) msg.sessionId = args.sessionId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private installMessageHandler(ws: WebSocket): void {
    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const msg = parsed as Record<string, unknown>;

      // Response to a previous command.
      if (typeof msg.id === "number") {
        const pend = this.pending.get(msg.id);
        if (!pend) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          const errObj = msg.error as { message?: string; code?: number };
          pend.reject(new Error(`CDP error ${errObj.code ?? ""}: ${errObj.message ?? "unknown"}`));
        } else {
          pend.resolve(msg.result);
        }
        return;
      }

      // Spontaneous event.
      if (typeof msg.method === "string") {
        const handlers = this.eventHandlers.get(msg.method);
        if (handlers) {
          for (const h of handlers) {
            try {
              h(msg.params, typeof msg.sessionId === "string" ? msg.sessionId : undefined);
            } catch {
              // event-handler errors don't propagate
            }
          }
        }
      }
    });
    ws.on("close", () => {
      // If we have pending requests when the socket closes, fail them.
      for (const p of this.pending.values()) {
        p.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
  }

  private async discoverWsUrl(): Promise<string> {
    if (this.opts.fetchVersion) {
      const r = await this.opts.fetchVersion(this.opts.endpoint);
      return r.webSocketDebuggerUrl;
    }
    const url = `${this.opts.endpoint.replace(/\/$/, "")}/json/version`;
    return await new Promise<string>((resolve, reject) => {
      const req = httpRequest(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              webSocketDebuggerUrl?: string;
            };
            if (typeof body.webSocketDebuggerUrl !== "string") {
              return reject(new Error("CDP /json/version missing webSocketDebuggerUrl"));
            }
            resolve(body.webSocketDebuggerUrl);
          } catch (e) {
            reject(e as Error);
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  private async connectWs(url: string): Promise<WebSocket> {
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    const maxAttempts = this.opts.maxConnectAttempts ?? 30;
    const retryMs = this.opts.retryDelayMs ?? 500;
    let lastErr: Error | undefined;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const ws = factory(url);
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", (e) => reject(e));
        });
        return ws;
      } catch (e) {
        lastErr = e as Error;
        await delay(retryMs);
      }
    }
    throw new Error(`could not connect to CDP after ${maxAttempts} attempts: ${lastErr?.message ?? ""}`);
  }
}
