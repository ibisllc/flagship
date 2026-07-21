/**
 * Worker-side Hetzner Cloud client (Plan A — sample-user provisioning).
 *
 * Subset of `tools/vps-e2e/src/providers/hetzner.ts` that the Worker can
 * actually execute: pure-`fetch()` REST. The Worker cannot SSH, so the
 * rescue+dd-the-running-disk dance now arrives via Hetzner's
 * cloud-init `user_data` field instead of through an SSH session:
 *
 *   POST /servers { image: 'ubuntu-22.04', user_data: '<bash script>' }
 *
 * cloud-init runs the user_data shebang script as root at first boot
 * with the network already up. The script `wget`s the personalized ISO
 * out of R2's public dev-url and `dd`s it onto /dev/sda — the same
 * primitive nixos-infect and hetzner-installimage rely on. No laptop
 * SSH is involved, so the laptop never needs `HCLOUD_TOKEN`. See W11
 * commit message + `docs/archive/sample-user-vps-plan.md` Phase F for the
 * full rationale.
 *
 * See docs/sample-users.md §7 for the snapshot-side contract.
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

export interface HetznerCreateServerWithUserDataArgs {
  /** Hetzner server name. */
  name: string;
  /** Hetzner location, e.g. "fsn1". */
  location: string;
  /** Hetzner server_type, e.g. "cpx11". On a 422 that looks like a
   *  per-account quota / deprecation rejection, the client retries
   *  through `fallbackServerTypes` in order before giving up. */
  serverType: string;
  /** OS image to boot from. Default: 'ubuntu-22.04' — has cloud-init
   *  pre-installed, which is what makes the user_data trick work. */
  image?: string;
  /** Shell script (with `#!` shebang) the cloud-init runs at boot as
   *  root. The W11 use case: wget the personalized ISO from R2 +
   *  `dd` it onto /dev/sda + reboot. */
  userData: string;
  /** Lowercased demo username; surfaces as a Hetzner label. */
  username: string;
  /** OPTIONAL SSH key id (numeric). When set, Hetzner attaches the key
   *  to the server (rescue access for the operator if cloud-init
   *  silently fails). The W11 happy path does NOT need it. */
  sshKeyId?: number;
  /** Ordered fallback list. Tried in order on 422; the first 2xx wins. */
  fallbackServerTypes?: readonly string[];
}

/** Snapshot lifecycle types. */
export interface HetznerSnapshotResult {
  /** Hetzner image id of the created snapshot. */
  imageId: string;
}

export type HetznerImageStatus = "creating" | "available" | "unknown";

export interface HetznerImageStatusResult {
  status: HetznerImageStatus;
}

export interface HetznerClient {
  findServerByName(name: string): Promise<HetznerCreateServerResult | null>;
  /** Legacy: provision a server FROM an existing snapshot (used by the
   *  on-connect path that lives outside the W11 scope). */
  createServerFromSnapshot(
    args: HetznerCreateServerArgs,
  ): Promise<HetznerCreateServerResult>;
  /** W11 — provision a fresh Ubuntu server with cloud-init `user_data`
   *  that wgets the personalized ISO and dd's it onto /dev/sda. */
  createServerWithUserData(
    args: HetznerCreateServerWithUserDataArgs,
  ): Promise<HetznerCreateServerResult>;
  getServerStatus(serverId: string): Promise<HetznerServerStatusResult>;
  destroyServer(serverId: string): Promise<void>;
  /** Trigger an asynchronous snapshot of a running server. The
   *  resulting image id is returned immediately; the caller polls
   *  `getImageStatus` until `available`. */
  createImageSnapshot(
    serverId: string,
    description: string,
  ): Promise<HetznerSnapshotResult>;
  getImageStatus(imageId: string): Promise<HetznerImageStatusResult>;
  destroyImage(imageId: string): Promise<void>;
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
    async findServerByName(name) {
      const { status, text } = await call("GET", `/servers?name=${encodeURIComponent(name)}`);
      if (status < 200 || status >= 300) {
        throwOnError("GET", "/servers", status, text);
      }
      const parsed = text ? safeJsonParse(text) : null;
      const server = (parsed as {
        servers?: Array<{ id?: unknown; public_net?: { ipv4?: { ip?: unknown } } }>;
      } | null)?.servers?.[0];
      if (!server?.id) return null;
      const ip = server.public_net?.ipv4?.ip;
      return {
        serverId: String(server.id),
        ipv4: typeof ip === "string" && ip.length > 0 ? ip : null,
      };
    },
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

    // W11 — provision a Hetzner Ubuntu server with cloud-init user_data
    // that wgets the personalized ISO and dd's it onto /dev/sda. The
    // operator's laptop never SSHes — the cloud-init script does
    // everything as root at first boot. Same model as nixos-infect /
    // hetzner-installimage / DigitalOcean's "Reinstall from URL".
    //
    // CORRUPTION WINDOW: dd'ing the running root disk overwrites the
    // very partition table the running kernel was booted from. This is
    // intentional — once dd finishes we `reboot -f` and the BIOS
    // re-reads the now-Alpine partition table from disk. Safe because
    // (a) the script runs end-to-end without touching anything that
    // would re-read /dev/sda mid-stream, (b) `sync` flushes the page
    // cache, (c) `reboot -f` skips userspace teardown so we don't fault
    // on the now-stale rootfs. A power-cut during the dd would brick
    // the server, but the failure mode is "VPS won't boot" not "data
    // loss" — we just destroy the temp VPS and re-provision.
    async createServerWithUserData(args) {
      const image = args.image ?? "ubuntu-22.04";
      const tried: string[] = [];
      const candidates = [args.serverType, ...(args.fallbackServerTypes ?? [])];
      let lastErr: HetznerClientError | null = null;
      for (const candidate of candidates) {
        tried.push(candidate);
        const body: Record<string, unknown> = {
          name: args.name,
          image,
          location: args.location,
          server_type: candidate,
          user_data: args.userData,
          start_after_create: true,
          labels: { "flagship-demo": args.username.toLowerCase() },
        };
        if (args.sshKeyId !== undefined) {
          body.ssh_keys = [args.sshKeyId];
        }
        const { status, text } = await call("POST", "/servers", body);
        if (status >= 200 && status < 300) {
          const parsed = text ? safeJsonParse(text) : null;
          const server = (parsed as {
            server?: { id?: unknown; public_net?: { ipv4?: { ip?: unknown } } };
          })?.server;
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
        }
        // 422 is the deprecation / unsupported-location / placement
        // class — only those are worth retrying with a fallback type.
        // Any other non-2xx is a hard error.
        lastErr = new HetznerClientError(
          `Hetzner POST /servers (${candidate}) → HTTP ${status}: ${text.slice(0, 240)}`,
          status,
          text.slice(0, 240),
        );
        if (status !== 422) break;
      }
      throw (
        lastErr ??
        new HetznerClientError(
          `Hetzner POST /servers exhausted candidates: ${tried.join(", ")}`,
          0,
          "",
        )
      );
    },

    async createImageSnapshot(serverId, description) {
      const { status, text } = await call(
        "POST",
        `/servers/${encodeURIComponent(serverId)}/actions/create_image`,
        { type: "snapshot", description },
      );
      if (status < 200 || status >= 300) {
        throwOnError(
          "POST",
          `/servers/${serverId}/actions/create_image`,
          status,
          text,
        );
      }
      const parsed = text ? safeJsonParse(text) : null;
      const imageId = (parsed as { image?: { id?: unknown } })?.image?.id;
      if (imageId === undefined || imageId === null) {
        throw new HetznerClientError(
          "Hetzner create_image response missing image.id",
          status,
          text.slice(0, 240),
        );
      }
      return { imageId: String(imageId) };
    },

    async getImageStatus(imageId) {
      const { status, text } = await call(
        "GET",
        `/images/${encodeURIComponent(imageId)}`,
      );
      if (status < 200 || status >= 300) {
        throwOnError("GET", `/images/${imageId}`, status, text);
      }
      const parsed = text ? safeJsonParse(text) : null;
      const raw = String(
        (parsed as { image?: { status?: unknown } })?.image?.status ?? "unknown",
      );
      const mapped: HetznerImageStatus =
        raw === "creating" || raw === "available" ? raw : "unknown";
      return { status: mapped };
    },

    async destroyImage(imageId) {
      const { status, text } = await call(
        "DELETE",
        `/images/${encodeURIComponent(imageId)}`,
      );
      if (status === 404) return;
      if (status < 200 || status >= 300) {
        throwOnError("DELETE", `/images/${imageId}`, status, text);
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
