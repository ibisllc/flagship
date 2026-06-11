import { connect as netConnect, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import acme from "acme-client";
import { readFile } from "node:fs/promises";
import { ed, type Bytes, type Keypair } from "@flagship/protocol";
import { ServicePlatform, buildServiceHttpHandlers } from "./servicePlatform.js";
import { AliasReconciler } from "./aliasReconciler.js";
import { handleAppRequest } from "./serviceProxy.js";
import { FileAppEnvStore, type AppEnvStore } from "./serviceEnvStore.js";
import { AppRunner } from "./serviceRunner.js";
import { CertManager, type CertMaterial } from "./certManager.js";
import {
  DataProvisioner,
  RealMinioAdmin,
  RealPostgresAdmin,
  RealRedisAdmin,
} from "./dataLayer/index.js";
import {
  LetsEncryptIssuer,
  type AcmeIssuancePhase,
  type LeEnvironment,
} from "./acme/letsEncryptIssuer.js";
import { PersistentAcmeStore, shouldReuseCert } from "./acme/persistentStore.js";
import { RemoteDnsChallengeWriter } from "./acme/remoteDnsChallengeWriter.js";
import { fetchGrantedAccountKeyPem } from "./acme/grantedAccountKey.js";
import { buildServiceCertHandlers, rehydrateServiceCerts } from "./serviceCertHttp.js";
import {
  superviseTunnelClient,
  type SupervisedTunnelClient,
} from "./tunnel/tunnelClient.js";
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
   * Default: 60 days. LE issues 90-day certs, so 60d-remaining means the
   * cert is ~30 days old; the wide safety margin tolerates daemons that
   * sleep, travel, or sit behind flaky residential ISPs for weeks at a
   * time and still recover before expiry.
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
   * Fine-grained ACME issuance observability. Fires per-step as the
   * issuer walks the order (`acme-order` → `dns01-publish-*` →
   * `tlsalpn-served` → `acme-validating`). The daemon maps these onto
   * signed ProvisionEvent sub-phases so a stuck cert is locatable from
   * the phone + a public `dig` with no box access. Best-effort.
   */
  onAcmePhase?: (phase: AcmeIssuancePhase) => void;
  /**
   * Called when an in-process ACME attempt FAILS (with the attempt
   * number + error). The runtime does NOT exit — it backs off and
   * retries in-process so the daemon stays up to serve TLS-ALPN-01 and
   * let DNS-01 propagate. The daemon uses this to surface the real error
   * via a `failed` provision phase while keeping the box alive.
   */
  onCertAttemptFailed?: (attempt: number, error: string) => void;
  /**
   * Backoff schedule for the in-process ACME retry loop, in ms. The
   * runtime cycles through these (clamping to the last entry) between
   * failed issuance attempts. Production default is a gentle ramp that
   * respects LE rate limits while still recovering within minutes once
   * the transient cause clears. Tests inject a short / single-entry
   * schedule. An empty array disables retry (one attempt only).
   */
  certRetryBackoffMs?: number[];
  /**
   * Test seam: replace the real setTimeout used by the ACME retry loop
   * so tests can advance time deterministically. Default `setTimeout`.
   */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
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
   * Optional supervisor overrides for the tunnel client. Production
   * uses the defaults (30s initial jitter, 1s→60s full-jitter
   * exponential backoff, 30s keep-alive, 3 missed pongs); tests pass
   * `initialJitterMs: 0` + injected `setTimeoutImpl` / `wsFactory` to
   * drive reconnect synthetically.
   */
  tunnelSupervisor?: import("./tunnel/tunnelClient.js").SupervisorOptions;
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
   * `/api/orders-from-user` and `/api/services` — usually you want
   * `additionalHandlers` instead.
   */
  handleHttp?: (req: HttpRequest) => Promise<HttpResponse>;
  /**
   * Optional pre-handlers tried before the default handler. Each
   * returns null to fall through. The first non-null response wins.
   * Use this to overlay extra surfaces (the browser feature's
   * `/api/browser/*`, the admin-UI proxy's `/.flagship/admin/*`)
   * without losing the built-in `/api/orders-from-user` + `/api/services`
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
   *   `ServicePlatform` (otherwise app install/uninstall is not exposed).
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
  servicePlatform?: {
    dataServicesEnvFile?: string;
    hostUsername?: string;
    hostIrkPub?: Bytes;
    hostIrk?: Keypair | null;
    swk?: Bytes;
    /**
     * Optional browser-feature wiring. The caller builds + starts
     * BrowserManager / TabRegistry / DomainGate / PhonePipe externally
     * and hands them in here; the runtime just plumbs them through to
     * ServicePlatform so install/uninstall hooks domain grants on the gate.
     * Apps' /api/browser/* calls are routed by the caller's
     * `opts.handleHttp` overlay, not by the default handler — keeps
     * runtime.ts decoupled from the browser surface.
     */
    appAuthTokens?: import("./serviceAuthToken.js").AppAuthTokens;
    domainGate?: import("./browser/domainGate.js").DomainGate;
    tabRegistry?: import("./browser/tabRegistry.js").TabRegistry;
    /**
     * Update-pack canonical-home registration. When set, ServicePlatform
     * records an initial AppPullState for cross-creator installs so
     * the pull scheduler can fetch updates. `cloneService` is invoked at
     * install time to materialize the initial working tree (production
     * wires this to a /.flagship/update?since= bundle fetch).
     */
    pullStateStore?: import("./updateClient.js").AppPullStateStore;
    cloneService?: (args: {
      serviceId: string;
      canonicalUrl: string;
    }) => Promise<{ currentTip: string }>;
    /**
     * V5 — base URL the AliasReconciler polls for the user's app
     * aliases. Defaults to `https://flagshipserver.com` when the
     * field is absent (production). Set to `false` to disable the
     * reconciler entirely (tests + air-gapped dev). Set to an
     * explicit string to point at a staging .com (e.g.
     * `http://localhost:8787`).
     */
    aliasReconcilerComBase?: string | false;
    /** V5 — override the 60-second default. */
    aliasReconcilerIntervalMs?: number;
    /**
     * Per-app generic env store. When omitted, the runtime builds a
     * `FileAppEnvStore` under `<dataDir>/data/app-env` automatically
     * whenever `swk` + `dataDir` are present, so an owner's set-app-env
     * order persists sealed and is injected into the deployed app's
     * runtime environment. Tests inject an `InMemoryAppEnvStore`.
     */
    envStore?: import("./serviceEnvStore.js").AppEnvStore;
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
   * compose stack isn't configured. `servicePlatform` is null when
   * `servicePlatform.hostIrkPub` + `servicePlatform.swk` weren't supplied —
   * the daemon then runs without an app-install surface, useful for
   * tunnel-only / cert-only test profiles.
   */
  appRunner: AppRunner;
  dataProvisioner: DataProvisioner | null;
  servicePlatform: ServicePlatform | null;
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
   * Null when no ServicePlatform / dataDir is wired.
   */
  appBackup: import("./serviceBackup.js").AppBackupService | null;
  /**
   * W10 — per-app env-var sealed store. Names-only accessor for the
   * `/api/screens/services/:appId/env` editor; the value path goes
   * through ServicePlatform.setEnv (signed envelope). Null when no
   * ServicePlatform is wired or no envStore is configured.
   */
  envStore: AppEnvStore | null;
  /**
   * Append a handler to the live HTTP-handler chain. Handlers are
   * tried in registration order; the first non-null response wins.
   * Use this to wire surfaces that depend on the runtime's own
   * post-startup state (servicePlatform, urlController, appBackup).
   */
  addHandler(h: (req: HttpRequest) => Promise<HttpResponse | null>): void;
  /**
   * Append a WebSocket upgrade handler. Handlers are tried in
   * registration order until one returns true (accepted + detached
   * the socket); if none accept, the inbound request falls back to
   * the HTTP handler chain (which will typically respond 501 for
   * Upgrade requests it doesn't recognize).
   *
   * The handler MUST take ownership of the socket if it returns true.
   */
  addUpgradeHandler(
    h: (args: UpgradeRequest) => boolean,
  ): void;
  /**
   * THEFT RESPONSE — revoke this daemon's currently-installed leaf cert via
   * RFC 8555 §7.6, authorized by the ACME account key the issuer holds.
   * `reason` is an RFC 5280 CRL reason code; default 1 (keyCompromise) —
   * the correct reason when a box is stolen and its cert private key is
   * exposed. Throws if no live cert is installed.
   *
   * BLAST RADIUS (cert model A′): the box's own cert is per-box
   * (`[<server>.<user>, *.<server>.<user>]`, box-local key), so revoking it
   * affects only this box. The re-mint-survivors-before-revoke ordering
   * applies only to a SHARED tier-2 service cert (`<service>.<user>`), whose
   * key lives on every box serving that service.
   */
  revokeCurrentCert(reason?: number): Promise<void>;
}

export interface UpgradeRequest {
  socket: TLSSocket;
  method: string;
  path: string;
  headers: Record<string, string>;
  headBuffer: Buffer;
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
  servicePlatformRef: { current: ServicePlatform | null },
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

    if (req.path === "/api/services" || req.path.startsWith("/api/services/")) {
      if (!servicePlatformRef.current) {
        return {
          status: 503,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "ServicePlatform not configured" }),
        };
      }
      const appsHandler = buildServiceHttpHandlers({
        platform: servicePlatformRef.current,
        hostIrk: opts.servicePlatform?.hostIrk ?? null,
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
  // SAN list — PER-BOX wildcard cert (cert model A′). Each box mints
  // `[<server>.<user>, *.<server>.<user>]` with its own box-local key:
  // distinct names per box (no LE duplicate-cert collisions) and the
  // box-scoped wildcard covers every `<label>.<server>.<user>` service/
  // device name natively, so the canonical hierarchical
  // `<service>.<server>.<user>` is the served form (the `--` name-pin
  // hack is retired). The per-user wildcard `*.<user>` is GONE; tier-2
  // `<service>.<user>` names ride a separate shared per-service cert.
  const sans = boxCertSans(opts.serverFqdn, wantWildcard);
  const certManager = new CertManager();
  // The default handler needs to refer to ServicePlatform, but ServicePlatform
  // is constructed below (after the cert + tunnel). The ref-cell lets
  // us bind the handler now and populate it later.
  const servicePlatformRef: { current: ServicePlatform | null } = { current: null };
  const baseHandleHttp = opts.handleHttp ?? buildDefaultHandler(opts, servicePlatformRef);
  // Mutable handler chain. We push internally-built handlers (live_siblings,
  // url) into this AFTER startup wires their dependencies. The closure
  // below captures the array by reference so post-startup additions are
  // visible to subsequent requests.
  const extras: Array<(req: HttpRequest) => Promise<HttpResponse | null>> = [
    ...(opts.additionalHandlers ?? []),
  ];
  // Same idea for WebSocket upgrade handlers — `addUpgradeHandler`
  // pushes here, the onUpgrade closure consults this list before
  // falling through to the built-in sibling-handshake path.
  const extraUpgrades: Array<(args: UpgradeRequest) => boolean> = [];
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
    const app = leftmost && servicePlatformRef.current
      ? servicePlatformRef.current.byLabel(leftmost)
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
    // surface. Otherwise the SNI is an unclaimed name under the box's
    // own wildcard `*.<serverFqdn>` (cert model A′) — serve the
    // disambiguation fallback page (N0f) UNLESS the request is a
    // sibling-handshake upgrade (N0e-2): peers reach us via the FQDN
    // they're trying to talk to, so the WS path needs to work on every
    // SNI we serve.
    handleHttpConnection(socket, async (req) => {
      // Default fallback when not handled by upgrade or extras.
      const ownFqdn = opts.serverFqdn.toLowerCase();
      const isOwnHost = sni === ownFqdn;
      const inBoxZone = sni.endsWith(`.${ownFqdn}`);
      if (!isOwnHost && inBoxZone) return disambiguationResponse(sni);
      return handleHttp(req);
    }, {
      onUpgrade: (args) => {
        // Try registered upgrade handlers first (post-startup wiring
        // pushes screensWs etc. onto extraUpgrades). The sibling-WS
        // path is the runtime's own built-in upgrade — checked last
        // so external handlers can override if needed.
        for (const h of extraUpgrades) {
          if (h(args)) return true;
        }
        if (args.path !== "/.flagship/sibling-handshake") return false;
        if (!opts.servicePlatform?.swk) return false; // no STK → can't auth siblings
        const accepted = acceptSiblingUpgrade({
          socket: args.socket as unknown as import("node:net").Socket,
          headBuffer: args.headBuffer,
          headers: args.headers,
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
  // PER-BOX addressing (cert model A′): the box claims its apex
  // `<server>.<user>` PLUS its own wildcard `*.<server>.<user>` — the
  // space where `<service>.<server>.<user>` and device names live. The
  // claim is box-scoped, so there's nothing for the hub to arbitrate
  // between sibling boxes; tier-2 `<service>.<user>` leader routing is a
  // separate claim.
  const tunnelInitialDomains = tunnelDomainsFor(opts.serverFqdn, wantWildcard);
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
  // Supervised tunnel client: reconnects on any WS close with full-jitter
  // exponential backoff (capped at 60s), and runs a 30s ping/pong keep-
  // alive so a half-open connection (Fly cycled the TCP without telling
  // us) gets force-closed and reconnected within ~90s.
  const tunnel: SupervisedTunnelClient = superviseTunnelClient({
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
    // Defaults: initialJitterMs=30s, baseReconnectMs=1s, maxReconnectMs=60s,
    // keepAliveIntervalMs=30s, maxMissedPongs=3. Tests can override via
    // opts.tunnelSupervisor if they need deterministic timing.
    ...(opts.tunnelSupervisor ?? {}),
  });
  void tunnelInitialDomains;
  await tunnel.ready();

  // Persistent ACME state. If a `dataDir` (or test-injected store) is
  // configured, account key and issued certs are loaded on startup and
  // persisted on issuance. With no store, behavior matches the in-memory
  // demo: a fresh LE account on every restart and no renewal continuity.
  const store: PersistentAcmeStore | null =
    opts.persistentStore ?? (opts.dataDir ? new PersistentAcmeStore(opts.dataDir) : null);
  // LE issues 90-day certs; we renew when ≤60 days remain (i.e. once the
  // cert is ~30 days old). The wide safety margin means the daemon can be
  // offline for weeks and still recover before expiry — important for
  // boxes that travel, sleep, or sit behind flaky residential ISPs.
  // Operators who specifically want LE's published 30-day-recommendation
  // can override via `renewalWindowMs`.
  const renewalWindowMs = opts.renewalWindowMs ?? 60 * 24 * 60 * 60 * 1000;
  const renewalCheckIntervalMs = opts.renewalCheckIntervalMs ?? 6 * 60 * 60 * 1000;

  // Resolve the ACME account key once: env-supplied → on-disk → fresh.
  // We need it for both initial issuance AND periodic renewal, so do it
  // up front rather than only on the issuance path.
  const accountKeyPem = await resolveAccountKey({
    explicitPem: opts.accountKeyPem,
    store,
    createPrivateKey: () => acme.crypto.createPrivateKey().then((b) => b.toString()),
    onGenerated: opts.onAccountKeyGenerated,
    // #28 seal-to-box: if an admin has granted this box the user's SHARED ACME
    // account key (sealed to its STK = the identity Ed25519 seed), adopt it so
    // every box under the user mints certs under ONE Let's Encrypt account.
    // Returns null when there's no grant / .com is unreachable / the blob isn't
    // for us, in which case resolveAccountKey falls back to disk → self-gen.
    resolveGrantedPem: () =>
      fetchGrantedAccountKeyPem({
        baseUrl: opts.controlPlaneBaseUrl,
        serverFqdn: opts.serverFqdn,
        stkSeed: identity.privateKey,
      }),
  });

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
    ...(opts.onAcmePhase ? { onPhase: opts.onAcmePhase } : {}),
  });

  // Initial cert acquisition. CRITICAL: this must NOT block startup nor
  // kill the process on failure. ACME needs the daemon to STAY UP — the
  // tunnel + local TLS server have to be live for Let's Encrypt to reach
  // the box for TLS-ALPN-01, and a single transient ACME hiccup must not
  // tear everything down (a process exit + systemd restart guarantees the
  // box is DOWN exactly when LE retries validation, an unwinnable loop).
  // So: if there's a reusable on-disk cert we install it synchronously
  // (fast, offline); otherwise we kick the issuance into an in-process
  // retry loop with backoff and return immediately. The daemon serves
  // its API + tunnel throughout; the cert installs into CertManager
  // whenever an attempt finally succeeds.
  const existing = store ? await store.loadCert(opts.serverFqdn) : null;
  let certRetryLoop: { stop: () => void } | null = null;
  if (existing && shouldReuseCert(existing, sans, renewalWindowMs)) {
    certManager.install(
      { certPem: existing.certPem, privateKeyPem: existing.privateKeyPem },
      existing.notAfter,
    );
    console.log(
      `[runtime] reusing on-disk cert for ${opts.serverFqdn}; not after ${new Date(existing.notAfter).toISOString()}`,
    );
  } else {
    certRetryLoop = startCertRetryLoop({
      issuer,
      certManager,
      store,
      serverFqdn: opts.serverFqdn,
      sans,
      onCertIssued: opts.onCertIssued,
      onCertAttemptFailed: opts.onCertAttemptFailed,
      backoffMs: opts.certRetryBackoffMs ?? DEFAULT_CERT_RETRY_BACKOFF_MS,
      setTimeoutImpl: opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms)),
    });
  }

  // Periodic renewal. With the default 60-day window + 6-hour cadence,
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

  // Tier-2 shared service certs (cert model A′ Phase 5). Rehydrate any
  // persisted `<service>.<user>` cert into the custom-SNI tier so the
  // leader-routed name serves straight after a restart; mount the
  // phone→box mint/export/install surface when we know the host user's
  // IRK (the verification authority for all three envelopes). The mint
  // path reuses THIS issuer but swaps in a DNS-01 writer that forwards
  // the phone's grant, so the per-box flow above is untouched.
  if (store) {
    const rehydrated = await rehydrateServiceCerts({
      store,
      certManager,
      serverFqdn: opts.serverFqdn,
    });
    for (const fqdn of rehydrated) {
      console.log(`[runtime] rehydrated tier-2 service cert for ${fqdn}`);
    }
  }
  if (opts.servicePlatform?.hostUsername && opts.servicePlatform.hostIrkPub) {
    extras.push(
      buildServiceCertHandlers({
        serverFqdn: opts.serverFqdn,
        username: opts.servicePlatform.hostUsername,
        irkPub: opts.servicePlatform.hostIrkPub,
        issuer,
        certManager,
        store,
        dnsWriterWithAuthority: (grant) => dns.withServiceCertAuthority(grant),
      }),
    );
    console.log(`[runtime] mounted /api/service-certs/* handlers`);
  }

  // App-platform construction. AppRunner is unconditional (apps that
  // don't use the data layer can still deploy); DataProvisioner is
  // wired only if the data-services env file is supplied + readable;
  // ServicePlatform is wired only when host IRK + SWK are supplied.
  const appRunner = new AppRunner();
  const dataProvisioner = await maybeBuildDataProvisioner(
    opts.servicePlatform?.dataServicesEnvFile,
  );

  const apOpts = opts.servicePlatform;
  let aliasReconciler: AliasReconciler | null = null;
  let envStore: AppEnvStore | null = null;
  if (apOpts?.hostUsername && apOpts.hostIrkPub && apOpts.swk) {
    // Per-app generic env store. Injected variant wins (tests);
    // otherwise a SWK-sealed file store under <dataDir>/data/app-env.
    // Without a dataDir we run store-less — apps just get no owner env.
    if (apOpts.envStore) {
      envStore = apOpts.envStore;
    } else if (opts.dataDir) {
      const fileStore = new FileAppEnvStore(
        `${opts.dataDir}/data/app-env`,
        apOpts.swk,
      );
      await fileStore.load();
      envStore = fileStore;
    }
    servicePlatformRef.current = new ServicePlatform({
      host: { username: apOpts.hostUsername, irkPub: apOpts.hostIrkPub },
      swk: apOpts.swk,
      appRunner,
      dataProvisioner,
      appAuthTokens: apOpts.appAuthTokens ?? null,
      domainGate: apOpts.domainGate ?? null,
      tabRegistry: apOpts.tabRegistry ?? null,
      pullStateStore: apOpts.pullStateStore ?? null,
      cloneService: apOpts.cloneService ?? null,
      envStore,
    });
    const extras: string[] = [];
    if (apOpts.appAuthTokens) extras.push("app-tokens");
    if (apOpts.domainGate) extras.push("browser-gate");
    console.log(
      `[runtime] ServicePlatform ready for host ${apOpts.hostUsername}` +
        (extras.length ? ` (with ${extras.join(", ")})` : ""),
    );
    // V5 — periodic poll of /api/users/:u/apps/aliases on .com so a
    // phone-driven Replace stem flow rebinds the reverse-proxy index
    // automatically. Opt-out via opts.servicePlatform.aliasReconcilerComBase = false.
    const reconcileBase = apOpts.aliasReconcilerComBase;
    if (reconcileBase !== false) {
      aliasReconciler = new AliasReconciler({
        comBaseUrl: reconcileBase ?? "https://flagshipserver.com",
        username: apOpts.hostUsername,
        platform: servicePlatformRef.current,
        intervalMs: apOpts.aliasReconcilerIntervalMs ?? 60_000,
        onApplied: (changes) => {
          for (const c of changes) {
            console.log(
              `[runtime] alias applied: ${c.serviceId} ${c.oldLabel ?? "(new)"} → ${c.newLabel}`,
            );
          }
        },
        onError: (e) => {
          console.warn(`[runtime] alias reconcile error: ${String(e)}`);
        },
      });
      aliasReconciler.start();
      console.log(`[runtime] AliasReconciler polling ${apOpts.hostUsername} → ${reconcileBase ?? "flagshipserver.com"}`);
    }
  } else {
    console.log(`[runtime] ServicePlatform skipped (host IRK / SWK not provided)`);
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
  const appAuthTokens = opts.servicePlatform?.appAuthTokens;
  // App backup service. Wired only when we have a place to put backup
  // archives + a way to find an app's source tree (ServicePlatform).
  const { AppBackupService } = await import("./serviceBackup.js");
  const appBackup =
    opts.dataDir && servicePlatformRef.current
      ? new AppBackupService({
          backupDir: `${opts.dataDir}/backups`,
          resolveSource: async ({ creator, slug }) => {
            const ap = servicePlatformRef.current;
            if (!ap) return null;
            const serviceId = ServicePlatform.serviceId(creator, slug);
            const app = ap.byServiceId(serviceId);
            if (!app) return null;
            // Vibe-coded apps live under <dataDir>/data/app-clones/<serviceId>;
            // cross-creator apps under their Forgejo checkout. The runtime
            // doesn't currently track per-app source paths centrally — the
            // common path is the daemon's app-clones dir. Caller may
            // override later when Forgejo discovery lands.
            return `${opts.dataDir}/data/app-clones/${serviceId}`;
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
        canonicalFqdnsForApp: (serviceId) => {
          const ap = servicePlatformRef.current;
          if (!ap) return [];
          const app = ap.byServiceId(serviceId);
          if (!app) return [];
          // The pod's wildcard already covers <app>.<server>.<user>; the
          // canonical FQDN we surface is the leftmost-label form so apps
          // can show + reason about their identity URL.
          const host = apOpts?.hostUsername ?? "";
          const label = host
            ? ServicePlatform.urlLabel(host, app.creator, app.slug)
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
      certRetryLoop?.stop();
      if (renewalTimer) clearInterval(renewalTimer);
      aliasReconciler?.stop();
      await tunnel.close();
      tls.close();
    },
    certManager,
    appRunner,
    dataProvisioner,
    servicePlatform: servicePlatformRef.current,
    urlController,
    siblingRouter,
    appBackup,
    envStore,
    addHandler(h) {
      extras.push(h);
    },
    addUpgradeHandler(h) {
      extraUpgrades.push(h);
    },
    revokeCurrentCert: (reason = 1) => revokeCurrentCert({ issuer, certManager, reason }),
  };
}

/**
 * Revoke the daemon's currently-installed leaf cert (RFC 8555 §7.6). Split
 * out and exported so the theft-response path and tests can drive it with a
 * fake issuer + cert manager. Throws if no live cert is installed.
 *
 * See `DaemonRuntime.revokeCurrentCert` for the re-mint-survivors-BEFORE-
 * revoke ordering the multi-box flow must honour.
 */
export async function revokeCurrentCert(deps: {
  issuer: { revokeCertificate(certPem: string, reason?: number): Promise<void> };
  certManager: { currentCertPem(): string | null };
  reason?: number;
}): Promise<void> {
  const certPem = deps.certManager.currentCertPem();
  if (!certPem) {
    throw new Error("[runtime] revokeCurrentCert: no live cert installed to revoke");
  }
  await deps.issuer.revokeCertificate(certPem, deps.reason ?? 1);
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

/**
 * Default in-process ACME retry backoff. A gentle ramp: a quick first
 * retry (the most common cause — DNS-01 not yet propagated, or LE's
 * negative cache — clears in seconds), then progressively longer waits
 * that respect Let's Encrypt's failed-validation rate limits (5 failures
 * per account/hostname/hour on prod) while still recovering within a few
 * minutes once the transient cause clears. The loop clamps to the last
 * entry, so it keeps retrying every 10 minutes indefinitely rather than
 * giving up — a long-lived demo box behind a flaky path eventually wins.
 */
export const DEFAULT_CERT_RETRY_BACKOFF_MS: number[] = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
];

/**
 * Drive ACME issuance in-process with backoff, WITHOUT blocking startup
 * or exiting the process on failure. Returns immediately with a handle to
 * stop the loop (wired into runtime.close). The first attempt fires on
 * the next tick so the caller's TLS server + tunnel are already serving;
 * each failure backs off per `backoffMs` (clamped to the last entry) and
 * retries. Once an attempt installs a cert the loop stops.
 *
 * This is the antidote to the crash-loop: the old path awaited issuance
 * during startup and `process.exit(1)`'d on any throw, so systemd kept
 * restarting the daemon — guaranteeing it was DOWN exactly when LE tried
 * TLS-ALPN-01 and never giving DNS-01 time to propagate. Keeping the box
 * up across retries lets both challenge types actually complete.
 */
export function startCertRetryLoop(deps: {
  issuer: IssueDeps["issuer"];
  certManager: CertManager;
  store: PersistentAcmeStore | null;
  serverFqdn: string;
  sans: string[];
  onCertIssued?: (cert: CertMaterial, notAfter: number, names: string[]) => void;
  onCertAttemptFailed?: (attempt: number, error: string) => void;
  backoffMs: number[];
  setTimeoutImpl: (cb: () => void, ms: number) => unknown;
}): { stop: () => void } {
  let stopped = false;
  let attempt = 0;

  const run = async (): Promise<void> => {
    if (stopped) return;
    attempt += 1;
    try {
      await issueAndInstall({
        issuer: deps.issuer,
        certManager: deps.certManager,
        store: deps.store,
        serverFqdn: deps.serverFqdn,
        sans: deps.sans,
        onCertIssued: deps.onCertIssued,
      });
      console.log(
        `[runtime] 🔒 cert installed for ${deps.serverFqdn} on attempt ${attempt}`,
      );
      // Success — let the loop fall through (no reschedule).
    } catch (e) {
      if (stopped) return;
      const msg = e instanceof Error ? e.message : String(e);
      try {
        deps.onCertAttemptFailed?.(attempt, msg);
      } catch {
        // observability is best-effort
      }
      // Empty schedule ⇒ single attempt only.
      if (deps.backoffMs.length === 0) {
        console.error(
          `[runtime] cert issuance failed for ${deps.serverFqdn} (attempt ${attempt}); retry disabled: ${msg}`,
        );
        return;
      }
      const idx = Math.min(attempt - 1, deps.backoffMs.length - 1);
      const wait = deps.backoffMs[idx]!;
      console.error(
        `[runtime] cert issuance failed for ${deps.serverFqdn} (attempt ${attempt}); retrying in ${Math.round(wait / 1000)}s: ${msg}`,
      );
      deps.setTimeoutImpl(() => {
        void run();
      }, wait);
    }
  };

  // Kick the first attempt on the next tick so the caller has finished
  // wiring + returning the runtime before issuance starts.
  deps.setTimeoutImpl(() => {
    void run();
  }, 0);

  return {
    stop: () => {
      stopped = true;
    },
  };
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
 * Resolve the ACME account key:
 *   1. Use `explicitPem` if supplied (env var / test injection).
 *   2. Else, if a `store` is configured, load `account.pem` from disk.
 *   3. Else, mint a fresh key, persist it (if a store is configured),
 *      and call `onGenerated` for observability.
 *
 * CRITICAL: when we mint a fresh account key, `store.saveAccountKey()`
 * MUST succeed before we return. A daemon that crashed between mint and
 * first issuance with an unpersisted account key would burn a fresh LE
 * account on every restart loop, ultimately tripping LE's per-IP cap
 * and locking the box out of issuance entirely. We turn the persistence
 * failure into a hard boot error so the operator sees it immediately
 * rather than silently leaking accounts in the background.
 */
export async function resolveAccountKey(deps: {
  explicitPem: string | undefined;
  store: { loadAccountKey(): Promise<string | null>; saveAccountKey(pem: string): Promise<void> } | null;
  createPrivateKey: () => Promise<string>;
  onGenerated?: (pem: string) => void;
  /**
   * #28 seal-to-box: resolve the user's SHARED ACME account key, granted to
   * this box and sealed to its STK (see `unsealGrantedAccountKeyPem`). Returns
   * the PEM, or null when there's no active grant (or `.com` is unreachable —
   * the resolver swallows transient errors and returns null). Tried BEFORE the
   * on-disk key so a grant supersedes a previously self-generated account key
   * (the box adopts the shared key); the granted PEM is then persisted so a
   * later OFFLINE boot still has it. With no grant, behaviour is unchanged.
   */
  resolveGrantedPem?: () => Promise<string | null>;
}): Promise<string> {
  if (deps.explicitPem) return deps.explicitPem;
  if (deps.resolveGrantedPem) {
    let granted: string | null = null;
    try {
      granted = await deps.resolveGrantedPem();
    } catch {
      granted = null; // .com unreachable / unseal failed → fall back to disk
    }
    if (granted) {
      if (deps.store) {
        try {
          await deps.store.saveAccountKey(granted);
        } catch (e) {
          throw new Error(
            `[runtime] failed to persist granted ACME account key — refusing to boot to avoid an inconsistent issuance identity. Underlying error: ${(e as Error).message}`,
            { cause: e },
          );
        }
      }
      return granted;
    }
  }
  if (deps.store) {
    const loaded = await deps.store.loadAccountKey();
    if (loaded) return loaded;
  }
  const fresh = await deps.createPrivateKey();
  if (deps.store) {
    try {
      await deps.store.saveAccountKey(fresh);
    } catch (e) {
      throw new Error(
        `[runtime] failed to persist fresh ACME account key — refusing to boot to avoid burning LE accounts on a restart loop. Underlying error: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
  deps.onGenerated?.(fresh);
  return fresh;
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
 * Disambiguation HTTP response served when the SNI is under the box's
 * own wildcard cert (`*.<server>.<user>`) but no app has claimed it.
 * The .services fallback per N0f. Exported for test reachability.
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
 * match. No longer on the cert/claim path (model A′ is box-scoped) —
 * kept as the canonical parser for user-zone (tier-2) name handling.
 */
export function userZoneOf(serverFqdn: string): string | null {
  const lower = serverFqdn.toLowerCase();
  if (!lower.endsWith(".flagship.services")) return null;
  const head = lower.slice(0, -".flagship.services".length);
  const parts = head.split(".");
  if (parts.length < 2) return null;
  const user = parts[parts.length - 1]!;
  if (!/^[a-z0-9]{3,30}$/.test(user)) return null;
  return `${user}.flagship.services`;
}

/**
 * PER-BOX cert SANs (cert model A′): `[<server>.<user>, *.<server>.<user>]`.
 * The key is box-local and the names are distinct per box, so issuance never
 * hits LE's duplicate-cert limit; the box-scoped wildcard covers every
 * `<label>.<server>.<user>` service/device name. `wantWildcard=false`
 * (e.g. ACME unavailable) yields just the apex.
 */
export function boxCertSans(serverFqdn: string, wantWildcard: boolean): string[] {
  return wantWildcard ? [serverFqdn, `*.${serverFqdn}`] : [serverFqdn];
}

/**
 * PER-BOX tunnel claim (cert model A′). The box claims its own apex
 * `<server>.<user>` PLUS its own wildcard `*.<server>.<user>` — exactly the
 * name space its cert covers. Tier-2 `<service>.<user>` leader routing is a
 * separate claim.
 */
export function tunnelDomainsFor(serverFqdn: string, wantWildcard: boolean): string[] {
  return wantWildcard ? [serverFqdn, `*.${serverFqdn}`] : [serverFqdn];
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
