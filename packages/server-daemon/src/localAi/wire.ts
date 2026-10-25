/**
 * Daemon start-up for local AI: one `LocalAi` per box, the harness's "On this server" provider,
 * the app SDK's environment hook and the owner's screen handler. On a box that can't run
 * containers (a test, a Mac) everything answers honestly that local AI is unavailable.
 */
import { existsSync } from "node:fs";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { AcceleratorBroker } from "../gpu/broker.js";
import { appSandboxRunArgs } from "../appSandbox/state.js";
import { STAGING_NETWORK } from "../buildmodes/staging.js";
import { filesVolume } from "../dataLayer/naming.js";
import { sandboxRunArgs } from "../egress/sandboxNetworking.js";
import type { LocalInferenceLease } from "../llmHarness.js";
import { ensureDockerNetwork, realCommandRunner, type CommandRunner } from "../serviceRunner.js";
import type { ServicePlatform } from "../servicePlatform.js";
import { setLocalAiEnvProvider } from "./appEnv.js";
import type { AppSdkDeps } from "./appSdk.js";
import { buildLocalAiHttp } from "./http.js";
import { LocalAi } from "./index.js";
import type { SensitiveOrderAuthority } from "./orders.js";
import type { DatasetSource } from "./training.js";

export interface SampleSessions {
  /** Sample files the owner attached to this app's build chats (name → text). */
  samplesFor(serviceId: string): Record<string, string>;
}

/** The harness's view of the box-local model, through a ref filled once local AI starts. */
export function localInferenceFor(ref: { current: LocalAi | null }): LocalInferenceLease {
  return {
    lease: async (model) => {
      const ai = ref.current;
      if (!ai) throw new Error("This server can't run a local model.");
      return await ai.service.lease(model);
    },
    models: () => (ref.current?.service.menuModels() ?? []).map((m) => ({ id: m.id, name: m.name, contextTokens: m.serveContextTokens })),
  };
}

export interface StartLocalAiOptions {
  dataDir: string;
  serverDomain: string;
  authority: () => SensitiveOrderAuthority;
  platform: () => ServicePlatform | null;
  sessions: SampleSessions;
  broker: AcceleratorBroker | null;
  ownedPorts: AppSdkDeps["links"];
  portFor: (key: string) => Promise<number>;
  denyCompanion: (req: HttpRequest) => HttpResponse | null;
  cmd?: CommandRunner;
  log?: (m: string) => void;
}

export function startLocalAi(o: StartLocalAiOptions): { ai: LocalAi; http: (path: string, method: string, req: HttpRequest) => Promise<HttpResponse | null> } {
  const cmd = o.cmd ?? realCommandRunner;
  const log = o.log ?? ((m: string) => console.warn(m));
  const apps = () =>
    (o.platform()?.list() ?? []).map((a) => ({
      serviceId: a.serviceId,
      name: a.manifest.name,
      declaresLocalAi: a.app?.localAi?.inference === true,
    }));
  const devVolume = (serviceId: string): string | null => {
    const a = o.platform()?.byServiceId(serviceId);
    if (!a) return null;
    try {
      return filesVolume({ creator: a.creator, slug: a.slug, space: "dev" });
    } catch {
      return null;
    }
  };
  const datasetFor = async (serviceId: string): Promise<DatasetSource | null> => {
    const files = o.sessions.samplesFor(serviceId);
    const names = Object.keys(files).sort();
    if (names.length > 0) return { kind: "text", text: names.map((n) => files[n]).join("\n") };
    const vol = devVolume(serviceId);
    if (!vol || !cmd.capture) return null;
    const r = await cmd.capture("docker", ["volume", "inspect", "-f", "{{.Name}}", vol]).catch(() => null);
    return r && r.stdout.trim() === vol ? { kind: "volume", volume: vol } : null;
  };
  const linux = process.platform === "linux" && (existsSync("/usr/bin/docker") || existsSync("/usr/bin/podman"));
  const ai = new LocalAi({
    dataDir: o.dataDir,
    serverDomain: o.serverDomain,
    cmd,
    broker: o.broker,
    authority: o.authority,
    apps,
    datasetFor,
    hasSampleData: (id) => Object.keys(o.sessions.samplesFor(id)).length > 0,
    sandboxArgs: appSandboxRunArgs,
    networkArgs: () => {
      const extra = sandboxRunArgs(STAGING_NETWORK, "host.flagship.internal") ?? [];
      // No data-store alias for the model: only the filtered resolver.
      const keep: string[] = [];
      for (let i = 0; i < extra.length; i++) {
        if (extra[i] === "--add-host") {
          i++;
          continue;
        }
        keep.push(extra[i]!);
      }
      return ["--network", STAGING_NETWORK, ...keep];
    },
    ensureNetwork: () => ensureDockerNetwork(cmd, STAGING_NETWORK),
    sdk: { links: o.ownedPorts, portFor: o.portFor, hostAlias: "host.flagship.internal" },
    available: () => (linux ? { ok: true, reason: null } : { ok: false, reason: "Local AI runs on a Flagship server, not here." }),
    log,
  });
  void ai.load().catch((e: Error) => log(`[local-ai] could not load its state: ${e.message}`));
  setLocalAiEnvProvider((serviceId, declares) => ai.envFor(serviceId, declares));
  const sweep = setInterval(() => {
    const installed = new Set(apps().map((a) => a.serviceId));
    void ai.sdk.sweep((id) => installed.has(id)).catch(() => {});
    for (const id of ai.grants.serviceIds()) if (!installed.has(id)) void ai.forgetApp(id).catch(() => {});
  }, 10 * 60_000);
  sweep.unref?.();
  return { ai, http: buildLocalAiHttp({ ai, broker: o.broker, serverDomain: o.serverDomain, denyCompanion: o.denyCompanion }) };
}
