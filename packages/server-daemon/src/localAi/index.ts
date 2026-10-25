/**
 * Local AI on the owner's server (AI01/AI02): the pinned model catalog and store, the box-local
 * OpenAI-compatible model server, fine-tuning jobs on an app's staged sample data, the per-app SDK
 * endpoint and the owner's screen API. docs/architecture-v2/local-ai.md.
 */
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import {
  authorizeSensitiveOrderSafe,
  type SensitiveOrderAuthority,
} from "./orders.js";
import type { AcceleratorBroker } from "../gpu/broker.js";
import type { CommandRunner } from "../serviceRunner.js";
import { readStateFile, writeFileDurable } from "../durableFile.js";
import { AppGrantStore, AppSdkEndpoints, type AppSdkDeps } from "./appSdk.js";
import { prepareOutVolume, realModelInstaller } from "./rootSteps.js";
import { ModelStore, type DownloadFetch, type ModelInstaller } from "./modelStore.js";
import { LocalInferenceService } from "./service.js";
import { TrainingJobs, type DatasetSource } from "./training.js";
import { verifyLocalAiAppGrant, type LocalAiAppGrant } from "@flagship/protocol";

export { LocalAiUnavailable, type LocalEndpoint } from "./service.js";
export { LOCAL_AI_PROVIDER } from "@flagship/protocol";

export interface LocalAiSettings {
  useGpu: boolean;
  serveModel: string | null;
}

export interface LocalAiApp {
  serviceId: string;
  name: string;
  declaresLocalAi: boolean;
}

export interface LocalAiOptions {
  dataDir: string;
  serverDomain: string;
  cmd: CommandRunner;
  broker: AcceleratorBroker | null;
  authority: () => SensitiveOrderAuthority;
  apps: () => LocalAiApp[];
  datasetFor: (serviceId: string) => Promise<DatasetSource | null>;
  hasSampleData: (serviceId: string) => boolean;
  sandboxArgs: () => Promise<string[]>;
  networkArgs: () => string[];
  ensureNetwork: () => Promise<void>;
  sdk: Pick<AppSdkDeps, "links" | "portFor" | "hostAlias">;
  installer?: ModelInstaller;
  fetch?: DownloadFetch;
  serverFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  hardware?: () => { cpus: number; memoryMiB: number };
  prepareOut?: (hex: string) => Promise<void>;
  available?: () => { ok: boolean; reason: string | null };
  now?: () => number;
  log?: (m: string) => void;
}

export class LocalAi {
  readonly store: ModelStore;
  readonly service: LocalInferenceService;
  readonly training: TrainingJobs;
  readonly grants: AppGrantStore;
  readonly sdk: AppSdkEndpoints;
  private settingsValue: LocalAiSettings = { useGpu: true, serveModel: null };
  readonly dir: string;
  readonly hardware: () => { cpus: number; memoryMiB: number };

  constructor(readonly o: LocalAiOptions) {
    this.dir = join(o.dataDir, "data", "local-ai");
    const now = o.now ?? Date.now;
    this.hardware = o.hardware ?? (() => ({ cpus: cpus().length, memoryMiB: Math.floor(totalmem() / (1 << 20)) }));
    this.store = new ModelStore({
      dir: this.dir,
      installer: o.installer ?? realModelInstaller(o.cmd),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.log ? { log: o.log } : {}),
      now,
    });
    this.service = new LocalInferenceService({
      cmd: o.cmd,
      store: this.store,
      broker: o.broker,
      hardware: this.hardware,
      sandboxArgs: o.sandboxArgs,
      networkArgs: o.networkArgs,
      ensureNetwork: o.ensureNetwork,
      settings: () => this.settingsValue,
      ...(o.serverFetch ? { fetch: o.serverFetch } : {}),
      ...(o.log ? { log: o.log } : {}),
      now,
    });
    this.training = new TrainingJobs({
      dir: this.dir,
      cmd: o.cmd,
      store: this.store,
      broker: o.broker,
      hardware: this.hardware,
      sandboxArgs: o.sandboxArgs,
      networkArgs: o.networkArgs,
      ensureNetwork: o.ensureNetwork,
      settings: () => this.settingsValue,
      datasetFor: o.datasetFor,
      prepareOut: o.prepareOut ?? ((hex) => prepareOutVolume(o.cmd, hex)),
      ...(o.log ? { log: o.log } : {}),
      now,
    });
    this.grants = new AppGrantStore(
      this.dir,
      (g) =>
        g.grant.serverDomain.toLowerCase() === o.serverDomain.toLowerCase() &&
        authorizeSensitiveOrderSafe(o.authority(), g.grant, g.signature, verifyLocalAiAppGrant),
      now,
    );
    this.sdk = new AppSdkEndpoints({
      service: this.service,
      grants: this.grants,
      declares: (id) => o.apps().some((a) => a.serviceId === id && a.declaresLocalAi),
      ...o.sdk,
      ...(o.serverFetch ? { fetch: o.serverFetch } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
  }

  async load(): Promise<void> {
    const r = await readStateFile(join(this.dir, "settings.json"));
    if (r.kind === "ok") {
      try {
        const v = JSON.parse(r.text) as Partial<LocalAiSettings>;
        this.settingsValue = { useGpu: v.useGpu !== false, serveModel: typeof v.serveModel === "string" ? v.serveModel : null };
      } catch {
        // defaults
      }
    }
    await this.store.load();
    await this.training.load();
    await this.grants.load();
  }

  settings(): LocalAiSettings {
    return { ...this.settingsValue };
  }

  async setSettings(s: Partial<LocalAiSettings>): Promise<LocalAiSettings> {
    this.settingsValue = {
      useGpu: s.useGpu ?? this.settingsValue.useGpu,
      serveModel: s.serveModel === undefined ? this.settingsValue.serveModel : s.serveModel,
    };
    await writeFileDurable(join(this.dir, "settings.json"), JSON.stringify(this.settingsValue));
    return this.settings();
  }

  /** The env an app's container gets: its endpoint when it declares the capability. */
  async envFor(serviceId: string, declares: boolean): Promise<Record<string, string>> {
    return await this.sdk.envFor(serviceId, declares);
  }

  /** An app was uninstalled: its endpoint, grant and training jobs go with it. */
  async forgetApp(serviceId: string): Promise<void> {
    await this.sdk.close(serviceId);
    await this.grants.forget(serviceId);
    await this.training.forgetApp(serviceId);
  }

  /** Verified grant application (the HTTP layer checks freshness and ordering). */
  async applyGrant(grant: LocalAiAppGrant, signature: string): Promise<void> {
    await this.grants.apply({ grant, signature });
  }
}
