/**
 * Naming helpers for the data layer: each app's Postgres database + role and
 * its files volume.
 *
 * App data identity is `(creator, slug, storeName?, space?)`.
 *
 *   Postgres db + role: OPAQUE. `app_<24 hex>` (prod) or `__dev_<24 hex>`
 *                       (dev), the hex an HMAC of the identity under the
 *                       box's own name key (DATA_NAME_KEY in
 *                       data-services.env). Every role can read
 *                       pg_database and pg_roles, so a readable name would
 *                       tell AI-written code which other apps the owner
 *                       runs; an opaque one tells it nothing.
 *   Files volume:       `flagship-files-<creator>--<slug>` (prod) or
 *                       `flagship-devfiles-<creator>--<slug>` (dev). Only
 *                       the box sees volume names (and the app its own).
 *                       `--` splits creator from slug, as in service ids:
 *                       neither may contain one.
 *
 * The names are stable for a box: the same identity and key always give the
 * same name, so the box can recompute a dev store a crashed daemon left. Prod
 * names are also kept in the app's credentials, which is what uninstall
 * drops (an app restored onto another box keeps the names it had).
 *
 * The dev dataspace (staging copies) can never collide with prod: a prod
 * database starts `app_`, a dev one `__dev_`; a prod volume starts
 * `flagship-files-`, a dev one `flagship-devfiles-`.
 *
 * Volumes made before usernames could hold a dash were
 * `flagship-files-<dashless creator>-<slug>`; they are still recognized as
 * prod volumes so those apps keep their files.
 *
 * Validation contract (enforced upstream by services-zone and the manifest):
 *   - creator: [a-z0-9-]{1,32}, no leading/trailing dash, no double dash
 *              (a username)
 *   - slug:    [a-z0-9-]{1,32}, no leading/trailing dash, no double dash
 *   - storeName: an RFC 1035 label, [a-z0-9-]{1,32} (the manifest's rule)
 */

import { createHmac } from "node:crypto";

const SLUG_RE = /^[a-z0-9](-?[a-z0-9])*$/;
const STORE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

function assertCreator(creator: string): void {
  if (creator.length < 1 || creator.length > 32 || !SLUG_RE.test(creator)) {
    throw new Error(`creator ${JSON.stringify(creator)} must match [a-z0-9-]{1,32} with no leading/trailing/double dash`);
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
    throw new Error(`storeName ${JSON.stringify(storeName)} must be an RFC 1035 label (1–32 chars, [a-z0-9-])`);
  }
}

export interface AppDataIdentity {
  creator: string;
  slug: string;
  storeName?: string;
  /**
   * Absent / "prod" = the production dataspace. "dev" = the ephemeral
   * synthetic dataspace a staging copy runs against, disjoint from prod.
   */
  space?: "dev" | "prod";
}

/** The implicit single-store name (a manifest's `postgres: true`). */
export const DEFAULT_STORE_NAME = "default";

/** Postgres identifiers (NAMEDATALEN - 1). */
export const MAX_PG_IDENT = 63;

/** The sentinel every dev database and role starts with; no prod name does. */
export const DEV_PG_PREFIX = "__dev_";
const PROD_PG_PREFIX = "app_";

/**
 * The extensions every app database gets, created by the admin so the app's
 * own (unprivileged) role can use them. The image is pgvector's Postgres 18
 * build, which ships `vector` next to the contrib modules.
 */
export const APP_PG_EXTENSIONS = [
  "pgcrypto",
  "citext",
  "pg_trgm",
  "unaccent",
  "fuzzystrmatch",
  "hstore",
  "ltree",
  "btree_gin",
  "btree_gist",
  "vector",
] as const;

/** Where an app's files folder is mounted, and the env var that names it. */
export const FILES_MOUNT = "/data";

function isDev(id: AppDataIdentity): boolean {
  return id.space === "dev";
}

function effectiveStoreName(s?: string): string {
  return s === undefined ? DEFAULT_STORE_NAME : s;
}

function assertNameKey(key: string): void {
  if (typeof key !== "string" || key.length < 16) {
    throw new Error("the data layer's name key is missing or too short");
  }
}

/** The app's Postgres database: opaque, stable for this box's name key. */
export function pgDatabase(id: AppDataIdentity, nameKey: string): string {
  assertCreator(id.creator);
  assertSlug(id.slug);
  assertStoreName(id.storeName);
  assertNameKey(nameKey);
  const space = isDev(id) ? "dev" : "prod";
  const digest = createHmac("sha256", nameKey)
    .update(`flagship/pg-name/v1|${space}|${id.creator}|${id.slug}|${effectiveStoreName(id.storeName)}`)
    .digest("hex")
    .slice(0, 24);
  return `${isDev(id) ? DEV_PG_PREFIX : PROD_PG_PREFIX}${digest}`;
}

/** One role per database, named the same. */
export function pgRole(id: AppDataIdentity, nameKey: string): string {
  return pgDatabase(id, nameKey);
}

/** The app's files volume (a Docker named volume, never a host path). */
export function filesVolume(id: AppDataIdentity): string {
  assertCreator(id.creator);
  assertSlug(id.slug);
  return `flagship-${isDev(id) ? "devfiles" : "files"}-${id.creator}--${id.slug}`;
}

const LABEL = "[a-z0-9](?:-?[a-z0-9]){0,31}";
const PROD_FILES_VOLUME_RE = new RegExp(`^flagship-files-${LABEL}--${LABEL}$`);
const DEV_FILES_VOLUME_RE = new RegExp(`^flagship-devfiles-${LABEL}--${LABEL}$`);
const LEGACY_FILES_VOLUME_RE = new RegExp(`^flagship-files-[a-z0-9]{1,32}-${LABEL}$`);

/** True for a name `filesVolume` could have made (prod or dev). */
export function isFilesVolume(name: string): boolean {
  return isProdFilesVolume(name) || DEV_FILES_VOLUME_RE.test(name);
}

/** True for a prod files volume (what backups carry; dev ones never are). */
export function isProdFilesVolume(name: string): boolean {
  return PROD_FILES_VOLUME_RE.test(name) || LEGACY_FILES_VOLUME_RE.test(name);
}

/**
 * Generate a 32-byte random secret encoded as a URL-safe base64 string for
 * use as a generated password.
 */
export function generateSecret(rng?: () => Uint8Array): string {
  const r = rng ?? (() => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b;
  });
  return Buffer.from(r()).toString("base64url");
}
