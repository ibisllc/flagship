import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ed,
  signServerRevokeBySelf,
  type Keypair,
  type ServerRevokeBySelf,
} from "@flagship/protocol";
import { BackupLoop } from "./backupLoop.js";
import { BootCoordinator } from "./bootCoordinator.js";
import { loadConfig, parseConfig, type ServerConfig } from "./config.js";
import { buildDaemonHttp, type DaemonContext } from "./httpApi.js";
import { AppMembership } from "./membership.js";
import { IdentityInjector } from "./identityInjector.js";
import { startDaemonRuntime, type DaemonRuntime } from "./runtime.js";
import type { LeEnvironment } from "./acme/letsEncryptIssuer.js";
import type { OrderExecutor } from "./orders.js";
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
  const orders = pskPubHex
    ? {
        pskPub: hexToBytes(pskPubHex.trim()),
        executor: defaultExecutor({
          backupLoop,
          identity: identityKeypair,
          serverFqdn: env.serverFqdn!,
          controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
        }),
      }
    : undefined;

  // ---- Bring up TLS + tunnel + ACME ----
  console.log(`[daemon] starting runtime for ${env.serverFqdn}`);
  console.log(`[daemon]   tunnel hub:    ${endpoints.endpoints.tunnelHub}`);
  console.log(`[daemon]   control plane: ${env.controlPlaneBaseUrl}`);
  console.log(`[daemon]   ACME env:      ${env.acmeEnvironment}`);
  console.log(`[daemon]   wildcard:      ${env.wildcard ? "yes" : "no"}`);

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
    });
    if (orders) console.log(`[daemon] orders-from-user endpoint enabled`);
    else console.log(`[daemon] FLAGSHIP_PSK_PUB_HEX not set; orders endpoint disabled`);
    console.log(`[daemon] 🔒 cert installed; serving HTTPS for ${env.serverFqdn}`);
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
    rotateServerIdentity: ({ newIdentityPubKey }) => {
      const len = newIdentityPubKey.length;
      console.log(`[daemon] order: rotate-server-identity ${len}B (TODO: persist + reload)`);
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
  };
}

async function persistBakPubKey(path: string, bakPubKey: Uint8Array): Promise<void> {
  const hex = bytesToHexLocal(bakPubKey);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, hex + "\n", { mode: 0o600 });
  await rename(tmp, path);
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
export { startTunnelClient } from "./tunnel/tunnelClient.js";
export type {
  TunnelClient,
  TunnelClientOptions,
  BackendTarget,
  BackendResolver,
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
export { startDaemonRuntime, renewIfNeeded } from "./runtime.js";
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
