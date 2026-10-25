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
 * The view goes stale by the clock: the accepted timestamp, snapshot and targets expiries are kept and
 * compared with the box's trusted clock (trustedClock.ts, never earlier than the signed-time floor) at
 * every decision, so blocking the catalog fetch cannot keep an accepted view, and a rollout it opened,
 * fresh forever.
 *
 * The high-water marks (versions, digests and the security floor) are also kept in a second file,
 * `<path>.floor`, written before the main one. A damaged or missing main file next to it does not read
 * as floor 0: the marks still bind the next catalog, nothing new is taken (no releases are known) and a
 * rollback is refused while the floor is above 0 or unknown, until a catalog is accepted again.
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
import { trustedNow } from "./trustedClock.js";

interface Persisted {
  state: TrustState;
  /** commit -> securityVersion of the last accepted targets, for rollback checks. */
  known: Record<string, number>;
  /** The last accepted targets' releases by commit, for the update checks. */
  releases?: Record<string, ReleaseEntry>;
  /** Stale already when accepted. */
  stale: boolean;
  /** The earliest of the accepted timestamp, snapshot and targets expiries (ms). Absent: stale. */
  freshUntil?: number;
}

interface Loaded extends Persisted {
  /** The main file was damaged or missing beside a kept floor (or both unreadable): fail closed. */
  degraded: boolean;
  /** Nothing trustworthy is known about the floor: refuse every rollback. */
  floorUnknown: boolean;
}

function isState(v: unknown): v is TrustState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  for (const k of ["rootVersion", "timestampVersion", "snapshotVersion", "targetsVersion", "securityFloor"]) {
    if (!Number.isSafeInteger(o[k]) || (o[k] as number) < 0) return false;
  }
  for (const k of ["timestampSha256", "snapshotSha256", "targetsSha256"]) {
    if (o[k] !== undefined && (typeof o[k] !== "string" || !/^[0-9a-f]{64}$/.test(o[k] as string))) return false;
  }
  return true;
}

/** The higher of two marks, field by field; the digest follows the version it belongs to. */
function maxState(a: TrustState, b: TrustState): TrustState {
  const pick = (va: number, vb: number, da: string | undefined, db: string | undefined) => (va > vb ? da : vb > va ? db : (da ?? db));
  const out: TrustState = {
    rootVersion: Math.max(a.rootVersion, b.rootVersion),
    timestampVersion: Math.max(a.timestampVersion, b.timestampVersion),
    snapshotVersion: Math.max(a.snapshotVersion, b.snapshotVersion),
    targetsVersion: Math.max(a.targetsVersion, b.targetsVersion),
    securityFloor: Math.max(a.securityFloor, b.securityFloor),
  };
  const ts = pick(a.timestampVersion, b.timestampVersion, a.timestampSha256, b.timestampSha256);
  const sn = pick(a.snapshotVersion, b.snapshotVersion, a.snapshotSha256, b.snapshotSha256);
  const tg = pick(a.targetsVersion, b.targetsVersion, a.targetsSha256, b.targetsSha256);
  if (ts) out.timestampSha256 = ts;
  if (sn) out.snapshotSha256 = sn;
  if (tg) out.targetsSha256 = tg;
  return out;
}

export class ReleaseCatalogGate {
  private loaded: Loaded | null = null;

  constructor(
    private readonly opts: {
      path: string;
      /** The root this box trusts (from its pinned trust file or a verified rotation). */
      root: () => RootMeta;
      /** Stable per-box secret salt for rollout buckets. */
      boxSalt: () => string;
      /** Defaults to the box's trusted clock. */
      now?: () => number;
    },
  ) {}

  private get floorPath(): string {
    return `${this.opts.path}.floor`;
  }

  private now(): number {
    return (this.opts.now ?? trustedNow)();
  }

  private async readMain(): Promise<{ kind: "ok"; p: Persisted } | { kind: "missing" } | { kind: "damaged" }> {
    const r = await readStateFile(this.opts.path);
    if (r.kind === "missing") return r;
    const effect = "release catalog state lost: no new update and no rollback below the kept floor until a catalog is accepted again";
    if (r.kind === "unreadable") {
      await keepCorruptAside(this.opts.path, r.error, effect);
      return { kind: "damaged" };
    }
    try {
      const j = JSON.parse(r.text) as Persisted;
      if (j && isState(j.state) && j.known && typeof j.known === "object" && typeof j.stale === "boolean") return { kind: "ok", p: j };
      throw new Error("release catalog state has the wrong shape");
    } catch (e) {
      await keepCorruptAside(this.opts.path, e, effect);
      return { kind: "damaged" };
    }
  }

  private async readFloor(): Promise<{ kind: "ok"; state: TrustState } | { kind: "missing" } | { kind: "damaged" }> {
    const r = await readStateFile(this.floorPath);
    if (r.kind === "missing") return r;
    if (r.kind === "ok") {
      try {
        const j = JSON.parse(r.text) as unknown;
        if (isState(j)) return { kind: "ok", state: j };
      } catch {
        /* below */
      }
    }
    await keepCorruptAside(this.floorPath, r.kind === "unreadable" ? r.error : new Error("damaged floor file"), "release catalog floor copy lost; the main state file still holds it");
    return { kind: "damaged" };
  }

  private async load(): Promise<Loaded> {
    if (this.loaded) return this.loaded;
    const main = await this.readMain();
    const kept = await this.readFloor();
    let l: Loaded;
    if (main.kind === "ok") {
      const state = kept.kind === "ok" ? maxState(main.p.state, kept.state) : main.p.state;
      l = { ...main.p, state, degraded: false, floorUnknown: false };
    } else if (main.kind === "missing" && kept.kind === "missing") {
      l = { state: { ...EMPTY_TRUST_STATE }, known: {}, stale: false, degraded: false, floorUnknown: false };
    } else {
      // The main file is gone or damaged: keep the marks we still have and know no release.
      l = {
        state: kept.kind === "ok" ? kept.state : { ...EMPTY_TRUST_STATE },
        known: {},
        stale: true,
        degraded: true,
        floorUnknown: kept.kind !== "ok",
      };
    }
    this.loaded = l;
    return l;
  }

  private async save(p: Persisted): Promise<void> {
    await mkdir(dirname(this.opts.path), { recursive: true });
    // The marks first: a crash between the two writes leaves them ahead of (never behind) the main file.
    await writeFileDurable(this.floorPath, JSON.stringify(p.state));
    await writeFileDurable(this.opts.path, JSON.stringify(p));
    this.loaded = { ...p, degraded: false, floorUnknown: false };
  }

  /** Stale already when accepted, or past its earliest expiry on the trusted clock now. */
  private isStale(cur: Persisted): boolean {
    return cur.stale || typeof cur.freshUntil !== "number" || this.now() >= cur.freshUntil;
  }

  /** Verify one fetched view and, if it holds, remember it. A refused view changes nothing. */
  async accept(view: Omit<CatalogInput, "root" | "now" | "state">): Promise<{ ok: true; catalog: Catalog } | { ok: false; reason: MetaRefusal }> {
    const cur = await this.load();
    const r = verifyReleaseCatalog({ ...view, root: this.opts.root(), now: this.now(), state: cur.state });
    if (!r.ok) return r;
    const known: Record<string, number> = {};
    const releases: Record<string, ReleaseEntry> = {};
    for (const rel of r.value.targets.releases) {
      known[rel.commit] = rel.securityVersion;
      releases[rel.commit] = rel;
    }
    const freshUntil = Math.min(view.timestamp.signed.expiresAt, view.snapshot.signed.expiresAt, view.targets.signed.expiresAt);
    await this.save({ state: r.value.state, known, releases, stale: r.value.stale, freshUntil });
    return { ok: true, catalog: r.value };
  }

  async floor(): Promise<number> {
    return (await this.load()).state.securityFloor;
  }

  /** The newest accepted view still counts as fresh only until its own expiry; a stale one blocks new updates. */
  async mayTakeNewRelease(release: ReleaseEntry, runningSecurityVersion: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cur = await this.load();
    if (cur.degraded) return { ok: false, reason: "catalog-state-lost" };
    if (cur.state.targetsVersion === 0) return { ok: false, reason: "no-catalog" };
    if (this.isStale(cur)) return { ok: false, reason: "stale-catalog" };
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
    if (cur.degraded) return { ok: false, reason: "catalog-state-lost" };
    const entry = cur.releases?.[commit];
    if (!entry) return { ok: false, reason: cur.state.targetsVersion === 0 ? "no-catalog" : "not-in-catalog" };
    return this.mayTakeNewRelease(entry, runningCommit ? cur.known[runningCommit] ?? 0 : 0);
  }

  offers(catalog: Catalog, runningSecurityVersion: number) {
    return offerableReleases(catalog, this.opts.boxSalt(), runningSecurityVersion);
  }

  /**
   * Health-failure rollback target check. With no floor set (0) any known or unknown commit may be returned to.
   * With the state lost and no kept floor, none may (the floor is unknown).
   */
  async rollbackAllowed(commit: string): Promise<boolean> {
    const cur = await this.load();
    if (cur.floorUnknown) return false;
    const floor = cur.state.securityFloor;
    if (floor <= 0) return true;
    const v = cur.known[commit];
    return v !== undefined && meetsSecurityFloor(v, floor);
  }
}
