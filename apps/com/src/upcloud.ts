/**
 * Worker-side UpCloud client for demo provisioning — the drop-in alternative
 * to `hetzner.ts` selected by `DEMO_CLOUD_PROVIDER=upcloud`.
 *
 * It implements only the surface the demo paths use: create-with-cloud-init,
 * find-by-name, status, destroy. Region/size/image travel through the same
 * demo-row fields as on Hetzner: `location` is an UpCloud zone, `serverType`
 * an UpCloud plan name, `image` a template UUID to clone.
 *
 * API 1.3, bearer-token auth (`ucat_…`). The token must NOT be IP-restricted:
 * Workers egress from Cloudflare's shared ranges.
 */

import type { FetchLike } from "./hetzner.js";

const UPCLOUD_API_BASE = "https://api.upcloud.com/1.3";
const DEMO_LABEL_KEY = "flagship-demo";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hetzner server ids are numeric; UpCloud server ids are UUIDs. The demo row
 *  has no provider column, so the id's shape is what routes status/cleanup. */
export function isUpCloudServerId(serverId: string): boolean {
  return UUID_RE.test(serverId);
}

export class UpCloudClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyExcerpt: string,
  ) {
    super(message);
    this.name = "UpCloudClientError";
  }
}

export interface UpCloudCreateServerArgs {
  name: string;
  /** UpCloud zone, e.g. `de-fra1`. */
  location: string;
  /** UpCloud plan name. */
  serverType: string;
  /** Template UUID to clone; falls back to the client's default template. */
  image?: string;
  userData: string;
  username: string;
  sshKeyId?: number;
  fallbackServerTypes?: readonly string[];
}

export interface UpCloudServerResult {
  serverId: string;
  ipv4: string | null;
}

export interface UpCloudClient {
  findServerByName(name: string): Promise<UpCloudServerResult | null>;
  createServerWithUserData(args: UpCloudCreateServerArgs): Promise<UpCloudServerResult>;
  getServerStatus(serverId: string): Promise<{ status: string; ipv4: string | null }>;
  destroyServer(serverId: string): Promise<void>;
  createServerFromSnapshot(): never;
}

export interface UpCloudClientOptions {
  token: string;
  /** Default template UUID (Debian 12) when a create call carries no image. */
  template?: string;
  /** Root disk size in GB; keep it within the plan's included quota. */
  storageGb?: number;
  /** Debug-only SSH public key for the default login user; unset in normal operation. */
  sshPublicKey?: string;
  fetch?: FetchLike;
  apiBase?: string;
  sleep?: (ms: number) => Promise<void>;
  stopPollAttempts?: number;
  stopPollIntervalMs?: number;
}

interface UpCloudIpAddress {
  access?: unknown;
  family?: unknown;
  address?: unknown;
}

interface UpCloudServerBody {
  uuid?: unknown;
  title?: unknown;
  hostname?: unknown;
  state?: unknown;
  ip_addresses?: { ip_address?: UpCloudIpAddress[] };
  networking?: { interfaces?: { interface?: Array<{ type?: unknown; ip_addresses?: { ip_address?: UpCloudIpAddress[] } }> } };
}

export function createUpCloudClient(opts: UpCloudClientOptions): UpCloudClient {
  if (!opts.token) throw new Error("createUpCloudClient: missing token");
  const f: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.apiBase ?? UPCLOUD_API_BASE;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stopPollAttempts = opts.stopPollAttempts ?? 30;
  const stopPollIntervalMs = opts.stopPollIntervalMs ?? 2_000;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, text: await res.text() };
  }

  function fail(method: string, path: string, status: number, text: string): never {
    throw new UpCloudClientError(
      `UpCloud ${method} ${path} → HTTP ${status}: ${text.slice(0, 240)}`,
      status,
      text.slice(0, 240),
    );
  }

  async function getServer(serverId: string): Promise<UpCloudServerBody | null> {
    const path = `/server/${encodeURIComponent(serverId)}`;
    const { status, text } = await call("GET", path);
    if (status === 404) return null;
    if (status < 200 || status >= 300) fail("GET", path, status, text);
    return (safeJsonParse(text) as { server?: UpCloudServerBody } | null)?.server ?? null;
  }

  return {
    async findServerByName(name) {
      const label = `${DEMO_LABEL_KEY}=${demoUsernameFromName(name)}`;
      const path = `/server?label=${encodeURIComponent(label)}`;
      const { status, text } = await call("GET", path);
      if (status < 200 || status >= 300) fail("GET", "/server", status, text);
      const servers = (safeJsonParse(text) as { servers?: { server?: UpCloudServerBody[] } } | null)
        ?.servers?.server ?? [];
      const match = servers.find((s) => s.title === name || s.hostname === name);
      if (!match || typeof match.uuid !== "string") return null;
      const detail = await getServer(match.uuid);
      return { serverId: match.uuid, ipv4: publicIpv4(detail ?? match) };
    },

    async createServerWithUserData(args) {
      const template = args.image && isUpCloudServerId(args.image) ? args.image : opts.template;
      if (!template) {
        throw new UpCloudClientError("UpCloud create needs a template UUID (UPCLOUD_TEMPLATE)", 0, "");
      }
      const body = {
        server: {
          zone: args.location,
          plan: args.serverType,
          title: args.name,
          hostname: args.name,
          metadata: "yes",
          user_data: args.userData,
          labels: { label: [{ key: DEMO_LABEL_KEY, value: args.username.toLowerCase() }] },
          ...(opts.sshPublicKey
            ? { login_user: { create_password: "no", ssh_keys: { ssh_key: [opts.sshPublicKey] } } }
            : {}),
          storage_devices: {
            storage_device: [{
              action: "clone",
              storage: template,
              title: `${args.name}-disk`,
              size: opts.storageGb ?? 20,
              tier: "standard",
            }],
          },
          networking: {
            interfaces: {
              interface: [
                { type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
                { type: "utility", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
              ],
            },
          },
        },
      };
      const { status, text } = await call("POST", "/server", body);
      if (status < 200 || status >= 300) fail("POST", "/server", status, text);
      const server = (safeJsonParse(text) as { server?: UpCloudServerBody } | null)?.server;
      if (typeof server?.uuid !== "string") {
        throw new UpCloudClientError("UpCloud POST /server response missing server.uuid", status, text.slice(0, 240));
      }
      return { serverId: server.uuid, ipv4: publicIpv4(server) };
    },

    async getServerStatus(serverId) {
      const server = await getServer(serverId);
      if (!server) fail("GET", `/server/${serverId}`, 404, "not found");
      return { status: mapState(server.state), ipv4: publicIpv4(server) };
    },

    async destroyServer(serverId) {
      const path = `/server/${encodeURIComponent(serverId)}`;
      let server = await getServer(serverId);
      if (!server) return;
      if (server.state !== "stopped") {
        const stop = await call("POST", `${path}/stop`, {
          stop_server: { stop_type: "hard", timeout: "60" },
        });
        // 409 = already stopping/stopped or mid-operation; the poll below decides.
        if (stop.status !== 409 && stop.status !== 404 && (stop.status < 200 || stop.status >= 300)) {
          fail("POST", `${path}/stop`, stop.status, stop.text);
        }
        for (let i = 0; i < stopPollAttempts; i += 1) {
          server = await getServer(serverId);
          if (!server || server.state === "stopped") break;
          await sleep(stopPollIntervalMs);
        }
        if (!server) return;
        if (server.state !== "stopped") {
          throw new UpCloudClientError(`UpCloud server ${serverId} did not stop in time`, 0, String(server.state));
        }
      }
      // storages=1 deletes the cloned disk with the server; backups=delete
      // drops any backups of it, so nothing keeps billing after cleanup.
      const del = await call("DELETE", `${path}?storages=1&backups=delete`);
      if (del.status === 404) return;
      if (del.status < 200 || del.status >= 300) fail("DELETE", path, del.status, del.text);
    },

    createServerFromSnapshot(): never {
      throw new Error("createServerFromSnapshot is unsupported on UpCloud");
    },
  };
}

function demoUsernameFromName(name: string): string {
  const m = /^flagship-demo-(.+)-[0-9a-f]+$/.exec(name);
  return m?.[1] ?? name;
}

function mapState(raw: unknown): string {
  switch (raw) {
    case "started": return "running";
    case "stopped": return "off";
    case "maintenance": return "initializing";
    default: return "unknown";
  }
}

function publicIpv4(server: UpCloudServerBody): string | null {
  const flat = server.ip_addresses?.ip_address ?? [];
  for (const ip of flat) {
    if (ip.access === "public" && ip.family === "IPv4" && typeof ip.address === "string") return ip.address;
  }
  for (const iface of server.networking?.interfaces?.interface ?? []) {
    if (iface.type !== "public") continue;
    for (const ip of iface.ip_addresses?.ip_address ?? []) {
      if (ip.family === "IPv4" && typeof ip.address === "string") return ip.address;
    }
  }
  return null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
