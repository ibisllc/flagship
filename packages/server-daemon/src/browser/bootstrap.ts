/**
 * Production composition of the pod-resident browser feature.
 *
 * The runtime accepts the individual pieces (BrowserManager, TabRegistry,
 * DomainGate, PhonePipe, AppAuthTokens) so test daemons can substitute
 * mocks. In production those pieces have a single sensible wiring; this
 * module is the canonical assembly.
 *
 *   const bundle = await bootstrapBrowserBundle({
 *     cdpEndpoint: "http://127.0.0.1:9222",
 *     dataDir: "/var/flagship",
 *     alertInbox,
 *   });
 *
 *   await startDaemonRuntime({
 *     ...,
 *     appPlatform: {
 *       ...,
 *       appAuthTokens: bundle.appAuthTokens,
 *       domainGate: bundle.domainGate,
 *       tabRegistry: bundle.tabRegistry,
 *     },
 *     orders: {
 *       pskPub,
 *       executor: defaultExecutor({ ..., phonePipe: bundle.phonePipe }),
 *     },
 *     handleHttp: bundle.overlayHandleHttp(defaultHandler),
 *   });
 *
 * The factory does NOT touch the runtime — the caller still owns the
 * lifecycle. Returns a `close()` to tear the bundle down on shutdown.
 */

import { join } from "node:path";
import type { AlertInbox } from "../alertInbox.js";
import type { PairedSessionGate } from "../alertInboxHttp.js";
import { FileAppAuthTokens, type AppAuthTokens } from "../appAuthToken.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { buildBrowserApiHandlers } from "./apiHandlers.js";
import { BrowserManager } from "./browserManager.js";
import { DomainGate } from "./domainGate.js";
import { PhonePipe } from "./phonePipe.js";
import { TabRegistry } from "./tabRegistry.js";

export interface BootstrapBrowserOptions {
  /**
   * CDP HTTP endpoint of the headful Chromium container, e.g.
   * `http://127.0.0.1:9222`. The compose stack publishes 9222 on
   * loopback only.
   */
  cdpEndpoint: string;
  /**
   * Daemon data directory. The factory writes per-app daemon-API
   * tokens under `<dataDir>/app-tokens/`.
   */
  dataDir: string;
  /**
   * Inbox PhonePipe emits `browser-input-needed` alerts to. The
   * caller owns the inbox so it can be shared with the update-pack
   * subsystem.
   */
  alertInbox: AlertInbox;
  /**
   * Optional pre-built BrowserManager. Tests use this to inject a
   * fake CDP. Production callers leave it unset and the factory
   * builds a real one against `cdpEndpoint`.
   */
  browser?: BrowserManager;
  /**
   * Test seam: replace the FileAppAuthTokens with an in-memory
   * implementation.
   */
  appAuthTokens?: AppAuthTokens;
  /**
   * When set, the bundle's apiHandle gates `GET /api/browser/screenshot/<ref>`
   * on a paired-session token. Production wires this to the same gate
   * the AlertInbox HTTP uses so phone-paired browser sessions can fetch
   * the bytes the alert references.
   */
  pairedSessionGate?: PairedSessionGate;
}

export interface BrowserBundle {
  browser: BrowserManager;
  tabRegistry: TabRegistry;
  domainGate: DomainGate;
  phonePipe: PhonePipe;
  appAuthTokens: AppAuthTokens;
  /**
   * The /api/browser/* request handler. Returns null when the path
   * doesn't belong to the browser API (so the caller can fall through
   * to the daemon's default handler).
   */
  apiHandle: (req: HttpRequest) => Promise<HttpResponse | null>;
  /**
   * Wrap an existing `handleHttp` to try the browser API first and
   * fall through on null. Convenience for runtime composition.
   */
  overlayHandleHttp(
    next: (req: HttpRequest) => Promise<HttpResponse>,
  ): (req: HttpRequest) => Promise<HttpResponse>;
  /** Stop subscriptions, close the CDP socket. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build + start the full browser bundle. Idempotent on `close()`. Throws
 * if the BrowserManager cannot connect (CDP container not up). Caller
 * decides whether to abort the daemon or run without the browser surface.
 */
export async function bootstrapBrowserBundle(
  opts: BootstrapBrowserOptions,
): Promise<BrowserBundle> {
  const browser = opts.browser ?? new BrowserManager({ endpoint: opts.cdpEndpoint });
  // If the caller supplied a pre-built manager we assume they've already
  // started it (tests do). For a freshly-built one, kick off the CDP
  // connection now.
  if (!opts.browser) {
    await browser.start();
  }

  const tabRegistry = new TabRegistry(browser);
  tabRegistry.start();

  const domainGate = new DomainGate();

  const phonePipe = new PhonePipe({
    browser,
    tabRegistry,
    inbox: opts.alertInbox,
  });
  phonePipe.start();

  let appAuthTokens: AppAuthTokens;
  if (opts.appAuthTokens) {
    appAuthTokens = opts.appAuthTokens;
  } else {
    const fileTokens = new FileAppAuthTokens(join(opts.dataDir, "app-tokens"));
    await fileTokens.load();
    appAuthTokens = fileTokens;
  }

  const apiHandle = buildBrowserApiHandlers({
    browser,
    tabRegistry,
    domainGate,
    phonePipe,
    appAuthTokens,
    pairedSessionGate: opts.pairedSessionGate,
  });

  let closed = false;
  return {
    browser,
    tabRegistry,
    domainGate,
    phonePipe,
    appAuthTokens,
    apiHandle,
    overlayHandleHttp(next) {
      return async (req) => {
        const r = await apiHandle(req);
        if (r) return r;
        return next(req);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      phonePipe.stop();
      tabRegistry.stop();
      // Only stop the manager if we built it. If the caller passed one
      // in, leave its lifecycle to them (matches the start() contract).
      if (!opts.browser) {
        await browser.stop();
      }
    },
  };
}
