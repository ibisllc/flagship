/**
 * Production adapter that fulfills the `LineageResolverLike` contract
 * for the BFF endpoint (`/api/screens/lineage-resolve`).
 *
 * Bridges three pre-existing primitives:
 *   - `AppPullStateStore.list()` to find paused apps
 *   - `UpdateClient.acceptLineageBreak` to roll the anchor forward
 *   - `ServicePlatform.uninstall` to revoke
 *
 * The webapp / phone use the BFF endpoint; this adapter is what the
 * daemon-side wiring in `index.ts` hands to `buildScreensHttp` so the
 * endpoint actually does something.
 *
 * Why a thin adapter rather than wiring directly:
 *   - The endpoint's input/output shapes (`LineagePauseSummary`,
 *     `LineageResolveResponse`) are wire-stable; the underlying
 *     `AppPullState` / uninstall internals are not. The adapter
 *     translates between them so a refactor to either side can't
 *     break the BFF contract.
 *   - Tests get a single seam: a fake `LineageResolverLike` replaces
 *     this whole module in `screensHttp.test.ts`.
 */

import type {
  LineagePauseSummary,
  LineageResolveResponse,
} from "../screens/types.js";
import type {
  AppPullStateStore,
  UpdateClient,
} from "../updateClient.js";

export interface LineageResolverAdapterDeps {
  store: AppPullStateStore;
  client: UpdateClient;
  /**
   * Best-effort uninstall hook. Production: a thunk that walks the
   * ServicePlatform.uninstall path (which already drops pull state +
   * container + data stores + tabs). Returning `{ ok: false }` is fine
   * — the BFF surfaces that to the phone as a 502.
   */
  uninstall: (serviceId: string) => Promise<{ ok: boolean; reason?: string }>;
}

export function buildLineageResolverAdapter(deps: LineageResolverAdapterDeps) {
  return {
    async list(): Promise<LineagePauseSummary[]> {
      // Walk every persisted pull state; surface only those that are
      // currently paused. The store's `list` is optional in the
      // interface (older callers may not implement it); when missing,
      // return an empty list rather than blowing up — the endpoint
      // degrades to "no paused apps" which is a safe default.
      if (!deps.store.list) return [];
      const appIds = await deps.store.list();
      const out: LineagePauseSummary[] = [];
      for (const serviceId of appIds) {
        const state = await deps.store.get(serviceId);
        if (!state?.lineagePaused || !state.lineagePauseInfo) continue;
        const info = state.lineagePauseInfo;
        out.push({
          serviceId,
          creator: info.creator,
          slug: info.slug,
          canonicalUrl: info.canonicalUrl,
          detectedAt: info.detectedAt,
          lineageAnchor: info.lineageAnchor,
          priorTip: info.priorTip,
          upstreamTip: info.upstreamTip,
          reason: info.reason,
          detail: info.detail,
        });
      }
      return out;
    },

    async accept(
      serviceId: string,
    ): Promise<{ ok: boolean; outcome: "accepted" | "already-clear"; reason?: string }> {
      const r = await deps.client.acceptLineageBreak({ serviceId });
      if (!r.ok) return { ok: false, outcome: "already-clear", reason: r.reason };
      return { ok: true, outcome: r.outcome };
    },

    async revoke(serviceId: string): Promise<{ ok: boolean; reason?: string }> {
      try {
        return await deps.uninstall(serviceId);
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  };
}

export type LineageResolverAdapter = ReturnType<typeof buildLineageResolverAdapter>;

// Trivially exposed so consumers can name the shape without importing
// the screens types module too.
export type { LineageResolveResponse };
