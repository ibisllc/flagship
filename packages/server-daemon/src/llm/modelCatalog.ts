/**
 * What the box knows about AI models, from `.com`:
 *   - the Flagship Inference catalog (`GET /api/inference/models`);
 *   - the daily capability table (`GET /api/inference/capabilities`).
 * Both are public, carry nothing about the owner, and are cached here for a
 * few hours (a stale copy is kept when `.com` can't answer). They size the
 * context for compaction and build the own-key model menus.
 */

import {
  buildCapabilityIndex,
  findCapability,
  modelOptions,
  type CapabilityIndex,
  type CapabilityTableResponse,
  type InferenceCatalogResponse,
  type ModelOption,
} from "@flagship/protocol";
import type { ModelListResult } from "@flagship/llm-providers";

const TTL_MS = 6 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface Cached<T> {
  value: T | null;
  at: number;
  pending?: Promise<T | null>;
}

export type AiModelsResponse =
  | { provider: "flagship"; kind: "flagship"; catalog: InferenceCatalogResponse | null }
  | {
      provider: string;
      kind: "own";
      /** False: no list could be read; offer a free-text model field. */
      listed: boolean;
      models: ModelOption[];
      defaultModel?: string;
      /** Why there's no list ("no-list", "rejected", "failed"). */
      reason?: string;
    };

export class ModelCatalog {
  private inf: Cached<InferenceCatalogResponse> = { value: null, at: 0 };
  private caps: Cached<CapabilityIndex> = { value: null, at: 0 };

  constructor(
    private readonly opts: {
      /** `.com`, e.g. https://flagshipserver.com */
      baseUrl: string;
      fetch?: Fetch;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async get<T>(c: Cached<T>, path: string, map: (raw: unknown) => T | null): Promise<T | null> {
    const age = this.now() - c.at;
    if (c.value && age < TTL_MS) return c.value;
    if (!c.value && c.at > 0 && age < RETRY_MS) return null;
    if (c.pending) return c.pending;
    const f = this.opts.fetch ?? ((url: string) => fetch(url));
    c.pending = (async () => {
      try {
        const r = await f(`${this.opts.baseUrl.replace(/\/+$/, "")}${path}`);
        const v = r.ok ? map(await r.json()) : null;
        if (v) c.value = v;
      } catch {
        // keep what we had
      }
      c.at = this.now();
      c.pending = undefined;
      return c.value;
    })();
    return c.pending;
  }

  inference(): Promise<InferenceCatalogResponse | null> {
    return this.get(this.inf, "/api/inference/models", (raw) => {
      const r = raw as InferenceCatalogResponse;
      return Array.isArray(r?.models) && r.models.length > 0 ? r : null;
    });
  }

  capabilities(): Promise<CapabilityIndex | null> {
    return this.get(this.caps, "/api/inference/capabilities", (raw) => {
      const r = raw as CapabilityTableResponse;
      return Array.isArray(r?.models) && r.models.length > 0 ? buildCapabilityIndex(r.models) : null;
    });
  }

  /** The context window of `model` on `provider`, when known. */
  async contextTokens(provider: string, model: string | undefined): Promise<number | undefined> {
    if (provider === "flagship") {
      const cat = await this.inference();
      const m = cat?.models.find((x) => x.id === model) ?? cat?.models.find((x) => x.id === cat.defaultModel);
      return m?.contextTokens;
    }
    if (!model) return undefined;
    const idx = await this.capabilities();
    const c = idx ? findCapability(idx, provider, model) : null;
    return c?.contextTokens || undefined;
  }

  /** The model menu for a credential: the catalog, or the key's live list joined with the table. */
  async menu(
    provider: string,
    list: () => Promise<ModelListResult>,
    defaultModel?: string,
  ): Promise<AiModelsResponse> {
    if (provider === "flagship") return { provider: "flagship", kind: "flagship", catalog: await this.inference() };
    const [listed, idx] = await Promise.all([list(), this.capabilities()]);
    if (!listed.ok) {
      return { provider, kind: "own", listed: false, models: [], reason: listed.reason, ...(defaultModel ? { defaultModel } : {}) };
    }
    const models = modelOptions(provider, listed.models, idx ?? buildCapabilityIndex([]));
    return { provider, kind: "own", listed: true, models, ...(defaultModel ? { defaultModel } : {}) };
  }
}
