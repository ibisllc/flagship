/**
 * Demo-server cloud selection. `DEMO_CLOUD_PROVIDER` picks where NEW demo
 * servers are created (default `hetzner`, so an unset var keeps today's
 * behaviour). Existing servers are always addressed by the provider that
 * created them, inferred from the server id's shape — a Hetzner demo row keeps
 * routing to Hetzner after the switch, and vice versa.
 */

import { createHetznerClient, type FetchLike } from "./hetzner.js";
import { createUpCloudClient, isUpCloudServerId } from "./upcloud.js";

export type DemoCloudProvider = "hetzner" | "upcloud";

export interface DemoCloudEnv {
  DEMO_CLOUD_PROVIDER?: string;
  HCLOUD_TOKEN?: string;
  UPCLOUD_TOKEN?: string;
  UPCLOUD_ZONE?: string;
  UPCLOUD_PLAN?: string;
  UPCLOUD_TEMPLATE?: string;
  UPCLOUD_STORAGE_GB?: string;
}

export interface DemoCreateSettings {
  provider: DemoCloudProvider;
  client: {
    findServerByName(name: string): Promise<{ serverId: string; ipv4: string | null } | null>;
    createServerWithUserData(args: {
      name: string;
      location: string;
      serverType: string;
      image?: string;
      userData: string;
      username: string;
      sshKeyId?: number;
      fallbackServerTypes?: readonly string[];
    }): Promise<{ serverId: string; ipv4: string | null }>;
  };
  defaultRegion: string;
  defaultSize: string;
  image?: string;
  fallbackServerTypes?: readonly string[];
}

export interface DemoServerRouter {
  getServerStatus(serverId: string): Promise<{ status: string; ipv4: string | null }>;
  destroyServer(serverId: string): Promise<void>;
}

export const UPCLOUD_DEFAULT_ZONE = "de-fra1";

export function demoCloudProvider(env: DemoCloudEnv): DemoCloudProvider {
  return env.DEMO_CLOUD_PROVIDER?.trim().toLowerCase() === "upcloud" ? "upcloud" : "hetzner";
}

/** Names the missing configuration for creating demos on the selected
 *  provider, or null when creation can proceed. */
export function demoCreateMissingConfig(env: DemoCloudEnv): string | null {
  if (demoCloudProvider(env) === "hetzner") {
    return env.HCLOUD_TOKEN ? null : "HCLOUD_TOKEN";
  }
  const missing = (["UPCLOUD_TOKEN", "UPCLOUD_PLAN", "UPCLOUD_TEMPLATE"] as const).filter((k) => !env[k]);
  return missing.length ? missing.join(" + ") : null;
}

export function hasAnyDemoCloudToken(env: DemoCloudEnv): boolean {
  return !!(env.HCLOUD_TOKEN || env.UPCLOUD_TOKEN);
}

function upcloudStorageGb(env: DemoCloudEnv): number | undefined {
  const n = env.UPCLOUD_STORAGE_GB ? parseInt(env.UPCLOUD_STORAGE_GB, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createDemoCreateSettings(env: DemoCloudEnv, fetchImpl?: FetchLike): DemoCreateSettings {
  const missing = demoCreateMissingConfig(env);
  if (missing) throw new Error(`demo creation requires ${missing}`);
  if (demoCloudProvider(env) === "upcloud") {
    const storageGb = upcloudStorageGb(env);
    return {
      provider: "upcloud",
      client: createUpCloudClient({
        token: env.UPCLOUD_TOKEN!,
        template: env.UPCLOUD_TEMPLATE!,
        ...(storageGb ? { storageGb } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
      defaultRegion: env.UPCLOUD_ZONE || UPCLOUD_DEFAULT_ZONE,
      defaultSize: env.UPCLOUD_PLAN!,
      image: env.UPCLOUD_TEMPLATE!,
    };
  }
  return {
    provider: "hetzner",
    client: createHetznerClient({ token: env.HCLOUD_TOKEN!, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    defaultRegion: "fsn1",
    defaultSize: "cpx11",
    fallbackServerTypes: ["cx23", "cpx21", "cpx22"],
  };
}

export function createDemoServerRouter(env: DemoCloudEnv, fetchImpl?: FetchLike): DemoServerRouter {
  const pick = (serverId: string): DemoServerRouter => {
    if (isUpCloudServerId(serverId)) {
      if (!env.UPCLOUD_TOKEN) throw new Error("UPCLOUD_TOKEN is not configured on the Worker");
      return createUpCloudClient({ token: env.UPCLOUD_TOKEN, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    }
    if (!env.HCLOUD_TOKEN) throw new Error("HCLOUD_TOKEN is not configured on the Worker");
    return createHetznerClient({ token: env.HCLOUD_TOKEN, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  };
  return {
    getServerStatus: async (serverId) => pick(serverId).getServerStatus(serverId),
    destroyServer: async (serverId) => pick(serverId).destroyServer(serverId),
  };
}
