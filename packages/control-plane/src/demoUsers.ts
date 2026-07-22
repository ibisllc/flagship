import type {
  AuditEventStorage,
  DemoUserRecord,
  DemoUsersStorage,
} from "@flagship/storage";
import { signPhoneOrder, type PhoneOrder } from "@flagship/protocol";
import { deriveDemoUserIrk } from "./demoIdentity.js";
import { bytesToHex, HEX64 } from "./hex.js";
import {
  conflict,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

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

export interface DemoPairingDeps {
  storage: DemoUsersStorage;
  demoIrkKek: Uint8Array;
  postOrder: (
    fqdn: string,
    envelope: { request: PhoneOrder; signature: string },
  ) => Promise<{ status: number }>;
  now?: () => number;
}

export interface DemoPairingBody {
  token?: unknown;
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

/**
 * Mint one ordinary paired session on a live demo box. Demo usernames are a
 * public capability, but the deterministic owner IRK remains Worker-held; this
 * endpoint signs only the non-sensitive add-paired-session order and forwards
 * it directly to the demo box. Real-account rows can never enter this path.
 */
export async function handlePairDemoUser(
  deps: DemoPairingDeps,
  username: string,
  body: DemoPairingBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const token = typeof body?.token === "string" ? body.token.toLowerCase() : "";
  if (!HEX64.test(token)) {
    return malformed("token must be 64-hex");
  }
  const row = await deps.storage.get(username.toLowerCase());
  if (!row) return notFound("no such demo user");
  if (row.state !== "ready" || !row.activeServerFqdn) {
    return conflict("demo server is not ready");
  }

  const issuedAt = (deps.now ?? Date.now)();
  const request: Extract<PhoneOrder, { type: "add-paired-session" }> = {
    type: "add-paired-session",
    serverId: row.activeServerFqdn,
    token,
    issuedAt,
  };
  const signature = bytesToHex(
    signPhoneOrder(request, deriveDemoUserIrk(deps.demoIrkKek, row.username)),
  );
  let upstream: { status: number };
  try {
    upstream = await deps.postOrder(row.activeServerFqdn, { request, signature });
  } catch {
    return { status: 502, body: { error: "demo server pairing failed" } };
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    return {
      status: 502,
      body: { error: "demo server rejected the pairing request" },
    };
  }
  await deps.storage.update(row.username, { lastActivityAt: issuedAt });
  return {
    ...ok({ ok: true, fqdn: row.activeServerFqdn }),
    headers: { "cache-control": "private, no-store" },
  };
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
        // The install is over. Leaving the last in-flight phase behind makes a
        // running server advertise mid-install progress forever — especially
        // when the provider server was ADOPTED and never replayed the later
        // phases at all.
        provisionPhase: null,
        provisionPhaseAt: null,
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
  const status = publicStatus(row);
  return {
    fqdn: row.activeServerFqdn ?? demoServerFqdn(row.username),
    status,
    ttlIdleMinutes: row.ttlIdleMinutes,
    // `phase` describes provisioning PROGRESS. Once the server is up it is
    // meaningless, and reporting a stale one contradicts the status beside it.
    // Suppressed defensively here too, so rows written before the transition
    // learned to clear it don't keep lying.
    phase: status === "up" ? null : (row.provisionPhase ?? null),
    phaseAt: status === "up" ? null : (row.provisionPhaseAt ?? null),
    ...(row.provisionLastError ? { lastError: row.provisionLastError } : {}),
    ...(row.activeServerIp ? { ip: row.activeServerIp } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.size ? { serverType: row.size } : {}),
    ...(row.image ? { image: row.image } : {}),
  };
}
