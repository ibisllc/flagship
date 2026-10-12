/**
 * Daemon wiring for the egress gateway (runtime.ts calls `bootEgress` before
 * any container starts). Waits briefly for dockerd, which can start after the
 * daemon, then starts the gateway, loads the owner's signed approvals and
 * builds the screens-API handler. FLAGSHIP_EGRESS=off turns it all off and
 * removes the firewall rules (the old, unfenced behaviour).
 */
import type { AdminGrantView, AppEgressGrant } from "@flagship/protocol";
import type { CommandRunner } from "../serviceRunner.js";
import type { SwkOps } from "../keyCustodian.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { AppEgressStore, authorizeEgressGrant, buildAppEgressHttp, egressView, type EgressView } from "./approvals.js";
import { EgressGateway, disableEgress, type EgressStatus } from "./gateway.js";
import { effectiveHosts } from "./policy.js";
import { setContainersChangedHook } from "./sandboxNetworking.js";

export interface EgressRuntime {
  status(): EgressStatus;
  /** For the screens API: the signed endpoint and the list/detail view. */
  appEgress: {
    handle: (path: string, method: string, req: HttpRequest) => Promise<HttpResponse | null>;
    view: (serviceId: string, declared: readonly string[]) => EgressView;
  } | null;
  /** Drop approvals of services that are no longer installed. */
  pruneUninstalled(): Promise<void>;
}

export interface BootEgressOptions {
  cmd: CommandRunner;
  /** `<dataDir>/data/app-egress.sealed` holds the approvals. */
  dataDir?: string;
  swk?: Pick<SwkOps, "sealWithSwk" | "openWithSwk">;
  serverDomain: string;
  /** Present when the box knows its owner (else no approvals can verify). */
  owner?: { username: string; irkPub: Uint8Array; adminRootPub?: Uint8Array; activeGrants?: readonly AdminGrantView[] };
  /** Declared egress hosts of an installed service, null when not installed. */
  declared: (serviceId: string) => string[] | null;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  /** How long to wait for dockerd. Default 60 s. */
  dockerWaitMs?: number;
}

async function waitForDocker(cmd: CommandRunner, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (cmd.capture) await cmd.capture("docker", ["version", "--format", "{{.Server.Version}}"]);
      else await cmd.run("docker", ["version"]);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function bootEgress(opts: BootEgressOptions): Promise<EgressRuntime> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const env = opts.env ?? process.env;
  if ((env.FLAGSHIP_EGRESS ?? "").toLowerCase() === "off") {
    await disableEgress(opts.cmd, log).catch(() => {});
    return { status: () => ({ enforced: false, reason: "FLAGSHIP_EGRESS=off" }), appEgress: null, pruneUninstalled: async () => {} };
  }

  const store = new AppEgressStore(
    opts.dataDir && opts.swk ? `${opts.dataDir}/data/app-egress.sealed` : null,
    opts.swk ?? null,
  );
  const owner = opts.owner;
  if (owner) {
    const authority = { ownerIrkPub: owner.irkPub, adminRootPub: owner.adminRootPub, username: owner.username, activeGrants: owner.activeGrants };
    try {
      const dropped = await store.load((g: AppEgressGrant, sig: Uint8Array) => authorizeEgressGrant(authority, g, sig));
      if (dropped > 0) log(`[egress] dropped ${dropped} app approval(s) that no longer verify`);
    } catch (e) {
      log(`[egress] could not read app approvals (${(e as Error).message}); every app starts with no internet`);
    }
  }
  const approvedHosts = (serviceId: string): string[] =>
    effectiveHosts(opts.declared(serviceId) ?? [], store.approvedHosts(serviceId));

  const gateway = new EgressGateway({ cmd: opts.cmd, approvedHosts, log });
  if (await waitForDocker(opts.cmd, opts.dockerWaitMs ?? 60_000)) {
    await gateway.start();
  } else {
    log("[egress] NOT ENFORCED: docker is not available");
  }
  if (gateway.status().enforced) {
    setContainersChangedHook(() => gateway.refreshApps());
    const t = setInterval(() => void gateway.refreshApps(), 10_000);
    t.unref?.();
  }

  const appEgress = owner
    ? {
        handle: buildAppEgressHttp({
          serverDomain: opts.serverDomain,
          username: owner.username,
          ownerIrkPub: owner.irkPub,
          ...(owner.adminRootPub ? { adminRootPub: owner.adminRootPub } : {}),
          ...(owner.activeGrants ? { activeGrants: owner.activeGrants } : {}),
          store,
          declared: opts.declared,
          onChange: (id) => {
            const cut = gateway.recheck();
            log(`[egress] ${id} may now reach: ${approvedHosts(id).join(", ") || "nothing"}${cut ? ` (closed ${cut} connection(s))` : ""}`);
          },
        }),
        view: (serviceId: string, declared: readonly string[]) => egressView(store, serviceId, declared),
      }
    : null;

  return {
    status: () => gateway.status(),
    appEgress,
    pruneUninstalled: async () => {
      for (const id of store.serviceIds()) {
        if (opts.declared(id) === null) await store.forget(id).catch(() => {});
      }
    },
  };
}
