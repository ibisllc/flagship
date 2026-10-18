import { existsSync } from "node:fs";
import { setDockerRepairedHook } from "./dockerHealth.js";
import { readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { onCorruptState, withFileLock, writeFileDurable } from "./durableFile.js";
import { basename, join } from "node:path";
import { buildModelRedactor } from "./llm/modelPrivacy.js";
import { X509Certificate } from "node:crypto";
import {
  derivePeerBackupKey,
  ed,
  signServerRevokeBySelf,
  verifyRootEntitlement,
  verifyArchiveDownloadApproval,
  verifyRescueSession,
  verifyArchiveKeysDeposit,
  verifyBackupPolicy,
  verifyServerShareGrant,
  verifyServerShareRevoke,
  type Keypair,
  type ServerRevokeBySelf,
  type ServerShareRevoke,
} from "@flagship/protocol";
import { InMemoryAlertInbox } from "./alertInbox.js";
import {
  buildAlertInboxHandlers,
} from "./alertInboxHttp.js";
import { startDaemonStatusHeartbeat, type DaemonStatusHeartbeat } from "./daemonStatusHeartbeat.js";
import { buildSignedLanHint, hostAddresses, lanPortFromEnv, leafCertSha256 } from "./lanDirect.js";
import { buildRescue } from "./rescue/rescue.js";
import { makeRelayTrustExceptionResolver } from "./relayTrustExceptions.js";
import { sendPushRelay, sendRelayTrustAlert } from "./relaySos.js";
import { buildOwnerWake } from "./ownerWake.js";
import type { RelayLockdownController } from "./relayLockdown.js";
import { BackupLoop } from "./backupLoop.js";
import { RepairScheduler } from "./peerBackup/repairScheduler.js";
import { RepairStatsAccumulator } from "./peerBackup/repairStatsAccumulator.js";
import { FileShardRegistry } from "./peerBackup/fileShardRegistry.js";
import { FileShardBytesStore } from "./peerBackup/fileShardStore.js";
import {
  FileManifestStore,
  uploadBackupManifest,
  type BackupManifest,
} from "./peerBackup/manifest.js";
import {
  buildComStkResolver,
  buildHttpShardPusher,
  buildLivePeerProvider,
} from "./peerBackup/shipper.js";
import { quiesceDataServices, walkDataDir } from "./dataDirWalker.js";
import {
  dumpDataVolumes,
  isDumpSubtree,
  isRawDataMount,
  loadDataServicesCreds,
  realVolumeDumpRunner,
  reloadDataVolumes,
} from "./volumeDump.js";
import {
  buildMigrationPoller,
  fileMigrationMarkerStore,
  pollMigrationAwareHandoffConfirm,
} from "./migrationConsumer.js";
import {
  buildPbFramesRuntimeHandler,
  type PbFramesHandlerOptions,
} from "./peerBackup/httpPeerLink.js";
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
import { buildInvitePage } from "./invitePage.js";
import { buildMemberRolesHttp, buildRankEntryApplier } from "./memberRoles.js";
import { buildAppSessionResolver } from "./appMemberSession.js";
import { matchesPublicRoute } from "./serviceProxy.js";
import { buildDaemonHttp, type DaemonContext } from "./httpApi.js";
import {
  buildIdentityRotateHandlers,
  defaultPendingIdentityPath,
} from "./identityRotateHttp.js";
import { AppMembership } from "./membership.js";
import { KeyCustodian, type SwkOps } from "./keyCustodian.js";
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
import { buildAppBackupHttpHandlers } from "./serviceBackupHttp.js";
import { buildAppStatusReader } from "./appStatus.js";
import { buildActivityResolver } from "./serviceActivity.js";
import { buildScreensUpgradeHandler } from "./screens/screensWs.js";
import { ScreensEventBus } from "./screens/screensEvents.js";
import { AccessAlertSetting } from "./egress/accessAlertSetting.js";
import { readServiceSource } from "./llm/serviceSource.js";
import type { EditableService } from "./buildmodes/buildOrchestrator.js";
import { VibeCodeSessionRegistry, fileVibeCodeSessionStore, type VibeCodeSession } from "./llm/vibeCodeSession.js";
import { buildVibeCodeHttpHandlers } from "./llm/vibeCodeHttp.js";
import { buildDeploySession, buildStagedChatDeploy } from "./llm/deploySession.js";
import { LlmHarness, type LlmCredential } from "./llmHarness.js";
import { ModelCatalog } from "./llm/modelCatalog.js";
import type { ChatRequest } from "@flagship/llm-providers";
import { FileBuildCredentialStore } from "./llm/buildCredentialStore.js";
import {
  buildVibeCodeStartStreaming,
  buildVibeCodeResumeStreaming,
  defaultModelsFromEnv,
  modelForProvider,
} from "./llm/vibeCodeStartStreaming.js";
import { FileBuildJournal } from "./buildmodes/buildJournal.js";
import { FileMcpKeyStore } from "./buildmodes/mcpKeyStore.js";
import { GitImporter } from "./buildmodes/gitImport.js";
import { httpAdapterIndex } from "./buildmodes/adapterIndex.js";
import { FileAdapterOrigins } from "./buildmodes/adapterOrigins.js";
import { combineNameHolders, type NameHolders } from "./llm/serviceName.js";
import { buildAppImage, buildArtifactPipeline } from "./buildmodes/deployArtifact.js";
import { StagingRunner } from "./buildmodes/staging.js";
import type { AgentRunner } from "./buildmodes/buildAgent.js";
import { BuildOrchestrator } from "./buildmodes/buildOrchestrator.js";
import { fileBuildStore } from "./buildmodes/buildStore.js";
import { buildBuildModesHttpHandlers } from "./buildmodes/buildModesHttp.js";
import { ForgejoAppAdmin } from "./forgejoServiceAdmin.js";
import type { ServicePlatform } from "./servicePlatform.js";
import {
  carriesAppApiKey,
  runAppSql,
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
  bundleFitsBox,
  defaultEntitlementBundlePath,
  loadEntitlementBundle,
} from "./entitlementBundleStore.js";
import { claimEntitlementDeposit, fetchEntitlementViaRelay } from "./entitlementRelay.js";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { appSqlRunner } from "./dataLayer/appSql.js";
import { DbWriteLedger, buildOwnerDbHttp } from "./dataLayer/ownerDb.js";
import { ActivityLog, defaultActivityLogPath } from "./shares/activityLog.js";
import { quotaNotices } from "./appQuota/notices.js";
import { withQuotaUsage } from "./appQuota/usage.js";
import { ShareStore, defaultShareStorePath } from "./shares/shareStore.js";
import { checkShareAcceptAdmin } from "./shares/acceptAdmin.js";
import { caTrustChainFromFolder } from "./releaseVerifier.js";
import { buildShareUpdate } from "./shares/shareUpdate.js";
import { ShareInviteStore, buildShareInvites, defaultShareInviteStorePath } from "./shares/shareInvites.js";
import {
  ShareSessionStore,
  buildShares,
  defaultShareSessionPath,
  startShareEndsPoller,
} from "./shares/sharesHttp.js";
import { ensureDocker, realAppCopyOps } from "./appCopy/ops.js";
import { buildAppCopySource } from "./appCopy/source.js";
import { AppCopyStore } from "./appCopy/store.js";
import { buildAppCopyTarget } from "./appCopy/target.js";
import { buildServerArchiveService } from "./serverArchive/service.js";
import { buildRestoreWait, type RestoreWait } from "./serverArchive/restoreWait.js";
import { buildMigratePause, movingPage, type MigratePause } from "./serverArchive/migratePause.js";
import { BackupPolicyStore } from "./backupPolicy/policy.js";
import { BackupCap } from "./backupPolicy/cap.js";
import { PeerBackupEngine } from "./peerNet/engine.js";
import { buildBackupPolicyHttp } from "./backupPolicy/http.js";
import { measureAppArchiveBytes } from "./serverArchive/build.js";
import {
  buildSelfDeletePoller,
  fileMarkerStore,
  realWipeContent,
} from "./selfDeleteConsumer.js";
import {
  buildDecommissionPoller,
  fileMarkerStore as decommissionMarkerStore,
  pollReplacementRestored,
} from "./decommissionConsumer.js";
import {
  buildRehomePoller,
  readRehomeMarker,
  reconcileAdminRootPinOnRehome,
  rehomeAdminRootOverride,
} from "./transferRehomeConsumer.js";
import {
  DebugAccessController,
  buildDebugSystem,
  debugGrantFromInstallBlob,
  realDebugCommandRunner,
} from "./debugAccessGate.js";
import {
  buildSwkDepositPoller,
  fileSwkMarkerStore,
} from "./swkDepositConsumer.js";
import {
  buildCgkDepositPoller,
  fileCgkMarkerStore,
} from "./cgkDepositConsumer.js";
import {
  AdminRootPinLostError,
  buildAdminRootRotationPoller,
  fileAdminRootPinStore,
  recoverLostAdminRootPin,
  resolvePinnedAdminRoot,
} from "./adminRootRotationConsumer.js";
import { buildServerOrderHolder, type ServerOrderHolder } from "./serverOrderHolder.js";
import {
  readAuthCodeBirthDate,
  wireGossip,
  resolveCgk,
  buildCertPrewarm,
  apexFromBoxFqdn,
  buildLeadsHttpHandler,
  type LeadsSnapshot,
} from "./gossip/index.js";
import type { GossipLoop } from "./gossip/gossipLoop.js";
import {
  addEmbeddedPairing,
  buildPairingDepositPoller,
  filePairingMarkerStore,
} from "./pairingDepositConsumer.js";
import {
  buildCurrentCommitProvider,
  applyEndorsedUpdate,
  buildUpdateConsumerPoller,
  filePendingVerifyStore,
  fileUsedNonceStore,
  realUpdateCommandRunner,
} from "./updateConsumer.js";
import {
  buildUpdateHealthSignal,
  runUpdateBootGate,
  type UpdateHealthSignal,
} from "./updateHealthGate.js";
import { fileUpdateOutcomeStore, onUpdateOutcome } from "./updateOutcome.js";
import { buildReleaseCatalog } from "./updateReleases.js";
import { runFirstBootUpdate } from "./firstBootUpdate.js";
import { installHealthReporter } from "./healthReporter.js";
import { installUpdateGuard } from "./updateGuard.js";
import { daemonRestarts as restarts } from "./restartCoordinator.js";
import { buildMaintainersReleaseGate } from "./selfUpdateReleaseGate.js";
import type { EntitlementBundle } from "./tunnel/tunnelClient.js";
import { providerRelay } from "./tunnel/relayFetch.js";
import { AccessPrincipals, AccountDeviceBook } from "./accessPrincipals.js";
import { AccessJournal } from "./accessJournal.js";
import { buildAccessSync, deriveAccessSyncKey, type AccessPeers, type AccessSync } from "./accessSync.js";
import { buildPodsPeers } from "./accessPeers.js";
import { BoxReadToken } from "./boxReadToken.js";

/**
 * The maintainer-endorsement gate every in-place update passes, whoever
 * ordered it.
 *
 * BRING-UP/TEST SEAM ONLY (docs/update-server-rollout-plan.md §Phase 4): a
 * dummy validation box can override the baked maintainer pin to a throwaway
 * ca-track anchor so the whole update pipeline is exercisable in software
 * without the owner's YubiKey. Absent on every real box ⇒ the hardcoded
 * MAINTAINER_PINNED_MANDATE_HASH stands. Setting it needs root on the box
 * (root can already do anything), so it widens no attack surface — but it is
 * logged LOUDLY so an override can never be silent.
 */
function selfUpdateReleaseGate(repoPath: string) {
  const override = process.env.FLAGSHIP_MAINTAINER_PIN_OVERRIDE;
  if (override) {
    console.warn(
      "[self-update] ⚠️  MAINTAINER PIN OVERRIDDEN via " +
        "FLAGSHIP_MAINTAINER_PIN_OVERRIDE — this box trusts a NON-production " +
        "release authority. This must NEVER be set on a real box.",
    );
  }
  return buildMaintainersReleaseGate({
    repoPath,
    ...(override ? { pinnedMandateHash: override } : {}),
    onLog: (m) => console.log(m),
  });
}

/**
 * Volume-aware backup pre-step: write CONSISTENT dumps of the data the box
 * keeps for apps (Postgres and Forgejo, bind mounts under
 * `<dataRoot>/{postgres,forgejo}`, and each app's files volume) into the
 * reserved `_dumps/` subtree BEFORE the walker runs, so the walker ships those
 * dumps instead of descending into the live mounts and shipping torn PGDATA or
 * oversize packfiles. Best-effort: without the data-services creds only the
 * files volumes are dumped. Returns the walk options that skip the raw mounts
 * and raise the whole-file cap for the (legitimately large) dumps.
 */
async function dumpVolumesBeforeWalk(
  dataRoot: string,
  onLog: (m: string) => void,
): Promise<{ exclude: (rel: string) => boolean; raiseCapFor: (rel: string) => boolean }> {
  const envFile = process.env.FLAGSHIP_DATA_SERVICES_ENV ?? "/var/flagship/data-services.env";
  const creds = await loadDataServicesCreds(envFile);
  if (!creds) onLog(`[volume-dump] no data-services creds at ${envFile}; dumping files folders only`);
  try {
    const report = await dumpDataVolumes({ dataRoot, runner: realVolumeDumpRunner, creds, onLog });
    if (!report.ok) {
      onLog(
        `[volume-dump] ${report.errors.length} store(s) failed to dump; they are omitted (not torn) this pass`,
      );
    }
  } catch (e) {
    // A wholesale failure (e.g. docker missing) must not stop the file walk —
    // non-store data under <dataRoot> still gets backed up.
    onLog(`[volume-dump] dump pass failed (continuing with file walk): ${(e as Error).message}`);
  }
  // The raw mounts are excluded whether or not the dump succeeded — a clean miss
  // beats a torn copy, and any store that DID dump rides via `_dumps/`.
  return { exclude: isRawDataMount, raiseCapFor: isDumpSubtree };
}

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
      adminRootPubHex?: unknown;
      authCode?: { userPubKey?: unknown; adminRootPubKey?: unknown };
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
    // Slice D — the pinned admin master root. Per decision D-1 it rides INSIDE
    // the signed AuthCode (`authCode.adminRootPubKey`); we also accept a
    // top-level `adminRootPubHex` sibling for the cloud-init/demo path (mirrors
    // how `ownerAidPubHex` is written). Prefer the signature-covered AuthCode
    // field. Hex-serialized on disk (like `authCode.userPubKey`).
    const adminRoot =
      isHex32(b.authCode?.adminRootPubKey)
        ? (b.authCode?.adminRootPubKey as string)
        : b.adminRootPubHex;
    return {
      serverId,
      userId,
      bakPublicKey: hexToBytes(bak),
      irkPublicKey: hexToBytes(irk),
      ...(isHex32(ownerAid) ? { ownerAidPub: hexToBytes(ownerAid) } : {}),
      ...(isHex32(adminRoot) ? { adminRootPub: hexToBytes(adminRoot) } : {}),
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

/** How this server was created, for its backups (a restore makes the new server the same way). */
async function installSettingsFromInstallBlob(): Promise<{ bootUnlockMode: "auto" | "approve"; diskEncryption: "luks" | "none" }> {
  const blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json";
  const raw = await tryReadFile(blobPath);
  let b: { bootUnlockMode?: unknown; diskEncryption?: unknown } = {};
  try {
    b = raw ? (JSON.parse(raw) as typeof b) : {};
  } catch {
    b = {};
  }
  return {
    bootUnlockMode: b.bootUnlockMode === "approve" ? "approve" : "auto",
    diskEncryption: b.diskEncryption === "none" ? "none" : "luks",
  };
}

/**
 * Read the recipe's OPTIONAL embedded pairing order (`pairingOrder`) from the
 * on-disk install blob — the OFFLINE/advanced secret-free mode. The phone embeds
 * the owner-IRK-signed `add-paired-session` order in PLAINTEXT (`{request,
 * signature}` JSON) as an UNSIGNED recipe sibling (never in the signed
 * InstallBlob's canonical bytes, so existing recipe signatures are untouched),
 * exactly like `swkHex`; the builder writes it into /var/flagship/install-blob.json.
 * The daemon verifies the owner-IRK signature at boot and adds the session
 * LOCALLY with no `.com` call. Returns the raw JSON string (un-verified here —
 * `addEmbeddedPairing` verifies) or null when absent/malformed (the default
 * online recipe carries NO pairing material → the box falls through to the
 * `.com` pairing-deposit poller).
 *
 * The default secret-free recipe carries `pairingKeyPrivHex` NO MORE: it is
 * cleanly removed. Older recipes that still carry it pair through the EXISTING
 * `.com` pairing-deposit lane (the phone now seals the order to the box identity,
 * which the poller opens) — the dead `pairingKeyPrivHex` sibling is simply ignored.
 */
async function pairingOrderFromInstallBlob(): Promise<string | null> {
  const blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json";
  const raw = await tryReadFile(blobPath);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as { pairingOrder?: unknown };
    const v = b.pairingOrder;
    // Accept either the embedded JSON STRING or an already-parsed object (the
    // builder writes the string; be tolerant of either shape).
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") return JSON.stringify(v);
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the recipe's Service Workload Key (`swkHex`) from the on-disk install
 * blob. The phone embeds it as an UNSIGNED recipe sibling (= `deriveSWK(umk,
 * serverId)`, never in the signed InstallBlob's canonical bytes, mirroring
 * `pairingKeyPrivHex`); the builder writes it into /var/flagship/install-blob.json.
 * The daemon consumes it at first boot to turn on the service/build platform.
 * Returns the validated 64-hex string (lowercased) or null when absent/malformed
 * (older recipes, or a recipe minted before SWK provisioning) — the box then
 * stays platform-less, exactly as before.
 */
export async function swkHexFromInstallBlob(): Promise<string | null> {
  const blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json";
  const raw = await tryReadFile(blobPath);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as { swkHex?: unknown };
    const v = b.swkHex;
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/i.test(v)) return null;
    return v.toLowerCase();
  } catch {
    return null;
  }
}

/** Persist the SWK hex to /var/flagship/swk.hex (mode 0600). A deposit claim
 *  MUST observe write failure so it never marks a consumed secret as durable. */
export async function persistSwkHex(path: string, swkHex: string): Promise<void> {
  await writeFileDurable(path, swkHex.trim() + "\n");
}

/** Snapshot the certificate metadata the synchronous screens BFF needs. */
export function liveCertInfo(
  certPem: string,
  notAfter: number,
  names: string[],
): { notAfter?: number; notBefore?: number; sans?: string[] } {
  let notBefore: number | undefined;
  try {
    const parsed = Date.parse(new X509Certificate(certPem).validFrom);
    if (Number.isFinite(parsed)) notBefore = parsed;
  } catch {
    // The cert is already installed by the runtime. Parsing metadata is
    // presentation-only; expiry + SANs remain useful if introspection fails.
  }
  return {
    ...(Number.isFinite(notAfter) ? { notAfter } : {}),
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(names.length > 0 ? { sans: [...names] } : {}),
  };
}

/** Best-effort persist of the CGK hex to /var/flagship/cgk.hex (mode 0600), so a
 *  reboot resolves it via the existing on-disk path (resolveCgk) and gossip wires
 *  on the next boot. Non-fatal: a write failure just means the next boot re-polls. */
export async function persistCgkHex(path: string, cgkHex: string): Promise<void> {
  try {
    await writeFileDurable(path, cgkHex.trim() + "\n");
  } catch (e) {
    console.warn(
      `[daemon] could not persist cgk.hex (${(e as Error).message}); will re-poll the cgk lane next boot`,
    );
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

  const dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
  const adminRootPinPath = `${dataDir}/admin-root-pin.json`;

  // What happened on this box (apps' Activity tab). One log for the whole
  // process; shares, migration, updates, backups and app changes all write to it.
  const activityLog = new ActivityLog(defaultActivityLogPath(dataDir));
  await activityLog.load().catch((e: Error) => console.warn(`[activity] load failed: ${e.message}`));
  // A state file found unreadable is set aside and loaded closed; the owner
  // sees it in Activity (reports made before this line are replayed).
  onCorruptState((r) =>
    activityLog.note("server.state.corrupt", `${basename(r.path)} couldn't be read and was set aside. ${r.effect}`, { ok: false }),
  );
  // The owner-assigned front page (its own route below, and server backups).
  const frontPage = new FrontPageStore();
  await frontPage.load();
  onUpdateOutcome((r) => {
    const to = r.targetCommit ? ` ${r.targetCommit.slice(0, 8)}` : "";
    if (r.outcome === "applied") activityLog.note("server.update.applied", `Updated to${to}.`);
    else if (r.outcome === "rolled-back") activityLog.note("server.update.rolled-back", `The update to${to} failed its boot check and was rolled back.`, { ok: false });
    else activityLog.note("server.update.refused", `An update order was refused${r.reason ? ` (${r.reason})` : ""}.`, { ok: false });
  });

  // Transfer-a-box re-home (docs/account-deletion-and-name-reclaim.md §4, Layer
  // A). If a prior boot's poller observed an ownership transfer it persisted a
  // marker; apply it BEFORE anything reads the canonical / owner IRK so cert SANs
  // + entitlement load against the NEW namespace. Same identity key carries
  // forward; only the FQDN + owner IRK move. The acquirer IRK only becomes
  // load-bearing once a fresh acquirer-IRK-signed entitlement verifies under it.
  {
    const rehomeMarkerPath =
      process.env.FLAGSHIP_REHOME_MARKER ?? `${dataDir}/transfer-rehome.json`;
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
        // Slice D §9.8 — the AUTHORITY anchor moves with the ownership, but
        // ONLY because the poller verified a giver-root-signed AdminRootTransfer
        // before it ever wrote `newAdminRootPubHex` into this marker (never
        // `.com`'s word). Applied HERE — before the admin-root-pin resolution
        // below — and paired with a ONE-TIME pin-file reset so a stale
        // GIVER-era pin in admin-root-pin.json can never override the
        // transferred root (see reconcileAdminRootPinOnRehome for why the
        // reset must not repeat on every boot: it would clobber the acquirer's
        // own later rotations).
        const adminOverride = rehomeAdminRootOverride(marker);
        if (adminOverride.kind === "repin") {
          cfg = { ...cfg, adminRootPub: hexToBytes(adminOverride.adminRootPubHex) };
        } else if (adminOverride.kind === "unpin") {
          const { adminRootPub: _giverRoot, ...rest } = cfg;
          cfg = rest;
        }
        if (adminOverride.kind !== "none") {
          try {
            await reconcileAdminRootPinOnRehome({
              marker,
              pinPath: adminRootPinPath,
              appliedPath: `${rehomeMarkerPath}.applied`,
              onLog: (m) => console.log(m),
            });
          } catch (e) {
            console.warn(
              `[daemon] admin-root pin reconciliation failed (${(e as Error).message}); ` +
                `will retry next boot`,
            );
          }
        }
      }
    }
  }

  const identityPrivKey = hexToBytes(env.identityPrivKeyHex);

  // ---- Discover the tunnel hub (so we can move infra without redeploying daemons) ----

  // ---- Admin master-root re-pin resolution (Slice D §5) ----
  // The box boots pinning the recipe's admin root (cfg.adminRootPub, the SEED);
  // recovery rotation persists any verified re-pin to admin-root-pin.json. Apply
  // the persisted pin NOW — before any sensitive-order handler is wired — so the
  // Phase-1 `authorizeSensitiveOrder` gate reads the rotated authority root.
  // Never trust `.com`'s reported root: only a proof that chained to the pinned
  // anchor could have written this file (the rotation consumer verifies it).
  // (adminRootPinPath is hoisted above the re-home marker apply, which resets
  // the pin file once on a transfer so a giver-era pin can't win here.)
  let adminRootSeedHex: string | undefined;
  if (cfg?.adminRootPub) {
    const seedHex = bytesToHexLocal(cfg.adminRootPub);
    adminRootSeedHex = seedHex;
    let pinned: string | null = null;
    try {
      pinned = await resolvePinnedAdminRoot(seedHex, fileAdminRootPinStore(adminRootPinPath));
    } catch (e) {
      if (!(e instanceof AdminRootPinLostError)) throw e;
      // Fail closed: the seed may be a root a recovery rotated away, so
      // nothing that takes admin orders is wired until the chain has been
      // replayed from the seed (verified hop by hop, as on a fresh box).
      console.error("[daemon] admin-root pin was lost; rebuilding it from the rotation chain before serving");
      for (;;) {
        pinned = env.controlPlaneBaseUrl
          ? await recoverLostAdminRootPin({
              seedAdminRootHex: seedHex,
              username: cfg.userId,
              controlPlaneBaseUrl: env.controlPlaneBaseUrl,
              pinStore: fileAdminRootPinStore(adminRootPinPath),
              onLog: (m) => console.log(m),
            })
          : null;
        if (pinned) break;
        console.error("[daemon] couldn't fetch the admin-root rotation chain; retrying in 30 s");
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
    if (pinned && pinned !== seedHex) {
      cfg = { ...cfg, adminRootPub: hexToBytes(pinned) };
      console.log(
        `[daemon] admin root re-pinned from box-local state: ${seedHex.slice(0, 12)} → ${pinned.slice(0, 12)}`,
      );
    }
  }

  const endpoints = await resolveServicesEndpoints({
    controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
    cachePath: defaultEndpointsCachePath(dataDir),
    fallback: { tunnelHub: env.tunnelHubFallback! },
  });
  console.log(
    `[daemon] services endpoints (${endpoints.source}): tunnelHub=${endpoints.endpoints.tunnelHub}`,
  );

  // ---- Self-update boot health-gate (docs/server-update-mechanism.md) ----
  // Runs FIRST on every boot (fire-and-forget so bring-up is never blocked; the
  // attempt count is persisted inside BEFORE the health wait, so even a boot
  // that crashes later still walks toward the rollback bound). If a staged
  // update's marker exists: commit it once THIS boot proves healthy (tunnel
  // HELLO_ACK + a signed daemon-status heartbeat — marked below), restart to
  // retry when it doesn't, and ROLL BACK to the previous commit once the boot
  // budget is spent. A bad update can never brick a box. Code swap only —
  // /var/flagship keys/data are never touched.
  const selfUpdateRepoPath = process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship";
  // The box's own running commit (its /opt/flagship HEAD). Shared between the
  // public /api/leads advertisement and the authenticated screens BFF, and the
  // applied-commit truth the self-update consumer enforces `fromCommit` against.
  const currentCommitProvider = buildCurrentCommitProvider(selfUpdateRepoPath);
  const selfUpdateHealth: UpdateHealthSignal = buildUpdateHealthSignal();
  void runUpdateBootGate({
    pendingStore: filePendingVerifyStore(`${dataDir}/update-pending.json`),
    repoPath: selfUpdateRepoPath,
    runner: realUpdateCommandRunner,
    // Generous window: first boot after an update does a full ACME + tunnel
    // bring-up; a transient network outage shouldn't burn a boot attempt.
    awaitHealthy: () => selfUpdateHealth.whenHealthy(10 * 60_000),
    requestRestart: () => {
      console.log("[self-update] restarting (health gate)");
      process.exit(0);
    },
    report: (event, info) =>
      fileUpdateOutcomeStore(`${dataDir}/update-outcome.json`).write({
        outcome: event === "update-applied" ? "applied" : "rolled-back",
        at: Date.now(),
        ...info,
      }),
    onLog: (m) => console.log(m),
  }).catch(() => {});

  // Rolls back an update the gate above can't: one interrupted mid-apply, or
  // one whose code never gets far enough to run the gate (updateGuard.ts).
  void installUpdateGuard({
    repoPath: selfUpdateRepoPath,
    dataDir,
    run: (cmd, args) => realUpdateCommandRunner(cmd, args),
    onLog: (m) => console.log(m),
  }).catch((e) => console.log(`[self-update] update guard not installed: ${(e as Error).message}`));

  // ---- Box health reporter (healthReporter.ts) ----
  // A systemd timer, separate from this process, so the owner still gets
  // memory / OOM / restart numbers when this daemon is the thing failing.
  if (cfg && env.controlPlaneBaseUrl) {
    void installHealthReporter({
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      serverDomain: env.serverFqdn,
      run: (cmd, args) => realUpdateCommandRunner(cmd, args),
      onLog: (m) => console.log(m),
    }).catch((e) => console.log(`[health] reporter not installed: ${(e as Error).message}`));
  }

  // ---- Service Workload Key (SWK) resolution ----
  // The SWK gates the service/build platform (and peer-backup participation,
  // which stays inert until the owner toggles it). The phone provisions it at
  // first boot by embedding `swkHex` (= deriveSWK(umk, serverId)) as an UNSIGNED
  // recipe sibling that the builder writes into install-blob.json. Resolution
  // order:
  //   1. FLAGSHIP_SWK_HEX env       (dev runs)
  //   2. /var/flagship/swk.hex      (already-provisioned box, the stable path)
  //   3. install-blob.json swkHex   (first boot — the phone's provisioning)
  // When (3) supplies it and swk.hex doesn't yet exist, PERSIST it to swk.hex so
  // every later boot resolves via (2) — best-effort, never fatal. A malformed
  // blob sibling is ignored by swkHexFromInstallBlob (returns null) ⇒ the box
  // stays platform-less rather than crashing.
  const swkHexFilePath = "/var/flagship/swk.hex";
  let swkHex: string | null =
    process.env.FLAGSHIP_SWK_HEX ?? (await tryReadFile(swkHexFilePath));
  if (!swkHex) {
    const fromBlob = await swkHexFromInstallBlob();
    if (fromBlob) {
      swkHex = fromBlob;
      console.log("[daemon] SWK provisioned from install blob; service platform enabled");
      try {
        await persistSwkHex(swkHexFilePath, fromBlob);
      } catch (e) {
        console.warn(
          `[daemon] could not persist swk.hex (${(e as Error).message}); will re-read the install blob next boot`,
        );
      }
    }
  }
  // When NOTHING above provisions an SWK the box stays platform-less — say so
  // LOUDLY rather than silently. Reached only by a legacy recipe (minted before
  // SWK provisioning) or a corrupted/missing sibling; once phone-provisioning is
  // in every recipe it should never fire. We deliberately do NOT mint a local
  // random fallback: that would let the box come up "working" with its secrets
  // AND peer-backups sealed under a key nothing can reproduce (backupLoop
  // encrypts chunks with the SWK), silently breaking the recovery guarantee the
  // deterministic deriveSWK(umk, serverId) exists to provide. Failing visibly —
  // reburn from a current recipe — is safer than an unrecoverable-data trap.
  if (!swkHex) {
    console.error(
      "[daemon] no SWK provisioned — build/service platform DISABLED. This box's " +
        "recipe is missing its Service Workload Key (deriveSWK); reburn from a " +
        "current recipe to enable build-a-service.",
    );
  }
  // ---- KeyCustodian — the single owner of the box's raw private key bytes ----
  // Constructed once here from the loaded material (identity seed + SWK when
  // provisioned + CGK when present) and threaded everywhere the raw keys used
  // to go. From this point on, no other module holds the identity `Keypair`
  // or the raw SWK: they hold a narrow interface slice (BoxSigner / SwkOps /
  // GossipOps) and call an operation. See keyCustodian.ts for the honest
  // in-process-boundary caveat.
  const custodian = new KeyCustodian({
    identityPriv: identityPrivKey,
    swk: swkHex ? hexToBytes(swkHex.trim()) : undefined,
    cgk: (await resolveCgk({ cgkHexFilePath: "/var/flagship/cgk.hex" })) ?? undefined,
  });

  const { backupLoop, repairAccumulator, repairScheduler, pbFramesHandler } =
    wirePeerBackup({
      swkHex,
      swkOps: swkHex ? custodian.asSwkOps() : null,
      serverId: env.serverFqdn ?? null,
      identityPrivKeyHex: env.identityPrivKeyHex ?? null,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl ?? null,
      dataDir,
    });

  // BFF in-memory ledgers (companion-dock).
  const {
    companionTicketStore,
    companionWriteRequestStore,
  } = wireBffStores();

  // ---- Order serial (provisioning-status channel) ----
  // The InstallBlob's authCode.serial is the order id keying the
  // per-order install-progress timeline the phone polls
  // (POST /api/order/<serial>/status). The bootstrap (installer/install.sh
  // + the builder's userdata.ts) writes it to /var/flagship/auth-code-serial
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

  // ---- Secret-free-recipe SWK delivery consumer ----
  // (docs/recipe-delivery-and-remote-install.md). When NO SWK is provisioned
  // (env / swk.hex / install-blob swkHex all absent — the default secret-free
  // recipe), poll the `.com` swk lane: the owner's phone seals the SWK to THIS
  // box's identity and IRK-signs the wrapper; we verify under the config-pinned
  // owner IRK, unseal with the identity key, persist swk.hex, and RESTART so the
  // SWK resolution above picks it up and the service platform constructs. Runs
  // ONLY in the no-SWK + production (cfg present) state — the recipe-embedded
  // swkHex path is entirely untouched; demo/gym (cfg-absent) is a no-op.
  if (!swkHex && cfg && env.controlPlaneBaseUrl) {
    const swkPoller = buildSwkDepositPoller({
      serverDomain: env.serverFqdn,
      ownerIrkPub: cfg.irkPublicKey,
      unsealToBox: (blob) => custodian.unsealToBox(blob),
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      persistSwk: (hex) => persistSwkHex(swkHexFilePath, hex),
      restart: () => restarts.request("SWK provisioned via deposit; restarting to enable the service platform"),
      markerStore: fileSwkMarkerStore(`${dataDir}/swk-claimed.json`),
      guard: restarts.guard,
      onLog: (m) => console.log(m),
    });
    swkPoller.start();
    process.once("SIGTERM", () => swkPoller.stop());
    process.once("SIGINT", () => swkPoller.stop());
    console.log("[daemon] no SWK yet — swk-deposit consumer armed (secret-free recipe)");
  }

  // ---- Post-boot CGK delivery consumer (Phase 6) ----
  // (docs/multi-pod-liveness-session-leadership.md). When NO CGK is provisioned
  // (env / cgk.hex / install-blob cgkHex all absent — the default secret-free
  // recipe), per-service leadership gossip stays DISABLED. Poll the `.com` cgk
  // lane: the owner's phone seals the per-cloud CGK to THIS box's identity and
  // IRK-signs the wrapper; we verify under the config-pinned owner IRK, unseal
  // with the identity key, persist cgk.hex, and RESTART so the next boot resolves
  // the CGK from disk and `wireGossip` enables. Runs ONLY in the no-CGK +
  // production (cfg present) state — mirrors the SWK consumer EXACTLY (forged/
  // wrong-box → keep polling, never persist/brick; idempotent). demo/gym
  // (cfg-absent) is a no-op.
  const cgkHexFilePath = "/var/flagship/cgk.hex";
  const hasCgk = (await resolveCgk({ cgkHexFilePath })) !== null;
  if (!hasCgk && cfg && env.controlPlaneBaseUrl) {
    const cgkPoller = buildCgkDepositPoller({
      serverDomain: env.serverFqdn!,
      ownerIrkPub: cfg.irkPublicKey,
      unsealToBox: (blob) => custodian.unsealToBox(blob),
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      persistCgk: (hex) => persistCgkHex(cgkHexFilePath, hex),
      restart: () => restarts.request("CGK provisioned via deposit; restarting to enable gossip"),
      markerStore: fileCgkMarkerStore(`${dataDir}/cgk-claimed.json`),
      guard: restarts.guard,
      onLog: (m) => console.log(m),
    });
    cgkPoller.start();
    process.once("SIGTERM", () => cgkPoller.stop());
    process.once("SIGINT", () => cgkPoller.stop());
    console.log("[daemon] no CGK yet — cgk-deposit consumer armed (secret-free recipe)");
  }

  // ---- Admin master-root rotation consumer (Slice D §5) ----
  // Armed ONLY when the box has a pinned admin root (a reburned box) + a control
  // plane. Fetches the account's rotation chain and re-pins ONLY on a proof that
  // chains from the box's CURRENTLY-pinned root (never `.com`'s word), persisting
  // the re-pin to admin-root-pin.json + restarting so the sensitive-order gate
  // re-binds. A legacy box with no admin root is a strict no-op.
  if (cfg?.adminRootPub && env.controlPlaneBaseUrl) {
    const adminRotationPoller = buildAdminRootRotationPoller({
      username: cfg.userId,
      seedAdminRootHex: bytesToHexLocal(cfg.adminRootPub),
      ...(adminRootSeedHex ? { recoverySeedHex: adminRootSeedHex } : {}),
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      pinStore: fileAdminRootPinStore(adminRootPinPath),
      restart: () => restarts.request("admin root rotated; restarting to re-bind the authority anchor"),
      onLog: (m) => console.log(m),
    });
    adminRotationPoller.start();
    process.once("SIGTERM", () => adminRotationPoller.stop());
    process.once("SIGINT", () => adminRotationPoller.stop());
    console.log("[daemon] admin-root-rotation consumer armed (recovery re-pin, verify-then-pin)");
  }

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
        // Slice D (§2 row 10) — the pinned admin master root gates the
        // destructive order types on this endpoint (absent ⇒ legacy).
        ...(cfg?.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
        ...(cfg ? { username: cfg.userId } : {}),
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
  // Set by wireOwnerHandlers; read when a vibe-coded app deploys invite-only.
  const serviceAccessRef: { current: ServiceAccessStore | null } = { current: null };
  // Who a signing key is on this box (account devices, co-managers): the
  // device book is wired by wireOwnerHandlers, the shares by wireRuntimeSurfaces.
  const accessPrincipals = new AccessPrincipals(cfg?.ownerAidPub ? bytesToHexStr(cfg.ownerAidPub) : null);
  // One access list per app across the account's servers: the hand-over is
  // wired by wireOwnerHandlers, and learns where the app's other servers are
  // once gossip is up (below).
  const accessSyncRef: { current: AccessSync | null } = { current: null };
  const accessPeersRef: { current: AccessPeers | null } = { current: null };
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
    custodian,
    reportStatus,
  });

  // Signed daemon-status heartbeat — populates `daemon_status` with REAL cert
  // info + a fresh heartbeat so /pods shows true current liveness (the proper
  // fix for the "never came online" regression; the /pods provision-status
  // bridge is the fallback when this hasn't run yet). Fired from onCertIssued
  // (first report the instant the cert lands) + periodically thereafter.
  // Late-binding cell for the gossip loop so the heartbeat (started here, before
  // the gossip loop wires) can report the live "services I lead" set (Phase 6
  // Part 3). Back-patched once the loop exists; null/absent ⇒ no leadsServices.
  const gossipLoopRef: { current: GossipLoop | null } = { current: null };
  // Late-binding source for `GET /api/leads` — the box's client-facing read of the
  // live per-service leadership map. Defaults to gossip-disabled (empty) and is
  // back-patched once gossip wires (below). The handler itself is registered the
  // moment the runtime is up, so /api/leads is ALWAYS served (200, gossipActive
  // false until/unless gossip enables) — mirroring /api/services' always-present
  // route (which 503s rather than 404s when its platform is absent).
  const leadsSnapshotRef: { current: () => LeadsSnapshot } = {
    current: () => ({ gossipActive: false, leads: {}, leader: null }),
  };
  // Late-binding cell for the on-service-delete teardown: ServicePlatform is
  // built inside startDaemonRuntime (below), but the route claimer + gossip loop
  // it must drive aren't wired until AFTER the runtime is up. Back-patched once
  // gossip wires; null ⇒ no-op (no gossip / no claimer = nothing to release).
  const onServiceRemovedRef: { current: ((slug: string) => Promise<void>) | null } = {
    current: null,
  };
  // Late-binding cell for the relay-trust lockdown controller (built inside
  // startDaemonRuntime, below). The heartbeat (started here, before the runtime
  // wires) reads the box's PER-BOX relay-trust verdict through this so the
  // signed box-trust-status rides every beat once the runtime is up. Null until
  // then ⇒ no trustStatus is signed/sent (additive; identical to an old box).
  const relayLockdownRef: { current: RelayLockdownController | null } = {
    current: null,
  };
  // The owner's server order (docs/server-order.md): who leads and who's next.
  // It arrives on the heartbeat reply and on siblings' gossip frames; the
  // holder adopts only a verified, newer order and keeps it across restarts.
  const serverOrder = cfg
    ? buildServerOrderHolder({
        path: `${dataDir}/server-order.json`,
        user: cfg.userId,
        ownerIrkPub: cfg.irkPublicKey,
        ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
        // Tell the siblings, and acknowledge to `.com` at once (the beat
        // carries `orderIssuedAt`) so the apps stop showing the leader gray.
        onAdopt: () => {
          void gossipLoopRef.current?.tick().catch(() => {});
          statusHeartbeatRef.current?.orderChanged();
        },
        onLog: (m) => console.log(m),
      })
    : null;
  await serverOrder?.load();
  const statusHeartbeatRef: { current: DaemonStatusHeartbeat | null } = { current: null };
  // A server created to restore a backup waits for it (docs/server-backup-
  // and-clone.md): the owner-signed restore order rides beside the pairing
  // order, and Home shows "Waiting for its backup" from the heartbeat.
  const restoreWait = cfg
    ? buildRestoreWait({
        path: `${dataDir}/restore-wait.json`,
        donePath: `${dataDir}/restore-done.json`,
        serverDomain: env.serverFqdn!,
        ownerIrkPub: cfg.irkPublicKey,
        ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
        username: cfg.userId,
        onChange: () => statusHeartbeatRef.current?.backupWaitChanged(),
        note: (kind, detail) => activityLog.note(kind, detail),
        log: (m) => console.log(m),
      })
    : null;
  await restoreWait?.load();
  // The backup policy (phone / peer / none) and the size limit it sets
  // (docs/server-backup-and-clone.md, "Backup policy"): chosen at create time
  // beside the pairing order, changed from the server page, signed under the
  // sensitive-order authority.
  const backupPolicy = cfg
    ? new BackupPolicyStore({
        path: `${dataDir}/backup-policy.json`,
        serverDomain: env.serverFqdn!,
        authorize: (order, sig) =>
          authorizeSensitiveOrder({
            ownerIrkPub: cfg.irkPublicKey,
            ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
            username: cfg.userId,
            order,
            signature: sig,
            verify: verifyBackupPolicy,
          }),
        log: (m) => console.log(m),
      })
    : null;
  await backupPolicy?.load();
  // Migrate's pause (docs/server-migration.md, "Data path"): the apps are
  // paused while the server moves, and their URLs say so.
  const migratePause = cfg
    ? buildMigratePause({
        path: `${dataDir}/migrate-pause.json`,
        containers: () => (servicePlatformRefForServer.current?.list() ?? []).map((a) => `flagship-${a.serviceId}`),
        run: async (args) => {
          const { realCommandRunner } = await import("./serviceRunner.js");
          await realCommandRunner.run("docker", args);
        },
        note: (kind, detail, ok) => activityLog.note(kind, detail, { ok: ok ?? true }),
        log: (m) => console.log(m),
      })
    : null;
  await migratePause?.load();
  // Peer backup between accounts (docs/peer-backup.md): runs while the policy
  // is Peer. Its pool is 2/3 of the disk, from the backup cap once that's up.
  const peerCapRef: { current: { reservedForPeersBytes(): number | null } | null } = { current: null };
  const peerEngine =
    cfg && backupPolicy && swkHex && env.controlPlaneBaseUrl && env.serverFqdn
      ? new PeerBackupEngine({
          serverId: env.serverFqdn,
          dataDir,
          pbk: derivePeerBackupKey(hexToBytes(swkHex.trim())),
          sign: (msg) => custodian.signAsBox(msg),
          comBaseUrl: env.controlPlaneBaseUrl,
          policy: backupPolicy,
          reservedForPeersBytes: () => peerCapRef.current?.reservedForPeersBytes() ?? null,
          log: (m) => console.log(`[peer-backup] ${m}`),
        })
      : null;
  const adoptPairingSiblings = async (json: string) => {
    await restoreWait?.adoptFromPairingJson(json);
    await backupPolicy?.adoptFromPairingJson(json);
  };
  const statusHeartbeat = startDaemonStatusHeartbeat({
    serverDomain: env.serverFqdn!,
    sign: (msg) => custodian.signAsBox(msg),
    controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
    ...(serverOrder
      ? {
          onServerOrder: (raw: unknown) => void serverOrder.offer(raw, ".com"),
          readOrderIssuedAt: () => serverOrder.current()?.order.issuedAt ?? 0,
        }
      : {}),
    readLeads: () => gossipLoopRef.current?.currentLeads() ?? [],
    readRuns: () => servicePlatformRefForServer.current?.list().map((a) => a.slug),
    readTrustStatus: () => relayLockdownRef.current?.trustStatus() ?? null,
    readAwaitingBackup: () => restoreWait?.heartbeatView() ?? null,
  });
  statusHeartbeatRef.current = statusHeartbeat;
  const liveCertInfoRef: {
    current: { notAfter?: number; notBefore?: number; sans?: string[] } | null;
  } = { current: null };
  // The live leaf cert, for the signed LAN hint (it binds the hint to the
  // fingerprint the phone pins). Same source as the status heartbeat.
  const liveCertPemRef: { current: string | null } = { current: null };

  let runtime: DaemonRuntime;
  try {
    // A Docker repaired after boot took the box's networks with it: restart
    // (systemd's Restart=always) so they and the apps come up on it again.
    setDockerRepairedHook((why) => {
      console.warn(`[docker] ${why}; restarting the daemon to set up again`);
      setTimeout(() => process.exit(0), 1000);
    });
    runtime = await startDaemonRuntime({
      serverFqdn: env.serverFqdn!,
      identityPrivKey,
      custodian,
      tunnelHubUrl: endpoints.endpoints.tunnelHub,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
      acmeEmail: env.acmeEmail!,
      acmeEnvironment: env.acmeEnvironment!,
      wildcard: env.wildcard,
      dataDir,
      entitlements: () => entitlementBundle,
      ...(peerEngine
        ? { peerMail: { announcements: () => peerEngine.mailboxAnnouncements(), onMail: (id: string, e: Uint8Array) => peerEngine.handleMail(id, e) } }
        : {}),
      // LAN-direct (docs/lan-direct.md): on by default at :443 on the box's
      // private LAN addresses only; FLAGSHIP_LAN_DIRECT=0 keeps the box
      // relay-only.
      ...(process.env.FLAGSHIP_LAN_DIRECT === "0"
        ? {}
        : { lanDirect: { port: lanPortFromEnv(process.env.FLAGSHIP_LAN_PORT) } }),
      // Every app in its own gVisor sandbox (docs/app-runtimes.md §5.1).
      appSandbox: true,
      healDocker: true,
      // Owner-override resolution for relay-trust: reads the owner-signed
      // relay TrustExceptions from `.com` + verifies them against the box's
      // IRK-anchored roster (anchor = the provisioned owner IRK). ONE
      // phone-signed override, fanned out via `.com`, thereby satisfies this
      // box too. Only when the box knows its owner (cfg present).
      ...(cfg
        ? {
            resolveRelayTrustExceptions: makeRelayTrustExceptionResolver({
              username: cfg.userId,
              ownerIrkPub: cfg.irkPublicKey,
              controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
            }),
            // Real STK-signed push-relay SOS (category "cert-alert") when the
            // box locks down under ENFORCE — replaces the log-only default. The
            // authoritative detail rides the signed /pods box-trust-status; this
            // is the proactive owner wake.
            onRelaySos: () => {
              void sendRelayTrustAlert({
                targetUsername: cfg.userId,
                signer: custodian,
                controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
                log: (l) => console.log(l),
              });
            },
          }
        : {}),
      // The cert has landed and HTTPS is genuinely serving — the real
      // "your server is live" moment. Report it ONCE on the single canonical
      // channel (idempotent: only the first cert/renewal POSTs `live`). Cert
      // acquisition is async + retried in-process (the daemon stays up across
      // transient ACME failures rather than process.exit-ing), so `live` is
      // gated here on the cert actually landing — not when startDaemonRuntime
      // resolves (which happens BEFORE the first cert attempt).
      onCertIssued: (cert, notAfter, names) => {
        liveCertInfoRef.current = liveCertInfo(cert.certPem, notAfter, names);
        liveCertPemRef.current = cert.certPem;
        void reportStatus("live");
        // Feed the signed daemon-status heartbeat with the freshly-issued
        // cert so /pods gets REAL fingerprint/validity/issuer + a fresh
        // lastReported (true liveness), fired immediately + on renewals.
        statusHeartbeat.update(cert, notAfter, names);
        // Self-update boot health-gate: a signed heartbeat just fired — the
        // second of the two health signals a staged update needs to COMMIT.
        selfUpdateHealth.markHeartbeat();
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
        onAppsChanged: () => statusHeartbeat.appsChanged(),
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
        // Slice D (D-2) — the pinned admin master root; when present, service-
        // membership invite/mutation are admin-gated (absent ⇒ legacy owner-IRK).
        ...(cfg?.adminRootPub ? { hostAdminRootPub: cfg.adminRootPub } : {}),
        // The box's own daemon identity keypair — accepted as an ADDITIVE
        // host-authority signer so a box-originated build-modes deploy
        // (which signs installs with this key, since the owner IRK private
        // half is phone-held) is accepted by ServicePlatform.install. The
        // phone-signed install path still verifies the owner IRK.
        hostIrk: identityKeypair,
        swk: swkHex ? custodian.asSwkOps() : undefined,
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
        // On-service-delete teardown of the per-service route. Late-bound: the
        // gossip claimer + loop are wired below, after the runtime is up.
        onServiceRemoved: (slug) => onServiceRemovedRef.current?.(slug),
        onAppEvent: (kind, serviceId) => {
          // An uninstalled app's access state goes with it, so a reinstall
          // under the same id doesn't inherit its members or ranks.
          if (kind === "app.removed") void serviceAccessRef.current?.forget(serviceId).catch(() => {});
          if (kind === "app.removed") void accessSyncRef.current?.forget(serviceId).catch(() => {});
          activityLog.note(
            kind,
            kind === "app.installed"
              ? `Installed ${serviceId}.`
              : kind === "app.updated"
                ? `Redeployed ${serviceId}.`
                : `Removed ${serviceId}.`,
            { target: serviceId },
          );
        },
      },
      additionalHandlers,
      updateServer,
    });
    servicePlatformRefForServer.current = runtime.servicePlatform;
    // Self-update boot health-gate: startDaemonRuntime resolves only after the
    // supervised tunnel's first HELLO_ACK — the first of the two health signals.
    selfUpdateHealth.markTunnelUp();
    if (orders) {
      console.log(
        `[daemon] orders-from-user endpoint enabled (verify key: ${pskPubHex ? "psk.pub.hex" : "owner IRK"})`,
      );
    } else console.log(`[daemon] no owner IRK / psk; orders endpoint disabled`);

    // Secret-free pairing: come online ALREADY paired (no manual "Pair this
    // server" tap), with NO secret in the recipe. Two modes (both need the owner
    // IRK, cfg, to verify the order):
    //   OFFLINE (advanced/embed): the recipe carries the owner-IRK-signed
    //     `add-paired-session` order in plaintext (`pairingOrder` sibling) — add
    //     it LOCALLY, no `.com` call.
    //   DEFAULT (online): the recipe carries NO pairing material; the phone
    //     deposits the order SEALED to THIS box's identity into the `.com`
    //     pairing-deposit lane AFTER we register, so we POLL that lane on the
    //     heartbeat cadence until we claim it (mirrors the SWK consumer).
    // Fire-and-forget + best-effort; never blocks bring-up.
    if (cfg) {
      const pairingMarker = filePairingMarkerStore(`${dataDir}/pairing-claimed.json`);
      void (async () => {
        const embedded = await pairingOrderFromInstallBlob();
        if (embedded) {
          const out = await addEmbeddedPairing({
            embeddedJson: embedded,
            serverFqdn: env.serverFqdn!,
            ownerIrkPub: cfg.irkPublicKey,
            pairedSessions,
            markerStore: pairingMarker,
            onVerified: async (json) => {
              await adoptPairingSiblings(json);
            },
            onLog: (m) => console.log(m),
          });
          // An embedded order that doesn't verify falls through to the poller
          // (a box might also carry a fresh `.com` deposit).
          if (out.added) return;
        }
        if (!env.controlPlaneBaseUrl) return;
        const pairingPoller = buildPairingDepositPoller({
          serverFqdn: env.serverFqdn!,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl,
          ownerIrkPub: cfg.irkPublicKey,
          unsealToBox: (blob) => custodian.unsealToBox(blob),
          pairedSessions,
          markerStore: pairingMarker,
          onVerified: async (json) => {
              await adoptPairingSiblings(json);
            },
          guard: restarts.guard,
          onLog: (m) => console.log(m),
        });
        pairingPoller.start();
        process.once("SIGTERM", () => pairingPoller.stop());
        process.once("SIGINT", () => pairingPoller.stop());
        console.log("[daemon] no embedded pairing — pairing-deposit consumer armed (secret-free recipe)");
      })();
    }
    console.log(
      `[daemon] tunnel online for ${env.serverFqdn}; ACME issuance running in-process (cert installs asynchronously)`,
    );

    // Client-facing per-service leadership read. Registered the moment the
    // runtime is up so `/api/leads` is ALWAYS served on the box's pinned pipe
    // (unauth + CORS-wrapped, exactly like /api/services). `leadsSnapshotRef`
    // defaults to gossip-disabled and is back-patched when gossip wires below.
    runtime.addHandler(
      buildLeadsHttpHandler({
        serverFqdn: env.serverFqdn!,
        snapshot: () => leadsSnapshotRef.current(),
        commit: currentCommitProvider,
      }),
    );
    // Peer-backup shard transport (box↔box). Registered on the PUBLIC pipe —
    // peers dial https://<fqdn>/api/peer-backup/frames; the handler verifies
    // the caller's STK envelope against the .com directory and owner-scopes
    // reads. 503s until wirePeerBackup had identity + .com reachability.
    runtime.addHandler(pbFramesHandler);
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
      frontPage,
      activityLog,
      restoreWait,
      backupPolicy,
      migratePause,
      peerEngine,
      peerCapRef,
      serverOrder,
      serviceAccessRef,
      accessPrincipals,
      accessSyncRef,
      runtime,
      cfg,
      env: env as RuntimeEnv,
      dataDir,
      swkHex,
      identityKeypair,
      custodian,
      pairedSessions,
      browserBundle,
      alertInbox,
      backupLoop,
      repairAccumulator,
      companionTicketStore,
      companionWriteRequestStore,
      pullStateStore,
      updateClient,
      updateScheduler,
      liveCertInfoRef,
      liveCertPemRef,
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

  // Back-patch the heartbeat's trust-snapshot source now that the runtime's
  // relay-trust lockdown controller exists. From here the signed
  // box-trust-status rides every beat (detect + propagate — NOT gated by
  // FLAGSHIP_RELAY_TRUST_ENFORCE; only the data-plane lockdown is).
  relayLockdownRef.current = runtime.relayLockdown;

  // ---- Owner-IRK handlers: dead-man + power + front-page + journal ----
  // Production-only (needs cfg.irkPublicKey). No enabled dead-man policy ⇒
  // no timer, no behavior change. Mounts onto the live runtime + arms the
  // dead-man SIGTERM/SIGINT stop hooks.
  await wireOwnerHandlers({
    frontPage,
    activityLog,
    serviceAccessRef,
    accessPrincipals,
    accessSyncRef,
    accessPeersRef,
    runtime,
    cfg,
    env: env as RuntimeEnv,
    autoUnlockSuppressor,
    hostPowerRunner,
    servicePlatformRef: servicePlatformRefForServer,
    identityKeypair,
    backupLoop,
    migratePause,
  });

  // ---- Peer-backup periodic pass ----
  // Feed the BackupLoop the REAL data tree on a slow cadence (it previously
  // only ever ran with an empty file list — a ghost run that shipped nothing).
  // runOnce is a no-op while the owner has backup toggled OFF, and unchanged
  // restorable chunks are skipped, so an idle pass is cheap.
  if (backupLoop) {
    const backupIntervalMs = (() => {
      const raw = Number(process.env.FLAGSHIP_BACKUP_INTERVAL_MS);
      return Number.isFinite(raw) && raw >= 60_000 ? raw : 6 * 60 * 60_000;
    })();
    const loop = backupLoop;
    const backupTimer = setInterval(() => {
      void (async () => {
        const dataRoot = `${dataDir}/data`;
        const walkOpts = await dumpVolumesBeforeWalk(dataRoot, (m) => console.log(`[peer-backup] ${m}`));
        const files = await walkDataDir(dataRoot, {
          onLog: (m) => console.log(`[peer-backup] ${m}`),
          exclude: walkOpts.exclude,
          raiseCapFor: walkOpts.raiseCapFor,
        });
        const report = await loop.runOnce(files);
        if (report.chunksShipped > 0) {
          console.log(
            `[peer-backup] periodic pass: ${report.filesProcessed} files, ` +
              `${report.chunksShipped} chunks shipped, ${report.chunksSkipped} unchanged`,
          );
        }
      })().catch((e) =>
        console.log(`[peer-backup] periodic pass failed: ${(e as Error).message}`),
      );
    }, backupIntervalMs);
    if (typeof backupTimer.unref === "function") backupTimer.unref();
  }

  // ---- Server-migration consumer (docs/server-migration.md, the NEW box) ----
  // A freshly-provisioned pod polls `.com` for a migration assignment naming
  // its account. The admin-signed order is RE-VERIFIED under the config-pinned
  // authority before anything runs. The data comes on the archive path: the
  // owner's app has this box pull the old server's backup and restore it (a
  // server waiting for a backup), and the pre-seed is done once it is. On take-over the
  // box writes the re-home marker for the migrated name and restarts — the
  // same boot path transfer-a-box uses re-homes FQDN/cert/entitlement.
  // Armed only in production (cfg) with an SWK; a box with no session just
  // 404s cheaply on the heartbeat cadence.
  if (cfg && env.controlPlaneBaseUrl && env.serverFqdn && swkHex) {
    const controlPlaneBaseUrl = env.controlPlaneBaseUrl;
    const myServerDomain = env.serverFqdn;
    const migrationPoller = buildMigrationPoller({
      myServerDomain,
      myStk: identityKeypair,
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
      username: cfg.userId,
      controlPlaneBaseUrl,
      // The data moves on the archive path (docs/server-migration.md, "Data
      // path"): the owner's app pauses the old server, makes its backup and
      // has this box pull and restore it as a server waiting for a backup.
      // The pre-seed (and the final delta) is done once that restore is.
      restore: async () =>
        restoreWait?.restoredAny()
          ? { complete: true }
          : { complete: false, detail: "waiting for the old server's backup" },
      onTakeOver: async ({ serverDomain }) => {
        activityLog.note("server.migration.taken-over", "This server took over the name from the old server.");
        // Symmetric restore step: the shard restore above landed `_dumps/**`
        // onto disk, but those are DUMPS — reload them INTO this fresh box's
        // data stack (psql < pg_dumpall / files tars into fresh volumes /
        // forgejo sqlite+repos) before it takes traffic. Idempotent +
        // best-effort per store; a store with no dump is simply skipped.
        // Without the data-services creds only the files folders reload.
        const dataRoot = `${dataDir}/data`;
        const envFile =
          process.env.FLAGSHIP_DATA_SERVICES_ENV ?? "/var/flagship/data-services.env";
        const creds = await loadDataServicesCreds(envFile);
        try {
          const rep = await reloadDataVolumes({
            dataRoot,
            runner: realVolumeDumpRunner,
            creds,
            onLog: (m) => console.log(`[migration] ${m}`),
          });
          if (!rep.ok) {
            console.log(
              `[migration] volume reload had ${rep.errors.length} store failure(s); re-homing anyway`,
            );
          }
        } catch (e) {
          console.log(`[migration] volume reload failed (continuing): ${(e as Error).message}`);
        }
        // Re-home to the migrated name via the SAME marker+boot path
        // transfer-a-box uses (owner unchanged ⇒ same IRK): next boot
        // re-derives cert SANs for the migrated name, re-mints the A′ cert,
        // and the tunnel claims the name.
        const markerPath =
          process.env.FLAGSHIP_REHOME_MARKER ?? `${dataDir}/transfer-rehome.json`;
        await writeFileDurable(
          markerPath,
          JSON.stringify({
            newServerDomain: serverDomain,
            acquirerUsername: cfg.userId,
            acquirerIrkPubHex: bytesToHexLocal(cfg.irkPublicKey),
            oldServerDomain: myServerDomain,
            claimedAt: Date.now(),
          }),
        );
        console.log(
          `[migration] take-over complete — re-homing ${myServerDomain} → ${serverDomain}; restarting`,
        );
        process.exit(0);
      },
      markerStore: fileMigrationMarkerStore(`${dataDir}/migration-state.json`),
      onLog: (m) => console.log(m),
    });
    migrationPoller.start();
    process.once("SIGTERM", () => migrationPoller.stop());
    process.once("SIGINT", () => migrationPoller.stop());
    console.log("[daemon] server-migration consumer armed");
  }

  // ---- Per-service leadership gossip loop (Phase 5) ----
  // CONTINUOUSLY gossips with account siblings to compute, per service, who
  // leads — then claims/releases the tier-2 leader-routed `<slug>.<user>` route
  // accordingly. ENTIRELY best-effort: disabled (no-op) when no CGK is
  // provisioned or no owner config exists. The `/internal/gossip` ingest handler
  // mounts on the live runtime; the announce+elect loop starts here. The route
  // claim/release is LIVE-wired to runtime.urlController (claim/release push a
  // tunnel HELLO update). Never throws / never bricks the daemon.
  const gossipLoop = await (async () => {
    if (!cfg) return null;
    try {
      const selfStkHex = bytesToHexLocal(identityKeypair.publicKey);
      // Cert pre-warm seam: when this box becomes the route lead for a tier-2
      // `<slug>.<user>` meta-URL (gossip election round AND the route-nudge
      // handler), load its already-provisioned cert from the persisted ACME
      // store into the CertManager so the parked request isn't waiting on ACME.
      // It cannot MINT (that's the phone's IRK-signed `/api/service-certs/mint`
      // flow) — pre-warm = "load if already provisioned".
      const certPrewarm = runtime.certStore
        ? buildCertPrewarm({ certManager: runtime.certManager, store: runtime.certStore })
        : undefined;
      const result = await wireGossip({
        user: cfg.userId,
        serverFqdn: env.serverFqdn!,
        identityPubHex: selfStkHex,
        birthDate: (await readAuthCodeBirthDate()) ?? Date.now(),
        urlController: runtime.urlController,
        ...(certPrewarm ? { certPrewarm } : {}),
        listServiceSlugs: () =>
          servicePlatformRefForServer.current?.list().map((a) => a.slug) ?? [],
        ...(serverOrder ? { serverOrder } : {}),
        // The zone this box lives in (`<server>.<user>.<apex>`): the gym's
        // boxes are under gym.flagship.services, so broadcast and the
        // leader-routed URLs must not assume the production apex.
        ...(apexFromBoxFqdn(env.serverFqdn!) ? { servicesApex: apexFromBoxFqdn(env.serverFqdn!)! } : {}),
        onLog: (m) => console.log(m),
      });
      if (result.enabled && result.handler && result.loop) {
        runtime.addHandler(result.handler);
        // The hub's on-demand route-nudge: mount on the SAME chain as
        // /internal/gossip so an unclaimed-meta-URL request claims instantly.
        if (result.routeNudgeHandler) runtime.addHandler(result.routeNudgeHandler);
        result.loop.start();
        // Back-patch the heartbeat's lead source so /pods can relay leadsServices.
        gossipLoopRef.current = result.loop;
        // Light up `/api/leads` with the LIVE full map (it served gossipActive:false
        // until now). result.leadsSnapshot reflects the current SiblingView on demand.
        leadsSnapshotRef.current = result.leadsSnapshot;
        // Back-patch the on-service-delete teardown so an uninstall releases the
        // box's `<slug>.<user>` route at the hub + re-announces.
        if (result.releaseRouteForRemovedService) {
          onServiceRemovedRef.current = result.releaseRouteForRemovedService;
        }
        return result.loop;
      }
    } catch (e) {
      console.warn(`[gossip] wiring failed (non-fatal): ${(e as Error).message}`);
    }
    return null;
  })();

  // Where each app's other servers are, for one access list per app: the
  // account's servers from .com, their order as this box holds it, and which
  // of them run an app asked of them directly (docs/service-access-gating.md).
  if (cfg && env.controlPlaneBaseUrl && env.serverFqdn) {
    const podsReader = new BoxReadToken({
      comBaseUrl: env.controlPlaneBaseUrl,
      username: cfg.userId,
      serverFqdn: env.serverFqdn,
      boxPublicKey: () => identityKeypair.publicKey,
      signAsBox: (msg) => ed.sign(msg, identityKeypair.privateKey),
    });
    const base = env.controlPlaneBaseUrl.replace(/\/+$/, "");
    const user = cfg.userId;
    const peers = buildPodsPeers({
      selfFqdn: env.serverFqdn,
      fetchPods: async () => {
        const r = await podsReader.fetch(`${base}/api/users/${encodeURIComponent(user)}/pods`);
        if (!r.ok) return null;
        const body = (await r.json()) as { pods?: unknown };
        return Array.isArray(body.pods) ? (body.pods as never) : null;
      },
      rankOf: (stk) => serverOrder?.rankOf(stk) ?? null,
      apps: () => servicePlatformRefForServer.current?.list().map((a) => a.serviceId) ?? [],
      probe: (peer, ref) => accessSyncRef.current?.probe(peer, ref) ?? Promise.resolve(false),
      log: (m) => console.warn(m),
    });
    accessPeersRef.current = peers;
    peers.start();
  }

  // ---- Bring up the daemon-local HTTP API (phone/loopback only) ----
  await wireLocalHttpApi({ cfg });

  // ---- Graceful-shutdown hooks (browser bundle + schedulers) ----
  wireShutdownHooks({ browserBundle, updateScheduler, repairScheduler, gossipLoop });

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
  /** Public-pipe frames endpoint (box↔box shard transport). Register on the runtime chain. */
  pbFramesHandler: ReturnType<typeof buildPbFramesRuntimeHandler>;
}

/**
 * Peer-backup participation. Two independent halves:
 *
 *  HOSTING (their-shards) — needs only an identity + `.com` reachability:
 *  the public frames endpoint accepts STK-verified peers' shards into the
 *  flat-file pool + persistent registry. Lit even without an SWK, so a
 *  box can reciprocate storage before its own platform is provisioned.
 *
 *  SHIPPING (my-shards) — needs the SWK (chunks encrypt under it): the
 *  BackupLoop ships shards via the .com matchmaker + HttpPeerLink and
 *  maintains the sealed manifest on .com (the fresh-box recovery root).
 *
 * Participation stays inert until the owner toggles backup on (the
 * BackupLoop `enabled` gate); the repair accumulator/scheduler wire-site
 * is unchanged (daemon=null today — flipped on by the upstream later).
 */
function wirePeerBackup(deps: {
  swkHex: string | null;
  /** The custodian's SwkOps slice — used by the live BackupLoop (encryptChunk).
   *  The raw `swkHex` stays for the manifest seal/upload plumbing, which still
   *  calls the pure `sealBackupManifest`/`fetchBackupManifest` helpers. */
  swkOps: SwkOps | null;
  serverId: string | null;
  identityPrivKeyHex: string | null;
  controlPlaneBaseUrl: string | null;
  dataDir: string;
}): PeerBackupBundle {
  const registry = new FileShardRegistry(`${deps.dataDir}/peer-backup/registry.json`);
  const peerPool = new FileShardBytesStore(`${deps.dataDir}/peer-pool`);
  const ownShards = new FileShardBytesStore(`${deps.dataDir}/peer-backup/own-shards`);
  const manifestStore = new FileManifestStore(`${deps.dataDir}/peer-backup/manifest.json`);

  const identity: Keypair | null = deps.identityPrivKeyHex
    ? (() => {
        const priv = hexToBytes(deps.identityPrivKeyHex);
        return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
      })()
    : null;
  const live = !!(deps.serverId && identity && deps.controlPlaneBaseUrl);

  let backupLoop: BackupLoop | null = null;
  if (deps.swkHex) {
    const swk = hexToBytes(deps.swkHex.trim());
    const shipping =
      live && deps.serverId && identity && deps.controlPlaneBaseUrl
        ? {
            myServerId: deps.serverId,
            peerProvider: buildLivePeerProvider({
              controlPlaneBaseUrl: deps.controlPlaneBaseUrl,
              myServerId: deps.serverId,
              mySTK: identity,
              onLog: (m) => console.log(`[peer-backup] ${m}`),
            }),
            pusher: buildHttpShardPusher({ myServerId: deps.serverId, mySTK: identity }),
            registry,
            ownShards,
            manifestStore,
            uploadManifest: (m: BackupManifest) =>
              uploadBackupManifest(
                {
                  controlPlaneBaseUrl: deps.controlPlaneBaseUrl!,
                  serverId: deps.serverId!,
                  mySTK: identity,
                  swk,
                },
                m,
              ),
            onLog: (m: string) => console.log(`[peer-backup] ${m}`),
          }
        : undefined;
    backupLoop = new BackupLoop({ swk: deps.swkOps!, k: 3, n: 5, ...(shipping ? { shipping } : {}) });
  }

  const framesOpts: PbFramesHandlerOptions | null =
    live && deps.serverId && identity && deps.controlPlaneBaseUrl
      ? {
          myServerId: deps.serverId,
          mySTK: identity,
          store: peerPool,
          registry,
          resolveCallerStk: buildComStkResolver({ controlPlaneBaseUrl: deps.controlPlaneBaseUrl }),
          onShardAccepted: (info) => backupLoop?.recordHostedBytes(info.sizeBytes),
        }
      : null;
  const pbFramesHandler = buildPbFramesRuntimeHandler(() => framesOpts);

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

  return { backupLoop, repairAccumulator, repairScheduler, pbFramesHandler };
}

interface BffStores {
  companionTicketStore: InMemoryCompanionTicketStore;
  companionWriteRequestStore: InMemoryCompanionWriteRequestStore;
}

/**
 * The in-memory BFF ledgers that the Screens-BFF (and, when wired, the signed
 * surfaces) share: P14 companion-dock tickets +
 * P14-Phase-2 write-relay queue. Each must be a single shared instance.
 */
function wireBffStores(): BffStores {
  return {
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
  const identityRotateHandle = buildIdentityRotateHandlers({
    gate: deps.pairedSessions,
    pendingPath: defaultPendingIdentityPath(deps.dataDir),
  });

  const additionalHandlers: Array<(req: HttpRequest) => Promise<HttpResponse | null>> = [];
  if (deps.browserBundle) additionalHandlers.push(deps.browserBundle.apiHandle);
  additionalHandlers.push(alertInboxHandle);
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
  custodian: KeyCustodian;
  reportStatus: StatusReporter;
}): Promise<EntitlementBundle> {
  const { env, cfg, dataDir, identityKeypair, custodian, reportStatus } = deps;
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
    // A bundle for another name or key is just as useless: a box that took
    // over a migrated server's name restarts holding the bundle for its OLD
    // name, and kept crash-looping on the check below.
    if (loaded && cfg && !bundleFitsBox(loaded, { serverFqdn: env.serverFqdn, identityPub: identityKeypair.publicKey })) {
      console.warn(
        `[daemon] on-disk entitlement names ${loaded.rootEntitlement.podCanonical}, not this server (${env.serverFqdn}) and its key; discarding and requesting one from the phone`,
      );
      loaded = null;
    }
    if (
      loaded &&
      cfg &&
      !authorizeSensitiveOrder({
        order: loaded.rootEntitlement,
        signature: loaded.rootEntitlementSig,
        verify: verifyRootEntitlement,
        ownerIrkPub: cfg.irkPublicKey,
        // Slice D — the entitlement anchor is the admin master root when pinned;
        // absent ⇒ legacy owner-IRK (a strict no-op on pre-wipe boxes).
        ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
        username: cfg.userId,
      })
    ) {
      console.warn(
        "[daemon] on-disk entitlement is not authorized (admin root / owner IRK; the hub would reject it at HELLO); discarding and requesting one from the phone",
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
      const deposited = await restarts.guard(() => claimEntitlementDeposit({
        serverDomain: env.serverFqdn,
        ownerIrkPub: cfg.irkPublicKey,
        ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
        username: cfg.userId,
        stkPub: identityKeypair.publicKey,
        controlPlaneBaseUrl: env.controlPlaneBaseUrl,
        entitlementBundlePath,
        onLog: (m) => console.log(m),
      }));
      if (deposited) {
        loaded = deposited;
      } else {
        console.log(
          `[daemon] no deposited entitlement; requesting one from the phone via ${env.controlPlaneBaseUrl} (awaiting-entitlement)`,
        );
        // The awaiting-entitlement handoff is covered by the `pairing` status
        // report fired once the bundle loads below — no separate UI phase.
        const relayed = await restarts.guard(() => fetchEntitlementViaRelay({
          serverDomain: env.serverFqdn,
          signer: custodian,
          ownerIrkPub: cfg.irkPublicKey,
          ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
          username: cfg.userId,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl,
          entitlementBundlePath,
          onLog: (m) => console.log(m),
        }));
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
  frontPage: FrontPageStore;
  activityLog: ActivityLog;
  restoreWait: RestoreWait | null;
  backupPolicy: BackupPolicyStore | null;
  migratePause: MigratePause | null;
  peerEngine: PeerBackupEngine | null;
  peerCapRef: { current: { reservedForPeersBytes(): number | null } | null };
  serviceAccessRef: { current: ServiceAccessStore | null };
  accessPrincipals: AccessPrincipals;
  accessSyncRef: { current: AccessSync | null };
  serverOrder: ServerOrderHolder | null;
  runtime: DaemonRuntime;
  cfg: ServerConfig | null;
  env: RuntimeEnv;
  dataDir: string;
  swkHex: string | null;
  identityKeypair: Keypair;
  custodian: KeyCustodian;
  pairedSessions: FilePairedSessionStore;
  browserBundle: BrowserBundle | null;
  alertInbox: InMemoryAlertInbox;
  backupLoop: BackupLoop | null;
  repairAccumulator: RepairStatsAccumulator;
  companionTicketStore: InMemoryCompanionTicketStore;
  companionWriteRequestStore: InMemoryCompanionWriteRequestStore;
  pullStateStore: FileAppPullStateStore;
  updateClient: UpdateClient;
  updateScheduler: UpdateScheduler;
  liveCertInfoRef: {
    current: { notAfter?: number; notBefore?: number; sans?: string[] } | null;
  };
  liveCertPemRef: { current: string | null };
}): Promise<void> {
  const {
    runtime,
    cfg,
    env,
    dataDir,
    swkHex,
    identityKeypair,
    custodian,
    pairedSessions,
    browserBundle,
    alertInbox,
    backupLoop,
    repairAccumulator,
    companionTicketStore,
    companionWriteRequestStore,
    pullStateStore,
    updateClient,
    updateScheduler,
    liveCertInfoRef,
    liveCertPemRef,
  } = deps;

  // Wire vibe-code (legacy /api/llm/sessions) + the BFF /api/screens/*
  // surface now that runtime.servicePlatform / appBackup / urlController
  // are populated. Both surfaces are paired-session gated.
  // Saved under the data dir so an update or reboot doesn't end open builds.
  const vibeRegistry = new VibeCodeSessionRegistry(
    fileVibeCodeSessionStore(join(dataDir, "vibe-sessions")),
    {
      onLog: (m) => console.warn(m),
      onDelete: (id) => void llmCredentials.forget(id).catch(() => {}),
    },
  );
  process.on("exit", () => vibeRegistry.flush());
  // Names are held by open AI chats and by git imports not yet deployed;
  // every name check reads both. The build orchestrator is made further down.
  const buildNameHoldersRef: { current: NameHolders | null } = { current: null };
  // The services open IDE / git builds are changing (their "Editing" pill).
  const buildEditingRef: { current: (() => string[]) | null } = { current: null };
  const nameHolders = combineNameHolders(vibeRegistry, {
    holderOf: (name, exceptId) => buildNameHoldersRef.current?.holderOf(name, exceptId),
  });
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
  // An installed service's current code, when it can be edited here: built on
  // this box (the owner is its creator) and still installed.
  const editableService = async (serviceId: string): Promise<EditableService> => {
    const app = runtime.servicePlatform?.byServiceId(serviceId);
    if (!app) return { ok: false, status: 404, reason: "That service isn't installed." };
    if (app.creator !== username) {
      return { ok: false, status: 403, reason: "Only services made on this server can be edited here." };
    }
    const src = await readServiceSource(vibeAppDir, serviceId);
    if (!src.ok) return { ok: false, status: 422, reason: src.reason };
    return { ok: true, serviceId, slug: app.slug, files: src.files, bytes: src.bytes };
  };
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
    name?: string;
  }): void => {
    const preview = a.text.length > 120 ? `${a.text.slice(0, 117)}…` : a.text;
    void buildJournal
      .append(a.sessionId, {
        mode: "scratch",
        kind: "user-message",
        actor: "owner",
        summary: preview.length > 0 ? preview : "(no text)",
        ...(a.name ? { name: a.name } : {}),
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
  // Both take the custodian's SwkOps slice (never the raw SWK). Construction is
  // safe even on a platform-less box (no SWK provisioned) — the ops only throw
  // if actually invoked, and the build surfaces that would invoke them are
  // themselves gated on an SWK-backed ServicePlatform.
  // Relay-on keys (the default) reach providers through the Flagship hub
  // over the tunnel, TLS end to end: the provider sees Flagship's address.
  const llmHarness = new LlmHarness({
    swk: custodian.asSwkOps(),
    relay: providerRelay({ connector: runtime.outboundRelay }),
  });
  const llmCredentials = new FileBuildCredentialStore(
    join(dataDir, "llm-credentials"),
    custodian.asSwkOps(),
  );
  await llmCredentials.load();
  vibeRegistry.sweep();
  setInterval(() => vibeRegistry.sweep(), 60 * 60_000).unref();
  const defaultLlmModels = defaultModelsFromEnv(process.env);
  // What any AI (the box's own, or an IDE) may read back: nothing that
  // names the owner, the box or its other apps.
  const modelRedactor = buildModelRedactor(() => ({
    username,
    serverFqdn: env.serverFqdn,
    extra: (runtime.servicePlatform?.list() ?? []).map((a) => a.serviceId),
  }));
  // The tool-calling model call an AI build's staged loop drives, with the
  // build's (or chat session's) transient BYOK key opened just-in-time.
  // Model names, context sizes and capabilities, from .com's public catalog.
  const modelCatalog = new ModelCatalog({ baseUrl: env.controlPlaneBaseUrl ?? "https://flagshipserver.com" });
  // A chat session's chosen model and effort carry into its staged fix loop.
  const sessionChoice = (buildId: string): { model?: string; effort?: string } => {
    const meta = vibeRegistry.get(buildId)?.meta;
    return { ...(meta?.model ? { model: meta.model } : {}), ...(meta?.effort ? { effort: meta.effort } : {}) };
  };
  const agentModel = (provider: string, buildId: string, requested?: string): string =>
    modelForProvider(provider, requested && requested.length > 0 ? requested : sessionChoice(buildId).model, defaultLlmModels);
  const buildAgentRunner: AgentRunner = Object.assign(
    async (buildId: string, req: ChatRequest) => {
      const credential = await llmCredentials.get(buildId);
      if (!credential) throw new Error("AI adapt not configured");
      const effort = req.reasoningEffort ?? sessionChoice(buildId).effort;
      return llmHarness.chatWithCredential(credential, {
        ...req,
        model: agentModel(credential.provider, buildId, req.model),
        ...(effort ? { reasoningEffort: effort } : {}),
      });
    },
    {
      contextTokens: async (buildId: string) => {
        const credential = await llmCredentials.get(buildId);
        if (!credential) return undefined;
        return modelCatalog.contextTokens(credential.provider, agentModel(credential.provider, buildId));
      },
    },
  );
  // The private copy every AI build deploys to and tests before it goes
  // live (docs/ai-privacy-and-staging.md §2). Never routed from the internet.
  const serviceRunnerMod = await import("./serviceRunner.js");
  const stagingRunner = new StagingRunner({
    cmd: serviceRunnerMod.realCommandRunner,
    workingDir: vibeAppDir,
    dataProvisioner: runtime.dataProvisioner,
    runSql: runtime.dataProvisioner ? runAppSql : null,
    sql: runtime.dataProvisioner ? appSqlRunner() : null,
    startCheck: serviceRunnerMod.buildStartCheck(serviceRunnerMod.realCommandRunner),
    fenced: () => runtime.egress.status().enforced,
    unfencedBecause: () => runtime.egress.status().reason,
  });
  void stagingRunner.sweep();
  const ownerEnvNames = async (serviceId: string): Promise<string[]> =>
    runtime.envStore ? runtime.envStore.names(serviceId).catch(() => []) : [];

  const directDeploySession = runtime.servicePlatform
    ? buildDeploySession({
        servicePlatform: runtime.servicePlatform,
        signer: custodian,
        hostUsername: username,
        workingDir: vibeAppDir,
        cmd: (await import("./serviceRunner.js")).realCommandRunner,
        forgejoAdmin,
        registry: nameHolders,
        activity: runtime.serviceActivity,
        restrictToInvited: async (serviceId) => {
          const accessStore = deps.serviceAccessRef.current;
          if (!accessStore?.knowsOwner()) {
            console.warn(`[vibe] ${serviceId} stays open: no owner key pinned to let the owner through an invite-only gate`);
            return false;
          }
          await accessStore.setMode(serviceId, "restricted");
          return true;
        },
      })
    : undefined;
  // The owner's Deploy of an AI chat: staged first (the session's AI may fix
  // a copy that won't start), sealed, then the tested image goes live.
  const deploySession = directDeploySession
    ? buildStagedChatDeploy({
        deploy: directDeploySession,
        staging: stagingRunner,
        journal: buildJournal,
        agentRunner: buildAgentRunner,
        hasCredential: (id) => llmCredentials.has(id),
        forgetCredential: (id) => llmCredentials.forget(id),
        redact: modelRedactor,
        envNames: ownerEnvNames,
        hostUsername: username,
      })
    : undefined;
  const vibeCodeHandle = buildVibeCodeHttpHandlers({
    registry: vibeRegistry,
    gate: pairedSessions,
    username,
    serverFqdn: env.serverFqdn,
    deploySession,
    recordScratchTurn,
    credentials: llmCredentials,
    onCredentialReplaced: ({ sessionId, provider, relay }) => {
      void buildJournal
        .append(sessionId, {
          mode: "scratch",
          kind: "build-phase",
          actor: "owner",
          summary: `the deploy uses a new AI key (${provider}, relay ${relay ? "on" : "off"})`,
        })
        .catch(() => {});
    },
    // Resume-after-reply is wired below where the streaming thunks are built
    // (the screens BFF reply path carries it); see `vibeCode.resumeStreaming`.
    // The legacy /api/llm/sessions surface is not the phone's path.
  });
  runtime.addHandler(vibeCodeHandle);

  // W10 — whenever a build needs the owner (a vibe-code session waiting on
  // a tool response, an IDE build asking for an env var), wake the phone
  // through .com's push relay. Content-free (ownerWake.ts): category
  // `generic`, a marker body, nothing about which build or what it asks.
  const wakeOwnerForBuild = buildOwnerWake({
    owner: () => cfg?.userId ?? null,
    signer: custodian,
    controlPlaneBaseUrl: env.controlPlaneBaseUrl,
    log: (l) => console.log(l),
  });
  vibeRegistry.setNotifyOwner(({ sessionId, kind, toolUseId }) => {
    // eslint-disable-next-line no-console
    console.log(`[vibecode] session=${sessionId} tool=${kind} toolUseId=${toolUseId} → waking the owner`);
    // #91 — queue a value-free AI-chat alert on the SAME phone-pollable
    // AlertInbox the rest of the daemon→phone events ride. The phone's
    // foreground long-poll (GET /api/phone/alerts) drains it, raises a
    // LOCAL notification, and surfaces the session in the operations sliver
    // with a deep link into the chat. The push opens the app to drain it.
    alertInbox.emit({
      kind: "ai-chat-needs-you",
      serviceId: sessionId,
      request: kind,
      toolUseId,
    });
    void wakeOwnerForBuild();
  });

  // ---- Build modes: git import + MCP (the two new create-service
  // sources beyond scratch). They share ONE journal with scratch so the
  // "your builds" list + the journal viewer span every mode. The deploy
  // path is the same artifact deployer (harness-only Forgejo push,
  // docker build, signed install) all modes funnel through.
  // Anonymous, and read from the public store: see adapterIndex.ts.
  // FLAGSHIP_ADAPTER_INDEX=off keeps every import and adapt on the box.
  const adapterIndex =
    process.env.FLAGSHIP_ADAPTER_INDEX === "off"
      ? undefined
      : httpAdapterIndex({
          ...(process.env.FLAGSHIP_ADAPTER_STORE ? { store: process.env.FLAGSHIP_ADAPTER_STORE } : {}),
          submitTo: env.controlPlaneBaseUrl ?? "https://flagshipserver.com",
        });
  const adapterOrigins = new FileAdapterOrigins(join(dataDir, "data", "adapter-origins.json"));
  await adapterOrigins.load().catch((e) => console.warn(`[adapters] origins unreadable: ${(e as Error).message}`));
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
    const artifacts = buildArtifactPipeline({
      servicePlatform: runtime.servicePlatform,
      signer: custodian,
      hostUsername: username,
      workingDir: vibeAppDir,
      cmd: realCmd,
      forgejoAdmin,
      journal: buildJournal,
      registry: nameHolders,
      activity: runtime.serviceActivity,
    });
    const buildOrchestrator = new BuildOrchestrator({
      // Git and IDE builds survive a restart (an update causes one).
      store: fileBuildStore(join(dataDir, "data", "builds")),
      modelRedactor,
      journal: buildJournal,
      gitImporter,
      mcpKeys,
      editableService,
      deployArtifact: artifacts.deploy,
      // AI builds deploy to a private staging copy, and go live with the
      // image they tested once sealed (their AI key forgotten).
      installArtifact: artifacts.install,
      staging: stagingRunner,
      forgetCredential: (buildId) => llmCredentials.forget(buildId),
      ownerEnvNames,
      names: () => ({ registry: nameHolders, hostUsername: username, installed: runtime.servicePlatform ?? null }),
      ...(adapterIndex ? { adapterIndex } : {}),
      recordAdapterOrigin: (serviceId, origin) => adapterOrigins.set(serviceId, origin),
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
          model: modelForProvider(credential.provider, model, defaultLlmModels),
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
      agentRunner: buildAgentRunner,
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
      // Same content-free wake as the vibe-code hook above. The callback
      // only ever sees the build id + the env NAME; neither leaves the box.
      notifyOwner: ({ buildId, name }) => {
        // eslint-disable-next-line no-console
        console.log(`[build] build=${buildId} env-requested=${name} → waking the owner`);
        void wakeOwnerForBuild();
      },
    });
    const restoredBuilds = await buildOrchestrator.restore().catch((e: Error) => {
      console.warn(`[build] could not read the saved builds: ${e.message}`);
      return 0;
    });
    if (restoredBuilds > 0) console.log(`[build] brought back ${restoredBuilds} git/IDE build(s)`);
    process.once("SIGTERM", () => void buildOrchestrator.flush());
    buildNameHoldersRef.current = buildOrchestrator;
    buildEditingRef.current = () => buildOrchestrator.editingServiceIds();
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
    return session ? serviceIdForSession(session) : null;
  };
  // The service a session builds or changes: `<creator>--<slug>`, the same id
  // the env store and the platform key it by.
  function serviceIdForSession(session: VibeCodeSession): string | null {
    if (session.meta.editsServiceId) return session.meta.editsServiceId;
    if (session.meta.name) return `${username}--${session.meta.name}`;
    const mj = session.manifestJson();
    if (!mj) return null;
    try {
      const m = JSON.parse(mj) as { name?: unknown };
      if (typeof m.name === "string" && m.name.length > 0) {
        return `${username}--${m.name.toLowerCase()}`;
      }
    } catch {
      // ignore malformed mid-stream JSON
    }
    return null;
  }

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
        defaultModels: defaultLlmModels,
        contextTokens: (provider: string, model: string) => modelCatalog.contextTokens(provider, model),
        modelEfforts: (provider: string, model: string) => modelCatalog.efforts(provider, model),
        redact: modelRedactor,
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

  // Access requests (docs/ai-privacy-and-staging.md §3a): a new one reaches
  // an open owner app on the screens socket, and wakes the phone through
  // .com's push relay with nothing about which app or host, unless the owner
  // turned alerts off (then nothing leaves the box).
  const screensEvents = new ScreensEventBus();
  const accessAlertSetting = await AccessAlertSetting.load(
    join(dataDir, "data", "access-alerts.json"),
    (m) => console.warn(m),
  );
  const accessPushCfg = cfg;
  runtime.egress.setAccessAlerts({
    emit: (e) => screensEvents.publish(e),
    alertsEnabled: () => accessAlertSetting.enabled(),
    ...(accessPushCfg
      ? {
          push: () =>
            sendPushRelay({
              category: "generic",
              targetUsername: accessPushCfg.userId,
              signer: custodian,
              controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
              logTag: "[egress] access alert push",
              log: (l) => console.log(l),
            }),
        }
      : {}),
  });

  // The backup policy's size limit: measured like a backup sizes itself,
  // refreshed every 10 minutes and after app changes, and checked before any
  // new app, copy or import comes onto this server.
  const backupCap = (() => {
    const platform = runtime.servicePlatform;
    if (!deps.backupPolicy || !platform) return null;
    const ops = realAppCopyOps();
    const cap = new BackupCap({
      policy: deps.backupPolicy,
      // The quota manager's own numbers where it has them (statfs of each
      // files image, pg_database_size), so the budgets and their enforcement
      // count the same bytes.
      measure: async () =>
        withQuotaUsage(
          await measureAppArchiveBytes({ apps: () => platform.list(), ops, sourceDir: vibeAppDir, log: (m) => console.log(m) }),
          runtime.appQuota.measured(),
        ),
      diskBytes: async () => {
        const s = await statfs(join(dataDir, "data")).catch(() => statfs(dataDir));
        return Number(s.blocks) * Number(s.bsize);
      },
      note: (kind, detail, ok) => deps.activityLog.note(kind, detail, { ok: ok ?? true }),
      log: (m) => console.log(m),
    });
    platform.setAdmitNewApp(() => cap.admit());
    void cap.refresh();
    setInterval(() => void cap.refresh(), 10 * 60_000).unref();
    // A new limit holds at once: re-measure, then re-apply every app's share.
    deps.backupPolicy.onChange(() => void cap.refresh().then(() => runtime.appQuota.kick()));
    runtime.appQuota.setBudgets(
      () => cap.appBudgets(),
      () => {
        const limit = cap.limitBytes();
        const used = cap.usedBytes();
        return limit === null || used === null ? null : limit - used;
      },
    );
    return cap;
  })();
  const backupPolicyHttp =
    deps.backupPolicy && backupCap
      ? buildBackupPolicyHttp({
          policy: deps.backupPolicy,
          cap: backupCap,
          note: (kind, detail, ok) => deps.activityLog.note(kind, detail, { ok: ok ?? true }),
        })
      : null;
  deps.peerCapRef.current = backupCap;
  const peerEngine = deps.peerEngine;
  if (peerEngine) backupPolicyHttp?.setPeerStatus(() => peerEngine.policyStatus());
  // Per-app disk limits (docs/app-runtimes.md §5.3): an app that fills up
  // is an Activity entry, a phone alert and a content-free wake.
  runtime.appQuota.setEvents(
    quotaNotices({
      note: (kind, detail, o) => deps.activityLog.note(kind, detail, o),
      alert: (a) => void deps.alertInbox.emit(a),
      ...(accessPushCfg
        ? {
            wake: () =>
              sendPushRelay({
                category: "generic",
                targetUsername: accessPushCfg.userId,
                signer: custodian,
                controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
                logTag: "[app-quota] storage push",
                log: (l) => console.log(l),
              }),
          }
        : {}),
    }),
  );

  // Copying an app between the account's servers (docs/app-placement.md §5):
  // this box as source (the public export endpoint) and as target (the
  // screens endpoints + the apps-list rows while a copy runs).
  const appCopyTarget = await (async () => {
    const platform = runtime.servicePlatform;
    if (!cfg || !platform || !env.controlPlaneBaseUrl) return null;
    const authority = {
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
      username: cfg.userId,
    };
    const ops = realAppCopyOps();
    const envKey = custodian.hasCgk ? (info: Uint8Array) => custodian.deriveAppCopyEnvKey(info) : null;
    const source = buildAppCopySource({
      ...authority,
      serverFqdn: env.serverFqdn,
      app: (id) => runtime.servicePlatform?.byServiceId(id),
      containerName: (id) => `flagship-${id}`,
      ops,
      resolveCallerKey: buildComStkResolver({ controlPlaneBaseUrl: env.controlPlaneBaseUrl }),
      workDir: join(dataDir, "data", "app-copy-out"),
      sourceDir: vibeAppDir,
      envKey,
      envStore: runtime.envStore,
      access: { exportEntry: (id) => deps.serviceAccessRef.current?.exportEntry(id) ?? null },
      accessList: (id) => runtime.egress.exportList(id),
      ledger: new DbWriteLedger(join(dataDir, "data", "app-copy-exports.json"), undefined, 60 * 60_000),
      lanEndpoints: () => runtime.lan?.endpoints() ?? [],
      log: (m) => console.log(m),
    });
    await source.init();
    runtime.addHandler(source.handle);
    const store = new AppCopyStore(join(dataDir, "data", "app-copies.json"));
    const interrupted = await store.load();
    const target = buildAppCopyTarget({
      ...authority,
      serverFqdn: env.serverFqdn,
      platform,
      ...(backupCap ? { admitIncoming: (bytes: number) => backupCap.admit(bytes) } : {}),
      dataProvisioner: runtime.dataProvisioner,
      store,
      ops,
      signAsBox: (msg) => custodian.signAsBox(msg),
      signInstall: (req) => custodian.signInstallService(req),
      workDir: join(dataDir, "data", "app-copy-in"),
      sourceDir: vibeAppDir,
      envKey,
      envStore: runtime.envStore,
      access: {
        importEntry: async (id, e) => {
          await deps.serviceAccessRef.current?.importEntry(id, e);
          // A copy starts from the source's list; the app's leader has the latest.
          void deps.accessSyncRef.current?.catchUp(id).catch(() => {});
        },
      },
      egress: { noteCopied: (id, list, declared) => runtime.egress.noteCopied(id, list, declared) },
      ledger: new DbWriteLedger(join(dataDir, "data", "app-copy-orders.json"), undefined, 60 * 60_000),
      // A box kept relay-only (FLAGSHIP_LAN_DIRECT=0) fetches through the relay too.
      ...(runtime.lan
        ? { ownLanAddresses: () => [...(runtime.lan?.endpoints().map((e) => e.address) ?? []), ...hostAddresses()] }
        : { lanFetch: null }),
      log: (m) => console.log(m),
    });
    void target.recover(interrupted).catch((e: Error) => console.warn(`[app-copy] recovery failed: ${e.message}`));
    return target;
  })();

  // "Backup/clone server": one sealed archive of every app, downloadable, and
  // importable onto any server of the account under any name.
  const serverArchiveService = await (async () => {
    const platform = runtime.servicePlatform;
    if (!cfg || !platform || !env.serverFqdn) return null;
    const ops = realAppCopyOps();
    const service = buildServerArchiveService({
      dir: join(dataDir, "archives"),
      uploadDir: join(dataDir, "restore-upload"),
      wait: deps.restoreWait,
      serverSettings: installSettingsFromInstallBlob,
      build: {
        serverFqdn: env.serverFqdn,
        apps: () => platform.list(),
        containerName: (id) => `flagship-${id}`,
        ops,
        envStore: runtime.envStore,
        access: { exportEntry: (id) => deps.serviceAccessRef.current?.exportEntry(id) ?? null },
        accessList: (id) => runtime.egress.exportList(id),
        sourceDir: vibeAppDir,
        apiKeys: runtime.appApiKeyStore,
        frontPage: () => deps.frontPage.get(),
        log: (m) => console.log(m),
      },
      restore: {
        serverFqdn: env.serverFqdn,
        platform,
        dataProvisioner: runtime.dataProvisioner,
        ops,
        signInstall: (req) => custodian.signInstallService(req),
        envStore: runtime.envStore,
        access: {
          importEntry: async (id, e) => {
            await deps.serviceAccessRef.current?.importEntry(id, e);
          },
        },
        egress: { noteCopied: (id, list, declared) => runtime.egress.noteCopied(id, list, declared) },
        sourceDir: vibeAppDir,
        // No image travels in a backup: rebuild here with this box's runtime
        // catalog, exactly as a deploy builds (the same sandboxed docker build).
        buildImage: async (a) => {
          await ensureDocker();
          return buildAppImage(serviceRunnerMod.realCommandRunner, { ...a, keepBinaries: false });
        },
        pullImage: async (image) => {
          await ensureDocker();
          await serviceRunnerMod.realCommandRunner.run("docker", ["pull", image]);
        },
        ...(runtime.apiKeyAuthority
          ? {
              apiKeys: {
                importService: (id: string, keys: unknown) =>
                  runtime.appApiKeyStore.importService(id, keys, runtime.apiKeyAuthority!, env.serverFqdn),
              },
            }
          : {}),
        frontPage: {
          get: () => deps.frontPage.get(),
          set: (label: string) => deps.frontPage.set(label),
          installed: (label: string) => platform.byLabel(label) !== undefined,
        },
        log: (m) => console.log(m),
      },
      note: (kind, detail, ok) => deps.activityLog.note(kind, detail, { ok: ok ?? true }),
      // A browser download needs the owner's signed approval (QR + Face ID).
      authorizeDownload: (approval, sig) =>
        authorizeSensitiveOrder({
          ownerIrkPub: cfg.irkPublicKey,
          ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
          username: cfg.userId,
          order: approval,
          signature: sig,
          verify: verifyArchiveDownloadApproval,
        }),
      // Saved and scheduled backups; their keys come signed from an admin device.
      saved: {
        dir: join(dataDir, "server-backups"),
        authorizeKeys: (deposit, sig) =>
          authorizeSensitiveOrder({
            ownerIrkPub: cfg.irkPublicKey,
            ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
            username: cfg.userId,
            order: deposit,
            signature: sig,
            verify: verifyArchiveKeysDeposit,
          }),
        // The schedule runs unless the policy is "No backups": the phone fetches its backups,
        // and the peer engine builds its bricks from them.
        scheduleActive: () => {
          const p = deps.backupPolicy?.current().policy ?? "unset";
          return p !== "none";
        },
      },
      ...(backupCap ? { admitIncoming: (bytes: number) => backupCap.admit(bytes) } : {}),
      ...(deps.migratePause ? { migrate: { pause: deps.migratePause } } : {}),
      ...(env.controlPlaneBaseUrl ? { appLinkBase: env.controlPlaneBaseUrl } : {}),
      log: (m) => console.log(m),
    });
    await service.init();
    // While a move has the apps paused, every app URL says so instead of a 502.
    const pause = deps.migratePause;
    if (pause) {
      runtime.addAppGate(async () => (pause.paused() ? movingPage() : null));
      setInterval(() => void pause.sweep().catch(() => {}), 10 * 60_000).unref();
    }
    service.startSchedule(
      (() => {
        const raw = Number(process.env.FLAGSHIP_BACKUP_SCHEDULE_TICK_MS);
        return Number.isFinite(raw) && raw >= 1_000 ? raw : 5 * 60_000;
      })(),
    );
    // The backup's download link carries its own token (no session), so a
    // browser or download manager can fetch it straight to disk.
    runtime.addHandler((req) => service.handleDownload(req));
    return service;
  })();
  if (peerEngine && serverArchiveService) {
    serverArchiveService.setSavedHooks({
      onArchiveSaved: (meta, files) => peerEngine.onArchiveSaved(meta, files),
      pinnedArchiveIds: () => peerEngine.pinnedArchiveIds(),
    });
    // A new server restoring a lost one from its pieces on other servers.
    serverArchiveService.setPeerFetcher((w) =>
      peerEngine.fetchArchive({ ...w, ...(w.onProgress ? { onProgress: (done: number) => w.onProgress!(done) } : {}) }),
    );
  }
  peerEngine?.start();

  // Share this server (docs/share-a-server.md): another account's per-share
  // sessions, gated by level on every screens route, and the activity log.
  const sharesBundle = await (async () => {
    if (!cfg || !env.serverFqdn) return null;
    const authority = {
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
      username: cfg.userId,
    };
    const store = new ShareStore(defaultShareStorePath(dataDir), {
      serverDomain: env.serverFqdn,
      verifyOwnerGrant: (g, sig) =>
        authorizeSensitiveOrder({ ...authority, order: g, signature: sig, verify: verifyServerShareGrant }),
      // Only an admin device of the joining account accepts: its proof is
      // checked against the maintainer CA chain this box ships with.
      verifyAcceptAdmin: (accept, proof) => {
        let chain = null;
        try {
          chain = caTrustChainFromFolder({ gitRepoPath: process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship" });
        } catch {
          chain = null;
        }
        return checkShareAcceptAdmin({ accept, proof, chain, now: Date.now() });
      },
    });
    const { dropped } = await store.load();
    if (dropped > 0) console.warn(`[shares] dropped ${dropped} share(s) that no longer verify`);
    // A co-manager's devices are Manager in every app by default.
    deps.accessPrincipals.shares = () =>
      store.list().map((h) => ({ shareId: h.grant.shareId, memberPubHex: h.grant.memberPubHex, label: h.grant.label, level: h.grant.level }));
    const sessions = new ShareSessionStore(defaultShareSessionPath(dataDir));
    await sessions.load();
    const activity = deps.activityLog;
    const verifyOwnerRevoke = (r: ServerShareRevoke, sig: Uint8Array) =>
      authorizeSensitiveOrder({ ...authority, order: r, signature: sig, verify: verifyServerShareRevoke });
    // A co-manager's update order takes the owner's gates (shares/shareUpdate.ts).
    const repoPath = process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship";
    const serverUpdate = existsSync(join(repoPath, ".git"))
      ? (() => {
          const releaseGate = selfUpdateReleaseGate(repoPath);
          const pendingStore = filePendingVerifyStore(`${dataDir}/update-pending.json`);
          return buildShareUpdate({
            gate: {
              serverDomain: env.serverFqdn,
              repoPath,
              runner: realUpdateCommandRunner,
              usedNonceStore: fileUsedNonceStore(`${dataDir}/update-used-nonces.json`),
              onLog: (m) => console.log(m),
            },
            pendingStore,
            verifyOwnerGrant: (g, sig) =>
              authorizeSensitiveOrder({ ...authority, order: g, signature: sig, verify: verifyServerShareGrant }),
            apply: (from, target, why) =>
              applyEndorsedUpdate(
                {
                  repoPath,
                  releaseGate,
                  runner: realUpdateCommandRunner,
                  pendingStore,
                  requestExit: () => {
                    console.log("[self-update] restarting into the update a co-manager ordered");
                    process.exit(0);
                  },
                  onLog: (m) => console.log(m),
                },
                from,
                target,
                why,
              ),
            outcomeStore: fileUpdateOutcomeStore(`${dataDir}/update-outcome.json`),
            activity,
          });
        })()
      : null;
    // A co-manager's invites to the apps (shares/shareInvites.ts).
    const inviteStore = new ShareInviteStore(defaultShareInviteStorePath(dataDir));
    await inviteStore.load();
    const invites = env.controlPlaneBaseUrl
      ? buildShareInvites({
          serverDomain: env.serverFqdn,
          username: cfg.userId,
          ownerAidHex: cfg.ownerAidPub ? bytesToHexStr(cfg.ownerAidPub) : null,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl,
          stk: identityKeypair,
          store: inviteStore,
          access: () => deps.serviceAccessRef.current,
          installed: (ref) => (runtime.servicePlatform?.list() ?? []).some((a) => a.serviceId === ref),
          record: (ref, e) => deps.accessSyncRef.current?.record(ref, e),
          activity,
          log: (m) => console.log(m),
        })
      : null;
    const shares = buildShares({
      serverDomain: env.serverFqdn,
      store,
      sessions,
      activity,
      verifyOwnerRevoke,
      isCompanion: (req) => pairedSessions.isCompanionRequest(req),
      serverUpdate,
      invites,
    });
    runtime.addHandler(shares.handlePublic);
    if (env.controlPlaneBaseUrl) {
      const poller = startShareEndsPoller({
        serverDomain: env.serverFqdn,
        controlPlaneBaseUrl: env.controlPlaneBaseUrl,
        store,
        shares,
        verifyOwnerRevoke,
      });
      process.once("SIGTERM", () => poller.stop());
      process.once("SIGINT", () => poller.stop());
    }
    console.log(`[shares] ${store.list().length} active share(s)`);
    return { shares, gate: shares.gate(pairedSessions) };
  })();

  // Owner debug access (docs/recipe-delivery-and-remote-install.md "Debug
  // access"): an admin-signed SSH key let in as `debug` until it ends. Takes
  // the recipe's grant once at first boot, then grants from the server page.
  const debugAccess = cfg
    ? new DebugAccessController({
        serverDomain: env.serverFqdn,
        authority: () => ({
          ownerIrkPub: cfg.irkPublicKey,
          ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
          username: cfg.userId,
          activeGrants: deps.accessPrincipals.book?.adminGrants() ?? [],
        }),
        statePath: join(dataDir, "debug-access.json"),
        legacyMarkerPath: join(dataDir, "debug-access-done.json"),
        system: buildDebugSystem({ runner: realDebugCommandRunner, log: (m) => console.log(m) }),
        installGrant: () => debugGrantFromInstallBlob(),
        activity: (kind, detail) => deps.activityLog.note(kind, detail),
        log: (m) => console.log(m),
      })
    : null;
  void debugAccess?.start();

  const screensHandle = buildScreensHttp({
    debugAccess,
    gate: sharesBundle?.gate ?? pairedSessions,
    shares: sharesBundle?.shares ?? null,
    // An unreadable access state leaves every app members-only (the store's own default).
    accessMode: (serviceId) => {
      const store = deps.serviceAccessRef.current;
      if (!store) return null;
      return store.mode(serviceId) === "open" ? "open" : "members-only";
    },
    appEgress: runtime.egress.appEgress,
    appCopy: appCopyTarget,
    serverArchive: serverArchiveService,
    // The owner's way in when `.com` is gone (docs/data-sovereignty.md): proven by
    // a signed order bound to this box's own certificate, no call to anyone.
    rescue:
      cfg && env.serverFqdn
        ? buildRescue({
            serverFqdn: env.serverFqdn,
            signAsBox: (msg) => custodian.signAsBox(msg),
            certSha256: () => (liveCertPemRef.current ? leafCertSha256(liveCertPemRef.current) : null),
            authorize: (order, signature) =>
              authorizeSensitiveOrder({
                ownerIrkPub: cfg.irkPublicKey,
                ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
                username: cfg.userId,
                order,
                signature,
                verify: verifyRescueSession,
              }),
            archive: serverArchiveService,
            apps: () => (runtime.servicePlatform?.list() ?? []).map((a) => ({ serviceId: a.serviceId, name: a.manifest.name })),
            note: (kind, detail, ok) => deps.activityLog.note(kind, detail, { ok: ok ?? true }),
            log: (m) => console.log(m),
          })
        : null,
    backupPolicy: backupPolicyHttp,
    // The status pill (docs/app-placement.md §6): one `docker ps` for every
    // app, and what's deploying or being edited here.
    appStatus: buildAppStatusReader({
      cmd: serviceRunnerMod.realCommandRunner,
      containerName: (id) => `flagship-${id}`,
    }),
    appActivity: buildActivityResolver({
      tracker: runtime.serviceActivity,
      chats: () => vibeRegistry.list(),
      builds: () => buildEditingRef.current?.() ?? [],
    }),
    appDb:
      cfg && runtime.servicePlatform && runtime.dataProvisioner
        ? {
            handle: buildOwnerDbHttp({
              serverDomain: env.serverFqdn,
              ownerIrkPub: cfg.irkPublicKey,
              ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
              username: cfg.userId,
              app: (id) => {
                const a = runtime.servicePlatform?.byServiceId(id);
                return a ? { data: a.data } : null;
              },
              sql: appSqlRunner(),
              ledger: new DbWriteLedger(join(dataDir, "data", "app-db-writes.json")),
              log: (m) => console.log(m),
            }),
          }
        : null,
    memberRoles: cfg
      ? {
          handle: (path, method, req) => {
            const store = deps.serviceAccessRef.current;
            if (!store) {
              return Promise.resolve({
                status: 503,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ error: "access control isn't ready yet" }),
              });
            }
            return buildMemberRolesHttp({
              serverDomain: env.serverFqdn,
              ownerIrkPub: cfg.irkPublicKey,
              ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
              username: cfg.userId,
              adminGrants: () => deps.accessPrincipals.book?.adminGrants() ?? [],
              onEntry: (ref, e) => deps.accessSyncRef.current?.record(ref, e),
              store,
              app: (id) => {
                const a = runtime.servicePlatform?.byServiceId(id);
                return a ? { manifest: a.manifest } : null;
              },
              log: (m) => console.log(m),
            })(path, method, req);
          },
        }
      : null,
    appApiKeys: runtime.appApiKeys,
    accessAlerts: accessAlertSetting,
    serverOrder: deps.serverOrder,
    serverFqdn: env.serverFqdn,
    username,
    daemonVersion: process.env.FLAGSHIP_DAEMON_VERSION ?? "0.0.0",
    // The applied-commit truth the self-update consumer enforces
    // `fromCommit` against — same checkout the consumer updates. (Its own
    // cached provider; the /api/leads one lives in the outer scope.)
    currentCommit: buildCurrentCommitProvider(
      process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship",
    ),
    releaseCatalog: existsSync(join(process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship", ".git"))
      ? buildReleaseCatalog({
          repoPath: process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship",
          onLog: (m) => console.log(m),
        })
      : null,
    lastUpdate: (() => {
      const store = fileUpdateOutcomeStore(
        `${process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship"}/update-outcome.json`,
      );
      return () => store.readSync();
    })(),
    startedAt: Date.now(),
    servicePlatform: runtime.servicePlatform,
    filesBytes: runtime.dataProvisioner ? (v: string) => runtime.dataProvisioner!.filesBytes(v) : null,
    storage: {
      app: (id: string) => runtime.appQuota.appView(id),
      server: () => runtime.appQuota.serverView(),
    },
    pairedSessions,
    ...(adapterIndex
      ? {
          adapterReports: {
            originOf: (serviceId: string) => {
              const o = adapterOrigins.get(serviceId);
              return o ? { repo: o.repo } : null;
            },
            report: async (serviceId: string, detail: string) => {
              const o = adapterOrigins.get(serviceId);
              if (!o) return false;
              await adapterIndex.complain({ repo: o.repo, file: o.file, stage: "report", detail });
              return true;
            },
          },
        }
      : {}),
    certInfo: () => liveCertInfoRef.current,
    lanHint: () =>
      buildSignedLanHint({
        serverDomain: env.serverFqdn!,
        certPem: liveCertPemRef.current,
        endpoints: runtime.lan?.endpoints() ?? [],
        sign: (msg) => custodian.signAsBox(msg),
      }),
    tabRegistry: browserBundle?.tabRegistry ?? null,
    appBackup: runtime.appBackup,
    urlController: runtime.urlController,
    vibeCode: deploySession
      ? {
          registry: vibeRegistry,
          nameHolders,
          username,
          serverFqdn: env.serverFqdn,
          recordScratchTurn,
          credentials: llmCredentials,
          editableService,
          canEdit: (serviceId: string) =>
            runtime.servicePlatform?.byServiceId(serviceId)?.creator === username &&
            /^[a-z0-9-]+$/.test(serviceId) &&
            existsSync(join(vibeAppDir, serviceId, "flagship.app.json")),
          ...(vibeStartStreaming ? { startStreaming: vibeStartStreaming } : {}),
          ...(vibeResumeStreaming ? { resumeStreaming: vibeResumeStreaming } : {}),
          onProviderSwitched: ({ sessionId, provider }: { sessionId: string; provider: string }) => {
            void buildJournal
              .append(sessionId, {
                mode: "scratch",
                kind: "build-phase",
                actor: "owner",
                summary: `the chat switched to another AI provider (${provider})`,
              })
              .catch(() => {});
          },
          aiModels: (credential: LlmCredential) =>
            modelCatalog.menu(
              credential.provider,
              () => llmHarness.listModels(credential),
              defaultLlmModels[credential.provider],
            ),
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
    peerNet: peerEngine,
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
    installEventLog: {
      recent: () =>
        deps.activityLog
          .recent(200)
          .flatMap((e) => {
            const kind =
              e.kind === "app.installed" ? "installed" : e.kind === "app.removed" ? "uninstalled" : e.kind === "app.updated" ? "deploy" : null;
            return kind && e.target ? [{ at: e.ts, kind, serviceId: e.target, ...(e.detail ? { detail: e.detail } : {}) } as const] : [];
          })
          .slice(0, 20),
    },
    // W10 — per-app env-var KV editor + vibe-code session BFF deps.
    appEnvStore: runtime.envStore,
    // The session's app id (`<creator>--<slug>`): the edited service, else
    // the owner's chosen name, else the manifest's once the AI writes it.
    resolveSessionAppId: (session) => serviceIdForSession(session),
  });
  runtime.addHandler(sharesBundle ? sharesBundle.shares.withActivity(screensHandle) : screensHandle);
  // The archive app-backup/start names; without this every client's fetch 404'd.
  if (runtime.appBackup) {
    runtime.addHandler(
      buildAppBackupHttpHandlers({ backups: runtime.appBackup, gate: sharesBundle?.gate ?? pairedSessions }),
    );
  }
  runtime.addUpgradeHandler(
    buildScreensUpgradeHandler({
      gate: sharesBundle?.gate ?? pairedSessions,
      vibeCodeRegistry: deploySession ? vibeRegistry : null,
      browser: browserBundle?.browser ?? null,
      tabRegistry: browserBundle?.tabRegistry ?? null,
      events: screensEvents,
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
  frontPage: FrontPageStore;
  activityLog: ActivityLog;
  serviceAccessRef: { current: ServiceAccessStore | null };
  accessPrincipals: AccessPrincipals;
  accessSyncRef: { current: AccessSync | null };
  accessPeersRef: { current: AccessPeers | null };
  runtime: DaemonRuntime;
  cfg: ServerConfig | null;
  env: RuntimeEnv;
  autoUnlockSuppressor: AutoUnlockSuppressor;
  hostPowerRunner: HostPowerRunner;
  servicePlatformRef: ServicePlatformRef;
  /** The box's STK (identity) keypair — signs the gating-v2 revocation poll. */
  identityKeypair: Keypair;
  /** Peer-backup loop (null when no SWK) — flushed on a finalBackup decommission. */
  backupLoop: BackupLoop | null;
  /** Migrate's pause: a move on the archive path needs no final flush. */
  migratePause: MigratePause | null;
}): Promise<void> {
  const { runtime, cfg, env, autoUnlockSuppressor, hostPowerRunner, identityKeypair } = deps;
  if (!cfg) return;

  const deadMan = new DeadManController({
    serverId: env.serverFqdn,
    irkPub: cfg.irkPublicKey,
    // Slice D — gate policy/affirm on the pinned admin root when present.
    ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
    username: cfg.userId,
    suppressor: autoUnlockSuppressor,
    runner: hostPowerRunner,
  });
  await deadMan.start();
  runtime.addHandler(buildDeadManHttp(deadMan));
  runtime.addHandler(
    buildPowerHttp({
      serverId: env.serverFqdn,
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
      username: cfg.userId,
      suppressor: autoUnlockSuppressor,
      runner: hostPowerRunner,
    }),
  );
  // Owner-assignable apex: GET/POST /api/front-page + the 302 itself.
  const frontPage = deps.frontPage;
  runtime.addHandler(
    buildFrontPageHttp({
      serverId: env.serverFqdn,
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
      username: cfg.userId,
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
  // M4: if the access-state file is present but unreadable, every app is
  // members-only until an admin opens it again (kept across restarts), the
  // file is set aside and the owner sees it in Activity.
  // The account's devices, verified here (docs/service-access-gating.md
  // "Account members"): refreshed every 5 minutes, and when an unknown key signs.
  const accessDataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
  const deviceBookReader = new BoxReadToken({
    comBaseUrl: env.controlPlaneBaseUrl,
    username: cfg.userId,
    serverFqdn: env.serverFqdn,
    boxPublicKey: () => identityKeypair.publicKey,
    signAsBox: (msg) => ed.sign(msg, identityKeypair.privateKey),
  });
  const deviceBook = new AccountDeviceBook({
    path: `${accessDataDir}/account-devices.json`,
    username: cfg.userId,
    ownerIrkPub: () => cfg.irkPublicKey,
    adminRootPub: () => cfg.adminRootPub,
    ...(cfg.ownerAidPub ? { ownerAidHex: bytesToHexStr(cfg.ownerAidPub) } : {}),
    fetchGrants: async () => {
      const base = env.controlPlaneBaseUrl.replace(/\/+$/, "");
      const r = await deviceBookReader.fetch(`${base}/api/users/${encodeURIComponent(cfg.userId)}/device-grants`);
      return r.ok ? await r.json() : null;
    },
    log: (m) => console.warn(m),
  });
  await deviceBook.load();
  deps.accessPrincipals.book = deviceBook;
  void deviceBook.refresh();
  {
    const t = setInterval(() => void deviceBook.refresh(), 5 * 60_000);
    if (typeof t.unref === "function") t.unref();
  }
  const accessStore = new ServiceAccessStore(`${accessDataDir}/data/flagship-access/service-access.json`, {
    legacyPath: "/var/flagship/service-access.json",
    principals: deps.accessPrincipals,
    serverDomain: env.serverFqdn,
    ...(cfg.ownerAidPub ? { ownerAidHex: bytesToHexStr(cfg.ownerAidPub) } : {}),
    onCorrupt: ({ error }) =>
      console.error(
        `[daemon] service-access state corrupt (${error}); every app is members-only until an admin opens it again`,
      ),
  });
  await accessStore.load();
  deps.serviceAccessRef.current = accessStore;
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
    ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
    adminGrants: () => deviceBook.adminGrants(),
    onEntry: (ref, e) => deps.accessSyncRef.current?.record(ref, e),
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
  {
    // One access list per app across the account's servers (box to box only).
    const cgk = await resolveCgk().catch(() => null);
    const journal = new AccessJournal(`${accessDataDir}/data/flagship-access/access-journal.json`);
    await journal.load();
    const installedIds = () => (deps.servicePlatformRef.current?.list() ?? []).map((a) => a.serviceId);
    const applyRank = buildRankEntryApplier({
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
      username: cfg.userId,
      adminGrants: () => deviceBook.adminGrants(),
      store: accessStore,
      app: (id) => {
        const a = deps.servicePlatformRef.current?.byServiceId(id);
        return a ? { manifest: a.manifest } : null;
      },
    });
    const sync = buildAccessSync({
      selfFqdn: env.serverFqdn,
      journal,
      store: accessStore,
      apply: async (ref, e) => (e.kind === "rank" ? applyRank(ref, e) : access.applyEntry(ref, e)),
      peers: () => deps.accessPeersRef.current,
      key: cgk ? deriveAccessSyncKey(cgk) : null,
      installed: (ref) => installedIds().includes(ref),
      apps: installedIds,
      log: (m) => console.log(m),
    });
    deps.accessSyncRef.current = sync;
    runtime.addHandler(sync.handle);
    sync.start();
    process.once("SIGTERM", () => sync.stop());
  }
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
      verifyRevoke: access.verifyWithdraw,
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
      myStkHex: bytesToHexLocal(identityKeypair.publicKey),
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
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
  // Graceful-decommission (docs/server-replacement-graceful-decommission.md
  // §10 + §9): poll this box's OWN eviction order on the heartbeat cadence. When
  // the owner replaces this server, `.com` deposits an owner-IRK-signed
  // ServerDecommission order naming THIS instance's STK; we verify it under the
  // config-pinned owner IRK (I1), confirm it names our STK (I2), flush a final
  // backup if asked (§9 — rides the STK/namespace, not routing, so it works even
  // after routing is revoked, I3), release routing, and apply the signed disk
  // disposition (keep → power off; wipe-now → wipe + power off; wipe-after-handoff
  // → idle until `.com` confirms the replacement restored, else power off WITHOUT
  // wiping). Idempotent via the `/var/flagship/decommissioned` marker. Best-effort.
  {
    const dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
    const myStkHex = bytesToHexLocal(identityKeypair.publicKey);
    const decommissionPoller = buildDecommissionPoller({
      serverDomain: env.serverFqdn,
      myStkHex,
      ownerIrkPub: cfg.irkPublicKey,
      ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
      username: cfg.userId,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      markerStore: decommissionMarkerStore(`${dataDir}/decommissioned`),
      onEvent: (kind, detail, ok) => deps.activityLog.note(kind, detail, { ok: ok ?? true }),
      // Final-flush (the migration/replacement FINAL DELTA): DUMP the data
      // stores (consistent dumps, services still LIVE — pg_dumpall / sqlite
      // .backup can't run against a stopped container), THEN quiesce the data services (write-freeze — now a REAL
      // stop, see quiesceDataServices), THEN walk the real data tree skipping
      // the raw mounts (only the `_dumps/**` ride). The dumps captured the
      // consistent state before the freeze; the freeze is the clean final point
      // for any non-store files under data/. The epoch is recorded by the §9
      // epoch-complete report the consumer POSTs after this resolves.
      backupFlush: async (_epoch) => {
        // A move on the archive path already carried the data and paused the apps.
        if (deps.migratePause?.paused()) return;
        if (!deps.backupLoop) return;
        const dataRoot = `${dataDir}/data`;
        const walkOpts = await dumpVolumesBeforeWalk(dataRoot, (m) => console.log(m));
        await quiesceDataServices((m) => console.log(m));
        const files = await walkDataDir(dataRoot, {
          onLog: (m) => console.log(m),
          exclude: walkOpts.exclude,
          raiseCapFor: walkOpts.raiseCapFor,
        });
        console.log(`[decommission] final flush: ${files.length} files from ${dataRoot}`);
        await deps.backupLoop.runOnce(files);
      },
      // Release routing = drop the tunnel + stop serving (runtime.close()).
      releaseRouting: () => runtime.close(),
      // Reuse the account-deletion content-wipe machinery (stop data-services +
      // `docker compose down -v` + prune + drop the app-data tree).
      wipeContent: realWipeContent,
      // Converge on the shared lock-and-poweroff latch — suppress auto-unlock,
      // then power off (the same primitive the dead-man + manual power-off use).
      lockAndPower: () =>
        executeLockAndPower({ mode: "off", suppressor: autoUnlockSuppressor, runner: hostPowerRunner }),
      // wipe-after-handoff: MIGRATION-AWARE bounded confirm. When a migration
      // session exists for this box, only its `taken-over` phase confirms (and
      // `aborted` denies immediately — data preserved); with no session it
      // falls back to the plain replacement-restored eviction-chain heuristic.
      // On timeout the consumer powers off WITHOUT wiping (fail-safe).
      awaitHandoffConfirm: () =>
        pollMigrationAwareHandoffConfirm({
          serverDomain: env.serverFqdn,
          myStkHex,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl,
          maxAttempts: 24, // ~2h at the default interval — generous for a restore
          intervalMs: 5 * 60_000,
          fallback: () =>
            pollReplacementRestored({
              serverDomain: env.serverFqdn,
              myStkHex,
              controlPlaneBaseUrl: env.controlPlaneBaseUrl,
              maxAttempts: 24,
              intervalMs: 5 * 60_000,
              onLog: (m) => console.log(m),
            }),
          onLog: (m) => console.log(m),
        }),
      onLog: (m) => console.log(m),
    });
    decommissionPoller.start();
    process.once("SIGTERM", () => decommissionPoller.stop());
    process.once("SIGINT", () => decommissionPoller.stop());
    console.log("[daemon] graceful-decommission poller armed");
  }
  // Phone-ordered, dual-signed in-place self-update
  // (docs/server-update-mechanism.md): poll the `.com` update lane on the
  // heartbeat cadence. The 2-of-2 gate is enforced ON-BOX, independently:
  // the order re-verifies under the Slice-D master-admin authority (pinned
  // admin root ⇒ NEVER the bare owner IRK — the same gate as self-delete /
  // decommission), AND the target commit must be maintainer-ENDORSED via the
  // ReleaseGate (verify-forward from the baked pin, offline). Armed only when
  // the box actually runs from a git checkout (production /opt/flagship; dev
  // runs without one simply never poll). Code swap only; the boot health gate
  // in main() commits or rolls back after the restart.
  {
    const dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
    const repoPath = process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship";
    if (existsSync(join(repoPath, ".git"))) {
      const updatePoller = buildUpdateConsumerPoller({
        serverDomain: env.serverFqdn,
        ownerIrkPub: cfg.irkPublicKey,
        ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
        username: cfg.userId,
        controlPlaneBaseUrl: env.controlPlaneBaseUrl,
        repoPath,
        releaseGate: selfUpdateReleaseGate(repoPath),
        runner: realUpdateCommandRunner,
        usedNonceStore: fileUsedNonceStore(`${dataDir}/update-used-nonces.json`),
        pendingStore: filePendingVerifyStore(`${dataDir}/update-pending.json`),
        outcomeStore: fileUpdateOutcomeStore(`${dataDir}/update-outcome.json`),
        requestExit: () => {
          console.log("[self-update] restarting into the staged update");
          process.exit(0);
        },
        onLog: (m) => console.log(m),
      });
      updatePoller.start();
      process.once("SIGTERM", () => updatePoller.stop());
      process.once("SIGINT", () => updatePoller.stop());
      console.log("[daemon] self-update consumer armed");
      // A new box starts on whatever its image baked in; it moves to the
      // newest endorsed release once, before it holds any apps.
      const firstBootGate = buildMaintainersReleaseGate({
        repoPath,
        ...(process.env.FLAGSHIP_MAINTAINER_PIN_OVERRIDE ? { pinnedMandateHash: process.env.FLAGSHIP_MAINTAINER_PIN_OVERRIDE } : {}),
        onLog: (m) => console.log(m),
      });
      const firstBootPending = filePendingVerifyStore(`${dataDir}/update-pending.json`);
      setTimeout(() => {
        void runFirstBootUpdate({
          markerPath: `${dataDir}/first-boot-update.json`,
          hasUpdateHistory: async () =>
            existsSync(`${dataDir}/update-outcome.json`) || (await firstBootPending.read().catch(() => null)) !== null,
          appCount: () => runtime.servicePlatform?.list().length ?? 0,
          catalog: buildReleaseCatalog({
            repoPath,
            ...(process.env.FLAGSHIP_MAINTAINER_PIN_OVERRIDE ? { pinnedMandateHash: process.env.FLAGSHIP_MAINTAINER_PIN_OVERRIDE } : {}),
            onLog: (m) => console.log(m),
          }),
          apply: (from, target) =>
            applyEndorsedUpdate(
              {
                repoPath,
                releaseGate: firstBootGate,
                runner: realUpdateCommandRunner,
                pendingStore: firstBootPending,
                requestExit: () => {
                  console.log("[first-boot-update] restarting into the newest release");
                  process.exit(0);
                },
                onLog: (m) => console.log(m),
              },
              from,
              target,
              "first-boot, maintainer-endorsed",
            ),
          log: (m) => console.log(m),
        }).catch((e: Error) => console.warn(`[first-boot-update] ${e.message}`));
      }, 30_000).unref?.();
    } else {
      console.log(
        `[daemon] self-update consumer NOT armed (no git checkout at ${repoPath})`,
      );
    }
  }
  // Transfer-a-box re-home (docs/account-deletion-and-name-reclaim.md §4, Layer
  // A): poll `.com` for "did my owner change?". On a completed transfer the
  // poller persists a marker; the box re-homes (new FQDN + owner IRK ⇒ cert
  // re-issue + fresh acquirer entitlement) on its NEXT restart. Best-effort; a
  // box that was never transferred just 404s cheaply on every poll. Slice D
  // §9.8: a box with a pinned admin root passes it here (cfg.adminRootPub is
  // already the EFFECTIVE pinned root — main resolved admin-root-pin.json
  // before wiring us) so the poller refuses to record a re-home until the
  // giver-root-signed admin handoff verifies against that pin.
  {
    const dataDir = process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship";
    const rehomePoller = buildRehomePoller({
      serverDomain: env.serverFqdn,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl,
      markerPath:
        process.env.FLAGSHIP_REHOME_MARKER ?? `${dataDir}/transfer-rehome.json`,
      pinnedAdminRootPubHex: cfg.adminRootPub ? bytesToHexLocal(cfg.adminRootPub) : null,
      // v1-sec GAP 3 — on the legacy (no-admin-root) path the re-home is written
      // only against a giver-owner-IRK-signed authorization verified under THIS
      // pinned IRK, never `.com`'s unsigned word.
      pinnedOwnerIrkPubHex: bytesToHexLocal(cfg.irkPublicKey),
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
    controlBaseUrl: env.controlPlaneBaseUrl,
  });
  runtime.addHandler(accessWeb.handle);
  runtime.addHandler(buildInvitePage({ serverId: env.serverFqdn, controlBaseUrl: env.controlPlaneBaseUrl }));
  // Enforcement: a restricted service's per-label reverse proxy is fronted by
  // this guard. A request to `<urlLabel>.<serverFqdn>` resolves to its
  // installed `<creator>-<slug>`; OPEN services + unknown labels fall through.
  // On a DENY, a top-level browser navigation gets the QR-login knock page.
  const accessEnforcement = buildAccessEnforcementHandler(
    access,
    (req, appServiceRef) => {
      // On the SNI-routed per-app proxy path the router already resolved the
      // service that selected the container — enforce on THAT, never on the
      // client-supplied Host (a tier-2 leader-routed share URL or a spoofed
      // `curl --resolve` Host would otherwise skip the gate). v1-sec GAP 1.
      if (appServiceRef) return appServiceRef;
      // Daemon's own chain (no SNI-selected app): Host-based lookup, which is
      // the only signal available there.
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
    // An owner's API key reaches a restricted app, and so does an anonymous
    // visitor on the app's declared public routes; the proxy decides both.
    (req, serviceRef) =>
      carriesAppApiKey(req) ||
      matchesPublicRoute(
        req.path,
        deps.servicePlatformRef.current?.byServiceId(serviceRef)?.manifest.access.public_routes ?? [],
      ),
  );
  runtime.addHandler(accessEnforcement);
  // The SNI-routed per-app proxy path does NOT run the daemon handler chain
  // (an app owns its URL space), so the enforcement must ALSO front it as an
  // app gate — otherwise a restricted service still serves on a real box
  // (live-gating-e2e catch). The knock endpoints go first (ungated by
  // design): the knock page polls `/__flagship/knock/<pageId>/status`
  // same-origin on the SERVICE subdomain.
  runtime.addAppGate(accessWeb.handle);
  runtime.addAppGate(accessEnforcement);
  // Member sessions on the app path (docs/app-apis.md §5): the session cookie
  // the knock flow issued names the owner or an invited person to the app,
  // and a denied browser navigation gets the knock page to sign in.
  runtime.setAppIdentity({
    resolveSession: buildAppSessionResolver({ sessions: sessionStore, access: accessStore }),
    deniedPage: accessWeb.maybeServeKnock,
    // Fail closed: a state file that couldn't be read leaves every app
    // members-only until an admin opens it again (ServiceAccessStore.load).
    accessMode: (serviceId) => (accessStore.mode(serviceId) === "open" ? "open" : "members-only"),
  });
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
  gossipLoop: GossipLoop | null;
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
  if (deps.gossipLoop) {
    process.once("SIGTERM", () => deps.gossipLoop!.stop());
    process.once("SIGINT", () => deps.gossipLoop!.stop());
  }
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
      ? async ({ token }) => {
          await deps.pairedSessions!.add(token);
          console.log(`[daemon] order: add-paired-session tokenPrefix=${token.slice(0, 12)}`);
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
  await writeFileDurable(path, bytesToHexLocal(bakPubKey) + "\n");
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
    await writeFileDurable(`${activePrivPath}.previous`, prev);
  } catch {
    // no prior identity — fresh-box rotation is unusual but not fatal
  }

  // 2. Atomically swap active = pending, plus the boot PEM.
  await writeFileDurable(activePrivPath, pendingHex + "\n");
  const newPubHex = bytesToHexLocal(newIdentityPubKey);
  await writeFileDurable(activePubPath, newPubHex + "\n", 0o644);
  // Boot PEM gets the new priv as PKCS8 so boot-stage.sh can sign with it.
  await writeFileDurable(bootPemPath, pkcs8PemFromRaw(pendingPriv));

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
  await withFileLock(configPath, async (write) => {
    const raw = await readFile(configPath, "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    obj.irkPublicKey = newIrkHex;
    const mode = (await stat(configPath)).mode & 0o777;
    await write(JSON.stringify(obj, null, 2), mode);
  });
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
export { providerRelay } from "./tunnel/relayFetch.js";
export type { OutboundConnector, ProviderRelay, RelayFetchOptions } from "./tunnel/relayFetch.js";
export { RelayError, RELAY_UNAVAILABLE_MESSAGE } from "./tunnel/outboundStream.js";
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
export { KeyCustodian } from "./keyCustodian.js";
export type { BoxSigner, SwkOps, GossipOps } from "./keyCustodian.js";
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
