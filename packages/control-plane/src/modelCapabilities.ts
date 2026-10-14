/**
 * The capability table behind own-key model menus: context size, image
 * input, tool calling and the reasoning efforts each model takes. A `.com`
 * cron rebuilds it once a day from OpenRouter's public catalog
 * (`https://openrouter.ai/api/v1/models`, JSON, no key, no scraping) and the
 * box reads it from `GET /api/inference/capabilities`. A model first seen in
 * the last two weeks is "new": the refresh logs it and the owner's admin view
 * (`GET /api/admin/model-capabilities`) lists them.
 */

import { capabilityFromOpenRouter, type CapabilityTableResponse, type ModelCapability } from "@flagship/protocol";
import type { HandlerResponse } from "./types.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** A row not seen in this long is no longer served (it left the catalog). */
export const CAPABILITY_STALE_MS = 3 * 24 * 60 * 60_000;
/** "New" in the admin view. */
export const CAPABILITY_NEW_MS = 14 * 24 * 60 * 60_000;

export interface CapabilityRow {
  capability: ModelCapability;
  /** 0 for models already there when tracking began. */
  firstSeen: number;
  lastSeen: number;
}

export interface ModelCapabilityStore {
  count(): Promise<number>;
  /** Insert or refresh rows; a new id keeps `firstSeen`, a known one keeps its own. */
  upsert(rows: CapabilityRow[]): Promise<void>;
  /** Rows seen at or after `since`. */
  list(since: number): Promise<CapabilityRow[]>;
}

export interface RefreshResult {
  total: number;
  added: string[];
}

/**
 * Fetch OpenRouter's catalog and refresh the table. On the very first run
 * every model counts as already known (first seen 0), so the admin view
 * starts empty rather than listing four hundred "new" models.
 */
export async function refreshModelCapabilities(deps: {
  store: ModelCapabilityStore;
  fetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now: number;
  log?: (msg: string) => void;
}): Promise<RefreshResult> {
  const res = await deps.fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) throw new Error(`OpenRouter catalog answered ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  const rows = (Array.isArray(body.data) ? body.data : [])
    .map(capabilityFromOpenRouter)
    .filter((c): c is ModelCapability => c !== null);
  if (rows.length < 20) throw new Error(`OpenRouter catalog had only ${rows.length} usable models`);
  const first = (await deps.store.count()) === 0;
  const known = new Set((await deps.store.list(0)).map((r) => r.capability.id));
  const added = first ? [] : rows.filter((r) => !known.has(r.id)).map((r) => r.id);
  await deps.store.upsert(rows.map((capability) => ({ capability, firstSeen: first ? 0 : deps.now, lastSeen: deps.now })));
  if (added.length > 0) deps.log?.(`[model-capabilities] new models: ${added.join(", ")}`);
  return { total: rows.length, added };
}

/** `GET /api/inference/capabilities`: every model OpenRouter listed lately. */
export async function handleModelCapabilities(deps: { store: ModelCapabilityStore; now: number }): Promise<HandlerResponse> {
  const rows = await deps.store.list(deps.now - CAPABILITY_STALE_MS);
  const body: CapabilityTableResponse = {
    fetchedAt: rows.reduce((m, r) => Math.max(m, r.lastSeen), 0),
    models: rows.map((r) => r.capability).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { status: 200, body };
}

/** The owner's admin view: models first seen in the last two weeks, newest first. */
export async function handleNewModelCapabilities(deps: { store: ModelCapabilityStore; now: number }): Promise<HandlerResponse> {
  const since = deps.now - CAPABILITY_NEW_MS;
  const rows = (await deps.store.list(since)).filter((r) => r.firstSeen >= since);
  rows.sort((a, b) => b.firstSeen - a.firstSeen || a.capability.id.localeCompare(b.capability.id));
  return {
    status: 200,
    body: {
      since,
      models: rows.map((r) => ({
        id: r.capability.id,
        name: r.capability.name,
        firstSeen: r.firstSeen,
        contextTokens: r.capability.contextTokens,
        input: r.capability.input,
        tools: r.capability.tools,
        efforts: r.capability.reasoning?.efforts ?? [],
        priceIn: r.capability.priceIn,
        priceOut: r.capability.priceOut,
      })),
    },
  };
}

/** An in-memory store, for tests and local runs. */
export class InMemoryModelCapabilityStore implements ModelCapabilityStore {
  private rows = new Map<string, CapabilityRow>();
  async count(): Promise<number> {
    return this.rows.size;
  }
  async upsert(rows: CapabilityRow[]): Promise<void> {
    for (const r of rows) {
      const had = this.rows.get(r.capability.id);
      this.rows.set(r.capability.id, { ...r, firstSeen: had ? had.firstSeen : r.firstSeen });
    }
  }
  async list(since: number): Promise<CapabilityRow[]> {
    return [...this.rows.values()].filter((r) => r.lastSeen >= since).map((r) => ({ ...r }));
  }
}
