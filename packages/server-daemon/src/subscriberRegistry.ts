/**
 * Per-app subscriber registry — the set of `pullerServerId` FQDNs that
 * are allowed to pull update packs for an app this box is the canonical
 * home of.
 *
 * The original design wanted to drive subscribers from `AppMembership`
 * directly — "anyone Bob shared the app with via membership can pull."
 * The catch: membership tracks IRK pubkeys, but the update-pack auth
 * header carries a `pullerServerId` FQDN. The mapping IRK → FQDN lives
 * on the `.com` control plane (the registry of `serverId → STK pubkey`
 * is keyed by FQDN, not by IRK). So in v1 we keep the subscriber list
 * as a sidecar maintained by the host's phone:
 *
 *   - `add(serviceId, fqdn)` / `remove(serviceId, fqdn)`: phone-issued
 *     mutations (over the orders endpoint or a future explicit
 *     `manage-subscribers` route) update the registry.
 *   - The membership store is still the source of truth for who can
 *     ACCESS the app (member → can hit /); the subscriber registry is
 *     about who can MIRROR the app (peer pod → can pull updates).
 *
 * Cardinality is tiny (≤ tens of subscribers per app even in big
 * communities), so a flat JSON file per app is the simplest persistent
 * store. Atomic write-then-rename keeps it crash-safe.
 *
 * `manifest.distribution.public` bypasses subscriber enforcement
 * entirely — that flag is per-app and source-of-truth at install time.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServicePlatform, InstalledService } from "./servicePlatform.js";
import type { AppDistributionInfo } from "./updateServer.js";

export interface SubscriberRegistry {
  /** All FQDNs allowed to pull this app's updates. */
  subscribersFor(serviceId: string): Promise<Set<string>>;
  add(serviceId: string, fqdn: string): Promise<void>;
  remove(serviceId: string, fqdn: string): Promise<void>;
  list(serviceId: string): Promise<string[]>;
}

const FQDN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function validateFqdn(fqdn: string): void {
  if (!FQDN_RE.test(fqdn.toLowerCase())) {
    throw new Error(`invalid FQDN: ${JSON.stringify(fqdn)}`);
  }
}

export class InMemorySubscriberRegistry implements SubscriberRegistry {
  private byApp = new Map<string, Set<string>>();

  async subscribersFor(serviceId: string): Promise<Set<string>> {
    const s = this.byApp.get(serviceId);
    return new Set(s ?? []);
  }
  async add(serviceId: string, fqdn: string): Promise<void> {
    validateFqdn(fqdn);
    let s = this.byApp.get(serviceId);
    if (!s) {
      s = new Set();
      this.byApp.set(serviceId, s);
    }
    s.add(fqdn.toLowerCase());
  }
  async remove(serviceId: string, fqdn: string): Promise<void> {
    this.byApp.get(serviceId)?.delete(fqdn.toLowerCase());
  }
  async list(serviceId: string): Promise<string[]> {
    return [...(this.byApp.get(serviceId) ?? [])].sort();
  }
}

export class FileSubscriberRegistry implements SubscriberRegistry {
  constructor(private readonly dir: string) {}

  private path(serviceId: string): string {
    return join(this.dir, `${serviceId}.json`);
  }

  private async readAll(serviceId: string): Promise<Set<string>> {
    try {
      const buf = await readFile(this.path(serviceId), "utf8");
      const arr = JSON.parse(buf) as unknown;
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.filter((x): x is string => typeof x === "string"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw e;
    }
  }

  private async writeAll(serviceId: string, fqdns: Set<string>): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path(serviceId)}.tmp`;
    const sorted = [...fqdns].sort();
    if (sorted.length === 0) {
      await rm(this.path(serviceId), { force: true });
      return;
    }
    await writeFile(tmp, JSON.stringify(sorted, null, 2));
    await rename(tmp, this.path(serviceId));
  }

  async subscribersFor(serviceId: string): Promise<Set<string>> {
    return this.readAll(serviceId);
  }

  async add(serviceId: string, fqdn: string): Promise<void> {
    validateFqdn(fqdn);
    const s = await this.readAll(serviceId);
    s.add(fqdn.toLowerCase());
    await this.writeAll(serviceId, s);
  }

  async remove(serviceId: string, fqdn: string): Promise<void> {
    const s = await this.readAll(serviceId);
    if (!s.delete(fqdn.toLowerCase())) return;
    await this.writeAll(serviceId, s);
  }

  async list(serviceId: string): Promise<string[]> {
    return [...(await this.readAll(serviceId))].sort();
  }

  /** All appIds with at least one subscriber — for diagnostics. */
  knownApps(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  }
}

export interface BuildAppDistributionDeps {
  platform: ServicePlatform;
  registry: SubscriberRegistry;
  /**
   * Resolve the on-disk path of the bare git repo for an installed app.
   * Production: the Forgejo per-user namespace path. Tests inject a
   * fixture path.
   */
  repoPath: (app: InstalledService) => string;
}

/**
 * Build an `appDistribution` callback for `UpdateServer.deps`. Combines
 * the subscriber registry + manifest's `distribution.public` flag so the
 * server doesn't have to care about either source separately.
 */
export function buildAppDistribution(deps: BuildAppDistributionDeps) {
  return async (app: InstalledService): Promise<AppDistributionInfo | null> => {
    const repoPath = deps.repoPath(app);
    if (!repoPath) return null;
    const subscribers = await deps.registry.subscribersFor(app.serviceId);
    return {
      publicDistribution: !!app.manifest.distribution?.public,
      subscribers,
      repoPath,
    };
  };
}
