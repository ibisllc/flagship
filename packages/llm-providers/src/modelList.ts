/**
 * List the models an owner's own key can use, live from the provider:
 *   - OpenAI and any OpenAI-compatible host (DeepInfra, Groq, Together,
 *     Mistral, …): `GET {base}/v1/models`
 *   - OpenRouter: `GET {base}/v1/models`
 *   - Anthropic: `GET {base}/v1/models`
 *   - Google: `GET {base}/v1beta/models` (generateContent models only)
 *   - Ollama: `GET {base}/api/tags`
 * `listed: false` means the provider has no list the box could read; the apps
 * then offer a free-text model field. The key is used for this one call and
 * never logged.
 */

import type { FetchLike, ProviderConfig } from "./types.js";

export interface ListedModel {
  id: string;
  name?: string;
  contextTokens?: number;
}

export type ModelListResult =
  | { ok: true; models: ListedModel[] }
  | { ok: false; reason: "no-list" | "rejected" | "failed"; status?: number };

const BASES: Record<string, string> = {
  openai: "https://api.openai.com",
  openrouter: "https://openrouter.ai/api",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

const MAX_MODELS = 1000;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function request(provider: string, cfg: ProviderConfig): { url: string; headers: Record<string, string> } | null {
  const base = (cfg.baseUrl ?? BASES[provider] ?? "").replace(/\/+$/, "");
  if (!base) return null;
  switch (provider) {
    case "openai":
    case "openrouter":
      return { url: `${base}/v1/models`, headers: { authorization: `Bearer ${cfg.apiKey}` } };
    case "anthropic":
      return {
        url: `${base}/v1/models?limit=1000`,
        headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      };
    case "google":
      return { url: `${base}/v1beta/models?pageSize=1000&key=${encodeURIComponent(cfg.apiKey)}`, headers: {} };
    case "ollama":
      return { url: `${base}/api/tags`, headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {} };
    default:
      return null;
  }
}

function parse(provider: string, body: unknown): ListedModel[] {
  const b = (body ?? {}) as { data?: unknown; models?: unknown };
  const out: ListedModel[] = [];
  if (provider === "google") {
    for (const m of Array.isArray(b.models) ? b.models : []) {
      const r = m as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; supportedGenerationMethods?: unknown };
      const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : [];
      const name = str(r.name);
      if (!name || !methods.includes("generateContent")) continue;
      out.push({
        id: name.replace(/^models\//, ""),
        ...(str(r.displayName) ? { name: str(r.displayName) } : {}),
        ...(count(r.inputTokenLimit) ? { contextTokens: count(r.inputTokenLimit) } : {}),
      });
    }
  } else if (provider === "ollama") {
    for (const m of Array.isArray(b.models) ? b.models : []) {
      const id = str((m as { name?: unknown }).name);
      if (id) out.push({ id });
    }
  } else {
    for (const m of Array.isArray(b.data) ? b.data : []) {
      const r = m as { id?: unknown; display_name?: unknown; name?: unknown; max_input_tokens?: unknown; context_length?: unknown };
      const id = str(r.id);
      if (!id) continue;
      const name = str(r.display_name) ?? (provider === "openrouter" ? str(r.name) : undefined);
      const ctx = count(r.max_input_tokens) ?? count(r.context_length);
      out.push({ id, ...(name ? { name } : {}), ...(ctx ? { contextTokens: ctx } : {}) });
    }
  }
  return out.slice(0, MAX_MODELS);
}

export async function listProviderModels(
  provider: string,
  cfg: ProviderConfig,
  fetchImpl: FetchLike,
): Promise<ModelListResult> {
  const req = request(provider, cfg);
  if (!req) return { ok: false, reason: "no-list" };
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(req.url, { method: "GET", headers: req.headers });
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (res.status === 404 || res.status === 405) return { ok: false, reason: "no-list", status: res.status };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "rejected", status: res.status };
  if (!res.ok) return { ok: false, reason: "failed", status: res.status };
  try {
    const models = parse(provider, await res.json());
    return models.length > 0 ? { ok: true, models } : { ok: false, reason: "no-list" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
