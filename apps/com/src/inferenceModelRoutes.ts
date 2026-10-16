/**
 * The AI model menus' public data, the owner's view of new models, and
 * Flagship Inference's server-side settings:
 *
 *   GET /api/inference/models         Flagship Inference's catalog (tiers,
 *                                     multipliers, labels), as the settings
 *                                     make it (packages/control-plane/src/
 *                                     inferenceSettings.ts)
 *   GET /api/inference/capabilities   the daily capability table for own-key
 *                                     menus (context, images, tools, efforts)
 *   GET /api/admin/model-capabilities models first seen in the last two
 *                                     weeks (x-admin-secret)
 *   GET|PUT /api/admin/inference-settings
 *                                     the settings in force, their history,
 *                                     and a change (x-admin-secret;
 *                                     scripts/inference-settings.mjs)
 *
 * The table is rebuilt once a day by the 00:00 UTC cron from OpenRouter's
 * public catalog (runModelCapabilityRefresh). None of this takes or keeps
 * anything about the caller.
 */

import {
  authorizeAdmin,
  freeAiConfigFrom,
  handleGetInferenceSettings,
  handleModelCapabilities,
  handleNewModelCapabilities,
  handlePutInferenceSettings,
  inferenceCatalogResponse,
  inferenceLineup,
  parseInferenceSettings,
  refreshModelCapabilities,
  type CapabilityRow,
  type InferenceSettings,
  type InferenceSettingsStore,
  type ModelCapabilityStore,
  type StoredInferenceSettings,
} from "@flagship/control-plane";
import type { ModelCapability } from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";

export const INFERENCE_MODELS_PATH = "/api/inference/models";
export const INFERENCE_CAPABILITIES_PATH = "/api/inference/capabilities";
export const ADMIN_MODEL_CAPABILITIES_PATH = "/api/admin/model-capabilities";
export const ADMIN_INFERENCE_SETTINGS_PATH = "/api/admin/inference-settings";

export interface InferenceModelEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
  AI_PROMO_STARTER_TOKENS?: string;
  AI_PROMO_WEEKLY_TOKENS?: string;
  AI_PROMO_DAILY_CAP_TOKENS?: string;
  AI_PROMO_INPUT_WEIGHT?: string;
  AI_PROMO_OUTPUT_WEIGHT?: string;
  AI_PROMO_ENDS_AT?: string;
}

export function isInferenceModelPath(pathname: string): boolean {
  return (
    pathname === INFERENCE_MODELS_PATH ||
    pathname === INFERENCE_CAPABILITIES_PATH ||
    pathname === ADMIN_MODEL_CAPABILITIES_PATH ||
    pathname === ADMIN_INFERENCE_SETTINGS_PATH
  );
}

function json(body: unknown, status = 200, cache?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(cache ? { "cache-control": cache } : { "cache-control": "no-store" }),
    },
  });
}

export async function handleInferenceModelRoutes(request: Request, env: InferenceModelEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === ADMIN_INFERENCE_SETTINGS_PATH) return handleInferenceSettingsRoute(request, env);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (path === INFERENCE_MODELS_PATH) {
    const stored = await loadInferenceSettings(env);
    const cfg = freeAiConfigFrom(envVars(env), stored);
    // A minute, so a settings change reaches the menus quickly.
    return json(
      inferenceCatalogResponse({ inputWeight: cfg.inputWeight, outputWeight: cfg.outputWeight }, inferenceLineup(stored)),
      200,
      "public, max-age=60",
    );
  }
  if (!env.DB) return json({ error: "model capabilities unavailable" }, 503);
  const store = new D1ModelCapabilityStore(env.DB);
  if (path === INFERENCE_CAPABILITIES_PATH) {
    const r = await handleModelCapabilities({ store, now: Date.now() });
    return json(r.body, r.status, "public, max-age=3600");
  }
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  const r = await handleNewModelCapabilities({ store, now: Date.now() });
  return json(r.body, r.status);
}

function envVars(env: InferenceModelEnv): Record<string, string | undefined> {
  return env as unknown as Record<string, string | undefined>;
}

async function handleInferenceSettingsRoute(request: Request, env: InferenceModelEnv): Promise<Response> {
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  if (!env.DB) return json({ error: "inference settings unavailable" }, 503);
  const deps = { store: new D1InferenceSettingsStore(env.DB), env: envVars(env) };
  if (request.method === "GET") {
    const r = await handleGetInferenceSettings(deps);
    return json(r.body, r.status);
  }
  if (request.method !== "PUT") return json({ error: "method not allowed" }, 405);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const r = await handlePutInferenceSettings(deps, body);
  if (r.status === 200) forgetInferenceSettings();
  return json(r.body, r.status);
}

/**
 * The stored settings, read at most every 30 s per isolate: every
 * allowance check and usage report needs them. A change reaches every
 * isolate within that (the menus within their 60 s cache on top). A row
 * that no longer validates (a model removed from the code since) and a D1
 * failure both fall back to the shipped defaults, logged.
 */
const SETTINGS_MEMO_MS = 30_000;
let settingsMemo: { at: number; value: InferenceSettings | null } | null = null;

export async function loadInferenceSettings(env: { DB?: D1Database }, now = Date.now()): Promise<InferenceSettings | null> {
  if (!env.DB) return null;
  if (settingsMemo && now - settingsMemo.at < SETTINGS_MEMO_MS) return settingsMemo.value;
  let value: InferenceSettings | null = null;
  try {
    const row = await new D1InferenceSettingsStore(env.DB).latest();
    if (row) {
      const parsed = parseInferenceSettings(row.settings);
      if (parsed.ok) value = parsed.value;
      else console.error(`[inference-settings] stored settings ignored: ${parsed.error}`);
    }
  } catch (e) {
    console.error("[inference-settings] read failed, using the shipped defaults", (e as Error).message);
    return settingsMemo?.value ?? null;
  }
  settingsMemo = { at: now, value };
  return value;
}

export function forgetInferenceSettings(): void {
  settingsMemo = null;
}

/** D1 `inference_settings` (migration 0103). */
export class D1InferenceSettingsStore implements InferenceSettingsStore {
  constructor(private readonly db: D1Database) {}

  async latest(): Promise<StoredInferenceSettings | null> {
    return (await this.history(1))[0] ?? null;
  }

  async history(limit: number): Promise<StoredInferenceSettings[]> {
    const r = await this.db
      .prepare("SELECT settings, note, set_at FROM inference_settings ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all<{ settings: string; note: string; set_at: number }>();
    const out: StoredInferenceSettings[] = [];
    for (const row of r.results ?? []) {
      try {
        out.push({ settings: JSON.parse(row.settings) as InferenceSettings, note: row.note, setAt: row.set_at });
      } catch {
        // a torn row is skipped; the one before it stays in force
      }
    }
    return out;
  }

  async put(row: StoredInferenceSettings): Promise<void> {
    await this.db
      .prepare("INSERT INTO inference_settings (settings, note, set_at) VALUES (?, ?, ?)")
      .bind(JSON.stringify(row.settings), row.note, row.setAt)
      .run();
  }
}

/** The daily refresh (00:00 UTC cron). */
export async function runModelCapabilityRefresh(env: InferenceModelEnv, now: Date): Promise<void> {
  if (!env.DB) return;
  const r = await refreshModelCapabilities({
    store: new D1ModelCapabilityStore(env.DB),
    fetch: (url) => fetch(url, { headers: { accept: "application/json" } }),
    now: now.getTime(),
    log: (m) => console.log(m),
  });
  console.log(`[model-capabilities] refreshed ${r.total} models, ${r.added.length} new`);
}

/** D1 `model_capabilities` (migration 0095). */
export class D1ModelCapabilityStore implements ModelCapabilityStore {
  constructor(private readonly db: D1Database) {}

  async count(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM model_capabilities").first<{ n: number }>();
    return r?.n ?? 0;
  }

  async upsert(rows: CapabilityRow[]): Promise<void> {
    const sql =
      "INSERT INTO model_capabilities (id, data, first_seen, last_seen) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, last_seen = excluded.last_seen";
    for (let i = 0; i < rows.length; i += 100) {
      await this.db.batch(
        rows
          .slice(i, i + 100)
          .map((r) => this.db.prepare(sql).bind(r.capability.id, JSON.stringify(r.capability), r.firstSeen, r.lastSeen)),
      );
    }
  }

  async list(since: number): Promise<CapabilityRow[]> {
    const r = await this.db
      .prepare("SELECT data, first_seen, last_seen FROM model_capabilities WHERE last_seen >= ?")
      .bind(since)
      .all<{ data: string; first_seen: number; last_seen: number }>();
    const out: CapabilityRow[] = [];
    for (const row of r.results ?? []) {
      try {
        out.push({ capability: JSON.parse(row.data) as ModelCapability, firstSeen: row.first_seen, lastSeen: row.last_seen });
      } catch {
        // a torn row is skipped; the next refresh rewrites it
      }
    }
    return out;
  }
}
