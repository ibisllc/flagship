import { BootCoordinator } from "./bootCoordinator.js";
import { loadConfig } from "./config.js";
import { buildDaemonHttp, type DaemonContext } from "./httpApi.js";
import { AppMembership } from "./membership.js";
import { IdentityInjector } from "./identityInjector.js";

async function main(): Promise<void> {
  const path = process.env.FLAGSHIP_CONFIG ?? "/etc/flagship/server.json";
  const cfg = await loadConfig(path);
  const coordinator = new BootCoordinator(cfg.serverId, cfg.bakPublicKey);

  // No SWK in the on-disk config (it's provisioned by the phone at first boot).
  // For now we boot with no apps; apps get registered as the user creates them.
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

  console.log(`flagship server-daemon listening on 127.0.0.1:${port}`);
  console.log(`  serverId: ${cfg.serverId}`);
  console.log(`  userId:   ${cfg.userId}`);
  console.log(`  pending challenges: ${coordinator.pendingCount()}`);
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
