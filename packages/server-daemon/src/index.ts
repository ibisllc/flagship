import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ed,
  signServerRevokeBySelf,
  openSealedFromEd25519Recipient,
  verifyPhoneOrder,
  verifyRootEntitlement,
  type Keypair,
  type PhoneOrder,
  type ServerRevokeBySelf,
} from "@flagship/protocol";
import { InMemoryAlertInbox } from "./alertInbox.js";
import {
  buildAlertInboxHandlers,
} from "./alertInboxHttp.js";
import { buildAdminProxyHandler } from "./adminProxy.js";
import { startDaemonStatusHeartbeat } from "./daemonStatusHeartbeat.js";
import { BackupLoop } from "./backupLoop.js";
import { RepairScheduler } from "./peerBackup/repairScheduler.js";
import { RepairStatsAccumulator } from "./peerBackup/repairStatsAccumulator.js";
import { InMemoryAppInviteStore } from "./inviteHandler.js";
import { InMemoryCompanionTicketStore } from "./companion/companionTicketStore.js";
import { InMemoryCompanionWriteRequestStore } from "./companion/companionWriteRequestStore.js";
import { bootstrapBrowserBundle, type BrowserBundle } from "./browser/bootstrap.js";
import { buildCloneApp } from "./cloneService.js";
import { loadConfig, parseConfig, type ServerConfig } from "./config.js";
import {
  DeadManController,
  BootUnlockModeSuppressor,
  SystemctlPowerRunner,
  executeLockAndPower,
  type AutoUnlockSuppressor,
  type HostPowerRunner,
} from "./deadMan.js";
import { buildDeadManHttp, buildPowerHttp } from "./deadManHttp.js";
import { buildFrontPageHttp, FrontPageStore } from "./frontPage.js";
import { buildJournalHttp, JournalctlReader } from "./journalHttp.js";
import {
  buildAccessEnforcementHandler,
  buildRevocationPoller,
  buildServiceAccessHttp,
  ServiceAccessStore,
  ServiceSessionStore,
} from "./serviceAccess.js";
import { buildServiceAccessWeb } from "./serviceAccessWeb.js";
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
import {
  defaultRePairWatcherPath,
  RePairWatcher,
} from "./postRecovery/rePairWatcher.js";
import {
  defaultJournalPath,
  FileJournalStore,
  startJournalPruner,
} from "./postRecovery/fileJournalStore.js";
import { buildRunMigration } from "./runMigration.js";
import { buildScreensHttp } from "./screens/screensHttp.js";
import { buildScreensUpgradeHandler } from "./screens/screensWs.js";
import { VibeCodeSessionRegistry } from "./llm/vibeCodeSession.js";
import { buildVibeCodeHttpHandlers } from "./llm/vibeCodeHttp.js";
import { buildDeploySession } from "./llm/deploySession.js";
import { LlmHarness } from "./llmHarness.js";
import { FileBuildCredentialStore } from "./llm/buildCredentialStore.js";
import { buildVibeCodeStartStreaming, buildVibeCodeResumeStreaming } from "./llm/vibeCodeStartStreaming.js";
import { FileBuildJournal } from "./buildmodes/buildJournal.js";
import { FileMcpKeyStore } from "./buildmodes/mcpKeyStore.js";
import { GitImporter } from "./buildmodes/gitImport.js";
import { buildArtifactDeployer } from "./buildmodes/deployArtifact.js";
import { BuildOrchestrator } from "./buildmodes/buildOrchestrator.js";
import { buildBuildModesHttpHandlers } from "./buildmodes/buildModesHttp.js";
import { ForgejoAppAdmin } from "./forgejoServiceAdmin.js";
import type { ServicePlatform } from "./servicePlatform.js";
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
import {
  defaultEntitlementBundlePath,
  loadEntitlementBundle,
} from "./entitlementBundleStore.js";
import { claimEntitlementDeposit, fetchEntitlementViaRelay } from "./entitlementRelay.js";
import {
  buildSelfDeletePoller,
  fileMarkerStore,
  realWipeContent,
} from "./selfDeleteConsumer.js";
import { buildRehomePoller, readRehomeMarker } from "./transferRehomeConsumer.js";
import type { EntitlementBundle } from "./tunnel/tunnelClient.js";

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

/**
 * Fallback config source: derive the owner ServerConfig from the InstallBlob the
 * installer always writes to /var/flagship/install-blob.json. The normal burn
 * never wrote a FLAGSHIP_CONFIG file (only the demo cloud-init did), so without
 * this `cfg` was null on EVERY real box and the entire owner-signed HTTP API —
 * /api/orders-from-user (paired-session mint), /api/power, /api/journal,
 * /api/front-page, dead-man — 404'd (the cfg===null short-circuit). Every field
 * the config needs is in the blob: serverDomain, username, phoneDelegatedPubKey
 * (reused as bakPublicKey, exactly as the demo cloud-init does), and
 * authCode.userPubKey (the account IRK — the real owner-signing key). Fails
 * closed (returns null) on a missing/malformed blob.
 */
async function configFromInstallBlob(): Promise<ServerConfig | null> {
  const blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json";
  const raw = await tryReadFile(blobPath);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as {
      serverDomain?: unknown;
      username?: unknown;
      phoneDelegatedPubKey?: unknown;
      ownerAidPubHex?: unknown;
      authCode?: { userPubKey?: unknown };
    };
    const serverId = b.serverDomain;
    const userId = b.username;
    const bak = b.phoneDelegatedPubKey;
    const irk = b.authCode?.userPubKey;
    const isHex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
    if (typeof serverId !== "string" || typeof userId !== "string" || !isHex32(bak) || !isHex32(irk)) {
      return null;
    }
    const ownerAid = b.ownerAidPubHex;
    return {
      serverId,
      userId,
      bakPublicKey: hexToBytes(bak),
      irkPublicKey: hexToBytes(irk),
      ...(isHex32(ownerAid) ? { ownerAidPub: hexToBytes(ownerAid) } : {}),
    };
  } catch {
    return null;
  }
}

async function tryLoadConfig(): Promise<ServerConfig | null> {
  const path = process.env.FLAGSHIP_CONFIG;
  if (path) {
    try {
      return await loadConfig(path);
    } catch (e) {
      console.error(`[daemon] config load failed: ${(e as Error).message}; trying install-blob`);
      // fall through to the install-blob fallback
    }
  }
  const fromBlob = await configFromInstallBlob();
  if (fromBlob) {
    console.log("[daemon] owner config derived from /var/flagship/install-blob.json (no FLAGSHIP_CONFIG)");
  }
  return fromBlob;
}

/**
 * Create-time pairing claim. The CREATING phone deposited an owner-IRK-signed
 * `add-paired-session` order — SEALED for a phone-chosen PAIRING key whose
 * private half rides the recipe (`pairingKeyPrivHex`) — to .com the moment it
 * minted the recipe, BEFORE this box ever booted. The box's own identity key is
 * generated fresh at first boot (`gen-identity`), so the phone can't seal to it
 * at create; it seals to the pairing key it embeds in the recipe instead. This
 * is what makes "waiting for the server" survive a phone refresh: the sealed
 * link lives in .com until we claim it. On startup we do ONE public
 * consume-once read, unseal it (trying the recipe pairing key first, then our
 * identity key as a fallback for a post-registration re-pair), VERIFY the
 * owner-IRK signature + the canonical bytes, and add the session — so the box
 * comes online ALREADY paired, with no "Pair this server" tap. Best-effort +
 * non-fatal: any failure leaves the manual pairing path as the fallback.
 * Content-blind: .com only ever held the sealed blob (I1).
 */
async function consumePendingPairing(opts: {
  serverFqdn: string;
  controlPlaneBaseUrl: string;
  /** Candidate recipient private keys, in priority order: the recipe pairing
   * key first (the create-time seal target), then the box identity key (a
   * post-registration re-pair seals to identity). Each is a 32-byte Ed25519
   * seed; we try them until one opens the blob. */
  recipientPrivKeys: Uint8Array[];
  ownerIrkPub: Uint8Array;
  pairedSessions: FilePairedSessionStore;
}): Promise<void> {
  try {
    const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
    const url = `${base}/api/server/${encodeURIComponent(opts.serverFqdn)}/pairing-deposit`;
    const res = await fetch(url, { method: "GET" });
    if (res.status !== 200) return; // 404 ⇒ nothing pending (the common case)
    const body = (await res.json()) as { sealed?: unknown };
    if (typeof body.sealed !== "string") return;
    const sealed = hexToBytes(body.sealed);
    let plain: Uint8Array | null = null;
    for (const priv of opts.recipientPrivKeys) {
      try {
        plain = openSealedFromEd25519Recipient(sealed, priv);
        break;
      } catch {
        // wrong recipient key — try the next candidate
      }
    }
    if (!plain) {
      console.error("[daemon] pairing deposit: no recipient key could open the sealed blob — ignored");
      return;
    }
    const env = JSON.parse(new TextDecoder().decode(plain)) as {
      request?: PhoneOrder;
      signature?: string;
    };
    const order = env.request;
    if (!order || typeof env.signature !== "string") return;
    if (order.type !== "add-paired-session" || order.serverId !== opts.serverFqdn) return;
    if (!verifyPhoneOrder(order, hexToBytes(env.signature), opts.ownerIrkPub)) {
      console.error("[daemon] pairing deposit: owner-IRK signature did NOT verify — ignored");
      return;
    }
    await opts.pairedSessions.add(order.token, order.label);
    console.log("[daemon] claimed a create-time pairing deposit — paired on first boot");
  } catch (e) {
    console.error(`[daemon] consumePendingPairing failed (non-fatal): ${(e as Error).message}`);
  }
}

/**
 * Read the recipe's pairing private key (`pairingKeyPrivHex`) from the on-disk
 * install blob. The phone embeds it as an UNSIGNED recipe sibling (never in the
 * signed InstallBlob's canonical bytes, so existing recipe signatures are
 * untouched); the burner writes it into /var/flagship/install-blob.json. Used
 * ONLY to open the create-time pairing deposit. Returns null when absent/
 * malformed (older recipes, or a non-pairing burn) — the box then falls back to
 * its identity key, then to the manual pairing path.
 */
async function pairingKeyFromInstallBlob(): Promise<Uint8Array | null> {
  const blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json";
  const raw = await tryReadFile(blobPath);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as { pairingKeyPrivHex?: unknown };
    const v = b.pairingKeyPrivHex;
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/i.test(v)) return null;
    return hexToBytes(v);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let cfg = await tryLoadConfig();
  const env = envFromProcess();

  if (!env.serverFqdn || !env.identityPrivKeyHex) {
    console.error(
      "[daemon] Missing required inputs. Set FLAGSHIP_SUBDOMAIN + FLAGSHIP_IDENTITY_PRIV_HEX, " +
        "or supply FLAGSHIP_CONFIG with the same fields.",
    );
    process.exit(2);
  }

  // Transfer-a-box re-home (docs/account-deletion-and-name-reclaim.md §4, Layer
  // A). If a prior boot's poller observed an ownership transfer it persisted a
  // marker; apply it BEFORE anything reads the canonical / owner IRK so cert SANs
  // + entitlement load against the NEW namespace. Same identity key carries
  // forward; only the FQDN + owner IRK move. The acquirer IRK only becomes
  // load-bearing once a fresh acquirer-IRK-signed entitlement verifies under it.
  {
    const rehomeMarkerPath =
      process.env.FLAGSHIP_REHOME_MARKER ??
      `${process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship"}/transfer-rehome.json`;
    const marker = await readRehomeMarker(rehomeMarkerPath);
    if (marker && marker.newServerDomain !== env.serverFqdn.toLowerCase()) {
      console.log(
        `[daemon] re-home marker present: serving as ${marker.newServerDomain} ` +
          `(was ${env.serverFqdn}); owner → ${marker.acquirerUsername}`,
      );
      env.serverFqdn = marker.newServerDomain;
      if (cfg) {
        cfg = {
          ...cfg,
          userId: marker.acquirerUsername,
          irkPublicKey: hexToBytes(marker.acquirerIrkPubHex),
        };
      }
    }
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
  // constructed and toggled by phone orders.
  const swkHex =
    process.env.FLAGSHIP_SWK_HEX ?? (await tryReadFile("/var/flagship/swk.hex"));
  const { backupLoop, repairAccumulator, repairScheduler } =
    wirePeerBackup({ swkHex });

  // BFF in-memory ledgers (collaborator invites + companion-dock).
  const { appInviteStore, companionTicketStore, companionWriteRequestStore } =
    wireBffStores();

  // ---- Order serial (provisioning-status channel) ----
  // The InstallBlob's authCode.serial is the order id keying the
  // per-order install-progress timeline the phone polls
  // (POST /api/order/<serial>/status). The bootstrap (installer/install.sh
  // + the burner's userdata.ts) writes it to /var/flagship/auth-code-serial
  // on first boot and POSTs the install-time phases. The daemon picks it
  // up here to report the two phases only IT can know:
  //   `pairing` — entitlement bundle loaded (paired with the phone)
  //   `live`    — ACME cert landed + HTTPS is genuinely serving
  // Dev runs supply FLAGSHIP_ORDER_SERIAL directly. Trimmed + validated;
  // an absent/malformed serial just disables the daemon-side status
  // reporter (never fatal).
  const orderSerial = normalizeOrderSerial(
    process.env.FLAGSHIP_ORDER_SERIAL ??
      (await tryReadFile("/var/flagship/auth-code-serial")),
  );

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
  const alertInbox = new InMemoryAlertInbox();
  const browserBundle = await wireBrowserBundle({
    dataDir,
    alertInbox,
    pairedSessions,
  });

  // Lock & power-off + dead-man: one suppressor + one host-power runner,
  // shared by the manual `power-off` order and the dead-man timer so the
  // suppress-before-power ordering lives in one place.
  const autoUnlockSuppressor: AutoUnlockSuppressor = new BootUnlockModeSuppressor();
  const hostPowerRunner: HostPowerRunner = new SystemctlPowerRunner();

  // The orders endpoint verifies phone orders against a "phone signing key".
  // Historically that was a per-server delegated key persisted to
  // /var/flagship/psk.pub.hex — but the phone discards its private half AND the
  // installer never writes the file, so on a real box the endpoint was
  // permanently disabled (no paired sessions ⇒ the /api/screens/* BFF 401s ⇒
  // the app's server pages never load). The phone + webapp actually sign owner
  // orders (add-paired-session, …) with the OWNER IRK, so fall the verification
  // key back to the config-pinned owner IRK — the same root authority that
  // /api/power, /api/journal, and /api/front-page already verify against. This
  // is what lets a real box mint the paired session its BFF needs.
  const ordersVerifyPub: Uint8Array | null = pskPubHex
    ? hexToBytes(pskPubHex.trim())
    : cfg
      ? cfg.irkPublicKey
      : null;
  const orders = ordersVerifyPub
    ? {
        pskPub: ordersVerifyPub,
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
  // The ServicePlatform isn't built until startDaemonRuntime resolves, but
  // the update-pack closures (runMigration, restartContainer) and the
  // front-page label resolver must reference it. This ref-cell is the
  // two-phase-init seam: created null here, back-patched to the live
  // platform right after the runtime is up (see below). Keep it owned by
  // main() so every late-binding consumer shares the SAME cell.
  const servicePlatformRefForServer: { current: ServicePlatform | null } = {
    current: null,
  };
  const {
    pullStateStore,
    updateServer,
    updateClient,
    updateScheduler,
    cloneService,
  } = wireUpdatePack({
    env: env as RuntimeEnv,
    dataDir,
    identityKeypair,
    subscriberRegistry,
    alertInbox,
    servicePlatformRef: servicePlatformRefForServer,
  });

  // ---- Phone-pollable AlertInbox HTTP + admin proxy + identity rotate ----
  const additionalHandlers = wirePreRuntimeHandlers({
    dataDir,
    alertInbox,
    pairedSessions,
    browserBundle,
  });

  // Provisioning-STATUS reporter — the SINGLE canonical channel the phone
  // polls (POST /api/order/<serial>/status).
  const reportStatus = buildStatusReporter({
    orderSerial,
    controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
  });

  // ---- Entitlement bundle (REQUIRED to start the tunnel client) ----
  // Loads (or relays-then-loads) the IRK-signed entitlement; on any failure
  // it reports the terminal `error` phase and exits — same behavior as the
  // inline try/catch it replaces.
  const entitlementBundle = await loadEntitlementsOrExit({
    env: env as RuntimeEnv,
    cfg,
    dataDir,
    identityKeypair,
    reportStatus,
  });

  // Signed daemon-status heartbeat — populates `daemon_status` with REAL cert
  // info + a fresh heartbeat so /pods shows true current liveness (the proper
  // fix for the "never came online" regression; the /pods provision-status
  // bridge is the fallback when this hasn't run yet). Fired from onCertIssued
  // (first report the instant the cert lands) + periodically thereafter.
  const statusHeartbeat = startDaemonStatusHeartbeat({
    serverDomain: env.serverFqdn!,
    identity: identityKeypair,
    controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
  });

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
      entitlements: () => entitlementBundle,
      // The cert has landed and HTTPS is genuinely serving — the real
      // "your server is live" moment. Report it ONCE on the single canonical
      // channel (idempotent: only the first cert/renewal POSTs `live`). Cert
      // acquisition is async + retried in-process (the daemon stays up across
      // transient ACME failures rather than process.exit-ing), so `live` is
      // gated here on the cert actually landing — not when startDaemonRuntime
      // resolves (which happens BEFORE the first cert attempt).
      onCertIssued: (cert, notAfter, names) => {
        void reportStatus("live");
        // Feed the signed daemon-status heartbeat with the freshly-issued
        // cert so /pods gets REAL fingerprint/validity/issuer + a fresh
        // lastReported (true liveness), fired immediately + on renewals.
        statusHeartbeat.update(cert, notAfter, names);
      },
      // Fine-grained ACME observability stays in the daemon log only — it is
      // NOT its own UI vocabulary on the canonical channel (the `sealing`/
      // `live` window covers it for the phone). Pass an optional detail string
      // through on the (still un-`live`) sealing window so a stuck cert is
      // locatable, without minting a new phase. `reportStatus` is idempotent
      // per phase, so this only refreshes the detail until `live` lands.
      onAcmePhase: (phase) => {
        if (typeof phase === "string" && phase.length > 0) {
          void reportStatus("sealing", `acme: ${phase}`.slice(0, 280));
        }
      },
      // An ACME attempt failed — the runtime backs off + retries IN-PROCESS
      // (the box stays up so LE can reach it for TLS-ALPN-01 and DNS-01 has
      // time to propagate). Surface the real cause as the terminal canonical
      // `error` phase so the phone shows it, but DO NOT exit.
      onCertAttemptFailed: (attempt, error) => {
        void reportStatus("error", `acme attempt ${attempt}: ${error}`.slice(0, 280));
      },
      orders,
      servicePlatform: {
        // Construct the ServicePlatform (the services / build / deploy / screens
        // / vibe surfaces) when the box has its owner identity AND a sealing key.
        // host{username,irkPub} come from the persisted config; the SWK from
        // FLAGSHIP_SWK_HEX / /var/flagship/swk.hex. ALL THREE are required by the
        // runtime gate — previously NONE were passed, so the platform never
        // constructed on any box (GET /api/services → 503). A box without a
        // config or an SWK still runs platform-less (unchanged), so this only
        // turns the platform ON where those inputs exist.
        hostUsername: cfg?.userId,
        hostIrkPub: cfg?.irkPublicKey,
        // The box's own daemon identity keypair — accepted as an ADDITIVE
        // host-authority signer so a box-originated build-modes deploy
        // (which signs installs with this key, since the owner IRK private
        // half is phone-held) is accepted by ServicePlatform.install. The
        // phone-signed install path still verifies the owner IRK.
        hostIrk: identityKeypair,
        swk: swkHex ? hexToBytes(swkHex.trim()) : undefined,
        // The data-services compose stack writes its admin creds here on
        // first boot. If it's missing, the runtime degrades gracefully:
        // apps declaring `data.stores` will refuse to install with a
        // clear error, but apps without data are unaffected.
        dataServicesEnvFile: process.env.FLAGSHIP_DATA_SERVICES_ENV ?? "/var/flagship/data-services.env",
        appAuthTokens: browserBundle?.appAuthTokens,
        domainGate: browserBundle?.domainGate,
        tabRegistry: browserBundle?.tabRegistry,
        pullStateStore,
        cloneService,
      },
      additionalHandlers,
      updateServer,
    });
    servicePlatformRefForServer.current = runtime.servicePlatform;
    if (orders) {
      console.log(
        `[daemon] orders-from-user endpoint enabled (verify key: ${pskPubHex ? "psk.pub.hex" : "owner IRK"})`,
      );
    } else console.log(`[daemon] no owner IRK / psk; orders endpoint disabled`);

    // Create-time pairing: claim any sealed add-paired-session the creating
    // phone left in .com before this box booted, so we come online ALREADY
    // paired (no manual "Pair this server" tap). Fire-and-forget + best-effort;
    // never blocks bring-up. Needs the owner IRK (cfg) to verify the order.
    if (cfg) {
      void (async () => {
        const pairingKey = await pairingKeyFromInstallBlob();
        await consumePendingPairing({
          serverFqdn: env.serverFqdn!,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
          // Recipe pairing key first (the create-time seal target), box
          // identity second (a post-registration re-pair seals to identity).
          recipientPrivKeys: pairingKey ? [pairingKey, identityPrivKey] : [identityPrivKey],
          ownerIrkPub: cfg.irkPublicKey,
          pairedSessions,
        });
      })();
    }
    console.log(
      `[daemon] tunnel online for ${env.serverFqdn}; ACME issuance running in-process (cert installs asynchronously)`,
    );
    // startDaemonRuntime now resolves once the tunnel is connected and the
    // local API + TLS server are serving — BEFORE the first ACME attempt
    // (cert acquisition is async + retried so a transient ACME failure can't
    // take the box down). The tunnel-online milestone is no longer its own UI
    // phase: the canonical channel already shows `pairing` (entitlement loaded)
    // and advances to `live` from `onCertIssued` once the cert lands.

    // Wire vibe-code + build-modes + the /api/screens/* BFF + the re-pair
    // watcher onto the live runtime (servicePlatform / appBackup /
    // urlController are now populated). These share a dense web of locals
    // (the vibe registry, build journal, BYOK harness/credentials, the
    // deploy session), so they're wired as ONE cohesive unit rather than
    // threading ~15 values through separate builders. Also starts the
    // update-pack scheduler. Same order + side effects as before.
    await wireRuntimeSurfaces({
      runtime,
      cfg,
      env: env as RuntimeEnv,
      dataDir,
      swkHex,
      identityKeypair,
      pairedSessions,
      browserBundle,
      alertInbox,
      backupLoop,
      repairAccumulator,
      appInviteStore,
      companionTicketStore,
      companionWriteRequestStore,
      pullStateStore,
      updateClient,
      updateScheduler,
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error(`[daemon] runtime startup failed: ${(e as Error).stack ?? e}`);
    // Surface the terminal failure to the phone on the single canonical
    // channel before exiting; the detail carries the real cause. Await briefly
    // so the POST has a chance to land before exit.
    await reportStatus("error", `startup: ${msg}`.slice(0, 280));
    process.exit(1);
  }

  // ---- Owner-IRK handlers: dead-man + power + front-page + journal ----
  // Production-only (needs cfg.irkPublicKey). No enabled dead-man policy ⇒
  // no timer, no behavior change. Mounts onto the live runtime + arms the
  // dead-man SIGTERM/SIGINT stop hooks.
  await wireOwnerHandlers({
    runtime,
    cfg,
    env: env as RuntimeEnv,
    autoUnlockSuppressor,
    hostPowerRunner,
    servicePlatformRef: servicePlatformRefForServer,
    identityKeypair,
  });

  // ---- Bring up the daemon-local HTTP API (phone/loopback only) ----
  await wireLocalHttpApi({ cfg });

  // ---- Graceful-shutdown hooks (browser bundle + schedulers) ----
  wireShutdownHooks({ browserBundle, updateScheduler, repairScheduler });

  // Stay alive forever (tunnel client + TLS server are event-driven and
  // hold the event loop on their own).
  await runtime.ready();
}

// ===========================================================================
// wire*() builders — main() is the readable sequence of these calls. Each
// builder owns one cohesive subsystem, takes exactly the deps it needs, and
// returns the typed bundle it produces. They are called in main()'s original
// order with identical side effects; this is a pure decomposition.
// ===========================================================================

/** Late-binding cell for the ServicePlatform (built only once the runtime is up). */
type ServicePlatformRef = { current: ServicePlatform | null };

interface PeerBackupBundle {
  backupLoop: BackupLoop | null;
  repairAccumulator: RepairStatsAccumulator;
  repairScheduler: RepairScheduler;
}

/**
 * Peer-backup participation: the encrypting BackupLoop (only when an SWK is
 * available) + the B4 repair accumulator/scheduler. The scheduler is started
 * here (idempotent no-op today with daemon=null) exactly as before — the wire
 * site is in place for the upstream RepairDaemon to flip on later.
 */
function wirePeerBackup(deps: { swkHex: string | null }): PeerBackupBundle {
  const backupLoop = deps.swkHex
    ? new BackupLoop({ swk: hexToBytes(deps.swkHex.trim()), k: 3, n: 5 })
    : null;

  const repairAccumulator = new RepairStatsAccumulator();
  const repairTickMs = (() => {
    const raw = process.env.FLAGSHIP_REPAIR_TICK_MS;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1_000 ? n : undefined;
  })();
  const repairScheduler = new RepairScheduler({
    accumulator: repairAccumulator,
    daemon: null,
    ...(repairTickMs !== undefined ? { intervalMs: repairTickMs } : {}),
  });
  // Idempotent no-op today (daemon=null). Once the upstream wires a real
  // RepairDaemon and calls repairScheduler.setDaemon(daemon), a subsequent
  // .start() will arm the interval.
  repairScheduler.start();

  return { backupLoop, repairAccumulator, repairScheduler };
}

interface BffStores {
  appInviteStore: InMemoryAppInviteStore;
  companionTicketStore: InMemoryCompanionTicketStore;
  companionWriteRequestStore: InMemoryCompanionWriteRequestStore;
}

/**
 * The in-memory BFF ledgers that the Screens-BFF (and, when wired, the signed
 * surfaces) share: P6 collaborator invites + P14 companion-dock tickets +
 * P14-Phase-2 write-relay queue. Each must be a single shared instance.
 */
function wireBffStores(): BffStores {
  return {
    appInviteStore: new InMemoryAppInviteStore(),
    companionTicketStore: new InMemoryCompanionTicketStore(),
    companionWriteRequestStore: new InMemoryCompanionWriteRequestStore(),
  };
}

/**
 * The optional pod-resident browser bundle. The compose stack publishes
 * Chromium's CDP on 127.0.0.1:9222; if the daemon can reach it we wire the
 * full browser surface, otherwise the daemon still boots and apps without
 * `browser.domains` are unaffected (they get 403). Returns null when disabled
 * or unreachable. The teardown hook is registered separately on exit.
 */
async function wireBrowserBundle(deps: {
  dataDir: string;
  alertInbox: InMemoryAlertInbox;
  pairedSessions: FilePairedSessionStore;
}): Promise<BrowserBundle | null> {
  const cdpEndpoint = process.env.FLAGSHIP_CHROMIUM_CDP ?? "http://127.0.0.1:9222";
  if (process.env.FLAGSHIP_DISABLE_BROWSER === "1") return null;
  try {
    const bundle = await bootstrapBrowserBundle({
      cdpEndpoint,
      dataDir: deps.dataDir,
      alertInbox: deps.alertInbox,
      pairedSessionGate: deps.pairedSessions,
    });
    console.log(`[daemon] browser bundle online (CDP ${cdpEndpoint})`);
    return bundle;
  } catch (e) {
    console.warn(
      `[daemon] browser bundle disabled: ${(e as Error).message}; ` +
        `apps with browser.domains will get 403`,
    );
    return null;
  }
}

interface UpdatePackBundle {
  pullStateStore: FileAppPullStateStore;
  updateServer: UpdateServer;
  updateClient: UpdateClient;
  updateScheduler: UpdateScheduler;
  cloneService: ReturnType<typeof buildCloneApp>;
}

/**
 * Update-pack distribution wiring: the per-app working-dir resolver, the pull
 * state store, the UpdateServer (serves packs to subscribers), the clone
 * service, and the UpdateClient/UpdateScheduler (pulls packs from canonical
 * homes). The runMigration + restartContainer closures read the live
 * ServicePlatform through the shared `servicePlatformRef` (back-patched once
 * the runtime is up). The scheduler is NOT started here — main() starts it
 * after the runtime is reachable, exactly as before.
 */
function wireUpdatePack(deps: {
  env: RuntimeEnv;
  dataDir: string;
  identityKeypair: Keypair;
  subscriberRegistry: FileSubscriberRegistry;
  alertInbox: InMemoryAlertInbox;
  servicePlatformRef: ServicePlatformRef;
}): UpdatePackBundle {
  const { env, dataDir, identityKeypair, subscriberRegistry, alertInbox } = deps;
  const appCloneRoot = join(dataDir, "data", "app-clones");
  const appWorkingDir = (serviceId: string) => join(appCloneRoot, serviceId);
  const pullStateStore = new FileAppPullStateStore(join(dataDir, "data", "app-state"));
  // Forgejo-backed app repos live under /var/flagship/data/forgejo/git/<host>/<slug>.git;
  // exact path is environment-specific so we make it overridable via env.
  const repoRoot =
    process.env.FLAGSHIP_REPO_ROOT ?? join(dataDir, "data", "forgejo", "git");
  const updateServer = new UpdateServer({
    appDistribution: buildAppDistribution({
      // Platform isn't strictly used by buildAppDistribution beyond its
      // type; the closure supplies the per-app repo path.
      platform: undefined as unknown as ServicePlatform,
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
          `${env.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/server/by-domain/${encodeURIComponent(fqdn)}`,
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

  const cloneService = buildCloneApp({
    identity: identityKeypair,
    pullerServerId: env.serverFqdn,
    appWorkingDir,
  });
  const runMigration = buildRunMigration({
    serviceByServiceId: (serviceId) =>
      deps.servicePlatformRef.current?.byServiceId(serviceId) ?? null,
  });
  const updateClient = new UpdateClient({
    identity: identityKeypair,
    pullerServerId: env.serverFqdn,
    state: pullStateStore,
    appWorkingDir,
    runMigration,
    restartContainer: async (serviceId) => {
      const ap = deps.servicePlatformRef.current;
      const app = ap?.byServiceId(serviceId);
      // AppRunner uses docker; restarting the named container is enough.
      // We don't tear down the ServicePlatform record because the install
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
    onResult: (serviceId, r) => console.log(`[update-pack] ${serviceId} → ${r.kind}`),
    onError: (serviceId, e) => console.warn(`[update-pack] ${serviceId} threw: ${e.message}`),
  });

  return { pullStateStore, updateServer, updateClient, updateScheduler, cloneService };
}

/**
 * The pre-runtime loopback handlers (phone-pollable AlertInbox + admin proxy +
 * identity-rotate), assembled in the original push order into the
 * `additionalHandlers` array that startDaemonRuntime mounts. The browser
 * bundle's API handler goes first when present.
 */
function wirePreRuntimeHandlers(deps: {
  dataDir: string;
  alertInbox: InMemoryAlertInbox;
  pairedSessions: FilePairedSessionStore;
  browserBundle: BrowserBundle | null;
}): Array<(req: HttpRequest) => Promise<HttpResponse | null>> {
  const alertInboxHandle = buildAlertInboxHandlers({
    inbox: deps.alertInbox,
    gate: deps.pairedSessions,
  });
  const adminProxyHandle = buildAdminProxyHandler({ gate: deps.pairedSessions });
  const identityRotateHandle = buildIdentityRotateHandlers({
    gate: deps.pairedSessions,
    pendingPath: defaultPendingIdentityPath(deps.dataDir),
  });

  const additionalHandlers: Array<(req: HttpRequest) => Promise<HttpResponse | null>> = [];
  if (deps.browserBundle) additionalHandlers.push(deps.browserBundle.apiHandle);
  additionalHandlers.push(alertInboxHandle);
  additionalHandlers.push(adminProxyHandle);
  additionalHandlers.push(identityRotateHandle);
  return additionalHandlers;
}

/** The reporter closure for the per-order provision-status channel. */
type StatusReporter = (phase: ProvisionStatusPhase, detail?: string) => void | Promise<void>;

/**
 * Provisioning-STATUS reporter — the SINGLE canonical channel the phone polls
 * (POST /api/order/<serial>/status). The box bootstrap reports the install-time
 * phases (booting → … → sealing); the daemon adds the two only it can know —
 * `pairing` (entitlement loaded) and `live` (cert serving) — plus the terminal
 * `error`. Best-effort + idempotent (one POST per phase — repeats for an
 * already-reported phase are dropped so renewals/retries don't spam .com).
 * Disabled (a no-op) when no serial was baked through.
 */
function buildStatusReporter(deps: {
  orderSerial: string | null;
  controlPlaneBaseUrl: string;
}): StatusReporter {
  const reportedStatusPhases = new Set<string>();
  return (phase: ProvisionStatusPhase, detail?: string) => {
    if (!deps.orderSerial) return;
    if (reportedStatusPhases.has(phase)) return;
    reportedStatusPhases.add(phase);
    return reportProvisionStatus({
      serial: deps.orderSerial,
      controlPlaneBaseUrl: deps.controlPlaneBaseUrl,
      phase,
      ...(detail !== undefined ? { detail } : {}),
    });
  };
}

/**
 * Load (or relay-then-load) the IRK-signed entitlement bundle REQUIRED to start
 * the tunnel client. If none is on disk and we know the owner IRK (cfg), ask the
 * phone via the blind mailbox; any relay failure falls through to whatever
 * exists on disk. Validates podCanonical + podPubKey against this server.
 * On any failure it reports the terminal `error` phase and process.exit(1)s —
 * identical to the inline try/catch it replaces. On success reports `pairing`.
 */
async function loadEntitlementsOrExit(deps: {
  env: RuntimeEnv;
  cfg: ServerConfig | null;
  dataDir: string;
  identityKeypair: Keypair;
  reportStatus: StatusReporter;
}): Promise<EntitlementBundle> {
  const { env, cfg, dataDir, identityKeypair, reportStatus } = deps;
  const entitlementBundlePath =
    process.env.FLAGSHIP_ENTITLEMENTS_PATH ?? defaultEntitlementBundlePath(dataDir);
  try {
    let loaded = await loadEntitlementBundle(entitlementBundlePath);

    // Self-heal: an on-disk bundle is only usable if its RootEntitlement is
    // signed by the OWNER IRK — the production hub verifies exactly this at
    // tunnel HELLO (irkLookup) and rejects anything else. A self-signed/stale
    // bundle would otherwise crash-loop forever with no recovery on a
    // shell-less production box. We hold the owner IRK (cfg.irkPublicKey), so
    // run the hub's check locally: if it fails, DISCARD the bundle and fall
    // through to the phone relay below to fetch a real IRK-signed one. (When
    // cfg is absent — demo/gym — we can't verify, so we present as-is, the
    // legacy behavior.)
    if (
      loaded &&
      cfg &&
      !verifyRootEntitlement(loaded.rootEntitlement, loaded.rootEntitlementSig, cfg.irkPublicKey)
    ) {
      console.warn(
        "[daemon] on-disk entitlement is not signed by the owner IRK (the hub would reject it at HELLO); discarding and requesting one from the phone",
      );
      loaded = null;
    }

    // Entitlement-via-relay (docs/security-phone-as-unlock-endpoint.md §4).
    // If no bundle is on disk, ask the user's phone — through `.com`'s blind
    // mailbox — to IRK-sign a RootEntitlement for this freshly-burned box,
    // instead of relying on a self-signed credential. We can only do this
    // when we know the owner IRK (baked into FLAGSHIP_CONFIG); without it we
    // can't verify the relay reply, so we skip straight to the fallback.
    // ANY relay failure (timeout, no reply, forged/mismatched carrier) falls
    // through to whatever already exists on disk — never a brick.
    if (!loaded && cfg) {
      // FIRST, claim a phone-DEPOSITED entitlement. The phone pre-deposits an
      // IRK-signed entitlement for this box's STK at the moment it approves the
      // first-boot unlock, so an encrypted box comes online with a SINGLE owner
      // approval. Only if there is no deposit do we issue a relay request.
      const deposited = await claimEntitlementDeposit({
        serverDomain: env.serverFqdn,
        ownerIrkPub: cfg.irkPublicKey,
        stkPub: identityKeypair.publicKey,
        controlPlaneBaseUrl: env.controlPlaneBaseUrl,
        entitlementBundlePath,
        onLog: (m) => console.log(m),
      });
      if (deposited) {
        loaded = deposited;
      } else {
        console.log(
          `[daemon] no deposited entitlement; requesting one from the phone via ${env.controlPlaneBaseUrl} (awaiting-entitlement)`,
        );
        // The awaiting-entitlement handoff is covered by the `pairing` status
        // report fired once the bundle loads below — no separate UI phase.
        const relayed = await fetchEntitlementViaRelay({
          serverDomain: env.serverFqdn,
          identity: identityKeypair,
          ownerIrkPub: cfg.irkPublicKey,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl,
          entitlementBundlePath,
          onLog: (m) => console.log(m),
        });
        if (relayed) {
          loaded = relayed;
        } else {
          // Re-read in case a concurrent provisioner (a phone PhoneOrders
          // delivery) wrote one while we waited.
          loaded = await loadEntitlementBundle(entitlementBundlePath);
        }
      }
    }

    if (!loaded) {
      throw new Error(
        `entitlement bundle not found at ${entitlementBundlePath}; ` +
          `the provisioner (phone relay / demo cloud-init bootstrap) must mint + write it before the daemon can serve`,
      );
    }
    // Defense-in-depth: the bundle's podCanonical must be this server,
    // and its podPubKey must equal our identity pubkey — otherwise the
    // hub will reject the HELLO ("STK pubkey mismatches podPubKey") and
    // we'd crash-loop with a confusing error. Catch it here instead.
    if (loaded.rootEntitlement.podCanonical.toLowerCase() !== env.serverFqdn.toLowerCase()) {
      throw new Error(
        `entitlement bundle podCanonical (${loaded.rootEntitlement.podCanonical}) does not match FLAGSHIP_SUBDOMAIN (${env.serverFqdn})`,
      );
    }
    const ourPubHex = bytesToHexLocal(identityKeypair.publicKey);
    const bundlePubHex = bytesToHexLocal(loaded.rootEntitlement.podPubKey);
    if (ourPubHex !== bundlePubHex) {
      throw new Error(
        `entitlement bundle podPubKey (${bundlePubHex.slice(0, 16)}…) does not match server identity (${ourPubHex.slice(0, 16)}…)`,
      );
    }
    console.log(
      `[daemon] loaded entitlement bundle for ${loaded.rootEntitlement.podCanonical} ` +
        `(${loaded.serviceEntitlement ? `${loaded.serviceEntitlement.canonicals.length} service canonicals` : "root-only"})`,
    );
    // Pairing handoff complete — the box now holds the phone's IRK-signed
    // entitlement, so it's paired. Tell the per-order status channel so the
    // phone's timeline advances past `sealing`. Best-effort.
    void reportStatus("pairing");
    return loaded;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error(`[daemon] entitlement bundle load failed: ${msg}`);
    await reportStatus("error", `entitlements: ${msg}`.slice(0, 280));
    process.exit(1);
  }
}

/**
 * Wire vibe-code + build-modes + the /api/screens/* BFF + the J.3/J.4 re-pair
 * watcher onto the live runtime, and start the update-pack scheduler. These
 * share a dense web of locals (the vibe registry, build journal, BYOK
 * harness/credentials, the deploy session, the rePairWatcherRef forward ref)
 * so they live as ONE cohesive builder rather than threading ~15 values through
 * separate functions. Construction order + side effects are identical to the
 * original inline block.
 */
async function wireRuntimeSurfaces(deps: {
  runtime: DaemonRuntime;
  cfg: ServerConfig | null;
  env: RuntimeEnv;
  dataDir: string;
  swkHex: string | null;
  identityKeypair: Keypair;
  pairedSessions: FilePairedSessionStore;
  browserBundle: BrowserBundle | null;
  alertInbox: InMemoryAlertInbox;
  backupLoop: BackupLoop | null;
  repairAccumulator: RepairStatsAccumulator;
  appInviteStore: InMemoryAppInviteStore;
  companionTicketStore: InMemoryCompanionTicketStore;
  companionWriteRequestStore: InMemoryCompanionWriteRequestStore;
  pullStateStore: FileAppPullStateStore;
  updateClient: UpdateClient;
  updateScheduler: UpdateScheduler;
}): Promise<void> {
  const {
    runtime,
    cfg,
    env,
    dataDir,
    swkHex,
    identityKeypair,
    pairedSessions,
    browserBundle,
    alertInbox,
    backupLoop,
    repairAccumulator,
    appInviteStore,
    companionTicketStore,
    companionWriteRequestStore,
    pullStateStore,
    updateClient,
    updateScheduler,
  } = deps;

  // Wire vibe-code (legacy /api/llm/sessions) + the BFF /api/screens/*
  // surface now that runtime.servicePlatform / appBackup / urlController
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
  const username = cfg?.userId ?? env.serverFqdn.split(".")[1] ?? "user";

  // The shared build journal — written by every mode (scratch / git /
  // mcp). Hoisted above the vibe-code wiring so scratch chat turns +
  // attachments land in the SAME journal the git/mcp paths use (buildId
  // = the vibe sessionId). Value-free: a short text preview + per-
  // attachment NAME/kind/size summaries, never the content/base64.
  const buildJournal = new FileBuildJournal(join(dataDir, "build-journals"));
  const recordScratchTurn = (a: {
    sessionId: string;
    text: string;
    attachmentSummaries: string[];
  }): void => {
    const preview = a.text.length > 120 ? `${a.text.slice(0, 117)}…` : a.text;
    void buildJournal
      .append(a.sessionId, {
        mode: "scratch",
        kind: "user-message",
        actor: "owner",
        summary: preview.length > 0 ? preview : "(no text)",
      })
      .catch(() => {});
    for (const summary of a.attachmentSummaries) {
      void buildJournal
        .append(a.sessionId, {
          mode: "scratch",
          kind: "attachment-added",
          actor: "owner",
          summary,
        })
        .catch(() => {});
    }
  };
  // ---- Live BYOK LLM wiring (scratch streaming + git-adapt) ----------
  //
  // The harness holds NO key — it opens a transient, sealed-at-rest
  // credential just-in-time for each provider call. The credential
  // arrives over the paired-session-gated pinned pipe (the box
  // terminates TLS) and NEVER leaves the box; flagshipserver.com is not
  // in this path. The credential store survives a daemon restart so an
  // in-flight build continues while the phone is locked (the owner's
  // endorsed "transient key on the box" posture). The strict default
  // baseUrlGuard (https + public only) applies; an explicit `baseUrl`
  // for an OpenAI-compatible / proxy endpoint is allowed by the guard's
  // normal public-host rules. (LAN baseUrl override is a future
  // self-host item, not enabled here.)
  const llmHarness = new LlmHarness({
    swk: swkHex ? hexToBytes(swkHex.trim()) : new Uint8Array(32),
  });
  const llmCredentials = new FileBuildCredentialStore(
    join(dataDir, "llm-credentials"),
    swkHex ? hexToBytes(swkHex.trim()) : new Uint8Array(32),
  );
  await llmCredentials.load();
  const defaultLlmModel =
    process.env.FLAGSHIP_LLM_DEFAULT_MODEL ?? "claude-3-5-sonnet-latest";

  const deploySession = runtime.servicePlatform
    ? buildDeploySession({
        servicePlatform: runtime.servicePlatform,
        hostIrk: identityKeypair,
        hostUsername: username,
        workingDir: vibeAppDir,
        cmd: (await import("./serviceRunner.js")).realCommandRunner,
        forgejoAdmin,
      })
    : undefined;
  const vibeCodeHandle = buildVibeCodeHttpHandlers({
    registry: vibeRegistry,
    gate: pairedSessions,
    username,
    serverFqdn: env.serverFqdn,
    deploySession,
    recordScratchTurn,
    // Resume-after-reply is wired below where the streaming thunks are built
    // (the screens BFF reply path carries it); see `vibeCode.resumeStreaming`.
    // The legacy /api/llm/sessions surface is not the phone's path.
  });
  runtime.addHandler(vibeCodeHandle);

  // W10 — fire a notify-owner callback whenever a vibe-code session
  // transitions into awaiting-tool-response. The default impl logs
  // (operator-visible) so the chain is provably wired; production
  // deployments that integrate with .com's push relay replace this
  // hook with a real fan-out (POST `<controlPlane>/api/push/relay`
  // with a category of "vibecode-needs-you"). The callback is
  // value-free by construction — it receives only the session id,
  // the tool kind, and the tool-use id. No model arguments, no env
  // values, no chat messages.
  vibeRegistry.setNotifyOwner(({ sessionId, kind, toolUseId }) => {
    // eslint-disable-next-line no-console
    console.log(
      `[vibecode] session=${sessionId} tool=${kind} toolUseId=${toolUseId} ` +
        `→ owner-notify hook fired (push fan-out wiring is operator-supplied)`,
    );
    // #91 — queue a value-free AI-chat alert on the SAME phone-pollable
    // AlertInbox the rest of the daemon→phone events ride. The phone's
    // foreground long-poll (GET /api/phone/alerts) drains it, raises a
    // LOCAL notification, and surfaces the session in the operations sliver
    // with a deep link into the chat. This is the always-on baseline; the
    // optional push relay below is an additional (operator-supplied) wake.
    alertInbox.emit({
      kind: "ai-chat-needs-you",
      serviceId: sessionId,
      request: kind,
      toolUseId,
    });
  });

  // ---- Build modes: git import + MCP (the two new create-service
  // sources beyond scratch). They share ONE journal with scratch so the
  // "your builds" list + the journal viewer span every mode. The deploy
  // path is the same artifact deployer (harness-only Forgejo push,
  // docker build, signed install) all modes funnel through.
  if (runtime.servicePlatform) {
    const mcpSwk = swkHex ? hexToBytes(swkHex.trim()) : new Uint8Array(32);
    const mcpKeys = new FileMcpKeyStore(join(dataDir, "mcp-keys"), mcpSwk);
    await mcpKeys.load();
    const realCmd = (await import("./serviceRunner.js")).realCommandRunner;
    const gitImporter = new GitImporter({
      cmd: realCmd,
      workingDir: join(dataDir, "data", "git-imports"),
      journal: buildJournal,
    });
    const artifactDeployer = buildArtifactDeployer({
      servicePlatform: runtime.servicePlatform,
      hostIrk: identityKeypair,
      hostUsername: username,
      workingDir: vibeAppDir,
      cmd: realCmd,
      forgejoAdmin,
      journal: buildJournal,
    });
    const buildOrchestrator = new BuildOrchestrator({
      journal: buildJournal,
      gitImporter,
      mcpKeys,
      deployArtifact: artifactDeployer,
      serverFqdn: env.serverFqdn,
      mcpBaseUrl: `https://${env.serverFqdn}`,
      // AI "adapt" pass for non-fit git imports — LIVE. One non-streaming
      // provider chat call (the harness opens the build's transient,
      // sealed BYOK credential just-in-time, applies the SSRF baseUrl
      // guard, and returns the raw assistant text in the emit-format the
      // VibeCodeStreamParser reads). The credential is keyed by buildId
      // in the same store the scratch path uses; the owner delivers it
      // over the pinned pipe. When NO credential is stored for the build,
      // this resolves to undefined-equivalent: the runner throws and the
      // orchestrator surfaces the clean "AI adapt not configured" 503 —
      // exactly the genuine no-credential case the contract calls for.
      // flagshipserver.com is never in this path.
      adaptRunner: async ({ buildId, systemPrompt, userPrompt, model }) => {
        const credential = await llmCredentials.get(buildId);
        if (!credential) {
          // Defensive — adaptCredentialAvailable below already
          // short-circuits this case into the clean 503.
          throw new Error("AI adapt not configured");
        }
        const resp = await llmHarness.chatWithCredential(credential, {
          model: model ?? defaultLlmModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });
        return resp.content;
      },
      // ⭐ The AGENTIC adapt path (the product bar). A provider-agnostic
      // tool-calling chat runner the loop drives over the SHARED build tool
      // surface (read_file → write_file → validate → deploy) until the app
      // deploys. The build's transient sealed BYOK credential is opened
      // just-in-time per call (same store the scratch path uses); the
      // request carries the tool specs, and the credential's provider must
      // support tool-calling (anthropic / openai / google / openrouter do —
      // ollama degrades to the legacy single-shot pass it can't tool-drive).
      // flagshipserver.com is never in this path. `adaptCredentialAvailable`
      // above already gates the genuine no-credential case to the clean 503.
      agentRunner: async (buildId, req) => {
        const credential = await llmCredentials.get(buildId);
        if (!credential) throw new Error("AI adapt not configured");
        return llmHarness.chatWithCredential(credential, {
          ...req,
          model: req.model && req.model.length > 0 ? req.model : defaultLlmModel,
        });
      },
      // The genuine no-credential case: a build for which the owner
      // never delivered a BYOK key degrades to the same clean 503 as
      // the provider-not-wired case.
      adaptCredentialAvailable: (buildId) => llmCredentials.has(buildId),
      // An external IDE / the AI can ask the owner to set a secret env var
      // VALUE-FREE (request_env_var). Journal it (names not values) so the
      // "your IDE asked for STRIPE_KEY" signal is durable + reviewable.
      recordEnvRequest: async ({ buildId, name, why }) => {
        await buildJournal.append(buildId, {
          mode: "mcp",
          kind: "env-requested",
          actor: "ide",
          summary: `requested env var ${name}`,
          ...(why != null ? { detail: why } : {}),
        });
      },
      // Mirror the vibe-code W10 notify-owner hook: log-only by default so
      // the chain is provably wired; production deployments that integrate
      // with .com's push relay replace this with a real fan-out (POST
      // `<controlPlane>/api/push/relay`, category "build-needs-env"). The
      // callback is value-free by construction — only the build id + the
      // env NAME, never a value, reason, or secret flag.
      notifyOwner: ({ buildId, name }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[build] build=${buildId} env-requested=${name} ` +
            `→ owner-notify hook fired (push fan-out wiring is operator-supplied)`,
        );
      },
    });
    runtime.addHandler(
      buildBuildModesHttpHandlers({
        orchestrator: buildOrchestrator,
        gate: pairedSessions,
        credentials: llmCredentials,
      }),
    );

    // Bridge scratch (vibe-code) into the same journal so all three
    // modes appear together. Value-free: only the session id + tool
    // kind, mirroring the notify hook's contract. This replaces the
    // log-only hook above with log + journal.
    vibeRegistry.setNotifyOwner(({ sessionId, kind, toolUseId }) => {
      // eslint-disable-next-line no-console
      console.log(
        `[vibecode] session=${sessionId} tool=${kind} toolUseId=${toolUseId} ` +
          `→ owner-notify hook fired`,
      );
      // #91 — this hook REPLACES the baseline above (setNotifyOwner is
      // last-writer-wins), so re-emit the value-free AI-chat alert onto the
      // phone-pollable AlertInbox here too, alongside the journal entry.
      alertInbox.emit({
        kind: "ai-chat-needs-you",
        serviceId: sessionId,
        request: kind,
        toolUseId,
      });
      void buildJournal
        .append(sessionId, {
          mode: "scratch",
          kind: kind === "requestEnvVar" ? "env-requested" : "question",
          actor: "ai",
          summary: kind === "requestEnvVar" ? "AI requested an env var" : "AI asked a question",
        })
        .catch(() => {});
    });
  }

  const lineageResolver = buildLineageResolverAdapter({
    store: pullStateStore,
    client: updateClient,
    // Production uninstall walks the ServicePlatform path which already
    // drops pull state + container + data stores + tabs. The BFF's
    // paired-session gate has already authenticated the caller, so
    // this is the trust equivalent of a host-IRK-signed uninstall.
    uninstall: async (serviceId) => {
      try {
        const ap = runtime.servicePlatform;
        const app = ap?.byServiceId(serviceId);
        if (!app) return { ok: true };
        // Drop pull state so the scheduler stops pestering the canonical
        // home, even if container-stop is best-effort and may fail in
        // ways we don't surface here.
        if (pullStateStore.delete) {
          await pullStateStore.delete(serviceId).catch(() => {});
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  });
  // Forward ref the screens handler reads on each /post-recovery/status
  // request. The watcher constructed later assigns itself here so the
  // status endpoint returns the live snapshot.
  const rePairWatcherRef: { current: RePairWatcher | null } = { current: null };

  // Resolve a session's editing serviceId from its pending manifest —
  // shared by startStreaming + the screens `resolveSessionAppId`.
  const resolveSessionServiceId = (sessionId: string): string | null => {
    const session = vibeRegistry.get(sessionId);
    if (!session) return null;
    const mj = session.manifestJson();
    if (!mj) return null;
    try {
      const m = JSON.parse(mj) as { name?: unknown };
      if (typeof m.name === "string" && m.name.length > 0) {
        return `${username}-${m.name}`;
      }
    } catch {
      // ignore malformed mid-stream JSON
    }
    return null;
  };

  // The live scratch-streaming thunk: resolves the session's transient
  // BYOK credential, assembles the system prompt from env-var NAMES
  // only, and streams the model reply through the harness. Only wired
  // when a deploy session exists (otherwise there's no app surface to
  // build into).
  const vibeStreamArgs = deploySession && runtime.envStore
    ? {
        registry: vibeRegistry,
        harness: llmHarness,
        credentials: llmCredentials,
        resolveAppId: resolveSessionServiceId,
        appEnvStore: runtime.envStore,
        context: {
          username,
          hostname: env.serverFqdn.split(".")[0] ?? "home",
          tier: "free" as const,
          availableProviders: llmHarness.listStreamingProviders(),
        },
        existingAppsSnapshot: () =>
          (runtime.servicePlatform?.list() ?? []).map((a) => ({
            name: a.slug,
            description:
              typeof a.manifest.description === "string"
                ? a.manifest.description
                : undefined,
            stores: "",
          })),
        defaultModel: defaultLlmModel,
      }
    : undefined;
  const vibeStartStreaming = vibeStreamArgs
    ? buildVibeCodeStartStreaming(vibeStreamArgs)
    : undefined;
  // Resume the model after a talkToUser reply / requestEnvVar ack so a
  // chat-guided build actually continues (the reply alone never re-invokes
  // the LLM).
  const vibeResumeStreaming = vibeStreamArgs
    ? buildVibeCodeResumeStreaming(vibeStreamArgs)
    : undefined;

  const screensHandle = buildScreensHttp({
    gate: pairedSessions,
    serverFqdn: env.serverFqdn,
    username,
    daemonVersion: process.env.FLAGSHIP_DAEMON_VERSION ?? "0.0.0",
    startedAt: Date.now(),
    servicePlatform: runtime.servicePlatform,
    pairedSessions,
    tabRegistry: browserBundle?.tabRegistry ?? null,
    appBackup: runtime.appBackup,
    urlController: runtime.urlController,
    vibeCode: deploySession
      ? {
          registry: vibeRegistry,
          username,
          serverFqdn: env.serverFqdn,
          recordScratchTurn,
          credentials: llmCredentials,
          ...(vibeStartStreaming ? { startStreaming: vibeStartStreaming } : {}),
          ...(vibeResumeStreaming ? { resumeStreaming: vibeResumeStreaming } : {}),
        }
      : null,
    controlPlaneBaseUrl: env.controlPlaneBaseUrl ?? null,
    lineageResolver,
    // P9 — peer-backup management surface. BackupLoop is the
    // authoritative participation toggle. The shard registry is not
    // yet bolted into the production boot path (no upstream shard
    // upload mechanism in src/ today — the BFF still surfaces an
    // empty shard/peer view in that case). B4 wires the
    // RepairStatsAccumulator + RepairScheduler so the BFF's
    // `repair` block surfaces accumulator state instead of the
    // null-provider default; today the scheduler is constructed
    // with `daemon=null` so its snapshot is idle/zero — same
    // observable behavior as before, but the plumbing is ready for
    // the daemon to be late-bound once the upstream lands.
    peerBackup: {
      backupLoop,
      repairStats: repairAccumulator,
    },
    // P6 — collaborator invites. Same store the signed-surface entry
    // must point at when it gets wired (see construction above).
    appInvite: {
      store: appInviteStore,
      serverFqdn: env.serverFqdn,
    },
    // P14 — companion-browser dock. Owner-gated mint/list/revoke +
    // public redeem. Companions land in the same `pairedSessions`
    // store (flagged `companion: true` + 4h `expiresAt`); the gate
    // rejects expired companion tokens and the BFF's write-scope
    // guard returns 403 for companion-initiated mutations.
    companion: {
      ticketStore: companionTicketStore,
      pairedSessions,
      serverFqdn: env.serverFqdn,
      username,
      // P14 Phase 2 — write-relay queue.
      writeRequestStore: companionWriteRequestStore,
    },
    postRecoveryStatus: () => rePairWatcherRef.current?.snapshot() ?? null,
    // W10 — per-app env-var KV editor + vibe-code session BFF deps.
    appEnvStore: runtime.envStore,
    // Resolve the session's app id from the pending manifest. The
    // session emits `flagship.app.json` mid-stream; once the manifest
    // is parsed we derive `<creator>-<slug>`. Pre-manifest sessions
    // surface a null appId — the chat UI shows "(pre-manifest)".
    resolveSessionAppId: (session) => {
      const mj = session.manifestJson();
      if (!mj) return null;
      try {
        const m = JSON.parse(mj) as { name?: unknown };
        if (typeof m.name === "string" && m.name.length > 0) {
          return `${username}-${m.name}`;
        }
      } catch {
        // ignore malformed mid-stream JSON
      }
      return null;
    },
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

  // ---- J.3 / J.4 — Re-pair watcher ----
  // Production-only (requires the on-disk config so we have an
  // authoritative starting IRK + a path to persist the rotated one).
  // Dev daemons that ship without FLAGSHIP_CONFIG skip the watcher.
  if (cfg) {
    const irkHexFromCfg = bytesToHexStr(cfg.irkPublicKey);
    const reissuerJournalSwk = swkHex
      ? hexToBytes(swkHex.trim())
      : new Uint8Array(32);   // no SWK yet → journal can't be decrypted
    const journalStore = new FileJournalStore(defaultJournalPath(dataDir));
    const journalPruner = startJournalPruner({
      store: journalStore,
      onPrune: (n) => {
        if (n > 0) console.log(`[daemon] pruned ${n} post-recovery journal rows`);
      },
    });
    process.once("SIGTERM", () => journalPruner.stop());
    process.once("SIGINT", () => journalPruner.stop());
    const watcher = new RePairWatcher({
      username: cfg.userId,
      currentIrkPubHex: irkHexFromCfg,
      comBaseUrl: env.controlPlaneBaseUrl,
      fetchImpl: fetch,
      statePath: defaultRePairWatcherPath(dataDir),
      pollIntervalMs: 5 * 60_000,
      clearPairedSessions: () => pairedSessions.removeAll(),
      reissuerDeps: runtime.servicePlatform
        ? {
            servicePlatform: runtime.servicePlatform,
            swk: reissuerJournalSwk,
            journal: journalStore,
          }
        : null,
      alertInbox,
      onIrkSwapped: async (event) => {
        const configPath = process.env.FLAGSHIP_CONFIG;
        if (configPath) {
          try {
            await persistRotatedIrk(configPath, event.newIrkPubHex);
          } catch (e) {
            console.warn(
              `[daemon] failed to update ${configPath} with rotated IRK: ${(e as Error).message}`,
            );
          }
        }
        console.log(
          `[daemon] J.3 re-pair complete: old=${event.oldIrkPubHex.slice(0, 12)} → new=${event.newIrkPubHex.slice(0, 12)} ` +
            `(${event.pairedSessionsCleared} paired sessions cleared; ` +
            `${event.reissue?.totalRewritten ?? 0} membership rows re-anchored)`,
        );
      },
    });
    await watcher.load();
    watcher.start();
    rePairWatcherRef.current = watcher;
    process.once("SIGTERM", () => watcher.stop());
    process.once("SIGINT", () => watcher.stop());
    console.log(`[daemon] re-pair watcher started (poll every 5 min)`);
  }
}

/**
 * Owner-IRK handlers (production-only — needs cfg.irkPublicKey): dead-man +
 * power-off + owner-assignable apex (front-page 302) + owner-only journal
 * diagnostics. Mounts each onto the live runtime and arms the dead-man
 * SIGTERM/SIGINT stop hooks. No-op (and no behavior change) when cfg is null.
 */
async function wireOwnerHandlers(deps: {
  runtime: DaemonRuntime;
  cfg: ServerConfig | null;
  env: RuntimeEnv;
  autoUnlockSuppressor: AutoUnlockSuppressor;
  hostPowerRunner: HostPowerRunner;
  servicePlatformRef: ServicePlatformRef;
  /** The box's STK (identity) keypair — signs the gating-v2 revocation poll. */
  identityKeypair: Keypair;
}): Promise<void> {
  const { runtime, cfg, env, autoUnlockSuppressor, hostPowerRunner, identityKeypair } = deps;
  if (!cfg) return;

  const deadMan = new DeadManController({
    serverId: env.serverFqdn,
    irkPub: cfg.irkPublicKey,
    suppressor: autoUnlockSuppressor,
    runner: hostPowerRunner,
  });
  await deadMan.start();
  runtime.addHandler(buildDeadManHttp(deadMan));
  runtime.addHandler(
    buildPowerHttp({
      serverId: env.serverFqdn,
      ownerIrkPub: cfg.irkPublicKey,
      suppressor: autoUnlockSuppressor,
      runner: hostPowerRunner,
    }),
  );
  // Owner-assignable apex: GET/POST /api/front-page + the 302 itself.
  const frontPage = new FrontPageStore();
  await frontPage.load();
  runtime.addHandler(
    buildFrontPageHttp({
      serverId: env.serverFqdn,
      ownerIrkPub: cfg.irkPublicKey,
      store: frontPage,
      resolveLabel: (l) => deps.servicePlatformRef.current?.byLabel(l) !== undefined,
    }),
  );
  // Owner-only diagnostics: POST /api/journal — IRK-signed read of the
  // flagship-daemon systemd journal, served over the box's own pinned pipe.
  runtime.addHandler(
    buildJournalHttp({
      serverId: env.serverFqdn,
      ownerIrkPub: cfg.irkPublicKey,
      reader: new JournalctlReader(),
    }),
  );
  // Per-service access gating (docs/service-access-gating.md): the owner-IRK
  // set-mode endpoint + the friend redeem endpoint + the serve-path enforcement.
  // The household key (for the invite-bundle decrypt) is provisioned to the box
  // over its pinned pipe like the SWK; absent ⇒ bundle decrypt is unavailable
  // (the gating itself still works). Default mode is OPEN, so existing services
  // are unaffected until the owner restricts one.
  // M4 — fail-open alert: if the access-state file is present-but-corrupt the
  // store falls open (so an OPEN service is never bricked) but raises a visible
  // owner-facing flag instead of failing silently.
  const accessStore = new ServiceAccessStore("/var/flagship/service-access.json", {
    onFailOpen: ({ error }) =>
      console.error(
        `[daemon] ⚠️  service-access state corrupt (${error}); restricted services FELL OPEN — owner action required`,
      ),
  });
  await accessStore.load();
  // Browser-session cookie store: lets a redeemed friend reach a restricted
  // service's WEBSITE in a plain browser (which can't sign the visit header).
  const sessionStore = new ServiceSessionStore();
  await sessionStore.load();
  const householdHex =
    process.env.FLAGSHIP_HOUSEHOLD_KEY_HEX ??
    (await tryReadFile("/var/flagship/household-key.hex"));
  const access = buildServiceAccessHttp({
    serverId: env.serverFqdn,
    ownerIrkPub: cfg.irkPublicKey,
    // gating v2 box-as-authority: verify the .com-relayed signed create against
    // the config-pinned owner AID (preferred) OR the owner IRK (transition).
    ...(cfg.ownerAidPub ? { ownerAidPub: cfg.ownerAidPub } : {}),
    store: accessStore,
    sessions: sessionStore,
    serviceInstalled: (ref) =>
      (deps.servicePlatformRef.current?.list() ?? []).some((a) => a.serviceId === ref),
    controlPlaneBaseUrl: env.controlPlaneBaseUrl,
    // gating v2 ANY-DEVICE manual-finalize: the box fetches the owner's signed
    // create from `.com` by inviteId at /api/service-access/accept (STK-signed),
    // so the author needn't carry it on the creating device. The box holds no
    // owner key — it authenticates the fetch with its STK against its server record.
    username: cfg.userId,
    serverDomain: env.serverFqdn,
    stk: identityKeypair,
    householdKey: householdHex ? hexToBytes(householdHex.trim()) : undefined,
  });
  runtime.addHandler(access.handle);
  // gating v2 revocation convergence: poll `.com` revoked-since on the
  // daemon-status heartbeat cadence + self-prune (the instant owner-prune stays
  // the primary path). Needs the owner AID (the authorAID the invites are scoped
  // to) — only runs when it's pinned; the box STK-signs the poll.
  if (cfg.ownerAidPub) {
    const poller = buildRevocationPoller({
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      username: cfg.userId,
      authorAidHex: bytesToHexStr(cfg.ownerAidPub),
      serverDomain: env.serverFqdn,
      stk: identityKeypair,
      store: accessStore,
    });
    poller.start();
    process.once("SIGTERM", () => poller.stop());
    process.once("SIGINT", () => poller.stop());
  }
  // Account-death content-wipe (docs/account-deletion-and-name-reclaim.md §5):
  // poll the self-delete lane on the heartbeat cadence. If the owner deleted
  // their LAST-device account with "ask all servers to delete their content",
  // `.com` deposited an owner-IRK-signed servers-self-delete order; we verify it
  // under the config-pinned owner IRK and wipe the data-services content. The
  // marker makes it idempotent across reboots. Best-effort throughout.
  {
    const dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
    const selfDeletePoller = buildSelfDeletePoller({
      serverDomain: env.serverFqdn,
      ownerIrkPub: cfg.irkPublicKey,
      username: cfg.userId,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      markerStore: fileMarkerStore(`${dataDir}/self-delete-done.json`),
      wipeContent: realWipeContent,
      onLog: (m) => console.log(m),
    });
    selfDeletePoller.start();
    process.once("SIGTERM", () => selfDeletePoller.stop());
    process.once("SIGINT", () => selfDeletePoller.stop());
    console.log("[daemon] self-delete content-wipe poller armed");
  }
  // Transfer-a-box re-home (docs/account-deletion-and-name-reclaim.md §4, Layer
  // A): poll `.com` for "did my owner change?". On a completed transfer the
  // poller persists a marker; the box re-homes (new FQDN + owner IRK ⇒ cert
  // re-issue + fresh acquirer entitlement) on its NEXT restart. Best-effort; a
  // box that was never transferred just 404s cheaply on every poll.
  {
    const dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
    const rehomePoller = buildRehomePoller({
      serverDomain: env.serverFqdn,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      markerPath:
        process.env.FLAGSHIP_REHOME_MARKER ?? `${dataDir}/transfer-rehome.json`,
      onLog: (m) => console.log(m),
    });
    rehomePoller.start();
    process.once("SIGTERM", () => rehomePoller.stop());
    process.once("SIGINT", () => rehomePoller.stop());
    console.log("[daemon] transfer re-home poller armed");
  }
  // Web-experience gating (docs "Web-experience gating"): QR-login for a
  // restricted service's WEBSITE (a browser can't AID-sign). Shares the access +
  // session stores. Its endpoints (knock poll / phone authorize / session
  // status+close) are registered BEFORE enforcement so they're never gated.
  const accessWeb = buildServiceAccessWeb({
    serverId: env.serverFqdn,
    store: accessStore,
    sessions: sessionStore,
  });
  runtime.addHandler(accessWeb.handle);
  // Enforcement: a restricted service's per-label reverse proxy is fronted by
  // this guard. A request to `<urlLabel>.<serverFqdn>` resolves to its
  // installed `<creator>-<slug>`; OPEN services + unknown labels fall through.
  // On a DENY, a top-level browser navigation gets the QR-login knock page.
  runtime.addHandler(
    buildAccessEnforcementHandler(
      access,
      (req) => {
        const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
        const suffix = `.${env.serverFqdn.toLowerCase()}`;
        if (!host.endsWith(suffix) || host.length === suffix.length) return null;
        const label = host.slice(0, host.length - suffix.length);
        // Only the leftmost single label is a service label (no nested dots).
        if (label.includes(".")) return null;
        const svc = deps.servicePlatformRef.current?.byLabel(label);
        return svc ? svc.serviceId : null;
      },
      accessWeb.maybeServeKnock,
    ),
  );
  process.once("SIGTERM", () => deadMan.stop());
  process.once("SIGINT", () => deadMan.stop());
  console.log(
    `[daemon] dead-man heartbeat-lock ${deadMan.policy().enabled ? "ARMED" : "idle (no policy)"}`,
  );
}

/**
 * Bring up the daemon-local HTTP API (phone/loopback only, 127.0.0.1).
 * Production-only — skipped (with a log line) when cfg is null.
 */
async function wireLocalHttpApi(deps: { cfg: ServerConfig | null }): Promise<void> {
  const { cfg } = deps;
  if (!cfg) {
    console.log(`[daemon] FLAGSHIP_CONFIG not provided; skipping local HTTP API`);
    return;
  }
  const apps = new Map<string, AppMembership>();
  const injectors = new Map<string, IdentityInjector>();
  const sessions = new Map<string, Uint8Array>();
  const ctx: DaemonContext = {
    serverId: cfg.serverId,
    userId: cfg.userId,
    apps,
    resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
    injectors,
  };
  const httpApp = buildDaemonHttp(ctx);
  const port = Number(process.env.FLAGSHIP_DAEMON_PORT) || 9090;
  await httpApp.listen({ port, host: "127.0.0.1" });
  console.log(`[daemon] local HTTP API listening on 127.0.0.1:${port}`);
}

/**
 * Graceful-shutdown hooks: tear the browser bundle down (so Chromium isn't
 * left holding the singleton lock on a restart) + stop the schedulers. Same
 * SIGTERM/SIGINT registrations as the original inline block.
 */
function wireShutdownHooks(deps: {
  browserBundle: BrowserBundle | null;
  updateScheduler: UpdateScheduler;
  repairScheduler: RepairScheduler;
}): void {
  if (deps.browserBundle) {
    const bundle = deps.browserBundle;
    process.once("SIGTERM", () => void bundle.close().catch(() => {}));
    process.once("SIGINT", () => void bundle.close().catch(() => {}));
  }
  process.once("SIGTERM", () => deps.updateScheduler.stop());
  process.once("SIGINT", () => deps.updateScheduler.stop());
  process.once("SIGTERM", () => deps.repairScheduler.stop());
  process.once("SIGINT", () => deps.repairScheduler.stop());
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
      ? async ({ serviceId, fqdn }) => {
          await deps.subscriberRegistry!.add(serviceId, fqdn);
          console.log(`[daemon] order: add-subscriber serviceId=${serviceId} fqdn=${fqdn}`);
        }
      : undefined,
    removeSubscriber: deps.subscriberRegistry
      ? async ({ serviceId, fqdn }) => {
          await deps.subscriberRegistry!.remove(serviceId, fqdn);
          console.log(`[daemon] order: remove-subscriber serviceId=${serviceId} fqdn=${fqdn}`);
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

/**
 * The provisioning-status phases the daemon emits on the per-order
 * channel (POST /api/order/<serial>/status). Mirrors the control-plane
 * allowlist (`PROVISION_STATUS_PHASES`) but kept as a local literal here
 * so the daemon doesn't depend on the control-plane package — the box
 * bootstrap reports the earlier phases (installing/registering/sealing),
 * the daemon reports `pairing` + `live`.
 */
export type ProvisionStatusPhase =
  | "booting"
  | "downloading"
  | "partitioning"
  | "installing"
  | "registering"
  | "sealing"
  | "pairing"
  | "live"
  | "error";

/**
 * Trim + validate a baked order serial. Returns null for an absent or
 * malformed value (which disables the daemon-side status reporter — a
 * missing serial is never fatal). Matches the control-plane SERIAL_RE.
 */
export function normalizeOrderSerial(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(s)) return null;
  return s;
}

/**
 * Provisioning-status reporter — POST /api/order/<serial>/status. The
 * phone polls this per-order channel to render the install timeline; the
 * box bootstrap already reports the install-time phases, and the daemon
 * adds the two phases only it can know (`pairing`, `live`). Unsigned —
 * keyed by the order serial (a capability the phone + installer share).
 *
 * ALWAYS fail-open: a failed POST is swallowed so a status report can
 * never crash or block the daemon. The phone falls back to polling +
 * the prior phase until the next report lands.
 */
export async function reportProvisionStatus(args: {
  serial: string;
  controlPlaneBaseUrl: string;
  phase: ProvisionStatusPhase;
  detail?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    const doFetch = args.fetchImpl ?? fetch;
    const url = `${args.controlPlaneBaseUrl.replace(/\/+$/, "")}/api/order/${encodeURIComponent(args.serial)}/status`;
    await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phase: args.phase,
        ...(args.detail !== undefined ? { detail: args.detail } : {}),
      }),
    });
  } catch {
    // Status reporting is best-effort; never let it break the daemon.
  }
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

function bytesToHexStr(b: Uint8Array): string {
  return bytesToHexLocal(b);
}

/**
 * Atomically replace the `irkPublicKey` field of the on-disk config so
 * a daemon restart picks up the rotated user IRK. The rest of the file
 * is preserved as-is. Write-then-rename keeps the file readable if we
 * crash mid-update.
 */
async function persistRotatedIrk(configPath: string, newIrkHex: string): Promise<void> {
  const raw = await readFile(configPath, "utf8");
  const obj = JSON.parse(raw) as Record<string, unknown>;
  obj.irkPublicKey = newIrkHex;
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, configPath);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { BackupLoop } from "./backupLoop.js";
export { AppRunner } from "./serviceRunner.js";
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
export {
  RelayTrustVerifier,
} from "./relayTrustVerifier.js";
export type {
  RelayTrustVerdict,
  RelayTrustVerdictReason,
  RelayTrustVerifierOptions,
  MaintainerChainMaterial,
} from "./relayTrustVerifier.js";
export {
  RelayLockdownController,
  relayTrustEnforceFromEnv,
} from "./relayLockdown.js";
export type {
  RelayLockdownState,
  RelayLockdownOptions,
  RelaySosEvent,
} from "./relayLockdown.js";
export { shouldRelayThroughHub } from "./relayBlessing.js";
export type { RelayGateResult, RelayGateReason } from "./relayBlessing.js";
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
export { buildServiceCertHandlers, rehydrateServiceCerts } from "./serviceCertHttp.js";
export type {
  ServiceCertHttpDeps,
  ServiceCertIssuer,
  ServiceCertPersistence,
} from "./serviceCertHttp.js";
export {
  CustomDomainCertStore,
  ensureLeadCustomDomainCert,
  receiveCustomDomainCert,
} from "./acme/customDomainCert.js";
export type {
  SiblingCertSender,
  EnsureLeadCustomCertDeps,
  ReceiveCustomCertDeps,
} from "./acme/customDomainCert.js";
export {
  defaultEntitlementBundlePath,
  loadEntitlementBundle,
  parseEntitlementBundle,
  serializeEntitlementBundle,
  writeEntitlementBundle,
} from "./entitlementBundleStore.js";
export type { EntitlementBundleFile } from "./entitlementBundleStore.js";
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
export {
  DeadManController,
  BootUnlockModeSuppressor,
  SystemctlPowerRunner,
  executeLockAndPower,
} from "./deadMan.js";
export type {
  AutoUnlockSuppressor,
  HostPowerRunner,
  DeadManControllerOptions,
  DeadManPolicyState,
} from "./deadMan.js";
export { buildDeadManHttp, buildPowerHttp } from "./deadManHttp.js";
export { buildFrontPageHttp, FrontPageStore } from "./frontPage.js";
export { buildJournalHttp, JournalctlReader, type JournalReader } from "./journalHttp.js";
export {
  buildServiceAccessHttp,
  buildAccessEnforcementHandler,
  decideServiceAccess,
  ServiceAccessStore,
  ServiceSessionStore,
  VISIT_PROOF_HEADER,
  SESSION_COOKIE,
  type ServiceAccessHttp,
  type ServiceAccessHttpOptions,
  type AccessDecision,
  type SessionView,
} from "./serviceAccess.js";
export {
  buildServiceAccessWeb,
  PendingKnockStore,
  KNOCK_HOLDER_COOKIE,
  type ServiceAccessWeb,
  type ServiceAccessWebOptions,
} from "./serviceAccessWeb.js";
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
export {
  InMemoryCompanionTicketStore,
  sha256HexOfHex as companionSha256HexOfHex,
} from "./companion/companionTicketStore.js";
export type {
  CompanionTicketRow,
  CompanionTicketStore,
} from "./companion/companionTicketStore.js";
export {
  COMPANION_WRITE_REQUEST_KINDS,
  InMemoryCompanionWriteRequestStore,
  isSupportedWriteRequestKind,
} from "./companion/companionWriteRequestStore.js";
export type {
  CompanionWriteRequestKind,
  CompanionWriteRequestRow,
  CompanionWriteRequestStatus,
  CompanionWriteRequestStore,
} from "./companion/companionWriteRequestStore.js";
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
} from "./serviceAccessGate.js";
export type {
  AccessGateDecision,
  AccessGateDeps,
  AccessModeStore,
} from "./serviceAccessGate.js";
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
export {
  SiblingHandshakeClientManager,
  startPersistentSiblingHandshakeClient,
} from "./sibling/siblingHandshakeClient.js";
export type {
  PersistentSiblingHandshakeClient,
  PersistentSiblingHandshakeClientOptions,
  SiblingHandshakeClientManagerOptions,
  SiblingOpenFn,
} from "./sibling/siblingHandshakeClient.js";
export { acceptSyncUpgrade } from "./sibling/siblingServer.js";
export type { AcceptSyncUpgradeArgs } from "./sibling/siblingServer.js";

// V5 — voi.ci-aware alias reconciler.
export { AliasReconciler } from "./aliasReconciler.js";
export type { AliasReconcilerDeps } from "./aliasReconciler.js";
