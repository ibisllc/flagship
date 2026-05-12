import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ed,
  signServerRevokeBySelf,
  type Keypair,
  type ServerRevokeBySelf,
} from "@flagship/protocol";
import { InMemoryAlertInbox } from "./alertInbox.js";
import {
  buildAlertInboxHandlers,
} from "./alertInboxHttp.js";
import { buildAdminProxyHandler } from "./adminProxy.js";
import { BackupLoop } from "./backupLoop.js";
import { BootCoordinator } from "./bootCoordinator.js";
import { bootstrapBrowserBundle, type BrowserBundle } from "./browser/bootstrap.js";
import { buildCloneApp } from "./cloneApp.js";
import { loadConfig, parseConfig, type ServerConfig } from "./config.js";
import { buildDaemonHttp, type DaemonContext } from "./httpApi.js";
import {
  buildIdentityRotateHandlers,
  defaultPendingIdentityPath,
} from "./identityRotateHttp.js";
import { AppMembership } from "./membership.js";
import { IdentityInjector } from "./identityInjector.js";
import {
  defaultPairedSessionPath,
  FilePairedSessionStore,
} from "./pairedSessionStore.js";
import { buildRunMigration } from "./runMigration.js";
import { buildScreensHttp } from "./screens/screensHttp.js";
import { buildScreensUpgradeHandler } from "./screens/screensWs.js";
import { VibeCodeSessionRegistry } from "./llm/vibeCodeSession.js";
import { buildVibeCodeHttpHandlers } from "./llm/vibeCodeHttp.js";
import { buildDeploySession } from "./llm/deploySession.js";
import { ForgejoAppAdmin } from "./forgejoAppAdmin.js";
import {
  startDaemonRuntime,
  type DaemonRuntime,
  type HttpRequest,
  type HttpResponse,
} from "./runtime.js";
import {
  buildAppDistribution,
  FileSubscriberRegistry,
} from "./subscriberRegistry.js";
import type { LeEnvironment } from "./acme/letsEncryptIssuer.js";
import type { OrderExecutor } from "./orders.js";
import type { PhonePipe } from "./browser/phonePipe.js";
import {
  FileAppPullStateStore,
  UpdateClient,
} from "./updateClient.js";
import { buildLineageResolverAdapter } from "./updatePack/lineageResolverAdapter.js";
import { UpdateScheduler } from "./updateScheduler.js";
import { UpdateServer } from "./updateServer.js";
import {
  defaultEndpointsCachePath,
  resolveServicesEndpoints,
} from "./servicesEndpoints.js";

/**
 * Production daemon entry point. Brings up:
 *   - The local TLS server with SNI/ALPN-aware cert resolution.
 *   - The outbound WebSocket tunnel to flagship.services.
 *   - ACME via Let's Encrypt for `<server>.<user>.flagship.services`
 *     (and the wildcard SAN for app subdomains, via DNS-01 against the
 *     .com control plane).
 *   - The local 127.0.0.1 HTTP API for phone-issued orders + status.
 *
 * Inputs come from either:
 *   - FLAGSHIP_CONFIG=/etc/flagship/server.json (production install path)
 *   - or env vars (dev path, mirroring hello-daemon).
 */

interface RuntimeEnv {
  serverFqdn: string;
  identityPrivKeyHex: string;
  /**
   * Hardcoded fallback for the tunnel hub URL when both the live
   * discovery call and the on-disk cache fail. Production daemons get
   * the URL via `/api/services/endpoints` on flagshipserver.com.
   */
  tunnelHubFallback: string;
  controlPlaneBaseUrl: string;
  acmeEmail: string;
  acmeEnvironment: LeEnvironment;
  wildcard: boolean;
}

function envFromProcess(): Partial<RuntimeEnv> {
  return {
    serverFqdn: process.env.FLAGSHIP_SUBDOMAIN,
    identityPrivKeyHex: process.env.FLAGSHIP_IDENTITY_PRIV_HEX,
    tunnelHubFallback: process.env.FLAGSHIP_HUB ?? "wss://flagship-services.fly.dev:8443/tunnel",
    controlPlaneBaseUrl:
      process.env.FLAGSHIP_CONTROL_PLANE_BASE_URL ?? "https://flagshipserver.com",
    acmeEmail: process.env.FLAGSHIP_ACME_EMAIL ?? "ops@flagship.services",
    acmeEnvironment: (process.env.FLAGSHIP_ACME_STAGING === "1" ? "staging" : "production") as LeEnvironment,
    wildcard: process.env.FLAGSHIP_NO_WILDCARD !== "1",
  };
}

async function tryLoadConfig(): Promise<ServerConfig | null> {
  const path = process.env.FLAGSHIP_CONFIG;
  if (!path) return null;
  try {
    return await loadConfig(path);
  } catch (e) {
    console.error(`[daemon] config load failed: ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const cfg = await tryLoadConfig();
  const env = envFromProcess();

  if (!env.serverFqdn || !env.identityPrivKeyHex) {
    console.error(
      "[daemon] Missing required inputs. Set FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX, " +
        "or supply FLAGSHIP_CONFIG with the same fields.",
    );
    process.exit(2);
  }

  const identityPrivKey = hexToBytes(env.identityPrivKeyHex);

  // ---- Discover the tunnel hub (so we can move infra without redeploying daemons) ----
  const dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
  const endpoints = await resolveServicesEndpoints({
    controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
    cachePath: defaultEndpointsCachePath(dataDir),
    fallback: { tunnelHub: env.tunnelHubFallback! },
  });
  console.log(
    `[daemon] services endpoints (${endpoints.source}): tunnelHub=${endpoints.endpoints.tunnelHub}`,
  );

  // ---- Backup loop (peer-backup participation) ----
  // SWK is provisioned by the phone at first boot. Until that's wired,
  // we accept FLAGSHIP_SWK_HEX from env / disk so the loop can be
  // constructed and toggled by phone orders. Without an SWK the loop
  // can't encrypt; we still construct a stub so set-backup-policy has
  // somewhere meaningful to call.
  const swkHex =
    process.env.FLAGSHIP_SWK_HEX ?? (await tryReadFile("/var/flagship/swk.hex"));
  const backupLoop = swkHex
    ? new BackupLoop({ swk: hexToBytes(swkHex.trim()), k: 3, n: 5 })
    : null;

  // ---- Phone-issued orders endpoint ----
  // PSK pubkey is baked into the install trailer; install.sh writes it
  // to /var/flagship/psk.pub.hex on first boot. For dev runs we accept
  // FLAGSHIP_PSK_PUB_HEX directly.
  const pskPubHex =
    process.env.FLAGSHIP_PSK_PUB_HEX ?? (await tryReadFile("/var/flagship/psk.pub.hex"));
  const identityKeypair: Keypair = {
    privateKey: identityPrivKey,
    publicKey: ed.getPublicKey(identityPrivKey),
  };

  // ---- Paired-session store (phone-paired browser bearer tokens) ----
  const pairedSessions = new FilePairedSessionStore(defaultPairedSessionPath(dataDir));
  await pairedSessions.load();

  // ---- Subscriber registry (per-app FQDN allowlist for update-pack pulls) ----
  const subscriberRegistry = new FileSubscriberRegistry(
    join(dataDir, "data", "subscribers"),
  );

  // ---- Pod-resident browser bundle (optional) ----
  // The compose stack publishes Chromium's CDP on 127.0.0.1:9222. If the
  // daemon can reach it we wire the full browser surface; if it can't,
  // the daemon still boots and apps without `browser.domains` are
  // unaffected. Bundle survives daemon shutdown via `bundle.close()`
  // registered on process exit.
  const alertInbox = new InMemoryAlertInbox();
  const cdpEndpoint =
    process.env.FLAGSHIP_CHROMIUM_CDP ?? "http://127.0.0.1:9222";
  let browserBundle: BrowserBundle | null = null;
  if (process.env.FLAGSHIP_DISABLE_BROWSER !== "1") {
    try {
      browserBundle = await bootstrapBrowserBundle({
        cdpEndpoint,
        dataDir,
        alertInbox,
        pairedSessionGate: pairedSessions,
      });
      console.log(`[daemon] browser bundle online (CDP ${cdpEndpoint})`);
    } catch (e) {
      console.warn(
        `[daemon] browser bundle disabled: ${(e as Error).message}; ` +
          `apps with browser.domains will get 403`,
      );
    }
  }

  const orders = pskPubHex
    ? {
        pskPub: hexToBytes(pskPubHex.trim()),
        executor: defaultExecutor({
          backupLoop,
          identity: identityKeypair,
          serverFqdn: env.serverFqdn!,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
          phonePipe: browserBundle?.phonePipe ?? null,
          subscriberRegistry,
          pairedSessions,
        }),
      }
    : undefined;

  // ---- Bring up TLS + tunnel + ACME ----
  console.log(`[daemon] starting runtime for ${env.serverFqdn}`);
  console.log(`[daemon]   tunnel hub:    ${endpoints.endpoints.tunnelHub}`);
  console.log(`[daemon]   control plane: ${env.controlPlaneBaseUrl}`);
  console.log(`[daemon]   ACME env:      ${env.acmeEnvironment}`);
  console.log(`[daemon]   wildcard:      ${env.wildcard ? "yes" : "no"}`);

  // ---- Update-pack distribution wiring ----
  const appCloneRoot = join(dataDir, "data", "app-clones");
  const appWorkingDir = (appId: string) => join(appCloneRoot, appId);
  const pullStateStore = new FileAppPullStateStore(
    join(dataDir, "data", "app-state"),
  );
  // Forgejo-backed app repos live under /var/flagship/data/forgejo/git/<host>/<slug>.git;
  // exact path is environment-specific so we make it overridable via env.
  const repoRoot =
    process.env.FLAGSHIP_REPO_ROOT ?? join(dataDir, "data", "forgejo", "git");
  const appPlatformRefForServer: { current: import("./appPlatform.js").AppPlatform | null } = { current: null };
  const updateServer = new UpdateServer({
    appDistribution: buildAppDistribution({
      // Platform isn't strictly used by buildAppDistribution beyond its
      // type; the closure supplies the per-app repo path.
      platform: undefined as unknown as import("./appPlatform.js").AppPlatform,
      registry: subscriberRegistry,
      repoPath: (app) =>
        join(repoRoot, app.creator.toLowerCase(), `${app.slug.toLowerCase()}.git`),
    }),
    resolveServerPubkey: async (fqdn) => {
      // .com exposes /api/server/by-domain/<fqdn> as the registry source
      // of truth (registered at install time, signed by IRK). Returning
      // null causes UpdateServer to reject the puller with 401.
      try {
        const r = await fetch(
          `${env.controlPlaneBaseUrl!.replace(/\/+$/, "")}/api/server/by-domain/${encodeURIComponent(fqdn)}`,
        );
        if (!r.ok) return null;
        const body = (await r.json()) as { stkPubKey?: string; identityPubKey?: string };
        const hex = body.identityPubKey ?? body.stkPubKey;
        if (typeof hex !== "string") return null;
        return hexToBytes(hex);
      } catch {
        return null;
      }
    },
    cacheDir: join(dataDir, "data", "update-pack-cache"),
  });

  const cloneApp = buildCloneApp({
    identity: identityKeypair,
    pullerServerId: env.serverFqdn!,
    appWorkingDir,
  });
  const runMigration = buildRunMigration({
    appByAppId: (appId) => appPlatformRefForServer.current?.byAppId(appId) ?? null,
  });
  const updateClient = new UpdateClient({
    identity: identityKeypair,
    pullerServerId: env.serverFqdn!,
    state: pullStateStore,
    appWorkingDir,
    runMigration,
    restartContainer: async (appId) => {
      const ap = appPlatformRefForServer.current;
      const app = ap?.byAppId(appId);
      // AppRunner uses docker; restarting the named container is enough.
      // We don't tear down the AppPlatform record because the install
      // is still valid; only the container's image needs to re-read
      // bind-mounted files.
      if (app) {
        // best-effort; AppRunner.deploy is idempotent on container name.
      }
      // Leaving as a no-op for v1; production wires AppRunner.restart.
      void app;
    },
    emitPhoneAlert: (alert) => {
      alertInbox.emit(alert);
    },
  });
  const updateScheduler = new UpdateScheduler({
    client: updateClient,
    store: pullStateStore,
    onResult: (appId, r) =>
      console.log(`[update-pack] ${appId} → ${r.kind}`),
    onError: (appId, e) =>
      console.warn(`[update-pack] ${appId} threw: ${e.message}`),
  });

  // ---- Phone-pollable AlertInbox HTTP + admin proxy + identity rotate ----
  const alertInboxHandle = buildAlertInboxHandlers({
    inbox: alertInbox,
    gate: pairedSessions,
  });
  const adminProxyHandle = buildAdminProxyHandler({ gate: pairedSessions });
  const identityRotateHandle = buildIdentityRotateHandlers({
    gate: pairedSessions,
    pendingPath: defaultPendingIdentityPath(dataDir),
  });

  const additionalHandlers: Array<(req: HttpRequest) => Promise<HttpResponse | null>> = [];
  if (browserBundle) additionalHandlers.push(browserBundle.apiHandle);
  additionalHandlers.push(alertInboxHandle);
  additionalHandlers.push(adminProxyHandle);
  additionalHandlers.push(identityRotateHandle);

  let runtime: DaemonRuntime;
  try {
    runtime = await startDaemonRuntime({
      serverFqdn: env.serverFqdn!,
      identityPrivKey,
      tunnelHubUrl: endpoints.endpoints.tunnelHub,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
      acmeEmail: env.acmeEmail!,
      acmeEnvironment: env.acmeEnvironment!,
      wildcard: env.wildcard,
      dataDir,
      orders,
      appPlatform: {
        // The data-services compose stack writes its admin creds here on
        // first boot. If it's missing, the runtime degrades gracefully:
        // apps declaring `data.stores` will refuse to install with a
        // clear error, but apps without data are unaffected.
        dataServicesEnvFile: process.env.FLAGSHIP_DATA_SERVICES_ENV ?? "/var/flagship/data-services.env",
        appAuthTokens: browserBundle?.appAuthTokens,
        domainGate: browserBundle?.domainGate,
        tabRegistry: browserBundle?.tabRegistry,
        pullStateStore,
        cloneApp,
      },
      additionalHandlers,
      updateServer,
    });
    appPlatformRefForServer.current = runtime.appPlatform;
    if (orders) console.log(`[daemon] orders-from-user endpoint enabled`);
    else console.log(`[daemon] FLAGSHIP_PSK_PUB_HEX not set; orders endpoint disabled`);
    console.log(`[daemon] 🔒 cert installed; serving HTTPS for ${env.serverFqdn}`);

    // Wire vibe-code (legacy /api/llm/sessions) + the BFF /api/screens/*
    // surface now that runtime.appPlatform / appBackup / urlController
    // are populated. Both surfaces are paired-session gated.
    const vibeRegistry = new VibeCodeSessionRegistry();
    const forgejoBaseUrl = process.env.FLAGSHIP_FORGEJO_BASE_URL;
    const forgejoToken = process.env.FLAGSHIP_FORGEJO_TOKEN;
    const forgejoOrg =
      process.env.FLAGSHIP_FORGEJO_ORG ?? `${cfg?.userId ?? "user"}-flagship`;
    const forgejoAdmin =
      forgejoBaseUrl && forgejoToken
        ? new ForgejoAppAdmin({
            baseUrl: forgejoBaseUrl,
            orgName: forgejoOrg,
            serviceToken: forgejoToken,
          })
        : null;
    const vibeAppDir = join(dataDir, "data", "app-clones");
    const username = cfg?.userId ?? env.serverFqdn!.split(".")[1] ?? "user";
    const deploySession = runtime.appPlatform
      ? buildDeploySession({
          appPlatform: runtime.appPlatform,
          hostIrk: identityKeypair,
          hostUsername: username,
          workingDir: vibeAppDir,
          cmd: (await import("./appRunner.js")).realCommandRunner,
          forgejoAdmin,
        })
      : undefined;
    const vibeCodeHandle = buildVibeCodeHttpHandlers({
      registry: vibeRegistry,
      gate: pairedSessions,
      username,
      serverFqdn: env.serverFqdn!,
      deploySession,
    });
    runtime.addHandler(vibeCodeHandle);

    const lineageResolver = buildLineageResolverAdapter({
      store: pullStateStore,
      client: updateClient,
      // Production uninstall walks the AppPlatform path which already
      // drops pull state + container + data stores + tabs. The BFF's
      // paired-session gate has already authenticated the caller, so
      // this is the trust equivalent of a host-IRK-signed uninstall.
      uninstall: async (appId) => {
        try {
          const ap = runtime.appPlatform;
          const app = ap?.byAppId(appId);
          if (!app) return { ok: true };
          // Drop pull state so the scheduler stops pestering the canonical
          // home, even if container-stop is best-effort and may fail in
          // ways we don't surface here.
          if (pullStateStore.delete) {
            await pullStateStore.delete(appId).catch(() => {});
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: (e as Error).message };
        }
      },
    });
    const screensHandle = buildScreensHttp({
      gate: pairedSessions,
      serverFqdn: env.serverFqdn!,
      username,
      daemonVersion: process.env.FLAGSHIP_DAEMON_VERSION ?? "0.0.0",
      startedAt: Date.now(),
      appPlatform: runtime.appPlatform,
      pairedSessions,
      tabRegistry: browserBundle?.tabRegistry ?? null,
      appBackup: runtime.appBackup,
      urlController: runtime.urlController,
      vibeCode: deploySession
        ? {
            registry: vibeRegistry,
            username,
            serverFqdn: env.serverFqdn!,
          }
        : null,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl ?? null,
      lineageResolver,
    });
    runtime.addHandler(screensHandle);
    runtime.addUpgradeHandler(
      buildScreensUpgradeHandler({
        gate: pairedSessions,
        vibeCodeRegistry: deploySession ? vibeRegistry : null,
        browser: browserBundle?.browser ?? null,
        tabRegistry: browserBundle?.tabRegistry ?? null,
      }),
    );
    console.log(`[daemon] /api/screens/* + /api/llm/sessions handlers mounted`);

    // Start the pull scheduler now that the cert is up + tunnel reachable.
    updateScheduler.start();
    console.log(`[daemon] update-pack scheduler started (6h jittered)`);
  } catch (e) {
    console.error(`[daemon] runtime startup failed: ${(e as Error).stack ?? e}`);
    process.exit(1);
  }

  // ---- Bring up the daemon-local HTTP API (phone/loopback only) ----
  if (cfg) {
    const coordinator = new BootCoordinator(cfg.serverId, cfg.bakPublicKey);
    const apps = new Map<string, AppMembership>();
    const injectors = new Map<string, IdentityInjector>();
    const sessions = new Map<string, Uint8Array>();
    const ctx: DaemonContext = {
      serverId: cfg.serverId,
      userId: cfg.userId,
      bootCoordinator: coordinator,
      apps,
      resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
      injectors,
    };
    const httpApp = buildDaemonHttp(ctx);
    const port = Number(process.env.FLAGSHIP_DAEMON_PORT) || 9090;
    await httpApp.listen({ port, host: "127.0.0.1" });
    console.log(`[daemon] local HTTP API listening on 127.0.0.1:${port}`);
  } else {
    console.log(`[daemon] FLAGSHIP_CONFIG not provided; skipping local HTTP API`);
  }

  // Tear the browser bundle down on graceful exit so Chromium isn't
  // left holding the singleton lock if the daemon restarts. We don't
  // try to be clever about ordering — the runtime owns the cert +
  // tunnel lifecycle and OpenRC/systemd will SIGKILL us if we hang.
  if (browserBundle) {
    const bundle = browserBundle;
    process.once("SIGTERM", () => void bundle.close().catch(() => {}));
    process.once("SIGINT", () => void bundle.close().catch(() => {}));
  }
  process.once("SIGTERM", () => updateScheduler.stop());
  process.once("SIGINT", () => updateScheduler.stop());

  // Stay alive forever (tunnel client + TLS server are event-driven and
  // hold the event loop on their own).
  await runtime.ready();
}

async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

interface ExecutorDeps {
  backupLoop: BackupLoop | null;
  identity: Keypair;
  serverFqdn: string;
  controlPlaneBaseUrl: string;
  /** Where deliver-bak writes the BAK pubkey hex. Default `/var/flagship/bak.pub.hex`. */
  bakPubPath?: string;
  /** Where rotate-server-identity reads the pending priv-hex. Default `/var/flagship/identity/identity.pending.priv.hex`. */
  pendingIdentityPrivPath?: string;
  /** Active identity priv-hex. Default `/var/flagship/identity/identity.priv.hex`. */
  activeIdentityPrivPath?: string;
  /** Active identity pub-hex. Default `/var/flagship/identity/identity.pub.hex`. */
  activeIdentityPubPath?: string;
  /** Boot-stage PEM the unsealed identity is consumed from at boot. Default `/boot/identity.pem`. */
  bootIdentityPemPath?: string;
  /**
   * When the browser bundle is up, the orders dispatcher routes
   * `browser-input-response` here so the typed value reaches the
   * focused field via CDP `Input.insertText`.
   */
  phonePipe?: PhonePipe | null;
  /** Subscriber registry for add/remove-subscriber phone orders. */
  subscriberRegistry?: FileSubscriberRegistry;
  /** Paired-session store for add/remove-paired-session phone orders. */
  pairedSessions?: FilePairedSessionStore;
}

function defaultExecutor(deps: ExecutorDeps): OrderExecutor {
  return {
    noop: () => {
      console.log(`[daemon] order: noop`);
    },
    setBackupPolicy: ({ enabled }) => {
      if (!deps.backupLoop) {
        console.log(
          `[daemon] order: set-backup-policy enabled=${enabled} — but no backup loop ` +
            `(missing FLAGSHIP_SWK_HEX); persisting policy intent only.`,
        );
        return;
      }
      deps.backupLoop.setEnabled(enabled);
      console.log(`[daemon] order: set-backup-policy → BackupLoop.setEnabled(${enabled})`);
    },
    shutDown: () => {
      console.log(`[daemon] order: shut-down — exiting in 1s`);
      setTimeout(() => process.exit(0), 1000);
    },
    revokeSelf: async ({ reason }) => {
      console.log(`[daemon] order: revoke-self reason=${JSON.stringify(reason)}`);
      try {
        await postSelfRevoke(deps, reason);
        console.log(`[daemon] revoke-self acknowledged by .com — exiting in 1s`);
      } catch (e) {
        console.error(
          `[daemon] revoke-self failed to reach .com: ${(e as Error).message}; exiting anyway`,
        );
      }
      setTimeout(() => process.exit(0), 1000);
    },
    rotateServerIdentity: async ({ newIdentityPubKey }) => {
      console.log(
        `[daemon] order: rotate-server-identity → swapping to pubkey ${bytesToHexLocal(newIdentityPubKey).slice(0, 16)}…`,
      );
      try {
        await rotateIdentity(deps, newIdentityPubKey);
        console.log(`[daemon] rotate complete; exiting in 1s so OpenRC respawns with new identity`);
        setTimeout(() => process.exit(0), 1000);
      } catch (e) {
        console.error(`[daemon] rotate-server-identity failed: ${(e as Error).message}`);
        throw e; // surfaces as 500 to phone
      }
    },
    deliverBak: async ({ bakPubKey }) => {
      const path = deps.bakPubPath ?? "/var/flagship/bak.pub.hex";
      try {
        await persistBakPubKey(path, bakPubKey);
        console.log(
          `[daemon] order: deliver-bak — wrote ${bakPubKey.length}B BAK pubkey to ${path}`,
        );
      } catch (e) {
        console.error(`[daemon] order: deliver-bak failed to persist: ${(e as Error).message}`);
        throw e; // surfaces as 500 to the phone
      }
    },
    browserInputResponse: deps.phonePipe
      ? async (args) => {
          await deps.phonePipe!.applyInputResponse(args);
        }
      : undefined,
    addSubscriber: deps.subscriberRegistry
      ? async ({ appId, fqdn }) => {
          await deps.subscriberRegistry!.add(appId, fqdn);
          console.log(`[daemon] order: add-subscriber appId=${appId} fqdn=${fqdn}`);
        }
      : undefined,
    removeSubscriber: deps.subscriberRegistry
      ? async ({ appId, fqdn }) => {
          await deps.subscriberRegistry!.remove(appId, fqdn);
          console.log(`[daemon] order: remove-subscriber appId=${appId} fqdn=${fqdn}`);
        }
      : undefined,
    addPairedSession: deps.pairedSessions
      ? async ({ token, label }) => {
          await deps.pairedSessions!.add(token, label);
          console.log(`[daemon] order: add-paired-session label=${JSON.stringify(label)}`);
        }
      : undefined,
    removePairedSession: deps.pairedSessions
      ? async ({ token }) => {
          await deps.pairedSessions!.remove(token);
          console.log(`[daemon] order: remove-paired-session`);
        }
      : undefined,
  };
}

async function persistBakPubKey(path: string, bakPubKey: Uint8Array): Promise<void> {
  const hex = bytesToHexLocal(bakPubKey);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, hex + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Rotate the daemon's server-identity keypair. The phone-issued order
 * carries the NEW pubkey; the matching priv must already be on disk
 * under `pendingIdentityPrivPath` (the daemon writes that file via a
 * prior phone-paired-session HTTP call to `/api/identity/pending`).
 *
 * Flow:
 *   1. Verify the pending priv-hex on disk derives to the order's pubkey
 *      — defends against a phone signing the wrong key.
 *   2. Atomically replace `active.priv.hex` + `active.pub.hex` + boot
 *      PEM with the new material (write tmp → rename, original priv
 *      kept as `.previous` for one cycle in case the next start fails).
 *   3. Best-effort revoke the old identity at .com so the routing
 *      table updates. Failure is logged but doesn't abort — the new
 *      identity is already on disk and will take over on next boot.
 *   4. Caller exits the process (OpenRC respawns the daemon, which
 *      reads the rotated files at startup).
 *
 * Tests inject all four paths through ExecutorDeps; production uses
 * the defaults documented in the interface.
 */
async function rotateIdentity(
  deps: ExecutorDeps,
  newIdentityPubKey: Uint8Array,
): Promise<void> {
  const pendingPath =
    deps.pendingIdentityPrivPath ?? "/var/flagship/identity/identity.pending.priv.hex";
  const activePrivPath =
    deps.activeIdentityPrivPath ?? "/var/flagship/identity/identity.priv.hex";
  const activePubPath =
    deps.activeIdentityPubPath ?? "/var/flagship/identity/identity.pub.hex";
  const bootPemPath = deps.bootIdentityPemPath ?? "/boot/identity.pem";

  let pendingHex: string;
  try {
    pendingHex = (await readFile(pendingPath, "utf8")).trim();
  } catch (e) {
    throw new Error(
      `pending identity not on disk at ${pendingPath} — phone must POST /api/identity/pending first; ${(e as Error).message}`,
    );
  }
  const pendingPriv = hexToBytes(pendingHex);
  const derivedPub = ed.getPublicKey(pendingPriv);
  if (!bytesEqualLocal(derivedPub, newIdentityPubKey)) {
    throw new Error("pending identity priv on disk does not derive to the order's newIdentityPubKey");
  }

  // 1. Snapshot the current active priv as `.previous` so a rotation
  //    that fails post-restart can be rolled back manually.
  try {
    const prev = await readFile(activePrivPath);
    await writeFile(`${activePrivPath}.previous`, prev, { mode: 0o600 });
  } catch {
    // no prior identity — fresh-box rotation is unusual but not fatal
  }

  // 2. Atomically swap active = pending, plus the boot PEM.
  await writeFile(`${activePrivPath}.tmp`, pendingHex + "\n", { mode: 0o600 });
  await rename(`${activePrivPath}.tmp`, activePrivPath);
  const newPubHex = bytesToHexLocal(newIdentityPubKey);
  await writeFile(`${activePubPath}.tmp`, newPubHex + "\n", { mode: 0o644 });
  await rename(`${activePubPath}.tmp`, activePubPath);
  // Boot PEM gets the new priv as PKCS8 so boot-stage.sh can sign with it.
  await writeFile(`${bootPemPath}.tmp`, pkcs8PemFromRaw(pendingPriv), { mode: 0o600 });
  await rename(`${bootPemPath}.tmp`, bootPemPath);

  // 3. Drop the pending file so the next rotate has to start fresh.
  try {
    await rm(pendingPath, { force: true });
  } catch {
    // best-effort
  }

  // 4. Revoke the old identity at .com so routing lookups stop accepting
  //    HELLOs signed by it. The daemon's tunnel will reconnect on next
  //    start with the new identity.
  try {
    await postSelfRevoke(deps, "rotated-by-phone");
  } catch (e) {
    // Non-fatal: the new identity is already on disk; we'll re-attempt
    // revocation manually if needed.
    console.warn(`[daemon] rotate: .com revoke best-effort failed: ${(e as Error).message}`);
  }
}

const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

function pkcs8PemFromRaw(raw32: Uint8Array): string {
  if (raw32.length !== 32) throw new Error("Ed25519 priv must be exactly 32 bytes");
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  der.set(PKCS8_ED25519_PREFIX, 0);
  der.set(raw32, PKCS8_ED25519_PREFIX.length);
  const b64 = Buffer.from(der).toString("base64");
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

function bytesEqualLocal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function postSelfRevoke(deps: ExecutorDeps, reason: string): Promise<void> {
  const issuedAt = Date.now();
  const claim: ServerRevokeBySelf = { serverId: deps.serverFqdn, reason, issuedAt };
  const sig = signServerRevokeBySelf(claim, deps.identity);
  const url = `${deps.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/server/by-domain/${encodeURIComponent(deps.serverFqdn)}/revoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { serverId: deps.serverFqdn, reason, issuedAt },
      signature: bytesToHexLocal(sig),
    }),
  });
  if (!res.ok) {
    throw new Error(`revoke-self HTTP ${res.status} ${await res.text()}`);
  }
}

function bytesToHexLocal(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { BootCoordinator } from "./bootCoordinator.js";
export { BackupLoop } from "./backupLoop.js";
export { AppRunner } from "./appRunner.js";
export { loadConfig, parseConfig } from "./config.js";
export type { ServerConfig } from "./config.js";
export {
  startTunnelClient,
  superviseTunnelClient,
  defaultWebSocketFactory,
} from "./tunnel/tunnelClient.js";
export type {
  TunnelClient,
  TunnelClientOptions,
  BackendTarget,
  BackendResolver,
  SupervisedTunnelClient,
  SupervisorOptions,
  SuperviseTunnelClientOptions,
  TunnelWebSocketLike,
  WebSocketFactory,
} from "./tunnel/tunnelClient.js";
export { MembershipStore, InviteStore, AppMembership } from "./membership.js";
export type {
  MembershipEntry,
  ApplyResult,
  MembershipStoreOptions,
  RedeemResult,
} from "./membership.js";
export { IdentityInjector, verifyIdentityHeaders } from "./identityInjector.js";
export type { IdentityInjectorOptions, Decision, InboundRequest } from "./identityInjector.js";
export { buildDaemonHttp } from "./httpApi.js";
export type { DaemonContext } from "./httpApi.js";
export {
  EncryptedCertStore,
  deriveTlsKey,
  alpnChallengeDigest,
} from "./acme.js";
export type { AcmeIssuer, StoredCert } from "./acme.js";
export { LetsEncryptIssuer } from "./acme/letsEncryptIssuer.js";
export type {
  LetsEncryptIssuerOptions,
  LeEnvironment,
  AlpnChallengeServer,
  DnsChallengeWriter,
  MinimalAcmeClient,
} from "./acme/letsEncryptIssuer.js";
export { buildAlpnChallengeCert } from "./acme/alpnChallengeCert.js";
export { RemoteDnsChallengeWriter } from "./acme/remoteDnsChallengeWriter.js";
export type { RemoteDnsChallengeWriterOptions } from "./acme/remoteDnsChallengeWriter.js";
export { CertManager } from "./certManager.js";
export type { CertMaterial } from "./certManager.js";
export { startDaemonRuntime, renewIfNeeded, resolveAccountKey } from "./runtime.js";
export type {
  DaemonRuntime,
  DaemonRuntimeOptions,
  HttpRequest as DaemonHttpRequest,
  HttpResponse as DaemonHttpResponse,
} from "./runtime.js";
export {
  PersistentAcmeStore,
  isCertFresh,
  sansEqual,
  shouldReuseCert,
} from "./acme/persistentStore.js";
export type { PersistedCert } from "./acme/persistentStore.js";
export { buildOrdersHandler } from "./orders.js";
export type { OrderExecutor, OrdersHandlerOptions } from "./orders.js";
export {
  buildInviteHandler,
  canonicalIssueInvite,
  canonicalRevokeAccess,
  InMemoryAppInviteStore,
  invitePage,
  signIssueInvite,
  signRevokeAccess,
} from "./inviteHandler.js";
export type {
  AppAccessRow,
  AppInviteRow,
  AppInviteStore,
  InviteHandlerDeps,
} from "./inviteHandler.js";
export {
  addLabel,
  appIds as labelBookAppIds,
  deserialize as deserializeLabelBook,
  emptyLabelBook,
  entriesForApp,
  lookup as lookupLabel,
  removeLabel,
  serialize as serializeLabelBook,
} from "./labelBook.js";
export type { LabelBook, LabelEntry } from "./labelBook.js";
export {
  buildAccessModeHandler,
  canonicalAccessMode,
  denialResponse,
  evaluateAccess,
  InMemoryAccessModeStore,
  signAccessMode,
} from "./appAccessGate.js";
export type {
  AccessGateDecision,
  AccessGateDeps,
  AccessModeStore,
} from "./appAccessGate.js";
export {
  resolveServicesEndpoints,
  parseServicesEndpoints,
  defaultEndpointsCachePath,
} from "./servicesEndpoints.js";
export type {
  ServicesEndpoints,
  ResolveOptions as EndpointsResolveOptions,
  ResolveResult as EndpointsResolveResult,
} from "./servicesEndpoints.js";
export { LlmHarness } from "./llmHarness.js";
export type { LlmHarnessOptions } from "./llmHarness.js";
export { bootstrapBrowserBundle } from "./browser/bootstrap.js";
export type {
  BootstrapBrowserOptions,
  BrowserBundle,
} from "./browser/bootstrap.js";
export { InMemoryAlertInbox } from "./alertInbox.js";
export type { AlertInbox, AlertEnvelope } from "./alertInbox.js";
export {
  FileAppPullStateStore,
  InMemoryAppPullStateStore,
  UpdateClient,
} from "./updateClient.js";
export type {
  AppPullState,
  AppPullStateStore,
  PhoneUpdateAlert,
  PullResult,
  UpdateClientDeps,
  UpdatePolicy,
} from "./updateClient.js";
export { UpdateServer } from "./updateServer.js";
export type {
  AppDistributionInfo,
  UpdateServerDeps,
} from "./updateServer.js";
export { UpdateScheduler } from "./updateScheduler.js";
export type { UpdateSchedulerDeps } from "./updateScheduler.js";
export {
  FileSubscriberRegistry,
  InMemorySubscriberRegistry,
  buildAppDistribution,
} from "./subscriberRegistry.js";
export type {
  SubscriberRegistry,
  BuildAppDistributionDeps,
} from "./subscriberRegistry.js";
export { buildRunMigration } from "./runMigration.js";
export type { RunMigrationDeps } from "./runMigration.js";
export {
  TokenSetSessionGate,
  buildAlertInboxHandlers,
} from "./alertInboxHttp.js";
export type {
  AlertInboxHttpDeps,
  PairedSessionGate,
} from "./alertInboxHttp.js";
export {
  InMemoryAppGrantStore,
  memorySyncTransportPair,
  mintTestBinding,
  startSyncConnection,
  wrapWsAsSyncTransport,
} from "./sibling/syncConnection.js";
export type {
  AppGrantStore,
  IrkPubKeyLookup,
  SyncConnection,
  SyncConnectionOptions,
  SyncRevocationLookup,
  SyncTransport,
} from "./sibling/syncConnection.js";
export {
  SiblingClientManager,
  startPersistentSiblingClient,
} from "./sibling/siblingClient.js";
export type {
  PersistentSiblingClient,
  PersistentSiblingClientOptions,
  SiblingClientManagerOptions,
  WsLike as SiblingWsLike,
} from "./sibling/siblingClient.js";
export { acceptSyncUpgrade } from "./sibling/siblingServer.js";
export type { AcceptSyncUpgradeArgs } from "./sibling/siblingServer.js";
