/**
 * Daemon wiring for the egress gateway (runtime.ts calls `bootEgress` before
 * any container starts). Waits briefly for dockerd, which can start after the
 * daemon, then starts the gateway, loads the owner's signed approvals and
 * builds the screens-API handler. FLAGSHIP_EGRESS=off turns it all off and
 * removes the firewall rules (the old, unfenced behaviour).
 */
import type { AdminGrantView, EgressSuggestion } from "@flagship/protocol";
import type { CommandRunner } from "../serviceRunner.js";
import type { SwkOps } from "../keyCustodian.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { buildAccessRequestRecorder, type AccessAlertSinks } from "./accessAlerts.js";
import { AppAccessStore } from "./accessStore.js";
import {
  accessAuthorizer,
  accessSummary,
  buildAppAccessHttp,
  egressView,
  type AccessSummary,
  type EgressView,
} from "./approvals.js";
import { EgressGateway, disableEgress, type EgressStatus } from "./gateway.js";
import { setContainersChangedHook } from "./sandboxNetworking.js";

export interface EgressRuntime {
  status(): EgressStatus;
  /** FLAGSHIP_EGRESS=off: the operator turned the fence off on purpose. */
  disabled: boolean;
  /** For the screens API: the signed endpoints and the views the apps list and detail carry. */
  appEgress: {
    handle: (path: string, method: string, req: HttpRequest) => Promise<HttpResponse | null>;
    view: (serviceId: string, declared: readonly string[]) => EgressView;
    access: (serviceId: string) => AccessSummary;
  } | null;
  /** Drop the lists and requests of services that are no longer installed. */
  pruneUninstalled(): Promise<void>;
  /**
   * A service was installed or updated: hosts its manifest suggests that are
   * new become a draft list for the owner. Plain host strings are accepted
   * (no reason given).
   */
  noteInstalled(serviceId: string, declared: readonly (string | EgressSuggestion)[]): Promise<void>;
  /**
   * The owner-signed list this box enforces for an app, to send with a copy
   * of it (appCopy/); null when the app runs on the default list.
   */
  exportList(serviceId: string): string | null;
  /** A copied app arrived: its source server's list becomes a draft here. */
  noteCopied(serviceId: string, sourceList: string, declared: readonly (string | EgressSuggestion)[]): Promise<void>;
  /** Where access-request alerts go (push + screens socket); set once the daemon has them. */
  setAccessAlerts(sinks: AccessAlertSinks): void;
}

export interface BootEgressOptions {
  cmd: CommandRunner;
  /** `<dataDir>/data/app-access.sealed` holds the lists (migrated from `app-egress.sealed`). */
  dataDir?: string;
  swk?: Pick<SwkOps, "sealWithSwk" | "openWithSwk">;
  serverDomain: string;
  /** Present when the box knows its owner (else no list can verify). */
  owner?: { username: string; irkPub: Uint8Array; adminRootPub?: Uint8Array; activeGrants?: readonly AdminGrantView[] };
  /** An installed service's name and declared `network.egress` hosts; null when not installed. */
  app: (serviceId: string) => { name: string; declared: string[] } | null;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  /** How long to wait for dockerd. Default 60 s. */
  dockerWaitMs?: number;
  /** How often to retry a gateway that couldn't start. Default 30 s. */
  retryMs?: number;
  /** The gateway came up after failing at boot: start the apps it held back. */
  onRecovered?: () => void;
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
    return {
      status: () => ({ enforced: false, reason: "FLAGSHIP_EGRESS=off" }),
      disabled: true,
      appEgress: null,
      pruneUninstalled: async () => {},
      noteInstalled: async () => {},
      exportList: () => null,
      noteCopied: async () => {},
      setAccessAlerts: () => {},
    };
  }

  const persist = opts.dataDir && opts.swk;
  const store = new AppAccessStore(persist ? `${opts.dataDir}/data/app-access.sealed` : null, opts.swk ?? null, {
    legacyPath: persist ? `${opts.dataDir}/data/app-egress.sealed` : null,
  });
  const owner = opts.owner;
  const authority = owner
    ? { ownerIrkPub: owner.irkPub, username: owner.username, ...(owner.adminRootPub ? { adminRootPub: owner.adminRootPub } : {}), ...(owner.activeGrants ? { activeGrants: owner.activeGrants } : {}) }
    : null;
  if (authority) {
    try {
      const { dropped, migrated } = await store.load(accessAuthorizer(authority), opts.serverDomain);
      if (migrated > 0) log(`[egress] moved ${migrated} app approval(s) to access lists`);
      if (dropped > 0) log(`[egress] dropped ${dropped} app access list(s) that no longer verify`);
    } catch (e) {
      log(`[egress] could not read app access lists (${(e as Error).message}); every app starts with no internet`);
    }
  }

  let sinks: AccessAlertSinks = {};
  const recorder = buildAccessRequestRecorder({
    store,
    appName: (id) => opts.app(id)?.name ?? null,
    sinks: () => sinks,
    log,
  });
  const gateway = new EgressGateway({
    cmd: opts.cmd,
    accessRules: (id) => (opts.app(id) ? store.rules(id) : []),
    onUnmatched: (id, host) => recorder.onUnmatched(id, host),
    log,
  });
  let dockerDown = false;
  const onEnforced = () => {
    setContainersChangedHook(() => gateway.refreshApps());
    const t = setInterval(() => void gateway.refreshApps(), 10_000);
    t.unref?.();
  };
  const attempt = async (waitMs: number): Promise<boolean> => {
    dockerDown = !(await waitForDocker(opts.cmd, waitMs));
    if (!dockerDown) await gateway.start();
    return gateway.status().enforced;
  };
  if (await attempt(opts.dockerWaitMs ?? 60_000)) {
    onEnforced();
  } else {
    if (dockerDown) log("[egress] NOT ENFORCED: docker is not available");
    // dockerd may come up later (a slow start, a repair); until the fence
    // does, apps, AI test copies and AI builds stay refused, so keep trying.
    let trying = false;
    const retry = setInterval(() => {
      if (trying) return;
      trying = true;
      void attempt(0).finally(() => (trying = false)).then((ok) => {
        if (!ok) return;
        clearInterval(retry);
        log("[egress] gateway up after a retry");
        onEnforced();
        opts.onRecovered?.();
      }, () => {});
    }, opts.retryMs ?? 30_000);
    retry.unref?.();
  }

  const appEgress = authority
    ? {
        handle: buildAppAccessHttp({
          ...authority,
          serverDomain: opts.serverDomain,
          store,
          app: opts.app,
          onChange: (id) => {
            const cut = gateway.recheck();
            const rules = store.rules(id);
            log(`[egress] ${id} access list now has ${rules.length} rule(s)${cut ? ` (closed ${cut} connection(s))` : ""}`);
          },
        }),
        view: (serviceId: string, declared: readonly string[]) => egressView(store, serviceId, declared),
        access: (serviceId: string) => accessSummary(store, serviceId),
      }
    : null;

  return {
    status: () => (dockerDown && !gateway.status().enforced ? { enforced: false, reason: "docker is not available" } : gateway.status()),
    disabled: false,
    appEgress,
    pruneUninstalled: async () => {
      for (const id of store.serviceIds()) {
        if (opts.app(id) === null) await store.forget(id).catch(() => {});
      }
      gateway.recheck();
    },
    noteInstalled: async (serviceId, declared) => {
      const suggestions = declared.map((d) => (typeof d === "string" ? { host: d } : d));
      await recorder.onDeclared(serviceId, suggestions).catch(() => {});
    },
    exportList: (serviceId) => (store.held(serviceId) ? store.list(serviceId) : null),
    noteCopied: async (serviceId, sourceList, declared) => {
      const suggestions = declared.map((d) => (typeof d === "string" ? { host: d } : d));
      await recorder.onCopied(serviceId, sourceList, suggestions).catch(() => {});
    },
    setAccessAlerts: (s) => {
      sinks = s;
    },
  };
}
