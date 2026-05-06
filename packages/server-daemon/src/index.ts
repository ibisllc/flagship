import { readFile } from "node:fs/promises";
import { BootCoordinator } from "./bootCoordinator.js";
import { loadConfig, parseConfig, type ServerConfig } from "./config.js";
import { buildDaemonHttp, type DaemonContext } from "./httpApi.js";
import { AppMembership } from "./membership.js";
import { IdentityInjector } from "./identityInjector.js";
import { startDaemonRuntime, type DaemonRuntime } from "./runtime.js";
import type { LeEnvironment } from "./acme/letsEncryptIssuer.js";
import type { OrderExecutor } from "./orders.js";

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
  tunnelHubUrl: string;
  controlPlaneBaseUrl: string;
  acmeEmail: string;
  acmeEnvironment: LeEnvironment;
  wildcard: boolean;
}

function envFromProcess(): Partial<RuntimeEnv> {
  return {
    serverFqdn: process.env.FLAGSHIP_SUBDOMAIN,
    identityPrivKeyHex: process.env.FLAGSHIP_IDENTITY_PRIV_HEX,
    tunnelHubUrl: process.env.FLAGSHIP_HUB ?? "wss://flagship-services.fly.dev:8443/tunnel",
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

  // ---- Phone-issued orders endpoint ----
  // PSK pubkey is baked into the install trailer; install.sh writes it
  // to /var/flagship/psk.pub.hex on first boot. For dev runs we accept
  // FLAGSHIP_PSK_PUB_HEX directly.
  const pskPubHex =
    process.env.FLAGSHIP_PSK_PUB_HEX ?? (await tryReadFile("/var/flagship/psk.pub.hex"));
  const orders = pskPubHex
    ? {
        pskPub: hexToBytes(pskPubHex.trim()),
        executor: defaultExecutor(),
      }
    : undefined;

  // ---- Bring up TLS + tunnel + ACME ----
  console.log(`[daemon] starting runtime for ${env.serverFqdn}`);
  console.log(`[daemon]   tunnel hub:    ${env.tunnelHubUrl}`);
  console.log(`[daemon]   control plane: ${env.controlPlaneBaseUrl}`);
  console.log(`[daemon]   ACME env:      ${env.acmeEnvironment}`);
  console.log(`[daemon]   wildcard:      ${env.wildcard ? "yes" : "no"}`);

  let runtime: DaemonRuntime;
  try {
    runtime = await startDaemonRuntime({
      serverFqdn: env.serverFqdn!,
      identityPrivKey,
      tunnelHubUrl: env.tunnelHubUrl!,
      controlPlaneBaseUrl: env.controlPlaneBaseUrl!,
      acmeEmail: env.acmeEmail!,
      acmeEnvironment: env.acmeEnvironment!,
      wildcard: env.wildcard,
      dataDir: process.env.FLAGSHIP_DATA_DIR ?? "/var/flagship",
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

function defaultExecutor(): OrderExecutor {
  return {
    noop: () => {
      console.log(`[daemon] order: noop`);
    },
    setBackupPolicy: ({ enabled }) => {
      console.log(`[daemon] order: set-backup-policy enabled=${enabled} (TODO: wire to BackupLoop)`);
    },
    shutDown: () => {
      console.log(`[daemon] order: shut-down — exiting in 1s`);
      setTimeout(() => process.exit(0), 1000);
    },
    revokeSelf: ({ reason }) => {
      console.log(`[daemon] order: revoke-self reason=${JSON.stringify(reason)} (TODO: notify .com)`);
    },
    rotateServerIdentity: ({ newIdentityPubKey }) => {
      const len = newIdentityPubKey.length;
      console.log(`[daemon] order: rotate-server-identity ${len}B (TODO: persist + reload)`);
    },
    deliverBak: ({ bakPubKey }) => {
      const len = bakPubKey.length;
      console.log(`[daemon] order: deliver-bak ${len}B (TODO: install at /var/flagship/bak.pub)`);
    },
  };
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
export { startDaemonRuntime } from "./runtime.js";
export type {
  DaemonRuntime,
  DaemonRuntimeOptions,
  HttpRequest as DaemonHttpRequest,
  HttpResponse as DaemonHttpResponse,
} from "./runtime.js";
export { PersistentAcmeStore, isCertFresh } from "./acme/persistentStore.js";
export type { PersistedCert } from "./acme/persistentStore.js";
export { buildOrdersHandler } from "./orders.js";
export type { OrderExecutor, OrdersHandlerOptions } from "./orders.js";
export { LlmHarness } from "./llmHarness.js";
export type { LlmHarnessOptions } from "./llmHarness.js";
