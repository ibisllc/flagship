import { connect as netConnect, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import acme from "acme-client";
import { readFile } from "node:fs/promises";
import { ed, type Bytes, type Keypair } from "@flagship/protocol";
import { AppPlatform, buildAppHttpHandlers } from "./appPlatform.js";
import { handleAppRequest } from "./appProxy.js";
import { AppRunner } from "./appRunner.js";
import { CertManager, type CertMaterial } from "./certManager.js";
import {
  DataProvisioner,
  RealMinioAdmin,
  RealPostgresAdmin,
  RealRedisAdmin,
} from "./dataLayer/index.js";
import { LetsEncryptIssuer, type LeEnvironment } from "./acme/letsEncryptIssuer.js";
import { PersistentAcmeStore, shouldReuseCert } from "./acme/persistentStore.js";
import { RemoteDnsChallengeWriter } from "./acme/remoteDnsChallengeWriter.js";
import { startTunnelClient, type TunnelClient } from "./tunnel/tunnelClient.js";
import { buildOrdersHandler, type OrderExecutor } from "./orders.js";
import { acceptSiblingUpgrade } from "./sibling/wsServer.js";
import type { UpdateServer } from "./updateServer.js";

export interface DaemonRuntimeOptions {
  /** Server FQDN, e.g. "home.alice.flagship.services". */
  serverFqdn: string;
  /** 32-byte server identity private key. The pubkey must already be registered. */
  identityPrivKey: Uint8Array;
  /** WebSocket URL of the .services tunnel hub. */
  tunnelHubUrl: string;
  /** Base URL of the .com control plane (for DNS-01 publish/delete). */
  controlPlaneBaseUrl: string;
  /** Email for the ACME account. */
  acmeEmail: string;
  /** "staging" for Let's Encrypt's pebble or "production" for prod issuance. */
  acmeEnvironment: LeEnvironment;
  /**
   * If true (default), request a wildcard `*.<serverFqdn>` SAN in addition
   * to the server FQDN. Set false to issue only the server FQDN (e.g.
   * during early bootstrap before the control-plane DNS-01 path is set up
   * for this environment).
   */
  wildcard?: boolean;
  /**
   * Optional pre-existing ACME account key PEM. If absent (and `dataDir`
   * is also absent), a fresh account key is generated and discarded on
   * shutdown. With `dataDir`, the runtime loads/persists the account key
   * automatically — you should usually use that instead.
   */
  accountKeyPem?: string;
  /**
   * Directory for persistent ACME state (account key + cert + private
   * key). Default: none (in-memory only). Production: `/var/flagship`
   * on the LUKS-encrypted root. Files are written `0700` dir / `0600`
   * file with atomic write-then-rename.
   */
  dataDir?: string;
  /**
   * Renewal window in ms. The runtime re-issues the cert when the live
   * one has less than this remaining. Same value gates the startup
   * "reuse-disk-cert" decision and the periodic renewal scheduler.
   * Default: 30 days (matching Let's Encrypt's renewal recommendation).
   */
  renewalWindowMs?: number;
  /**
   * How often the daemon wakes up to check whether the cert is in the
   * renewal window. Default 6 hours; 0 disables periodic renewal
   * (used by tests, or by callers that prefer to drive renewals
   * externally). With the default 30d window + 6h check, a long-lived
   * daemon can miss several checks and still renew with weeks to spare.
   */
  renewalCheckIntervalMs?: number;
  /** Test seam — replace with mock store. */
  persistentStore?: PersistentAcmeStore;
  /**
   * Called when a new cert is issued (or renewed). Fires AFTER persistence.
   */
  onCertIssued?: (cert: CertMaterial, notAfter: number, names: string[]) => void;
  /**
   * Optional secondary listener for domain-granted events from the
   * hub. The runtime always wires its internal SiblingRouter to
   * receive the event (so apps see it via /api/live_siblings/poll);
   * this hook is for tests / observability that need to assert events
   * were forwarded.
   */
  onDomainGranted?: (e: { fqdn: string; ownerServerId: string }) => void;
  /**
   * Override the STK pubkey lookup used to verify inbound sibling-WS
   * handshakes. Production fetches from .com `/api/server/by-domain`;
   * tests inject a static map. Default: a fetcher pointed at
   * `controlPlaneBaseUrl`.
   */
  peerStkLookup?: (peerServerId: string) => Promise<Uint8Array | null>;
  /**
   * REQUIRED when starting a tunnel client. Returns the daemon's
   * current entitlement bundle (root + optional app certs from the
   * phone). Production loads from on-disk cache populated by
   * PhoneOrders; tests mint an in-test bundle with a fake IRK.
   */
  entitlements?: () => import("./tunnel/tunnelClient.js").EntitlementBundle | Promise<import("./tunnel/tunnelClient.js").EntitlementBundle>;
  /**
   * Called when a fresh ACME account key is generated. Fires AFTER
   * persistence. Useful for tests / observability.
   */
  onAccountKeyGenerated?: (pem: string) => void;
  /**
   * How to respond to incoming HTTPS requests once the cert is up.
   * Default: a tiny "Flagship daemon — no app configured" page on /,
   * `/api/orders-from-user` if `orders` is configured, 404 elsewhere.
   * Replace with a real reverse-proxy / app router.
   *
   * Replacing this entirely also disables the built-in routes for
   * `/api/orders-from-user` and `/api/apps` — usually you want
   * `additionalHandlers` instead.
   */
  handleHttp?: (req: HttpRequest) => Promise<HttpResponse>;
  /**
   * Optional pre-handlers tried before the default handler. Each
   * returns null to fall through. The first non-null response wins.
   * Use this to overlay extra surfaces (the browser feature's
   * `/api/browser/*`, the admin-UI proxy's `/.flagship/admin/*`)
   * without losing the built-in `/api/orders-from-user` + `/api/apps`
   * routes.
   */
  additionalHandlers?: Array<(req: HttpRequest) => Promise<HttpResponse | null>>;
  /**
   * Update-pack distribution server. When set, requests to the
   * per-app reverse proxy for `/.flagship/update` are routed here
   * before the container is consulted.
   */
  updateServer?: UpdateServer;
  /**
   * Phone-server orders endpoint. When set, the default HTTP handler
   * dispatches `POST /api/orders-from-user` to a signature-verifying
   * dispatcher backed by `executor`. Custom `handleHttp` implementations
   * should integrate `buildOrdersHandler` themselves.
   */
  orders?: {
    pskPub: Uint8Array;
    executor: OrderExecutor;
  };
  /**
   * App-platform plumbing.
   *
   * - `dataServicesEnvFile`: the key=value file written by
   *   `installer/data-services/init.sh`. When readable, the runtime
   *   builds a `DataProvisioner` wired to the running compose stack.
   *   Without it, apps with `data.stores` declarations fail to install
   *   (apps with no stores still deploy).
   * - `hostUsername`: the host's username (the middle label of
   *   `<server>.<host>.flagship.services`). Required to build
   *   `AppPlatform` (otherwise app install/uninstall is not exposed).
   * - `hostIrkPub`: the host's IRK pubkey, the authority for
   *   membership mutations on every app installed here.
   * - `hostIrk`: optional. When supplied, the install endpoint can
   *   automatically add the host as `owner` of newly-installed apps
   *   (the typical UX). Future production callers pass `null` and
   *   provide a phone-pre-signed membership mutation in the install
   *   body instead.
   * - `swk`: Server Working Key, used to derive per-app secrets
   *   (member stable-id derivation, cross-app fingerprint resistance).
   *
   * `AppRunner` is built unconditionally (it just shells to docker).
   */
  appPlatform?: {
    dataServicesEnvFile?: string;
    hostUsername?: string;
    hostIrkPub?: Bytes;
    hostIrk?: Keypair | null;
    swk?: Bytes;
    /**
     * Optional browser-feature wiring. The caller builds + starts
     * BrowserManager / TabRegistry / DomainGate / PhonePipe externally
     * and hands them in here; the runtime just plumbs them through to
     * AppPlatform so install/uninstall hooks domain grants on the gate.
     * Apps' /api/browser/* calls are routed by the caller's
     * `opts.handleHttp` overlay, not by the default handler — keeps
     * runtime.ts decoupled from the browser surface.
     */
    appAuthTokens?: import("./appAuthToken.js").AppAuthTokens;
    domainGate?: import("./browser/domainGate.js").DomainGate;
    tabRegistry?: import("./browser/tabRegistry.js").TabRegistry;
    /**
     * Update-pack canonical-home registration. When set, AppPlatform
     * records an initial AppPullState for cross-creator installs so
     * the pull scheduler can fetch updates. `cloneApp` is invoked at
     * install time to materialize the initial working tree (production
     * wires this to a /.flagship/update?since= bundle fetch).
     */
    pullStateStore?: import("./updateClient.js").AppPullStateStore;
    cloneApp?: (args: {
      appId: string;
      canonicalUrl: string;
    }) => Promise<{ currentTip: string }>;
  };
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export interface DaemonRuntime {
  /** Wait until the daemon is reachable end-to-end (cert installed). */
  ready(): Promise<void>;
  close(): Promise<void>;
  certManager: CertManager;
  /**
   * App-platform handles. `appRunner` is unconditional (it just shells
   * to docker). `dataProvisioner` is null when the data-services
   * compose stack isn't configured. `appPlatform` is null when
   * `appPlatform.hostIrkPub` + `appPlatform.swk` weren't supplied —
   * the daemon then runs without an app-install surface, useful for
   * tunnel-only / cert-only test profiles.
   */
  appRunner: AppRunner;
  dataProvisioner: DataProvisioner | null;
  appPlatform: AppPlatform | null;
  /**
   * App-claim primitives: add/remove FQDNs from this pod's
   * controlledDomains list and push a HELLO update to the tunnel hub.
   * Capability enforcement happens at a higher layer (the phone-order
   * dispatcher or N0j's /api/url/claim handler) — `urlController`
   * itself is the lower-level mutation primitive.
   */
  urlController: UrlController;
  /**
   * In-pod live-siblings router. Receives FRAME_DOMAIN_GRANTED events
   * from the tunnel hub and inbound sibling-app-message frames from
   * peer connections; fans out to app subscribers via
   * /api/live_siblings/poll. The sibling-WS connection layer (N0e-2)
   * registers/removes peers via setSibling/removeSibling.
   */
  siblingRouter: import("./sibling/router.js").InMemorySiblingRouter;
  /**
   * App backup service. PhoneOrder backup-app calls into this; the
   * resulting one-shot fetch URL is served at /api/backups/<id>.
   * Null when no AppPlatform / dataDir is wired.
   */
  appBackup: import("./appBackup.js").AppBackupService | null;
  /**
   * Append a handler to the live HTTP-handler chain. Handlers are
   * tried in registration order; the first non-null response wins.
   * Use this to wire surfaces that depend on the runtime's own
   * post-startup state (appPlatform, urlController, appBackup).
   */
  addHandler(h: (req: HttpRequest) => Promise<HttpResponse | null>): void;
}

export interface UrlController {
  /** Add an FQDN to the controlled list. Idempotent. Pushes a HELLO update. */
  claim(fqdn: string): Promise<void>;
  /** Remove an FQDN. Idempotent. Pushes a HELLO update. */
  release(fqdn: string): Promise<void>;
  /** Snapshot of extra (non-base) claimed FQDNs. */
  list(): string[];
}

function buildDefaultHandler(
  opts: DaemonRuntimeOptions,
  appPlatformRef: { current: AppPlatform | null },
): (req: HttpRequest) => Promise<HttpResponse> {
  const orderHandler = opts.orders
    ? buildOrdersHandler({
        serverFqdn: opts.serverFqdn,
        pskPub: opts.orders.pskPub,
        executor: opts.orders.executor,
      })
    : null;

  return async function defaultHandler(req: HttpRequest): Promise<HttpResponse> {
    if (req.path === "/api/orders-from-user") {
      if (!orderHandler) {
        return {
          status: 404,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "orders endpoint not configured" }),
        };
      }
      return orderHandler(req);
    }

    if (req.path === "/api/apps" || req.path.startsWith("/api/apps/")) {
      if (!appPlatformRef.current) {
        return {
          status: 503,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "AppPlatform not configured" }),
        };
      }
      const appsHandler = buildAppHttpHandlers({
        platform: appPlatformRef.current,
        hostIrk: opts.appPlatform?.hostIrk ?? null,
      });
      const r = await appsHandler(req);
      if (r) return r;
    }

    if (req.path === "/" || req.path === "") {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: defaultHelloPage(),
      };
    }
    return {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "not found",
    };
  };
}

function defaultHelloPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Flagship daemon</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #eee; padding: 4rem 2rem; max-width: 720px; margin: 0 auto; line-height: 1.55; }
      h1 { color: #6ee7a8; }
      code { background: #1a1a1a; padding: 0.2rem 0.4rem; border-radius: 4px; color: #fbcc4a; }
      .meta { color: #888; font-size: 0.9rem; margin-top: 2rem; }
    </style>
  </head>
  <body>
    <h1>🟢 Flagship daemon online</h1>
    <p>This server is alive. No app is yet bound to <code id="host"></code>.</p>
    <p class="meta">TLS terminated locally on this server. flagship.services only saw ciphertext.</p>
    <script>document.getElementById("host").textContent = location.host;</script>
  </body>
</html>`;
}

/**
 * Bring up the full daemon runtime:
 *   1. local TLS server with SNI/ALPN-aware cert resolution
 *   2. tunnel client connected to the .services hub
 *   3. ACME with Let's Encrypt for the server's cert
 *
 * Returns once the cert is installed (so the daemon is serving real HTTPS).
 */
export async function startDaemonRuntime(opts: DaemonRuntimeOptions): Promise<DaemonRuntime> {
  const wantWildcard = opts.wildcard ?? true;
  // SAN list (N0c). The user-zone wildcard `*.<user>.flagship.services`
  // covers single-label-deep names — both the canonical
  // `<server>.<user>.flagship.services` and any aliased
  // `<app>.<user>.flagship.services`. The pod-zone wildcard
  // `*.<server>.<user>.flagship.services` covers the canonical
  // app URLs `<app>.<server>.<user>.flagship.services` (one label deeper).
  // The user-zone apex is included for completeness; it would otherwise
  // not be covered by any wildcard.
  const userZone = userZoneOf(opts.serverFqdn);
  const sans = wantWildcard
    ? userZone
      ? [userZone, `*.${userZone}`, `*.${opts.serverFqdn}`]
      : [opts.serverFqdn, `*.${opts.serverFqdn}`]
    : [opts.serverFqdn];
  const certManager = new CertManager();
  // The default handler needs to refer to AppPlatform, but AppPlatform
  // is constructed below (after the cert + tunnel). The ref-cell lets
  // us bind the handler now and populate it later.
  const appPlatformRef: { current: AppPlatform | null } = { current: null };
  const baseHandleHttp = opts.handleHttp ?? buildDefaultHandler(opts, appPlatformRef);
  // Mutable handler chain. We push internally-built handlers (live_siblings,
  // url) into this AFTER startup wires their dependencies. The closure
  // below captures the array by reference so post-startup additions are
  // visible to subsequent requests.
  const extras: Array<(req: HttpRequest) => Promise<HttpResponse | null>> = [
    ...(opts.additionalHandlers ?? []),
  ];
  const handleHttp: (req: HttpRequest) => Promise<HttpResponse> = async (req) => {
    for (const h of extras) {
      const r = await h(req);
      if (r) return r;
    }
    return baseHandleHttp(req);
  };

  // Local TLS server. The tunnel hub forwards inbound TCP from
  // `<serverFqdn>:443` to this socket; the TLS handshake terminates here.
  const tls = createTlsServer({
    ALPNProtocols: ["acme-tls/1", "http/1.1"],
    SNICallback: (servername, cb) => {
      const ctx = certManager.contextFor(servername);
      if (!ctx) {
        cb(new Error(`no cert for ${servername}`));
        return;
      }
      cb(null, ctx);
    },
  });
  tls.on("secureConnection", (socket: TLSSocket) => {
    if (socket.alpnProtocol === "acme-tls/1") {
      socket.end();
      return;
    }
    // Per-app routing: if the SNI's leftmost label matches an installed
    // app, forward the request to its container (gated by membership);
    // otherwise fall back to the daemon's own HTTP surface.
    const sni = ((typeof socket.servername === "string" ? socket.servername : null) ?? opts.serverFqdn).toLowerCase();
    const leftmost = leftmostLabel(sni, opts.serverFqdn);
    const app = leftmost && appPlatformRef.current
      ? appPlatformRef.current.byLabel(leftmost)
      : undefined;
    if (app) {
      handleHttpConnection(socket, async (req) => {
        return handleAppRequest(app, req, {
          injectorKey: identityKeypairForInjection,
          updateServer: opts.updateServer,
        });
      });
      return;
    }
    // SNI doesn't match an installed app. If the SNI is the pod's
    // canonical address, fall through to the daemon's own HTTP
    // surface. Otherwise the SNI is an unclaimed FQDN under our
    // user-zone wildcard cert (per N0c) — serve the disambiguation
    // fallback page (N0f) UNLESS the request is a sibling-handshake
    // upgrade (N0e-2): peers reach us via the FQDN they're trying to
    // talk to, so the WS path needs to work on every SNI we serve.
    handleHttpConnection(socket, async (req) => {
      // Default fallback when not handled by upgrade or extras.
      const userZone = userZoneOf(opts.serverFqdn);
      const isOwnHost = sni === opts.serverFqdn || sni === `*.${opts.serverFqdn}`;
      const inUserZone = userZone && (sni === userZone || sni.endsWith(`.${userZone}`));
      if (!isOwnHost && inUserZone) return disambiguationResponse(sni);
      return handleHttp(req);
    }, {
      onUpgrade: ({ socket: rawSocket, path: reqPath, headers, headBuffer }) => {
        if (reqPath !== "/.flagship/sibling-handshake") return false;
        if (!opts.appPlatform?.swk) return false; // no STK → can't auth siblings
        // Build the sibling STK from SWK on demand. The STK is the
        // ed25519 keypair derived from SWK; same key the tunnel
        // client uses to sign HELLO.
        const accepted = acceptSiblingUpgrade({
          socket: rawSocket as unknown as import("node:net").Socket,
          headBuffer,
          headers,
          myServerId: opts.serverFqdn,
          myStk: identity, // identity keypair is the STK in this runtime
          lookupPeerStk: opts.peerStkLookup ?? defaultPeerStkLookup(opts),
          router: siblingRouter,
          liveSiblings: () => listLiveSiblings(siblingRouter),
          onReady: ({ peerServerId }) => {
            siblingRouter.setSibling({
              siblingId: peerServerId,
              fqdns: [],
              online: true,
              transport: null,
            });
          },
          onClose: ({ peerServerId }) => {
            if (peerServerId) siblingRouter.removeSibling(peerServerId);
          },
        });
        return accepted;
      },
    });
  });
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", () => resolve()));
  const tlsAddr = tls.address();
  if (!tlsAddr || typeof tlsAddr === "string") throw new Error("could not bind TLS backend");
  const tlsPort = tlsAddr.port;

  // The same Ed25519 keypair the daemon uses for its server-identity
  // (signing tunnel HELLO, etc.) doubles as the X-Flagship-Signature
  // injector key — apps that want to verify the signature fetch the
  // pubkey from `GET /.flagship/runtime-pubkey`. (Future: derive a
  // separate injection-only key from SWK so the identity-key blast
  // radius stays minimal.)
  // (Defined below; built once we have the keypair.)
  // Identity keypair derived from the priv key.
  const identity: Keypair = {
    privateKey: opts.identityPrivKey,
    publicKey: ed.getPublicKey(opts.identityPrivKey),
  };
  const identityKeypairForInjection = identity;

  // Tunnel client: forwards FRAME_OPEN(SNI) → 127.0.0.1:tlsPort.
  // The initial controlledDomains list is the canonical pod FQDN plus
  // (when wildcard is on) its single-label wildcard, which together
  // cover the canonical app URL space (`<app>.<server>.<user>.flagship.services`).
  // App-claimed alias / custom FQDNs are added later via /api/url/claim
  // and pushed to the hub as a HELLO update.
  const tunnelInitialDomains = wantWildcard
    ? [opts.serverFqdn, `*.${opts.serverFqdn}`]
    : [opts.serverFqdn];
  // In-pod live-siblings router. Receives the hub's domain-granted
  // broadcast (and, once N0e-2 lands the WS layer, inbound
  // sibling-app-message frames from peer pods).
  const { InMemorySiblingRouter } = await import("./sibling/router.js");
  const siblingRouter = new InMemorySiblingRouter();

  if (!opts.entitlements) {
    throw new Error(
      "[runtime] DaemonRuntimeOptions.entitlements is required " +
        "(N12b: tunnel client now sends IRK-signed entitlement certs, not controlledDomains). " +
        "Production loads from disk; tests inject a mint-on-the-fly bundle.",
    );
  }
  const tunnel = startTunnelClient({
    hubUrl: opts.tunnelHubUrl,
    signingKey: identity,
    getEntitlements: opts.entitlements,
    resolveBackend: () => ({ host: "127.0.0.1", port: tlsPort }),
    onDomainGranted: (e) => {
      siblingRouter.broadcastDomainGranted({
        fqdn: e.fqdn,
        ownerSiblingId: e.ownerServerId,
      });
      opts.onDomainGranted?.(e);
    },
  });
  void tunnelInitialDomains;
  await tunnel.ready();

  // Persistent ACME state. If a `dataDir` (or test-injected store) is
  // configured, account key and issued certs are loaded on startup and
  // persisted on issuance. With no store, behavior matches the in-memory
  // demo: a fresh LE account on every restart and no renewal continuity.
  const store: PersistentAcmeStore | null =
    opts.persistentStore ?? (opts.dataDir ? new PersistentAcmeStore(opts.dataDir) : null);
  const renewalWindowMs = opts.renewalWindowMs ?? 30 * 24 * 60 * 60 * 1000;
  const renewalCheckIntervalMs = opts.renewalCheckIntervalMs ?? 6 * 60 * 60 * 1000;

  // Resolve the ACME account key once: env-supplied → on-disk → fresh.
  // We need it for both initial issuance AND periodic renewal, so do it
  // up front rather than only on the issuance path.
  let accountKeyPem = opts.accountKeyPem;
  if (!accountKeyPem && store) {
    accountKeyPem = (await store.loadAccountKey()) ?? undefined;
  }
  if (!accountKeyPem) {
    accountKeyPem = (await acme.crypto.createPrivateKey()).toString();
    if (store) await store.saveAccountKey(accountKeyPem);
    opts.onAccountKeyGenerated?.(accountKeyPem);
  }

  const dns = new RemoteDnsChallengeWriter({
    controlPlaneBaseUrl: opts.controlPlaneBaseUrl,
    serverId: opts.serverFqdn,
    stk: identity,
  });
  const issuer = new LetsEncryptIssuer({
    email: opts.acmeEmail,
    environment: opts.acmeEnvironment,
    accountKeyPem,
    alpn: certManager,
    dns,
  });

  // Issue or reuse the initial cert.
  const existing = store ? await store.loadCert(opts.serverFqdn) : null;
  if (existing && shouldReuseCert(existing, sans, renewalWindowMs)) {
    certManager.install(
      { certPem: existing.certPem, privateKeyPem: existing.privateKeyPem },
      existing.notAfter,
    );
    console.log(
      `[runtime] reusing on-disk cert for ${opts.serverFqdn}; not after ${new Date(existing.notAfter).toISOString()}`,
    );
  } else {
    await issueAndInstall({
      issuer,
      certManager,
      store,
      serverFqdn: opts.serverFqdn,
      sans,
      onCertIssued: opts.onCertIssued,
    });
  }

  // Periodic renewal. With the default 30-day window + 6-hour cadence,
  // a daemon that's online any reasonable fraction of the time renews
  // with weeks to spare. setInterval timers don't keep Node alive on
  // their own once `unref`'d, so the tunnel and TLS server are still
  // what holds the event loop.
  let renewalTimer: NodeJS.Timeout | null = null;
  if (renewalCheckIntervalMs > 0) {
    renewalTimer = setInterval(() => {
      void renewIfNeeded({
        issuer,
        certManager,
        store,
        serverFqdn: opts.serverFqdn,
        sans,
        renewalWindowMs,
        onCertIssued: opts.onCertIssued,
      });
    }, renewalCheckIntervalMs);
    renewalTimer.unref?.();
  }

  // App-platform construction. AppRunner is unconditional (apps that
  // don't use the data layer can still deploy); DataProvisioner is
  // wired only if the data-services env file is supplied + readable;
  // AppPlatform is wired only when host IRK + SWK are supplied.
  const appRunner = new AppRunner();
  const dataProvisioner = await maybeBuildDataProvisioner(
    opts.appPlatform?.dataServicesEnvFile,
  );

  const apOpts = opts.appPlatform;
  if (apOpts?.hostUsername && apOpts.hostIrkPub && apOpts.swk) {
    appPlatformRef.current = new AppPlatform({
      host: { username: apOpts.hostUsername, irkPub: apOpts.hostIrkPub },
      swk: apOpts.swk,
      appRunner,
      dataProvisioner,
      appAuthTokens: apOpts.appAuthTokens ?? null,
      domainGate: apOpts.domainGate ?? null,
      tabRegistry: apOpts.tabRegistry ?? null,
      pullStateStore: apOpts.pullStateStore ?? null,
      cloneApp: apOpts.cloneApp ?? null,
    });
    const extras: string[] = [];
    if (apOpts.appAuthTokens) extras.push("app-tokens");
    if (apOpts.domainGate) extras.push("browser-gate");
    console.log(
      `[runtime] AppPlatform ready for host ${apOpts.hostUsername}` +
        (extras.length ? ` (with ${extras.join(", ")})` : ""),
    );
  } else {
    console.log(`[runtime] AppPlatform skipped (host IRK / SWK not provided)`);
  }

  // URL controller — under the entitlement model, claims happen at
  // the hub via FRAME_REQUEST_TRANSFER, not via HELLO updates. The
  // hub's allocator validates that the pod has a derivable claim
  // (from its presented entitlement cert) and atomically reassigns;
  // the result surfaces back through the next FRAME_DOMAIN_GRANTED
  // snapshot the hub broadcasts.
  //
  // The local set tracks in-flight + locally-acknowledged claims so
  // /api/url/owned can show what this app asked for. The snapshot
  // received from the hub is the source of truth.
  const requestedClaims = new Set<string>();
  const urlController: UrlController = {
    async claim(fqdn: string) {
      const lower = fqdn.toLowerCase();
      requestedClaims.add(lower);
      tunnel.requestTransfer(lower);
    },
    async release(fqdn: string) {
      const lower = fqdn.toLowerCase();
      requestedClaims.delete(lower);
      // No dedicated release-frame yet — when a holder explicitly
      // gives up a slot, the next holder's FRAME_REQUEST_TRANSFER
      // takes over via FCFS in the allocator. Apps that genuinely
      // want to abandon a held slot rely on socket-death
      // redistribution or a peer's transfer-request.
    },
    list(): string[] {
      return [...requestedClaims];
    },
  };

  // Wire app-facing HTTP surfaces — /api/live_siblings/* (sibling
  // discovery + opaque app messaging) and /api/url/* (URL claims) —
  // when an AppAuthTokens map is wired. Without it, apps can't
  // authenticate so the routes would always 401; we just don't mount
  // them. URL claims are now hub-driven via FRAME_REQUEST_TRANSFER —
  // no daemon-side capability store needed (N12d).
  const appAuthTokens = opts.appPlatform?.appAuthTokens;
  // App backup service. Wired only when we have a place to put backup
  // archives + a way to find an app's source tree (AppPlatform).
  const { AppBackupService } = await import("./appBackup.js");
  const appBackup =
    opts.dataDir && appPlatformRef.current
      ? new AppBackupService({
          backupDir: `${opts.dataDir}/backups`,
          resolveSource: async ({ creator, slug }) => {
            const ap = appPlatformRef.current;
            if (!ap) return null;
            const app = ap.byAppId(`${creator}--${slug}`);
            if (!app) return null;
            // Vibe-coded apps live under <dataDir>/data/app-clones/<appId>;
            // cross-creator apps under their Forgejo checkout. The runtime
            // doesn't currently track per-app source paths centrally — the
            // common path is the daemon's app-clones dir. Caller may
            // override later when Forgejo discovery lands.
            return `${opts.dataDir}/data/app-clones/${creator}--${slug}`;
          },
        })
      : null;

  if (appAuthTokens) {
    const { buildSiblingHttpHandlers } = await import("./sibling/httpHandlers.js");
    const { buildUrlHttpHandlers } = await import("./sibling/urlHttpHandlers.js");
    extras.push(
      buildSiblingHttpHandlers({
        router: siblingRouter,
        appAuthTokens,
        thisSiblingId: opts.serverFqdn,
      }),
    );
    extras.push(
      buildUrlHttpHandlers({
        appAuthTokens,
        urlController,
        thisSiblingId: opts.serverFqdn,
        canonicalFqdnsForApp: (appId) => {
          const ap = appPlatformRef.current;
          if (!ap) return [];
          const app = ap.byAppId(appId);
          if (!app) return [];
          // The pod's wildcard already covers <app>.<server>.<user>; the
          // canonical FQDN we surface is the leftmost-label form so apps
          // can show + reason about their identity URL.
          const host = apOpts?.hostUsername ?? "";
          const label = host
            ? AppPlatform.urlLabel(host, app.creator, app.slug)
            : app.slug;
          return [`${label}.${opts.serverFqdn}`];
        },
      }),
    );
    console.log(`[runtime] mounted /api/live_siblings/* + /api/url/* handlers`);
  }

  return {
    ready: () => Promise.resolve(),
    close: async () => {
      if (renewalTimer) clearInterval(renewalTimer);
      await tunnel.close();
      tls.close();
    },
    certManager,
    appRunner,
    dataProvisioner,
    appPlatform: appPlatformRef.current,
    urlController,
    siblingRouter,
    appBackup,
    addHandler(h) {
      extras.push(h);
    },
  };
}

async function maybeBuildDataProvisioner(envFile?: string): Promise<DataProvisioner | null> {
  if (!envFile) return null;
  let env: Record<string, string>;
  try {
    env = parseEnvFile(await readFile(envFile, "utf8"));
  } catch (e) {
    console.warn(
      `[runtime] data-services env file ${envFile} unreadable; data layer disabled: ${(e as Error).message}`,
    );
    return null;
  }
  const required = [
    "POSTGRES_ADMIN_USER",
    "POSTGRES_ADMIN_PASSWORD",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "REDIS_ADMIN_PASSWORD",
  ];
  for (const k of required) {
    if (!env[k]) {
      console.warn(`[runtime] data-services env missing ${k}; data layer disabled`);
      return null;
    }
  }
  const pgUrl = `postgresql://${env.POSTGRES_ADMIN_USER}:${encodeURIComponent(env.POSTGRES_ADMIN_PASSWORD!)}@127.0.0.1:5432/postgres`;
  const redisUrl = `redis://default:${encodeURIComponent(env.REDIS_ADMIN_PASSWORD!)}@127.0.0.1:6379/0`;
  console.log(`[runtime] data layer wired (postgres + redis + minio admins ready)`);
  return new DataProvisioner({
    postgres: new RealPostgresAdmin({ adminUrl: pgUrl }),
    kv: new RealRedisAdmin({ adminUrl: redisUrl }),
    objects: new RealMinioAdmin({
      endPoint: "127.0.0.1",
      port: 9000,
      rootUser: env.MINIO_ROOT_USER!,
      rootPassword: env.MINIO_ROOT_PASSWORD!,
    }),
  });
}

/** Parse a flat KEY=VALUE env file. Lines starting with # are comments. */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

interface IssueDeps {
  issuer: { issue(names: string[]): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }> };
  certManager: CertManager;
  store: PersistentAcmeStore | null;
  serverFqdn: string;
  sans: string[];
  onCertIssued?: (cert: CertMaterial, notAfter: number, names: string[]) => void;
}

/** Run the issuer, install the result in CertManager, and persist. */
async function issueAndInstall(deps: IssueDeps): Promise<void> {
  const result = await deps.issuer.issue(deps.sans);
  deps.certManager.install(
    { certPem: result.certPem, privateKeyPem: result.privateKeyPem },
    result.notAfter,
  );
  if (deps.store) {
    await deps.store.saveCert(deps.serverFqdn, {
      certPem: result.certPem,
      privateKeyPem: result.privateKeyPem,
      names: deps.sans,
      notAfter: result.notAfter,
    });
  }
  deps.onCertIssued?.(
    { certPem: result.certPem, privateKeyPem: result.privateKeyPem },
    result.notAfter,
    deps.sans,
  );
}

/**
 * Periodic renewal check. Exported (via `_internal` below) so tests can
 * trigger it with a fake issuer + clock without spinning up a real
 * daemon. Failures log and bail; the next tick will retry.
 */
export async function renewIfNeeded(
  deps: IssueDeps & { renewalWindowMs: number; now?: () => number },
): Promise<{ renewed: boolean; reason?: string; error?: string }> {
  const now = deps.now ?? (() => Date.now());
  if (!deps.certManager.needsRenewal(deps.renewalWindowMs, now())) {
    return { renewed: false, reason: "not in renewal window" };
  }
  const daysLeft = Math.floor(deps.certManager.msUntilExpiry(now()) / 86_400_000);
  console.log(
    `[runtime] cert for ${deps.serverFqdn} has ${daysLeft}d left — renewing`,
  );
  try {
    await issueAndInstall(deps);
    console.log(`[runtime] cert renewed for ${deps.serverFqdn}`);
    return { renewed: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[runtime] renewal failed for ${deps.serverFqdn}: ${msg}`);
    return { renewed: false, error: msg };
  }
}


/**
 * Tiny HTTP/1.1 reader on the TLS socket. Real production path will
 * proxy to per-app Forgejo/etc. backends via the AppRunner; for now this
 * is a self-contained handler so the daemon can prove end-to-end without
 * an app in the picture.
 */
interface HandleHttpOptions {
  /**
   * Optional WebSocket upgrade hook. Invoked when an inbound request
   * is `Upgrade: websocket` for one of the path prefixes the caller
   * recognizes. When the hook returns true the socket is handed off
   * (no further HTTP parsing). When it returns false a 400 is sent.
   */
  onUpgrade?: (args: {
    socket: TLSSocket;
    method: string;
    path: string;
    headers: Record<string, string>;
    headBuffer: Buffer;
  }) => boolean;
}

function handleHttpConnection(
  socket: TLSSocket,
  handler: (req: HttpRequest) => Promise<HttpResponse>,
  upgradeOpts?: HandleHttpOptions,
): void {
  let buf: Buffer = Buffer.alloc(0);
  let headersDone = false;
  let method = "";
  let path = "";
  let headers: Record<string, string> = {};
  let bodyExpected = 0;
  let bodyAccum: Buffer = Buffer.alloc(0);
  let detached = false;

  const onData = (chunk: Buffer) => {
    if (detached) return;
    buf = Buffer.concat([buf, chunk]);
    if (!headersDone) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const headerBlock = buf.subarray(0, sep).toString("utf8");
      buf = buf.subarray(sep + 4);
      const lines = headerBlock.split(/\r\n/);
      const requestLine = lines[0]?.split(" ") ?? [];
      method = requestLine[0] ?? "";
      path = requestLine[1] ?? "/";
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        headers[k] = v;
      }
      // Detect WebSocket upgrade. If the caller has an upgrade hook
      // and accepts the request, hand the socket off and stop HTTP
      // parsing. The hook owns the socket from this point on.
      const upgradeHdr = headers["upgrade"]?.toLowerCase();
      const connectionHdr = headers["connection"]?.toLowerCase() ?? "";
      const isUpgrade = upgradeHdr === "websocket" && connectionHdr.includes("upgrade");
      if (isUpgrade && upgradeOpts?.onUpgrade) {
        const accepted = upgradeOpts.onUpgrade({
          socket,
          method,
          path,
          headers,
          headBuffer: buf,
        });
        if (accepted) {
          detached = true;
          socket.off("data", onData);
          return;
        }
      }
      bodyExpected = parseInt(headers["content-length"] ?? "0", 10) || 0;
      headersDone = true;
    }
    if (headersDone) {
      bodyAccum = Buffer.concat([bodyAccum, buf]);
      buf = Buffer.alloc(0);
      if (bodyAccum.length >= bodyExpected) {
        respond({ method, path, headers, body: bodyAccum.subarray(0, bodyExpected) }).catch(() => {});
      }
    }
  };
  socket.on("data", onData);
  socket.on("error", () => {});

  async function respond(req: HttpRequest): Promise<void> {
    let resp: HttpResponse;
    try {
      resp = await handler(req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      resp = { status: 500, headers: { "content-type": "text/plain" }, body: `internal error: ${msg}` };
    }
    const body = typeof resp.body === "string" ? Buffer.from(resp.body) : resp.body;
    const hdrs = resp.headers ?? { "content-type": "text/plain" };
    const head = [
      `HTTP/1.1 ${resp.status} ${statusText(resp.status)}`,
      `Content-Length: ${body.length}`,
      "Connection: close",
      ...Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ].join("\r\n");
    socket.write(head);
    socket.write(body);
    socket.end();
  }
}

/**
 * Pull the leftmost DNS label out of an SNI hostname *if* it sits
 * under the daemon's serverFqdn. Returns null if the SNI doesn't end
 * with `.<serverFqdn>` (e.g., the server FQDN itself, or a hostname
 * outside our zone).
 *
 *   sni = "game1.alice.flagship.services"
 *   serverFqdn = "alice.flagship.services" → "game1"
 *
 *   sni = "game1-john.alice.flagship.services"
 *   serverFqdn = "alice.flagship.services" → "game1-john"
 *
 *   sni = "alice.flagship.services" (no leftmost) → null
 */
/**
 * Default STK pubkey lookup for inbound sibling-WS handshakes.
 * Fetches `<controlPlaneBaseUrl>/api/server/by-domain/<fqdn>` and
 * extracts identityPubKey/stkPubKey hex.
 */
function defaultPeerStkLookup(opts: DaemonRuntimeOptions): (peerServerId: string) => Promise<Uint8Array | null> {
  const base = (opts.controlPlaneBaseUrl ?? "https://flagshipserver.com").replace(/\/+$/, "");
  return async (peerServerId: string) => {
    try {
      const r = await fetch(`${base}/api/server/by-domain/${encodeURIComponent(peerServerId)}`);
      if (!r.ok) return null;
      const body = (await r.json()) as { stkPubKey?: string; identityPubKey?: string };
      const hex = body.identityPubKey ?? body.stkPubKey;
      if (typeof hex !== "string") return null;
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    } catch {
      return null;
    }
  };
}

/**
 * Snapshot of currently-live sibling serverIds from the router. Used
 * as the gossip getter on outbound + inbound sibling-WS handshakes.
 */
function listLiveSiblings(
  router: import("./sibling/router.js").InMemorySiblingRouter,
): string[] {
  return router.list().map((s) => s.siblingId);
}

/**
 * Disambiguation HTTP response served when the SNI is under our
 * user-zone wildcard cert but no app has claimed it. The .services
 * fallback per N0f. Exported for test reachability.
 */
export function disambiguationResponse(sni: string): HttpResponse {
  const safe = sni.replace(/[<>"&]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "&": "&amp;" }[c] ?? c),
  );
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>No app here · Flagship</title>
    <meta name="robots" content="noindex">
    <style>
      :root { --bg:#0a0a0a; --fg:#eee; --muted:#888; --accent:#7ad; }
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); padding: 4rem 1.5rem; max-width: 640px; margin: 0 auto; line-height: 1.55; }
      h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
      .lede { color: var(--muted); margin-bottom: 1.5rem; }
      code { font-family: ui-monospace, monospace; color: var(--accent); }
      .help { margin-top: 2rem; color: var(--muted); font-size: .9rem; }
      .help a { color: var(--accent); }
    </style>
  </head>
  <body>
    <h1>No app here yet.</h1>
    <p class="lede">The URL <code>${safe}</code> isn't pointing at an app right now. The owner of this username can decide which install — if any — claims it.</p>
    <p class="help">The long form (<code>&lt;app&gt;.&lt;server&gt;.&lt;user&gt;.flagship.services</code>) is always reachable. <a href="https://flagshipserver.com/docs/multiplexing">More on multiplexing →</a></p>
  </body>
</html>`;
  return {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html,
  };
}

/**
 * For a serverFqdn `<server>.<user>.flagship.services`, return the user
 * zone `<user>.flagship.services`. Returns null if the shape doesn't
 * match (degenerate; the runtime then falls back to the per-pod wildcard
 * SAN set without the user-zone leg). Exported so test code can invoke
 * the same parser the cert/SAN logic uses.
 */
export function userZoneOf(serverFqdn: string): string | null {
  const lower = serverFqdn.toLowerCase();
  if (!lower.endsWith(".flagship.services")) return null;
  const head = lower.slice(0, -".flagship.services".length);
  const parts = head.split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(user)) return null;
  return `${user}.flagship.services`;
}

function leftmostLabel(sni: string, serverFqdn: string): string | null {
  const suffix = `.${serverFqdn.toLowerCase()}`;
  const lower = sni.toLowerCase();
  if (!lower.endsWith(suffix)) return null;
  const head = lower.slice(0, lower.length - suffix.length);
  if (head.length === 0 || head.includes(".")) return null;
  return head;
}

function statusText(s: number): string {
  if (s === 200) return "OK";
  if (s === 201) return "Created";
  if (s === 204) return "No Content";
  if (s === 301) return "Moved Permanently";
  if (s === 302) return "Found";
  if (s === 304) return "Not Modified";
  if (s === 400) return "Bad Request";
  if (s === 401) return "Unauthorized";
  if (s === 403) return "Forbidden";
  if (s === 404) return "Not Found";
  if (s === 500) return "Internal Server Error";
  if (s === 502) return "Bad Gateway";
  if (s === 503) return "Service Unavailable";
  return "OK";
}
