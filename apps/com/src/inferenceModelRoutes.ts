/**
 * The AI model menus' public data, and the owner's view of new models:
 *
 *   GET /api/inference/models         Flagship Inference's catalog (tiers,
 *                                     multipliers, labels), packages/
 *                                     control-plane/src/inferenceModels.ts
 *   GET /api/inference/capabilities   the daily capability table for own-key
 *                                     menus (context, images, tools, efforts)
 *   GET /api/admin/model-capabilities models first seen in the last two
 *                                     weeks (x-admin-secret)
 *
 * The table is rebuilt once a day by the 00:00 UTC cron from OpenRouter's
 * public catalog (runModelCapabilityRefresh). None of this takes or keeps
 * anything about the caller.
 */

import {
  authorizeAdmin,
  freeAiConfigFromEnv,
  handleModelCapabilities,
  handleNewModelCapabilities,
  inferenceCatalogResponse,
  refreshModelCapabilities,
  type CapabilityRow,
  type ModelCapabilityStore,
} from "@flagship/control-plane";
import type { ModelCapability } from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";

export const INFERENCE_MODELS_PATH = "/api/inference/models";
export const INFERENCE_CAPABILITIES_PATH = "/api/inference/capabilities";
export const ADMIN_MODEL_CAPABILITIES_PATH = "/api/admin/model-capabilities";

export interface InferenceModelEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
  AI_PROMO_INPUT_WEIGHT?: string;
  AI_PROMO_OUTPUT_WEIGHT?: string;
}

export function isInferenceModelPath(pathname: string): boolean {
  return (
    pathname === INFERENCE_MODELS_PATH ||
    pathname === INFERENCE_CAPABILITIES_PATH ||
    pathname === ADMIN_MODEL_CAPABILITIES_PATH
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
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (path === INFERENCE_MODELS_PATH) {
    const cfg = freeAiConfigFromEnv(env as Record<string, string | undefined>);
    return json(
      inferenceCatalogResponse({ inputWeight: cfg.inputWeight, outputWeight: cfg.outputWeight }),
      200,
      "public, max-age=300",
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
