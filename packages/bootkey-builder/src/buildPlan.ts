import type { Bytes } from "@flagship/protocol";

export interface BuildSpec {
  userId: string;
  newServerId: string;
  irkPublicKey: Bytes;
  bakPublicKey: Bytes;
  swkProvisioningTokenHash: Bytes;
  wifi: { ssid: string; psk: string };
  shareRatio: number;
  totalDiskGb: number;
  issuedAt: number;
}

export interface PartitionPlan {
  name: string;
  sizeGb: number;
  fs: "ext4" | "btrfs";
  encrypted: boolean;
  mountPoint: string;
}

export interface ConfigFile {
  path: string;
  content: string;
  mode?: number;
}

export interface SystemContainer {
  /** Logical name used in service file naming. */
  name: string;
  /** OCI image reference. */
  image: string;
  /** Internal subdomain this container is reachable at via the local Caddy. */
  subdomain?: string;
  /** Persistent volume mount: container_path → host_path under /var/flagship/system/<name>. */
  volumes?: Record<string, string>;
  /** Description shown to the user in the desktop UI. */
  description: string;
}

export interface BuildPlan {
  spec: BuildSpec;
  partitions: PartitionPlan[];
  initramfsModules: string[];
  systemdUnits: string[];
  systemContainers: SystemContainer[];
  configFiles: ConfigFile[];
}

const SYSTEM_RESERVED_GB = 8;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function planBuild(spec: BuildSpec): BuildPlan {
  if (spec.shareRatio < 0 || spec.shareRatio > 0.9) {
    throw new Error("shareRatio must be in [0, 0.9]");
  }
  if (spec.totalDiskGb < 16) {
    throw new Error("totalDiskGb must be >= 16");
  }
  if (!spec.wifi.ssid) throw new Error("wifi.ssid is required");
  if (!spec.userId) throw new Error("userId is required");
  if (!spec.newServerId) throw new Error("newServerId is required");
  // serverId is the human-facing DNS label (e.g. "home-box", "chillout").
  // It's baked into every URL: <app>.<server>.<user>.flagship.services
  if (!DNS_LABEL_RE.test(spec.userId)) {
    throw new Error(`userId must match RFC 1035 label rules (got ${JSON.stringify(spec.userId)})`);
  }
  if (!DNS_LABEL_RE.test(spec.newServerId)) {
    throw new Error(`newServerId must match RFC 1035 label rules (got ${JSON.stringify(spec.newServerId)})`);
  }
  assertHexBytes("irkPublicKey", spec.irkPublicKey, 32);
  assertHexBytes("bakPublicKey", spec.bakPublicKey, 32);
  assertHexBytes("swkProvisioningTokenHash", spec.swkProvisioningTokenHash, 32);

  const userlandGb = spec.totalDiskGb - SYSTEM_RESERVED_GB;
  const backupGb = Math.floor(userlandGb * spec.shareRatio);
  const userGb = userlandGb - backupGb;

  const partitions: PartitionPlan[] = [
    { name: "system", sizeGb: SYSTEM_RESERVED_GB, fs: "ext4", encrypted: true, mountPoint: "/" },
    { name: "user-data", sizeGb: userGb, fs: "btrfs", encrypted: true, mountPoint: "/var/flagship/data" },
  ];
  if (backupGb > 0) {
    partitions.push({
      name: "peer-backup-pool",
      sizeGb: backupGb,
      fs: "ext4",
      encrypted: true,
      mountPoint: "/var/flagship/peer-pool",
    });
  }

  return {
    spec,
    partitions,
    initramfsModules: ["dracut-network", "systemd-networkd", "flagship-unlock"],
    systemdUnits: [
      "flagship-server-daemon.service",
      "flagship-backup.timer",
      "flagship-tunnel.service",
      "flagship-system-containers.target",
    ],
    systemContainers: [
      {
        name: "forgejo",
        image: "codeberg.org/forgejo/forgejo:9",
        subdomain: "git",
        volumes: { "/data": "forgejo-data" },
        description: "Per-user git host. The LLM commits vibe-coded changes here; you browse, diff, and revert.",
      },
      {
        name: "caddy",
        image: "docker.io/library/caddy:2",
        volumes: { "/data": "caddy-data", "/config": "caddy-config" },
        description: "In-server reverse proxy. Terminates per-app TLS arriving via SNI passthrough; injects the X-Flagship-User identity header on every app request.",
      },
      // Unified data layer (FOSS only — see unified_data_layer.md).
      {
        name: "postgres",
        // PostgreSQL is PostgreSQL Global Development Group — perpetual FOSS.
        image: "docker.io/library/postgres:16-alpine",
        volumes: { "/var/lib/postgresql/data": "postgres-data" },
        description: "Unified relational store. Per-app DB + role created on deploy; FLAGSHIP_PG_URL injected into the container.",
      },
      {
        name: "minio",
        // MinIO uses AGPLv3; we ship the upstream FOSS image, not the commercial one.
        image: "docker.io/minio/minio:latest",
        volumes: {
          "/data": "minio-data",
          "/root/.minio": "minio-config",
        },
        description: "Unified object store. Per-app bucket + access key created on deploy; FLAGSHIP_S3_* injected.",
      },
      {
        name: "redis",
        // Redis 7.2 was released under BSD; we pin to that line. If the project
        // re-licenses upstream we'll switch to the Valkey fork.
        image: "docker.io/library/redis:7.2-alpine",
        volumes: { "/data": "redis-data" },
        description: "Unified KV / pubsub store. Per-app ACL user with key prefix; FLAGSHIP_REDIS_URL injected.",
      },
    ],
    configFiles: [
      {
        path: "/etc/flagship/server.json",
        content: serverJson(spec),
        mode: 0o600,
      },
      {
        path: "/etc/wpa_supplicant/wpa_supplicant.conf",
        content: wifiConfig(spec.wifi),
        mode: 0o600,
      },
      {
        path: "/etc/flagship/share-ratio",
        content: `${spec.shareRatio}\n`,
      },
    ],
  };
}

function serverJson(spec: BuildSpec): string {
  return (
    JSON.stringify(
      {
        serverId: spec.newServerId,
        userId: spec.userId,
        irkPublicKey: bytesToHex(spec.irkPublicKey),
        bakPublicKey: bytesToHex(spec.bakPublicKey),
        swkProvisioningTokenHash: bytesToHex(spec.swkProvisioningTokenHash),
        issuedAt: spec.issuedAt,
      },
      null,
      2,
    ) + "\n"
  );
}

function wifiConfig(wifi: { ssid: string; psk: string }): string {
  // Image is single-use-per-machine because the home WiFi PSK lives in it.
  // Distribute over HTTPS only; flash promptly.
  return (
    `ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\n` +
    `update_config=1\n\n` +
    `network={\n` +
    `  ssid=${quote(wifi.ssid)}\n` +
    `  psk=${quote(wifi.psk)}\n` +
    `  key_mgmt=WPA-PSK\n` +
    `}\n`
  );
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function assertHexBytes(name: string, b: Bytes, len: number): void {
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
