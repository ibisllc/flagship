/**
 * AI model menus: the wire shapes `.com`, the box and the apps share.
 *
 * Two sources feed a menu:
 *   - Flagship Inference: `.com`'s curated catalog (`GET /api/inference/models`),
 *     one entry per tier with its credit multiplier.
 *   - The owner's own key: the provider's live model list (the box asks it with
 *     the key, which never reaches `.com`), joined with the capability table
 *     `.com` builds daily from OpenRouter's public catalog
 *     (`GET /api/inference/capabilities`): context size, image input, tool
 *     calling and the reasoning efforts each model takes. A model the table
 *     doesn't know is still offered, with no effort control.
 */

/** One Flagship Inference model, as `.com` serves it. */
export interface InferenceModel {
  /** Catalog id the box sends as `model` ("low", "medium", …). */
  id: string;
  /** Tier label ("Low", "Medium multimodal", …). */
  tier: string;
  /** The real model's name ("Qwen3.6-35B-A3B"). */
  model: string;
  /** Credits charged per 1,000 weighted tokens, relative to the base model. */
  multiplier: number;
  /** "Low 1× (Qwen3.6-35B-A3B)": what a menu shows. */
  label: string;
  /** One line about what it's good at. */
  descriptor: string;
  contextTokens: number;
  /** "text", "image". */
  modalities: string[];
  /** The model reasons. On its own this offers no effort control; `efforts` does. */
  reasoning: boolean;
  /**
   * The effort levels the apps offer for this model (the shim's words), when
   * the catalog lists any. Absent or empty: no effort control.
   */
  efforts?: string[];
  defaultEffort?: string;
  /** Used when the owner hasn't chosen. */
  default?: boolean;
  /** For a text-only model: the catalog id to switch to for an image. */
  visionAlternative?: string;
  /** Its id on each upstream the shim may use ("deepinfra", "openrouter"). */
  upstream?: Record<string, string>;
}

export interface InferenceCatalogResponse {
  models: InferenceModel[];
  defaultModel: string;
  /** 1 credit = this many weighted tokens. */
  creditTokens: number;
  inputWeight: number;
  outputWeight: number;
}

/** One row of the daily capability table (from OpenRouter's public catalog). */
export interface ModelCapability {
  /** OpenRouter's id, e.g. "openai/gpt-5.4-mini". */
  id: string;
  /** Hugging Face id, when the catalog names one (open-weight models). */
  hf?: string;
  name: string;
  contextTokens: number;
  maxOutputTokens?: number;
  /** Input modalities: "text", "image", "file", … */
  input: string[];
  /** Takes tool calls. */
  tools: boolean;
  /** Present when the model reasons. `efforts` in the provider's own words. */
  reasoning?: { efforts?: string[]; defaultEffort?: string; mandatory?: boolean };
  /** USD per million tokens. */
  priceIn?: number;
  priceOut?: number;
}

export interface CapabilityTableResponse {
  fetchedAt: number;
  models: ModelCapability[];
}

/** A row of an own-key model menu, as the box answers it. */
export interface ModelOption {
  id: string;
  label: string;
  contextTokens?: number;
  /** Takes images. Null: unknown. */
  vision: boolean | null;
  /** Takes tool calls (the builder needs them). Null: unknown. */
  tools: boolean | null;
  /** The effort levels to offer, in the provider's own words; absent: no control. */
  efforts?: string[];
  defaultEffort?: string;
  /** False: not in the capability table ("capabilities unknown"). */
  known: boolean;
  /** For a text-only model: the option to switch to for an image. */
  visionAlternative?: string;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A capability row from one entry of `https://openrouter.ai/api/v1/models`;
 * null for variants (`:free`, `:batch`), routers and anything malformed.
 */
export function capabilityFromOpenRouter(raw: unknown): ModelCapability | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : "";
  if (!/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(id)) return null;
  const arch = (m.architecture ?? {}) as { input_modalities?: unknown };
  const input = Array.isArray(arch.input_modalities)
    ? arch.input_modalities.filter((x): x is string => typeof x === "string")
    : ["text"];
  const params = Array.isArray(m.supported_parameters)
    ? m.supported_parameters.filter((x): x is string => typeof x === "string")
    : [];
  const top = (m.top_provider ?? {}) as { max_completion_tokens?: unknown };
  const pricing = (m.pricing ?? {}) as { prompt?: unknown; completion?: unknown };
  const r = (m.reasoning ?? null) as {
    supported_efforts?: unknown;
    default_effort?: unknown;
    mandatory?: unknown;
  } | null;
  const reasons = params.includes("reasoning") || r !== null;
  const efforts = Array.isArray(r?.supported_efforts)
    ? r!.supported_efforts
        .filter((x): x is string => typeof x === "string" && /^[a-z]{2,12}$/.test(x))
        .sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
    : [];
  const priceIn = num(pricing.prompt);
  const priceOut = num(pricing.completion);
  const out: ModelCapability = {
    id,
    name: typeof m.name === "string" ? m.name.slice(0, 120) : id,
    contextTokens: Math.max(0, Math.floor(num(m.context_length) ?? 0)),
    input,
    tools: params.includes("tools"),
  };
  if (typeof m.hugging_face_id === "string" && m.hugging_face_id.length > 0) out.hf = m.hugging_face_id;
  const maxOut = num(top.max_completion_tokens);
  if (maxOut) out.maxOutputTokens = Math.floor(maxOut);
  if (reasons) {
    out.reasoning = {
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(typeof r?.default_effort === "string" && efforts.includes(r.default_effort)
        ? { defaultEffort: r.default_effort }
        : {}),
      ...(r?.mandatory === true ? { mandatory: true } : {}),
    };
  }
  if (priceIn !== undefined && priceIn >= 0) out.priceIn = Math.round(priceIn * 1e6 * 1e4) / 1e4;
  if (priceOut !== undefined && priceOut >= 0) out.priceOut = Math.round(priceOut * 1e6 * 1e4) / 1e4;
  return out;
}

/** The comparable form of a model id: lowercase, no date suffix, dots as dashes. */
export function modelKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/:latest$/, "")
    .replace(/[:.]/g, "-")
    .replace(/-(20\d{6}|20\d{2}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "");
}

const VENDOR_OF: Record<string, string> = { openai: "openai", anthropic: "anthropic", google: "google" };

export interface CapabilityIndex {
  byKey: Map<string, ModelCapability>;
  byTail: Map<string, ModelCapability>;
}

export function buildCapabilityIndex(rows: readonly ModelCapability[]): CapabilityIndex {
  const byKey = new Map<string, ModelCapability>();
  const byTail = new Map<string, ModelCapability>();
  for (const r of rows) {
    const [vendor, rest] = [r.id.slice(0, r.id.indexOf("/")), r.id.slice(r.id.indexOf("/") + 1)];
    byKey.set(`${vendor}/${modelKey(rest)}`, r);
    if (r.hf) byTail.set(modelKey(r.hf.slice(r.hf.indexOf("/") + 1)), r);
    // The first vendor to claim a bare name keeps it (the maker lists it first).
    if (!byTail.has(modelKey(rest))) byTail.set(modelKey(rest), r);
  }
  return { byKey, byTail };
}

/**
 * The capability row for a model a provider listed, or null. OpenAI,
 * Anthropic and Google ids match under their vendor; an OpenRouter id is the
 * table's own; any other host (an OpenAI-compatible DeepInfra, Groq, Together,
 * Mistral, a local Ollama) matches by Hugging Face id or by the name after
 * its last slash.
 */
export function findCapability(index: CapabilityIndex, provider: string, modelId: string): ModelCapability | null {
  const vendor = VENDOR_OF[provider];
  if (vendor) {
    const direct = index.byKey.get(`${vendor}/${modelKey(modelId)}`);
    if (direct) return direct;
  }
  if (provider === "openrouter" && modelId.includes("/")) {
    const v = modelId.slice(0, modelId.indexOf("/"));
    const hit = index.byKey.get(`${v}/${modelKey(modelId.slice(modelId.indexOf("/") + 1))}`);
    if (hit) return hit;
  }
  if (vendor) return null;
  return index.byTail.get(modelKey(modelId.slice(modelId.lastIndexOf("/") + 1))) ?? null;
}

/** Blended price on a build's token mix (mostly input). */
export function blendedPrice(c: Pick<ModelCapability, "priceIn" | "priceOut">): number | null {
  if (c.priceIn === undefined || c.priceOut === undefined) return null;
  return c.priceIn * 424 + c.priceOut * 13;
}

/** Ids that can't drive a chat build (embeddings, speech, images, moderation). */
const NOT_CHAT = /(embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image-|rerank|sora|search-preview|-search-|imagen|veo|aqa|computer-use)/i;

/**
 * An own-key menu: the provider's listed models joined with the capability
 * table. Known models that can't call tools are left out (the builder needs
 * them); unknown ones stay, flagged. Each text-only model names the vision
 * model to switch to: the cheapest known one with tools that costs at least
 * as much, else the dearest below it.
 */
export function modelOptions(
  provider: string,
  listed: ReadonlyArray<{ id: string; name?: string; contextTokens?: number }>,
  index: CapabilityIndex,
): ModelOption[] {
  const seen = new Set<string>();
  const out: Array<ModelOption & { price: number | null }> = [];
  for (const l of listed) {
    if (seen.has(l.id) || NOT_CHAT.test(l.id)) continue;
    seen.add(l.id);
    const cap = findCapability(index, provider, l.id);
    if (cap && !cap.tools) continue;
    const efforts = cap?.reasoning?.efforts;
    out.push({
      id: l.id,
      label: l.name && l.name.trim().length > 0 ? l.name.trim() : cap?.name ?? l.id,
      ...(cap?.contextTokens || l.contextTokens ? { contextTokens: cap?.contextTokens || l.contextTokens } : {}),
      vision: cap ? cap.input.includes("image") : null,
      tools: cap ? cap.tools : null,
      ...(efforts && efforts.length > 0 ? { efforts: [...efforts] } : {}),
      ...(cap?.reasoning?.defaultEffort ? { defaultEffort: cap.reasoning.defaultEffort } : {}),
      known: cap !== null,
      price: cap ? blendedPrice(cap) : null,
    });
  }
  const vision = out.filter((o) => o.vision === true && o.price !== null).sort((a, b) => a.price! - b.price!);
  for (const o of out) {
    if (o.vision !== false || vision.length === 0) continue;
    const p = o.price ?? 0;
    const pick = vision.find((v) => v.price! >= p) ?? vision[vision.length - 1]!;
    o.visionAlternative = pick.id;
  }
  // Known models first (newest names sort high in a plain sort), then unknown.
  out.sort((a, b) => Number(b.known) - Number(a.known) || a.label.localeCompare(b.label));
  return out.map(({ price: _price, ...o }) => o);
}
