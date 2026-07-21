import type {
  AuditEventStorage,
  DemoUserRecord,
  DemoUsersStorage,
} from "@flagship/storage";
import { notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

export const DEMO_PAIRED_SESSION_CAP = 3;

export interface DemoProviderStatusClient {
  getServerStatus(
    serverId: string,
  ): Promise<{ status: string; ipv4: string | null }>;
}

export interface DemoUsersDeps {
  storage: DemoUsersStorage;
  hetzner: DemoProviderStatusClient;
  audit?: AuditEventStorage;
  now?: () => number;
}

function nowMs(deps: DemoUsersDeps): number {
  return (deps.now ?? Date.now)();
}

function publicStatus(row: DemoUserRecord): "none" | "provisioning" | "up" {
  if (row.state === "ready") return row.activeServerId ? "up" : "none";
  if (row.state === "cleanup-only" || row.state === "failed") return "none";
  return "provisioning";
}

export function demoServerFqdn(username: string): string {
  return `home.${username.toLowerCase()}.flagship.services`;
}

export async function handleGetDemoUser(
  deps: DemoUsersDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const row = await deps.storage.get(username.toLowerCase());
  if (!row) return notFound("no such demo user");
  let provider: { status: string; ipv4: string | null } | null = null;
  if (row.activeServerId) {
    try {
      provider = await deps.hetzner.getServerStatus(row.activeServerId);
    } catch {
      provider = null;
    }
  }
  return ok({
    username: row.username,
    idempotencyKey: row.idempotencyKey,
    state: row.state,
    activeServerId: row.activeServerId,
    activeServerFqdn: row.activeServerFqdn,
    region: row.region,
    size: row.size,
    createdAt: row.createdAt,
    provider,
  });
}

export async function handleListDemoUsers(
  deps: DemoUsersDeps,
): Promise<HandlerResponseWithHeaders> {
  const rows = await deps.storage.list();
  return ok({
    demoUsers: rows.map((row) => ({
      username: row.username,
      idempotencyKey: row.idempotencyKey,
      state: row.state,
      activeServerId: row.activeServerId,
      activeServerFqdn: row.activeServerFqdn,
      createdAt: row.createdAt,
    })),
  });
}

export async function runDemoProvisioningPoller(
  deps: DemoUsersDeps,
  isRegistered: (fqdn: string, createdAt: number) => Promise<boolean>,
): Promise<{ promoted: number }> {
  let promoted = 0;
  for (const row of await deps.storage.list()) {
    if (row.state !== "provisioning" || !row.activeServerId) continue;
    let live: { status: string; ipv4: string | null };
    try {
      live = await deps.hetzner.getServerStatus(row.activeServerId);
    } catch {
      continue;
    }
    if (live.status !== "running") continue;
    const fqdn = row.activeServerFqdn ?? demoServerFqdn(row.username);
    if (!(await isRegistered(fqdn, row.createdAt))) continue;
    const ready = await deps.storage.transition(
      row.username,
      "provisioning",
      "ready",
      {
        activeServerFqdn: fqdn,
        activeServerIp: live.ipv4,
        lastActivityAt: nowMs(deps),
      },
    );
    if (!ready) continue;
    promoted += 1;
    try {
      await deps.audit?.append({
        username: row.username,
        eventKind: "demo-vps-provisioned",
        detail: `serverId=${row.activeServerId} fqdn=${fqdn}`,
        devicePrefix: "",
        postedAt: nowMs(deps),
      });
    } catch {
      // Provisioning remains ready when optional audit storage is unavailable.
    }
  }
  return { promoted };
}

export interface DemoServerBlock {
  fqdn: string;
  status: "none" | "provisioning" | "up";
  ttlIdleMinutes: number;
  phase: string | null;
  phaseAt: number | null;
  lastError?: string;
  ip?: string;
  region?: string;
  serverType?: string;
  image?: string;
}

export function demoServerBlockFromRow(row: DemoUserRecord): DemoServerBlock {
  return {
    fqdn: row.activeServerFqdn ?? demoServerFqdn(row.username),
    status: publicStatus(row),
    ttlIdleMinutes: row.ttlIdleMinutes,
    phase: row.provisionPhase ?? null,
    phaseAt: row.provisionPhaseAt ?? null,
    ...(row.provisionLastError ? { lastError: row.provisionLastError } : {}),
    ...(row.activeServerIp ? { ip: row.activeServerIp } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.size ? { serverType: row.size } : {}),
    ...(row.image ? { image: row.image } : {}),
  };
}
