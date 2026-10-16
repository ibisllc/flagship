/**
 * What Flagship Inference offers, as server-side settings: which catalog
 * models are on, the default, each model's multiplier and description, and
 * the promotion's allowance. The owner changes them from feedback without a
 * deploy (`scripts/inference-settings.mjs`, docs/runbooks/inference-settings.md).
 *
 * Three layers, each over the one before:
 *   1. the shipped decision, {@link INFERENCE_SETTINGS_DEFAULTS} (and
 *      FREE_AI_DEFAULTS for the allowance);
 *   2. `.com`'s AI_PROMO_* env vars (allowance only);
 *   3. the latest row of D1 `inference_settings`, set through
 *      `PUT /api/admin/inference-settings`. Every row is kept as history.
 * The model definitions themselves (upstream ids, prices, thinking switches)
 * stay in `inferenceModels.ts`: a new model needs a probe, not a setting.
 */

import type { InferenceCatalogResponse, InferenceModel } from "@flagship/protocol";
// freeAiCredits imports resolveInferenceModel back; neither uses the other at load time.
import { TOKENS_PER_CREDIT, freeAiConfigFromEnv, type FreeAiConfig } from "./freeAiCredits.js";
import {
  INFERENCE_MODELS,
  INFERENCE_PRICING,
  formatMultiplier,
  multiplierFor,
  type CatalogEntry,
  type RequestFields,
} from "./inferenceModels.js";
import { malformed, type HandlerResponse } from "./types.js";

export interface InferenceModelSettings {
  /** Offered in the menus. An off model a box still asks for gets the default. */
  enabled?: boolean;
  /** Replaces the computed multiplier (≥ 1, in steps of 0.5). */
  multiplier?: number;
  /** The menu's one-line description. */
  descriptor?: string;
}

export interface InferenceAllowanceSettings {
  starterTokens?: number;
  weeklyTokens?: number;
  dailyCapTokens?: number;
  inputWeight?: number;
  outputWeight?: number;
  /** ISO 8601; null clears an end date set by the env. */
  endsAt?: string | null;
}

export interface InferenceSettings {
  defaultModel?: string;
  models?: Record<string, InferenceModelSettings>;
  allowance?: InferenceAllowanceSettings;
}

/**
 * The shipped decision (owner, 2026-10-15, docs/ai-inference-costs.md §16):
 * GLM is the default (9/10 builds, reads images, cheapest per credit), and
 * Low is off: it failed most and costs about 3× per credit what the others
 * do, so it is priced at 3× should it be turned back on.
 */
export const INFERENCE_SETTINGS_DEFAULTS: InferenceSettings = {
  defaultModel: "medium-vision",
  models: { low: { enabled: false, multiplier: 3 } },
};

export const MULTIPLIER_LIMITS = { min: 1, max: 20, step: 0.5 } as const;
const ALLOWANCE_TOKEN_MAX = 10_000_000_000;
const WEIGHT_MAX = 100;
const DESCRIPTOR_MAX = 120;
const NOTE_MAX = 500;

/** A model as offered right now: its definition plus the settings on it. */
export interface LineupEntry extends CatalogEntry {
  enabled: boolean;
  multiplier: number;
  /** From prices alone, before any setting. */
  computedMultiplier: number;
}

export interface InferenceLineup {
  entries: readonly LineupEntry[];
  /** Always an enabled entry's id. */
  defaultModel: string;
}

/** Later layers win field by field; a model's settings merge per field. */
export function mergeInferenceSettings(...layers: Array<InferenceSettings | null | undefined>): InferenceSettings {
  const out: InferenceSettings = {};
  for (const l of layers) {
    if (!l) continue;
    if (l.defaultModel !== undefined) out.defaultModel = l.defaultModel;
    if (l.models) {
      out.models = { ...out.models };
      for (const [id, m] of Object.entries(l.models)) out.models[id] = { ...out.models[id], ...m };
    }
    if (l.allowance) out.allowance = { ...out.allowance, ...l.allowance };
  }
  return out;
}

/** The lineup from the stored settings (over the shipped defaults). */
export function inferenceLineup(
  stored?: InferenceSettings | null,
  models: readonly CatalogEntry[] = INFERENCE_MODELS,
): InferenceLineup {
  const s = mergeInferenceSettings(INFERENCE_SETTINGS_DEFAULTS, stored);
  const base = models.find((m) => m.id === INFERENCE_PRICING.baseModel) ?? models[0];
  const entries = models.map((e): LineupEntry => {
    const set = s.models?.[e.id] ?? {};
    const computedMultiplier = base ? multiplierFor(e, base) : 1;
    return {
      ...e,
      ...(set.descriptor !== undefined ? { descriptor: set.descriptor } : {}),
      enabled: set.enabled ?? true,
      multiplier: set.multiplier ?? computedMultiplier,
      computedMultiplier,
    };
  });
  // Validation keeps the default on; this only guards a row written some other way.
  const on = entries.filter((e) => e.enabled);
  const defaultModel = on.find((e) => e.id === s.defaultModel)?.id ?? on[0]?.id ?? entries[0]?.id ?? "";
  return { entries, defaultModel };
}

/** The promotion's numbers: shipped defaults, then the env, then the stored settings. */
export function freeAiConfigFrom(env: Record<string, string | undefined>, stored?: InferenceSettings | null): FreeAiConfig {
  const cfg = freeAiConfigFromEnv(env);
  const a = stored?.allowance;
  if (!a) return cfg;
  return {
    starterTokens: a.starterTokens ?? cfg.starterTokens,
    weeklyTokens: a.weeklyTokens ?? cfg.weeklyTokens,
    dailyCapTokens: a.dailyCapTokens ?? cfg.dailyCapTokens,
    inputWeight: a.inputWeight ?? cfg.inputWeight,
    outputWeight: a.outputWeight ?? cfg.outputWeight,
    endsAt: a.endsAt === undefined ? cfg.endsAt : a.endsAt === null ? null : Date.parse(a.endsAt),
  };
}

const DEFAULT_LINEUP = inferenceLineup();

function servedLabel(e: LineupEntry): string {
  return `${e.tier} ${formatMultiplier(e.multiplier)} (${e.model})`;
}

/** The menu `.com` serves: enabled models only, with labels. */
export function inferenceCatalog(lineup: InferenceLineup = DEFAULT_LINEUP): InferenceModel[] {
  const on = lineup.entries.filter((e) => e.enabled);
  const onIds = new Set(on.map((e) => e.id));
  return on.map((e) => ({
    id: e.id,
    tier: e.tier,
    model: e.model,
    multiplier: e.multiplier,
    label: servedLabel(e),
    descriptor: e.descriptor,
    contextTokens: e.contextTokens,
    modalities: [...e.modalities],
    // Flagship Inference never thinks, so the apps offer no effort for it.
    reasoning: false,
    ...(e.id === lineup.defaultModel ? { default: true } : {}),
    ...(e.visionAlternative && onIds.has(e.visionAlternative) ? { visionAlternative: e.visionAlternative } : {}),
    upstream: Object.fromEntries(Object.entries(e.upstream).map(([k, v]) => [k, v.id])),
  }));
}

export function defaultInferenceModel(lineup: InferenceLineup = DEFAULT_LINEUP): LineupEntry {
  return lineup.entries.find((e) => e.id === lineup.defaultModel)!;
}

/** `GET /api/inference/models`. */
export function inferenceCatalogResponse(
  weights: { inputWeight: number; outputWeight: number },
  lineup: InferenceLineup = DEFAULT_LINEUP,
): InferenceCatalogResponse {
  return {
    models: inferenceCatalog(lineup),
    defaultModel: lineup.defaultModel,
    creditTokens: INFERENCE_PRICING.creditTokens,
    inputWeight: weights.inputWeight,
    outputWeight: weights.outputWeight,
  };
}

/** What the shim needs about the model a call asked for. */
export interface ResolvedInferenceModel {
  id: string;
  multiplier: number;
  modalities: string[];
  /** The model's output cap per call. */
  maxOutputTokens: number;
  upstream: Record<string, { id: string; maxPriceIn: number; maxPriceOut: number; thinkingOff: RequestFields }>;
  /** The label of the model to switch to for images. */
  visionAlternative?: string;
}

/** The model a call runs on: the one asked for if it's on, else the default. */
export function resolveInferenceModel(id: string | undefined, lineup: InferenceLineup = DEFAULT_LINEUP): ResolvedInferenceModel {
  const entry = lineup.entries.find((e) => e.id === id && e.enabled) ?? defaultInferenceModel(lineup);
  const alt = entry.visionAlternative ? lineup.entries.find((e) => e.id === entry.visionAlternative && e.enabled) : undefined;
  return {
    id: entry.id,
    multiplier: entry.multiplier,
    modalities: [...entry.modalities],
    maxOutputTokens: entry.maxOutputTokens,
    upstream: Object.fromEntries(
      Object.entries(entry.upstream).map(([k, v]) => [
        k,
        { id: v.id, maxPriceIn: v.inUsd, maxPriceOut: v.outUsd, thinkingOff: v.thinkingOff },
      ]),
    ),
    ...(alt ? { visionAlternative: servedLabel(alt) } : {}),
  };
}

/**
 * The multiplier to charge a usage report at: the named model's, on or off
 * (a call resolved just before it was turned off). An id the catalog doesn't
 * know (a shim and `.com` out of step) is charged at the dearest rate.
 */
export function chargeMultiplier(id: string | undefined, lineup: InferenceLineup = DEFAULT_LINEUP): number {
  if (id === undefined) return defaultInferenceModel(lineup).multiplier;
  const hit = lineup.entries.find((e) => e.id === id);
  return hit ? hit.multiplier : Math.max(1, ...lineup.entries.map((e) => e.multiplier));
}

// ── Validation ────────────────────────────────────────────────

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `${where}: unknown ${extra.length === 1 ? "field" : "fields"} ${extra.join(", ")}` : null;
}

function wholeIn(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * Checks a settings document the admin endpoint was sent, and that the
 * lineup it makes is usable: known model ids only, a default that is on, at
 * least one model on, multipliers and allowances in range.
 */
export function parseInferenceSettings(raw: unknown, models: readonly CatalogEntry[] = INFERENCE_MODELS): Parsed<InferenceSettings> {
  if (!isObject(raw)) return { ok: false, error: "settings must be an object" };
  const bad = unknownKeys(raw, ["defaultModel", "models", "allowance"], "settings");
  if (bad) return { ok: false, error: bad };
  const ids = new Set(models.map((m) => m.id));
  const out: InferenceSettings = {};

  if (raw.defaultModel !== undefined) {
    if (typeof raw.defaultModel !== "string" || !ids.has(raw.defaultModel)) {
      return { ok: false, error: `defaultModel must be one of ${[...ids].join(", ")}` };
    }
    out.defaultModel = raw.defaultModel;
  }

  if (raw.models !== undefined) {
    if (!isObject(raw.models)) return { ok: false, error: "models must be an object keyed by model id" };
    out.models = {};
    for (const [id, m] of Object.entries(raw.models)) {
      if (!ids.has(id)) return { ok: false, error: `models: no catalog model "${id}" (known: ${[...ids].join(", ")})` };
      if (!isObject(m)) return { ok: false, error: `models.${id} must be an object` };
      const extra = unknownKeys(m, ["enabled", "multiplier", "descriptor"], `models.${id}`);
      if (extra) return { ok: false, error: extra };
      const set: InferenceModelSettings = {};
      if (m.enabled !== undefined) {
        if (typeof m.enabled !== "boolean") return { ok: false, error: `models.${id}.enabled must be true or false` };
        set.enabled = m.enabled;
      }
      if (m.multiplier !== undefined) {
        const x = m.multiplier;
        const { min, max, step } = MULTIPLIER_LIMITS;
        if (typeof x !== "number" || !(x >= min && x <= max) || Math.abs(x / step - Math.round(x / step)) > 1e-9) {
          return { ok: false, error: `models.${id}.multiplier must be ${min}–${max} in steps of ${step}` };
        }
        set.multiplier = x;
      }
      if (m.descriptor !== undefined) {
        if (typeof m.descriptor !== "string" || m.descriptor.trim() === "" || m.descriptor.length > DESCRIPTOR_MAX) {
          return { ok: false, error: `models.${id}.descriptor must be 1–${DESCRIPTOR_MAX} characters` };
        }
        set.descriptor = m.descriptor.trim();
      }
      out.models[id] = set;
    }
  }

  if (raw.allowance !== undefined) {
    const a = raw.allowance;
    if (!isObject(a)) return { ok: false, error: "allowance must be an object" };
    const extra = unknownKeys(
      a,
      ["starterTokens", "weeklyTokens", "dailyCapTokens", "inputWeight", "outputWeight", "endsAt"],
      "allowance",
    );
    if (extra) return { ok: false, error: extra };
    const al: InferenceAllowanceSettings = {};
    for (const k of ["starterTokens", "weeklyTokens", "dailyCapTokens"] as const) {
      if (a[k] === undefined) continue;
      if (!wholeIn(a[k], ALLOWANCE_TOKEN_MAX)) return { ok: false, error: `allowance.${k} must be a whole number of tokens, 0–${ALLOWANCE_TOKEN_MAX}` };
      al[k] = a[k] as number;
    }
    for (const k of ["inputWeight", "outputWeight"] as const) {
      if (a[k] === undefined) continue;
      const w = a[k];
      if (typeof w !== "number" || !(w >= 0 && w <= WEIGHT_MAX)) return { ok: false, error: `allowance.${k} must be 0–${WEIGHT_MAX}` };
      al[k] = w;
    }
    if (a.endsAt !== undefined) {
      if (a.endsAt !== null && (typeof a.endsAt !== "string" || !Number.isFinite(Date.parse(a.endsAt)))) {
        return { ok: false, error: "allowance.endsAt must be an ISO 8601 date/time or null" };
      }
      al.endsAt = a.endsAt === null ? null : new Date(Date.parse(a.endsAt as string)).toISOString();
    }
    out.allowance = al;
  }

  const merged = mergeInferenceSettings(INFERENCE_SETTINGS_DEFAULTS, out);
  const on = models.filter((m) => merged.models?.[m.id]?.enabled ?? true);
  if (on.length === 0) return { ok: false, error: "at least one model must be on" };
  if (merged.defaultModel !== undefined && !on.some((m) => m.id === merged.defaultModel)) {
    return { ok: false, error: `the default model "${merged.defaultModel}" is turned off; pick an enabled default` };
  }
  return { ok: true, value: out };
}

// ── Storage and the admin endpoint ────────────────────────────

export interface StoredInferenceSettings {
  settings: InferenceSettings;
  note: string;
  setAt: number;
}

/** D1 `inference_settings` (migration 0103): one row per change, the latest wins. */
export interface InferenceSettingsStore {
  latest(): Promise<StoredInferenceSettings | null>;
  history(limit: number): Promise<StoredInferenceSettings[]>;
  put(row: StoredInferenceSettings): Promise<void>;
}

export class InMemoryInferenceSettingsStore implements InferenceSettingsStore {
  readonly rows: StoredInferenceSettings[] = [];
  async latest(): Promise<StoredInferenceSettings | null> {
    return this.rows.at(-1) ?? null;
  }
  async history(limit: number): Promise<StoredInferenceSettings[]> {
    return this.rows.slice(-limit).reverse();
  }
  async put(row: StoredInferenceSettings): Promise<void> {
    this.rows.push(row);
  }
}

export interface InferenceSettingsDeps {
  store: InferenceSettingsStore;
  env: Record<string, string | undefined>;
  now?: () => number;
}

/** Everything in force, in the units the owner thinks in. */
export function effectiveInferenceSettings(env: Record<string, string | undefined>, stored: InferenceSettings | null) {
  const lineup = inferenceLineup(stored);
  const cfg = freeAiConfigFrom(env, stored);
  const credits = (t: number) => Math.floor(t / TOKENS_PER_CREDIT);
  return {
    defaultModel: lineup.defaultModel,
    models: lineup.entries.map((e) => ({
      id: e.id,
      tier: e.tier,
      model: e.model,
      enabled: e.enabled,
      multiplier: e.multiplier,
      computedMultiplier: e.computedMultiplier,
      label: servedLabel(e),
      descriptor: e.descriptor,
    })),
    allowance: {
      starterTokens: cfg.starterTokens,
      weeklyTokens: cfg.weeklyTokens,
      dailyCapTokens: cfg.dailyCapTokens,
      starterCredits: credits(cfg.starterTokens),
      weeklyCredits: credits(cfg.weeklyTokens),
      dailyCapCredits: credits(cfg.dailyCapTokens),
      inputWeight: cfg.inputWeight,
      outputWeight: cfg.outputWeight,
      endsAt: cfg.endsAt === null ? null : new Date(cfg.endsAt).toISOString(),
    },
  };
}

async function view(deps: InferenceSettingsDeps) {
  const [latest, history] = await Promise.all([deps.store.latest(), deps.store.history(20)]);
  return {
    effective: effectiveInferenceSettings(deps.env, latest?.settings ?? null),
    stored: latest ? { settings: latest.settings, note: latest.note, setAt: new Date(latest.setAt).toISOString() } : null,
    shippedDefaults: INFERENCE_SETTINGS_DEFAULTS,
    history: history.map((h) => ({ setAt: new Date(h.setAt).toISOString(), note: h.note, settings: h.settings })),
  };
}

/** `GET /api/admin/inference-settings`. */
export async function handleGetInferenceSettings(deps: InferenceSettingsDeps): Promise<HandlerResponse> {
  return { status: 200, body: await view(deps) };
}

/**
 * `PUT /api/admin/inference-settings` `{ settings, note, preview? }`: the
 * whole stored document is replaced (a field left out falls back to the env
 * and the shipped defaults). `preview: true` returns what it would put in
 * force without storing it.
 */
export async function handlePutInferenceSettings(deps: InferenceSettingsDeps, body: unknown): Promise<HandlerResponse> {
  if (!isObject(body)) return malformed("body must be { settings, note }");
  const parsed = parseInferenceSettings(body.settings);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error, code: "invalid-settings" } };
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note === "" || note.length > NOTE_MAX) return { status: 400, body: { error: `note must say why, 1–${NOTE_MAX} characters`, code: "invalid-settings" } };
  if (body.preview === true) {
    return { status: 200, body: { preview: true, effective: effectiveInferenceSettings(deps.env, parsed.value) } };
  }
  await deps.store.put({ settings: parsed.value, note, setAt: (deps.now ?? Date.now)() });
  return { status: 200, body: await view(deps) };
}
