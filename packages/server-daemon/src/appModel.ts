/**
 * The box's side of manifest schema 2 (P01) for the runtimes that need it
 * (P04 WASI, P05 app groups, docs/wasi-apps.md, docs/app-groups.md): parse
 * either schema into the one normalized model, refuse what this box can't
 * honour (protocol `admitApp`) instead of dropping it, and turn the model
 * into the runtime part of an app's spec. A v1 manifest gives exactly what it
 * always gave.
 */
import {
  BOX_CAPABILITIES_0_3,
  admitApp,
  parseAnyManifest,
  type AppManifest,
  type BoxRuntimeCapabilities,
  type NormalizedApp,
} from "@flagship/protocol";
import type { AppDataCredentials } from "./dataLayer/provisioner.js";
import { limitsFromResources, type AppSpec } from "./serviceRunner.js";
import type { GroupMemberSpec } from "./appGroups/runner.js";
import { DEFAULT_WASI_RUN_LIMITS, type WasiAppSpec } from "./wasi/runner.js";

export type ParsedApp = { ok: true; manifest: AppManifest; app: NormalizedApp; source: string; notes?: string[] } | { ok: false; errors: string[] };

/** Parse an install's manifest (either schema) and check this box can run it. */
export function parseAppManifest(json: string, box: BoxRuntimeCapabilities = BOX_CAPABILITIES_0_3): ParsedApp {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    input = null;
  }
  const r = parseAnyManifest(input);
  if (!r.ok) return { ok: false, errors: r.errors };
  const admitted = admitApp(r.app, box);
  if (!admitted.ok) return { ok: false, errors: admitted.refusals.map((x) => x.message) };
  if (r.app.wasi && !r.app.wasi.digest) return { ok: false, errors: ["a WebAssembly app's install must name its module's digest (runtime.digest)"] };
  return { ok: true, manifest: r.app.manifest, app: r.app, source: json, ...(r.notes ? { notes: r.notes } : {}) };
}

/** Per-request ceilings a manifest's `resources.memoryMiB` can raise a WASI run to. */
const WASI_MAX_RUN_MEMORY_MIB = 1024;
const WASI_CONCURRENT_RUNS = 4;

export interface RuntimeExtrasInput {
  serviceId: string;
  app: NormalizedApp | undefined;
  data: AppDataCredentials | null;
  /** The main process's image (a component with a `base` runs the app's own build). */
  appImage: string;
  /** Owned gateway ports for group links (appGroups/portBook.ts). */
  linkPortFor?: (key: string) => Promise<number>;
  pickPort?: () => number;
}

function randomPort(): number {
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}

/** The runtime part of an app's spec: limits, and a WASI or group description when the app has one. */
export async function runtimeExtras(i: RuntimeExtrasInput): Promise<Pick<AppSpec, "limits" | "wasi" | "group">> {
  const app = i.app;
  if (!app || app.schemaVersion === 1) return {};
  const out: Pick<AppSpec, "limits" | "wasi" | "group"> = {};
  const limits = limitsFromResources(app.resources);
  if (app.wasi) {
    const memory = Math.min(WASI_MAX_RUN_MEMORY_MIB, app.resources?.memoryMiB ?? DEFAULT_WASI_RUN_LIMITS.memoryMiB);
    const wasi: WasiAppSpec = {
      world: app.wasi.world,
      moduleDigest: app.wasi.digest!,
      files: !!i.data?.files,
      egressHosts: (app.manifest.network?.egress ?? []).map((h) => h.toLowerCase()),
      postgres: { ...(i.data?.postgres ?? {}) },
      runLimits: { ...DEFAULT_WASI_RUN_LIMITS, memoryMiB: memory },
      maxConcurrentRuns: WASI_CONCURRENT_RUNS,
      unit: {
        memoryMiB: memory * WASI_CONCURRENT_RUNS + 128,
        // Connection threads (up to 32), the epoch ticker and the host-call pool.
        tasks: Math.min(1024, Math.max(128, app.resources?.pids ?? 256)),
        cpuPercent: Math.round(((app.resources?.cpuMillis ?? 1000) / 1000) * 100),
        restart: app.restart ?? "on-failure",
      },
    };
    out.wasi = wasi;
    return out;
  }
  if (limits) out.limits = limits;
  if (app.components.length > 0) {
    const pick = i.pickPort ?? randomPort;
    const members: GroupMemberSpec[] = [];
    for (const c of app.components) {
      const m: GroupMemberSpec = {
        name: c.name,
        image: c.base !== undefined && !c.image ? i.appImage : c.image,
        startAfter: [...c.startAfter],
        ...(c.start ? { command: [...c.start] } : {}),
        ...(limitsFromResources(c.resources) ? { limits: limitsFromResources(c.resources)! } : {}),
      };
      if (c.port !== undefined) {
        if (!i.linkPortFor) throw new Error("this server can't connect an app's processes");
        m.port = c.port;
        m.hostPort = pick();
        m.linkPort = await i.linkPortFor(`group:${i.serviceId}:${c.name}`);
      }
      members.push(m);
    }
    out.group = { members };
  }
  return out;
}

/** What the app's page can show about how it runs (no secrets). */
export function runtimeSummary(app: NormalizedApp | undefined): { kind: "container" | "group" | "wasi"; world?: string; moduleDigest?: string; members?: Array<{ name: string; startAfter: string[] }> } {
  if (!app) return { kind: "container" };
  if (app.wasi) return { kind: "wasi", world: app.wasi.world, ...(app.wasi.digest ? { moduleDigest: app.wasi.digest } : {}) };
  if (app.components.length > 0) return { kind: "group", members: app.components.map((c) => ({ name: c.name, startAfter: [...c.startAfter] })) };
  return { kind: "container" };
}
