/**
 * Naming helpers for the unified data layer.
 *
 * Canonical app data identity is `(creator, slug, storeName?)` — host-
 * independent on purpose so an app's data identity doesn't change when
 * the app moves between servers via the migration flow. The host (the
 * server actually running the app today) is implicit: we're running on
 * it.
 *
 * Per-store rendering of the same identity, accommodating each store's
 * naming rules:
 *
 *   Postgres db + role: `_<creator>_<slug>` (or `_<creator>_<slug>_<storeName>`)
 *                       dashes in the slug become underscores (PG identifier rule)
 *   Redis ACL user:     `_<creator>_<slug>` (or `_<creator>_<slug>_<storeName>`)
 *                       dashes in the slug become underscores (matches PG)
 *   Redis key prefix:   `<creator>:<slug>:` (or `<creator>:<slug>:<storeName>:`)
 *                       dashes in the slug preserved
 *   MinIO bucket:       `<creator>-<slug>` (or `<creator>-<slug>-<storeName>`)
 *                       dashes in the slug preserved (S3 rule: no underscores)
 *   MinIO access key:   same as bucket
 *
 * The leading `_` on Postgres + Redis avoids collisions with system
 * databases / roles / ACL users (Postgres reserves `pg_*`; Redis system
 * keys never start with a colon-bearing creator). MinIO doesn't allow
 * underscores at all, so the bucket form is the same convention without
 * the leading sentinel.
 *
 * Validation contract (enforced upstream by services-zone):
 *   - creator: [a-z0-9]{1,32}, no dashes (so a single dash unambiguously
 *     separates it from the slug in URLs like `<slug>-<creator>...`)
 *   - slug:    [a-z0-9-]{1,32}, no leading/trailing dash, no double dash
 *   - storeName: [a-z0-9]{1,32} (dashless for cleanliness; LLM-generated)
 *
 * This module just composes the names — caller is expected to have
 * already validated.
 */

const CREATOR_RE = /^[a-z0-9]{1,32}$/;
const SLUG_RE = /^[a-z0-9](-?[a-z0-9])*$/;
const STORE_NAME_RE = /^[a-z0-9]{1,32}$/;

function assertCreator(creator: string): void {
  if (!CREATOR_RE.test(creator)) {
    throw new Error(`creator ${JSON.stringify(creator)} must match [a-z0-9]{1,32} (no dashes)`);
  }
}
function assertSlug(slug: string): void {
  if (slug.length < 1 || slug.length > 32 || !SLUG_RE.test(slug)) {
    throw new Error(`slug ${JSON.stringify(slug)} must match [a-z0-9-]{1,32} with no leading/trailing/double dash`);
  }
}
function assertStoreName(storeName?: string): void {
  if (storeName === undefined) return;
  if (!STORE_NAME_RE.test(storeName)) {
    throw new Error(`storeName ${JSON.stringify(storeName)} must match [a-z0-9]{1,32} (dashless)`);
  }
}

/**
 * Canonical app data identity. `storeName` is optional — when an app
 * declares only a single store (the manifest's `true`-form) we treat
 * it as a default-name store and omit the suffix everywhere.
 */
export interface AppDataIdentity {
  creator: string;
  slug: string;
  storeName?: string;
  /**
   * Which dataspace this identity addresses. Absent / "prod" = the production
   * dataspace (byte-identical to pre-dev-dataspace names — no migration).
   * "dev" = the ephemeral synthetic dev dataspace: a parallel, `dev`-prefixed
   * db / role / bucket / prefix that the author's app runs against during
   * authoring, and which can never collide with prod. See
   * `docs/dev-prod-dataspace-harness-spec.md` §3.
   */
  space?: "dev" | "prod";
}

/**
 * The `dev` marker woven into every dev-space name. Kept short + dashless so it
 * is valid in Postgres identifiers (with the leading `_`), Redis, and S3
 * buckets alike. A prod identity NEVER carries this token.
 */
const DEV_SPACE_TOKEN = "dev";

/** True when the identity addresses the dev dataspace. */
function isDev(id: AppDataIdentity): boolean {
  return id.space === "dev";
}

/**
 * "default" is the implicit single-store name. We render WITHOUT a
 * suffix when the input is `default` so single-store apps get clean
 * names (`_harry_game1`, not `_harry_game1_default`). The manifest
 * normalizer surfaces "default" for single-store apps; this constant
 * is also exported so other modules can refer to it.
 */
export const DEFAULT_STORE_NAME = "default";

function effectiveStoreName(s?: string): string | undefined {
  if (s === undefined || s === DEFAULT_STORE_NAME) return undefined;
  return s;
}

export function pgDatabase(id: AppDataIdentity): string {
  assertCreator(id.creator);
  assertSlug(id.slug);
  assertStoreName(id.storeName);
  // Postgres unquoted identifiers: lowercase, [a-z0-9_], no leading digit.
  // Convert dashes in the slug to underscores; everything else is already safe.
  const slugSafe = id.slug.replace(/-/g, "_");
  const eff = effectiveStoreName(id.storeName);
  const suffix = eff ? `_${eff}` : "";
  // Prod: `_<creator>_<slug>`. Dev: `__dev_<creator>_<slug>` — a prod name is
  // always `_<creator>_…` with creator [a-z0-9], so it can never begin with
  // `__`. The dev and prod namespaces are therefore provably disjoint even
  // after slug dashes collapse to underscores.
  const prefix = isDev(id) ? `__${DEV_SPACE_TOKEN}_` : `_`;
  return `${prefix}${id.creator}_${slugSafe}${suffix}`;
}

export function pgRole(id: AppDataIdentity): string {
  return pgDatabase(id);
}

export function redisUser(id: AppDataIdentity): string {
  return pgDatabase(id);
}

export function redisPrefix(id: AppDataIdentity): string {
  assertCreator(id.creator);
  assertSlug(id.slug);
  assertStoreName(id.storeName);
  // Redis prefixes are free-form (we just glob-match on them); preserve
  // dashes in the slug for human readability. Dev space gets a leading
  // `dev:` segment — the colon is the reserved separator and a prod prefix
  // starts with the creator ([a-z0-9]), so `dev:` can never collide.
  const eff = effectiveStoreName(id.storeName);
  const suffix = eff ? `${eff}:` : "";
  const devSeg = isDev(id) ? `${DEV_SPACE_TOKEN}:` : "";
  return `${devSeg}${id.creator}:${id.slug}:${suffix}`;
}

export function s3Bucket(id: AppDataIdentity): string {
  assertCreator(id.creator);
  assertSlug(id.slug);
  assertStoreName(id.storeName);
  // S3 bucket: 3–63 chars, lowercase alnum + dash + dot, no leading/trailing
  // dash or dot, no underscores. Slug already conforms; creator is dashless;
  // storeName is dashless. Concatenation is well-formed. Dev space gets a
  // leading `dev.` label — the dot is a valid S3 bucket separator and a prod
  // bucket starts with the creator ([a-z0-9]), so `dev.` never collides.
  const eff = effectiveStoreName(id.storeName);
  const suffix = eff ? `-${eff}` : "";
  const devSeg = isDev(id) ? `${DEV_SPACE_TOKEN}.` : "";
  return `${devSeg}${id.creator}-${id.slug}${suffix}`;
}

export function s3AccessKey(id: AppDataIdentity): string {
  return s3Bucket(id);
}

/**
 * Generate a 32-byte random secret encoded as a URL-safe base64 string for
 * use as a generated password / access key.
 */
export function generateSecret(rng?: () => Uint8Array): string {
  const r = rng ?? (() => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b;
  });
  return Buffer.from(r()).toString("base64url");
}
