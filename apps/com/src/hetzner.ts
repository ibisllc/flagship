/**
 * Worker-side Hetzner Cloud client (Plan A — sample-user provisioning).
 *
 * Subset of `tools/vps-e2e/src/providers/hetzner.ts` that the Worker can
 * actually execute: pure-`fetch()` REST. The Worker cannot SSH, so the
 * rescue+dd path is excluded by construction — that work happens once
 * on the operator's laptop during `create-sample-user`, then this
 * client only needs to restore a pre-existing snapshot on each
 * /connect (~30s) and destroy it on idle teardown / delete.
 *
 * See docs/sample-users.md §7 for the full contract.
 */

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

export class HetznerClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodyExcerpt: string,
  ) {
    super(message);
    this.name = "HetznerClientError";
  }
}

export type HetznerServerStatus =
  | "initializing"
  | "starting"
  | "running"
  | "stopping"
  | "off"
  | "deleting"
  | "migrating"
  | "rebuilding"
  | "unknown";

const KNOWN_SERVER_STATUSES = new Set<HetznerServerStatus>([
  "initializing",
  "starting",
  "running",
  "stopping",
  "off",
  "deleting",
  "migrating",
  "rebuilding",
  "unknown",
]);

export interface HetznerCreateServerArgs {
  /** Hetzner server name, e.g. `demo-demoalice-1a2b3c4d`. */
  name: string;
  /** Numeric snapshot/image id, captured by `create-sample-user` and
   *  persisted in D1 as `demo_users.snapshot_id`. */
  snapshotId: string;
  /** Hetzner location, e.g. "fsn1" (Falkenstein). */
  location: string;
  /** Hetzner server_type, e.g. "cx22". */
  serverType: string;
  /** SSH key id (numeric) that Hetzner attaches to the server. The
   *  Worker reads this from env.DEMO_PUBLIC_SSH_KEY_ID — uploaded once
   *  during create-sample-user. */
  sshKeyId: number;
  /** Lowercased demo username; included as a Hetzner label so the
   *  operator can find demo servers in the dashboard. */
  username: string;
}

export interface HetznerCreateServerResult {
  serverId: string;
  ipv4: string | null;
}

export interface HetznerServerStatusResult {
  status: HetznerServerStatus;
  ipv4: string | null;
}

export interface HetznerClient {
  createServerFromSnapshot(
    args: HetznerCreateServerArgs,
  ): Promise<HetznerCreateServerResult>;
  getServerStatus(serverId: string): Promise<HetznerServerStatusResult>;
  destroyServer(serverId: string): Promise<void>;
}

/** Fetch shape we depend on. Mirrors the global, but typed so tests can
 *  hand in a `vi.fn()` without TypeScript complaining. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface HetznerClientOptions {
  token: string;
  fetch?: FetchLike;
  apiBase?: string;
}

export function createHetznerClient(
  tokenOrOpts: string | HetznerClientOptions,
): HetznerClient {
  const opts: HetznerClientOptions =
    typeof tokenOrOpts === "string" ? { token: tokenOrOpts } : tokenOrOpts;
  const f: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.apiBase ?? HETZNER_API_BASE;
  const token = opts.token;
  if (!token) {
    throw new Error("createHetznerClient: missing token");
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  function throwOnError(method: string, path: string, status: number, text: string): never {
    throw new HetznerClientError(
      `Hetzner ${method} ${path} → HTTP ${status}: ${text.slice(0, 240)}`,
      status,
      text.slice(0, 240),
    );
  }

  return {
    async createServerFromSnapshot(args) {
      const body = {
        name: args.name,
        image: args.snapshotId,
        location: args.location,
        server_type: args.serverType,
        ssh_keys: [args.sshKeyId],
        start_after_create: true,
        labels: { "flagship-demo": args.username.toLowerCase() },
      };
      const { status, text } = await call("POST", "/servers", body);
      if (status < 200 || status >= 300) throwOnError("POST", "/servers", status, text);
      const parsed = text ? safeJsonParse(text) : null;
      const server = (parsed as { server?: { id?: unknown; public_net?: { ipv4?: { ip?: unknown } } } })?.server;
      const idRaw = server?.id;
      if (idRaw === undefined || idRaw === null) {
        throw new HetznerClientError(
          "Hetzner POST /servers response missing server.id",
          status,
          text.slice(0, 240),
        );
      }
      const ipv4Raw = server?.public_net?.ipv4?.ip;
      return {
        serverId: String(idRaw),
        ipv4: typeof ipv4Raw === "string" && ipv4Raw.length > 0 ? ipv4Raw : null,
      };
    },

    async getServerStatus(serverId) {
      const { status, text } = await call("GET", `/servers/${encodeURIComponent(serverId)}`);
      if (status < 200 || status >= 300) {
        throwOnError("GET", `/servers/${serverId}`, status, text);
      }
      const parsed = text ? safeJsonParse(text) : null;
      const server = (parsed as { server?: { status?: unknown; public_net?: { ipv4?: { ip?: unknown } } } })?.server;
      const raw = String(server?.status ?? "unknown");
      const enumStatus = KNOWN_SERVER_STATUSES.has(raw as HetznerServerStatus)
        ? (raw as HetznerServerStatus)
        : "unknown";
      const ipv4Raw = server?.public_net?.ipv4?.ip;
      return {
        status: enumStatus,
        ipv4: typeof ipv4Raw === "string" && ipv4Raw.length > 0 ? ipv4Raw : null,
      };
    },

    async destroyServer(serverId) {
      const { status, text } = await call("DELETE", `/servers/${encodeURIComponent(serverId)}`);
      // 404 = the server is already gone (manual ops via the Hetzner
      // console, or a previous cron pass partially succeeded). Treat
      // as success so the cron driver collapses the state machine
      // cleanly. Any other non-2xx is a real error.
      if (status === 404) return;
      if (status < 200 || status >= 300) {
        throwOnError("DELETE", `/servers/${serverId}`, status, text);
      }
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
