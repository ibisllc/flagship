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
 *     servicePlatform: {
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
import { FileAppAuthTokens, type AppAuthTokens } from "../serviceAuthToken.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { buildBrowserApiHandlers } from "./apiHandlers.js";
import { BrowserManager } from "./browserManager.js";
import { lookup } from "node:dns/promises";
import { DomainGate } from "./domainGate.js";
import { PolicedBrowser } from "./policedBrowser.js";
import { BrowserGrants, BrowserJudge, ContextRegistry } from "./policy/index.js";
import { PhonePipe } from "./phonePipe.js";
import { TabRegistry } from "./tabRegistry.js";
import { chromiumEgressFlags, contextSession, ServiceProxies, type ServiceProxiesOptions } from "./egress.js";
import { BrowserGrantRequests } from "./grantRequests.js";
import type { SensitiveAuthority } from "../egress/approvals.js";

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
  /** This server's own names and addresses: never reachable from an app browser (the judge refuses them). */
  protectedHosts?: () => { names: string[]; addresses: string[] };
  /** Test seam: resolve a name to every address it has. Default: the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Told of every address the judge approved for a host (beside the app's own pinning proxy, which always is). */
  onApproved?: (host: string, addresses: string[], serviceId: string) => void;
  /**
   * Where each app context's pinning proxy listens and whom it serves (egress.ts). Chromium must be
   * started with {@link BrowserBundle.chromiumFlags}. `false` (tests of the policy alone): no proxies.
   */
  egress?: ServiceProxiesOptions | false;
  /** This server's name, signed into the owner's answers to grant requests. */
  serverDomain?: string;
  /** The owner's keys, which sign an answer that widens an app's browser. Absent: grant requests are off. */
  authority?: () => SensitiveAuthority;
  /** A grant request is waiting for the owner (content-free). */
  onGrantRequest?: (serviceId: string) => void;
  /** Told of every refusal, for the owner's activity view. */
  onDenied?: ConstructorParameters<typeof PolicedBrowser>[0]["onDenied"];
}

export interface BrowserBundle {
  browser: BrowserManager;
  tabRegistry: TabRegistry;
  domainGate: DomainGate;
  phonePipe: PhonePipe;
  appAuthTokens: AppAuthTokens;
  /** The policy layer every tab operation goes through. */
  policed: PolicedBrowser;
  /** The grants the judge reads; they follow each app's install-time `browser.domains`. */
  grants: BrowserGrants;
  /** Each app context's pinning proxy; null when egress is off. */
  proxies: ServiceProxies | null;
  /** Grants beyond the manifest, answered by the owner; null without `authority`. */
  grantRequests: BrowserGrantRequests | null;
  /** The flags Chromium must run with so nothing leaves except through the proxies. */
  chromiumFlags(): Promise<string[]>;
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

  // The policy layer. An app's `browser.domains`, which the owner approved with the manifest, is its one
  // standing grant; the judge, the contexts and the guard enforce it on what the browser really does.
  const grants = new BrowserGrants();
  const judge = new BrowserJudge({
    grants,
    resolve: opts.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address)),
    ...(opts.protectedHosts ? { protectedHosts: opts.protectedHosts } : {}),
  });
  const proxies = opts.egress === false ? null : new ServiceProxies(opts.egress ?? {});
  const grantRequests =
    opts.authority && opts.serverDomain
      ? new BrowserGrantRequests({
          grants,
          serverDomain: opts.serverDomain,
          authority: opts.authority,
          ...(opts.onGrantRequest ? { onRequest: opts.onGrantRequest } : {}),
        })
      : null;
  const policed = new PolicedBrowser({
    cdp: browser,
    contexts: new ContextRegistry(),
    judge,
    onApproved: (host, addresses, serviceId) => {
      proxies?.allow(serviceId, host, addresses);
      opts.onApproved?.(host, addresses, serviceId);
    },
    ...(proxies ? { contextOptions: async (serviceId: string) => ({ proxyServer: await proxies.proxyFor(serviceId), proxyBypassList: "<-loopback>" }) } : {}),
    onContextGone: (serviceId) => {
      grants.endSession(contextSession(serviceId));
      void proxies?.close(serviceId);
    },
    ...(opts.onDenied ? { onDenied: opts.onDenied } : {}),
  });
  domainGate.onChange = (serviceId, domains) => {
    grants.revokeService(serviceId);
    if (domains === null) {
      grantRequests?.forgetService(serviceId);
      void policed.revokeService(serviceId).catch(() => {});
      return;
    }
    if (domains.length === 0) return;
    try {
      grants.approve({
        serviceId,
        capabilities: ["navigate", "read-dom", "screenshot", "input"],
        origins: domains,
        schemes: ["https"],
        duration: "service",
        explanation: "the sites this app declared in its manifest and you approved when you installed it",
      });
    } catch {
      // a domain the grant rules refuse (an address, a bare TLD) leaves the app with no grant: it can open nothing
    }
  };
  await policed.start();

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
    policed,
    appAuthTokens,
    pairedSessionGate: opts.pairedSessionGate,
    ...(grantRequests ? { grantRequests } : {}),
  });

  let closed = false;
  return {
    browser,
    tabRegistry,
    domainGate,
    phonePipe,
    appAuthTokens,
    policed,
    grants,
    proxies,
    grantRequests,
    async chromiumFlags() {
      return proxies ? chromiumEgressFlags(await proxies.denyAll()) : [];
    },
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
      await policed.stop();
      await proxies?.closeAll();
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
