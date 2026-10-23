/**
 * The box's side of signed release metadata (protocol/releaseMetadata.ts, SECURITY-HARDENING-PLAN.md
 * 18.13). It keeps the last state the box accepted (versions and the security floor only ever go up),
 * checks every fetched catalog against the trusted root, and answers the two questions the update path
 * asks:
 *
 *   - may a NEW release be offered or taken? No while the catalog is stale, below the floor, outside the
 *     open rollout cohort or not newer. Nothing else on the box depends on the catalog.
 *   - may a health-failure rollback go back to this commit? Only when its security version still meets
 *     the floor. A commit the catalog does not know is refused once a floor is set.
 *
 * The state file is written whole; an unreadable one is kept aside and read as the empty state, which only
 * makes the box stricter about nothing (it accepts a catalog again) and never lowers a floor it enforced,
 * because the floor also comes from the catalog itself on the next fetch.
 */
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  EMPTY_TRUST_STATE,
  inRolloutCohort,
  meetsSecurityFloor,
  offerableReleases,
  verifyReleaseCatalog,
  type Catalog,
  type CatalogInput,
  type MetaRefusal,
  type ReleaseEntry,
  type RootMeta,
  type TrustState,
} from "@flagship/protocol";
import { keepCorruptAside, readStateFile, writeFileDurable } from "./durableFile.js";

interface Persisted {
  state: TrustState;
  /** commit -> securityVersion of the last accepted targets, for rollback checks. */
  known: Record<string, number>;
  /** The last accepted targets' releases by commit, for the update checks. */
  releases?: Record<string, ReleaseEntry>;
  stale: boolean;
}

export class ReleaseCatalogGate {
  private loaded: Persisted | null = null;

  constructor(
    private readonly opts: {
      path: string;
      /** The root this box trusts (from its pinned trust file or a verified rotation). */
      root: () => RootMeta;
      /** Stable per-box secret salt for rollout buckets. */
      boxSalt: () => string;
      now?: () => number;
    },
  ) {}

  private async load(): Promise<Persisted> {
    if (this.loaded) return this.loaded;
    const r = await readStateFile(this.opts.path);
    let p: Persisted = { state: { ...EMPTY_TRUST_STATE }, known: {}, stale: false };
    if (r.kind === "ok") {
      try {
        const j = JSON.parse(r.text) as Persisted;
        if (j && j.state && typeof j.state.securityFloor === "number" && j.known && typeof j.known === "object") p = j;
      } catch (e) {
        await keepCorruptAside(this.opts.path, e, "release catalog state reset; the next catalog fetch rebuilds it");
      }
    } else if (r.kind === "unreadable") {
      await keepCorruptAside(this.opts.path, r.error, "release catalog state reset; the next catalog fetch rebuilds it");
    }
    this.loaded = p;
    return p;
  }

  private async save(p: Persisted): Promise<void> {
    await mkdir(dirname(this.opts.path), { recursive: true });
    await writeFileDurable(this.opts.path, JSON.stringify(p));
    this.loaded = p;
  }

  /** Verify one fetched view and, if it holds, remember it. A refused view changes nothing. */
  async accept(view: Omit<CatalogInput, "root" | "now" | "state">): Promise<{ ok: true; catalog: Catalog } | { ok: false; reason: MetaRefusal }> {
    const cur = await this.load();
    const r = verifyReleaseCatalog({ ...view, root: this.opts.root(), now: (this.opts.now ?? Date.now)(), state: cur.state });
    if (!r.ok) return r;
    const known: Record<string, number> = {};
    const releases: Record<string, ReleaseEntry> = {};
    for (const rel of r.value.targets.releases) {
      known[rel.commit] = rel.securityVersion;
      releases[rel.commit] = rel;
    }
    await this.save({ state: r.value.state, known, releases, stale: r.value.stale });
    return { ok: true, catalog: r.value };
  }

  async floor(): Promise<number> {
    return (await this.load()).state.securityFloor;
  }

  /** The newest accepted view still counts as fresh only until its own expiry; a stale one blocks new updates. */
  async mayTakeNewRelease(release: ReleaseEntry, runningSecurityVersion: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cur = await this.load();
    if (cur.state.targetsVersion === 0) return { ok: false, reason: "no-catalog" };
    if (cur.stale) return { ok: false, reason: "stale-catalog" };
    if (!meetsSecurityFloor(release.securityVersion, cur.state.securityFloor)) return { ok: false, reason: "below-floor" };
    if (release.securityVersion <= runningSecurityVersion) return { ok: false, reason: "not-newer" };
    if (!inRolloutCohort(this.opts.boxSalt(), release)) return { ok: false, reason: "not-in-cohort" };
    return { ok: true };
  }

  /**
   * May this box move from `runningCommit` to `commit`? The target must be in the accepted catalog and
   * pass `mayTakeNewRelease` against the running release's security version (0 when the catalog does not
   * list what runs, e.g. a release older than the catalog).
   */
  async allowsUpdateTo(commit: string, runningCommit: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cur = await this.load();
    const entry = cur.releases?.[commit];
    if (!entry) return { ok: false, reason: cur.state.targetsVersion === 0 ? "no-catalog" : "not-in-catalog" };
    return this.mayTakeNewRelease(entry, runningCommit ? cur.known[runningCommit] ?? 0 : 0);
  }

  offers(catalog: Catalog, runningSecurityVersion: number) {
    return offerableReleases(catalog, this.opts.boxSalt(), runningSecurityVersion);
  }

  /** Health-failure rollback target check. With no floor set (0) any known or unknown commit may be returned to. */
  async rollbackAllowed(commit: string): Promise<boolean> {
    const cur = await this.load();
    const floor = cur.state.securityFloor;
    if (floor <= 0) return true;
    const v = cur.known[commit];
    return v !== undefined && meetsSecurityFloor(v, floor);
  }
}
