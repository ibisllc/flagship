/**
 * Flagship app manifest — `flagship.app.json` at the root of every app's git repo.
 *
 * The LLM harness emits this; the platform validates it; it's the single source of
 * truth for how the app is deployed, what it exposes, who can access it, and
 * whether it can be migrated to another user.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

/** Repo-wide cap on the app one-liner (`manifest.description`). It renders in tight rows
 *  (apps list, app detail) right next to the equally-capped server
 *  description — keep them symmetrical so neither wraps. */
export const APP_ONELINER_MAX_LEN = 30;

export interface AppManifest {
  schema_version: number;
  name: string;
  description?: string;
  version: string;
  runtime: AppRuntime;
  data: AppData;
  network: AppNetwork;
  access: AppAccess;
  migration: AppMigration;
  /**
   * Optional. Apps that need to drive the pod-resident Chromium
   * browser declare here which web hosts they may navigate to. The
   * user reviews + approves this list at install time; the daemon
   * hard-blocks any navigation outside the set. Apps that don't set
   * this field cannot use the browser API at all.
   */
  browser?: AppBrowser;
  /**
   * Optional. Update-pack distribution policy.
   */
  distribution?: AppDistribution;
}

export interface AppDistribution {
  /**
   * When true, any signed puller can fetch update packs without being
   * on the canonical-home's subscriber list. Useful for open-source
   * apps that want anyone hosting the app to receive updates. The
   * puller's identity is still verified (sig auth on every request),
   * but no membership check gates access. Default: false.
   */
  public?: boolean;
}

export interface AppRuntime {
  /** OCI image reference. Must be pullable by the Flagship server. */
  image: string;
  /** Port the container exposes. */
  port: number;
  /** Environment variables. The runtime reserves any key starting with FLAGSHIP_. */
  env?: Record<string, string>;
}

export interface AppData {
  /**
   * Optional ephemeral scratch path inside the container. Persistence across
   * restarts is NOT guaranteed — apps that need durable state must use one
   * of the unified-data-layer stores below. Kept for niche cases (e.g. a
   * compile cache) where survival across container restarts is unnecessary.
   */
  path?: string;
  /** Subpaths to exclude when migrating data. */
  excludes?: string[];
  /**
   * Unified data-layer access. Vibe-coded apps must use these for persistent
   * state — Postgres for relational, MinIO for blobs/files, Redis for
   * cache/pubsub. The runtime injects FLAGSHIP_PG_URL / FLAGSHIP_S3_* /
   * FLAGSHIP_REDIS_URL into the container's env when each is enabled.
   *
   * Names are scoped to `<username>_<appname>` so the data layer is
   * portable: `pg_dump` filtered on the prefix is the migration unit.
   */
  stores?: AppDataStores;
}

/**
 * Each store flag is one of:
 *   - `true`     — single default instance; env var is FLAGSHIP_<STORE>_URL (no suffix).
 *   - `false`    — store not used.
 *   - string[]   — multiple named instances; env vars are FLAGSHIP_<STORE>_URL_<INSTANCE>.
 */
export type StoreFlag = boolean | string[];

export interface AppDataStores {
  postgres?: StoreFlag;
  objects?: StoreFlag;
  kv?: StoreFlag;
}

const INSTANCE_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Normalize a StoreFlag to a list of instance names. Single (default)
 * instance returns `["default"]` so callers can iterate uniformly; empty
 * array means the store isn't used.
 *
 * Throws on duplicates or instance names that aren't RFC 1035 labels.
 */
export function normalizeStoreFlag(flag: StoreFlag | undefined): string[] {
  if (flag === true) return ["default"];
  if (flag === false || flag === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of flag) {
    if (typeof name !== "string") throw new Error("instance names must be strings");
    if (!INSTANCE_RE.test(name)) {
      throw new Error(
        `instance name ${JSON.stringify(name)} must be RFC 1035 label (1–32 chars, [a-z0-9-])`,
      );
    }
    if (seen.has(name)) throw new Error(`duplicate instance name ${JSON.stringify(name)}`);
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Whether a flag indicates the singleton default instance (drives env-var naming). */
export function isSingletonStore(flag: StoreFlag | undefined): boolean {
  return flag === true;
}

export interface AppNetwork {
  /** DNS label under <user>.flagship.services. e.g. "habits" → habits.harry.flagship.services */
  subdomain: string;
}

export interface AppAccess {
  /** Mandatory true. Apps cannot opt out of identity injection. */
  enabled: true;
  /** Default role assigned to a new member. */
  default_role: "owner" | "admin" | "member" | "viewer";
  /** Custom role labels the app understands (passed through unchanged). */
  custom_roles?: string[];
  /**
   * Paths the app exposes to anonymous visitors (X-Flagship-User: anonymous).
   * Default: empty — all routes require membership. Adding entries explicitly
   * opens them for public access (e.g. "/", "/about").
   */
  public_routes?: string[];
  /**
   * Sister-app allowlist. App ids listed here may call
   * `GET /.flagship/peers/<this-app-id>/installed` and learn whether this
   * app is installed. Apps NOT listed always see `installed: false` —
   * the lookup is silently denied (no fingerprinting).
   *
   * Direction is target-controlled: app A wanting to query app B requires
   * B's manifest to include A in `queryable_by`.
   */
  queryable_by?: string[];
}

export interface AppBrowser {
  /**
   * Hosts the app may navigate the pod's Chromium to. Each entry is
   * either a literal host (`amazon.com`, `accounts.google.com`) or a
   * single-label wildcard (`*.example.com`, which matches any
   * subdomain of example.com but NOT example.com itself — declare
   * both if you need both). No schemes, no paths, no single-label
   * hosts (`localhost` is rejected).
   */
  domains: string[];
  /**
   * UX hint for the install screen. When true, the phone tells the
   * user "this app needs you to log in to its declared domains for
   * normal operation." Doesn't change daemon behavior — every login
   * still goes through the phone-mediated password flow.
   */
  login_required?: boolean;
}

/** Match a host literal `example.com` or `accounts.google.com`. Multi-label only. */
const LITERAL_HOST_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Match a wildcard host `*.example.com`. Exactly one leading `*.`; rest must be multi-label. */
const WILDCARD_HOST_RE =
  /^\*\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Match a request URL host against a domain entry from a manifest.
 * Exposed so the daemon's DomainGate can reuse the exact same
 * matching rules the manifest validator enforces.
 */
export function matchBrowserDomain(entry: string, host: string): boolean {
  if (entry === host) return true;
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}

export type MigrationVerification = "standard" | "elevated";

export interface AppMigration {
  /**
   * "standard" = biometric only on both ends.
   * "elevated" = biometric + 2FA (TOTP or WebAuthn) on both ends.
   * LLM should default elevated for apps holding financial, medical, or password material.
   * All apps are transferable; this only ratchets HOW the user proves intent.
   */
  verification: MigrationVerification;
}

export type ManifestParseResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; errors: string[] };

const RESERVED_ENV_PREFIX = "FLAGSHIP_";
const VALID_ROLES = new Set(["owner", "admin", "member", "viewer"]);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseManifest(input: unknown): ManifestParseResult {
  const errors: string[] = [];
  const e = (msg: string) => errors.push(msg);

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }
  const m = input as Record<string, unknown>;

  if (m.schema_version !== MANIFEST_SCHEMA_VERSION) {
    e(`schema_version must be ${MANIFEST_SCHEMA_VERSION} (got ${JSON.stringify(m.schema_version)})`);
  }

  const name = stringField(m, "name", e);
  if (name && !NAME_RE.test(name)) {
    e("name must be a DNS label (lowercase, 1–63 chars, [a-z0-9-], not starting with hyphen)");
  }

  const version = stringField(m, "version", e);
  if (version && !VERSION_RE.test(version)) {
    e("version must be semver (e.g. 1.2.3 or 1.2.3-beta.4)");
  }

  optionalString(m, "description", e);
  if (
    typeof m.description === "string" &&
    m.description.length > APP_ONELINER_MAX_LEN
  ) {
    e(`description must be at most ${APP_ONELINER_MAX_LEN} characters`);
  }

  const runtime = parseRuntime(m.runtime, e);
  // `data` is OPTIONAL: a static site / a service with no data stores legitimately
  // omits it. Absent ⇒ an empty AppData (identical to `data:{}`, which already
  // validated), so the manifest always carries a data object downstream and an
  // AI-authored minimal manifest no longer fails deploy with "data must be an
  // object". A PRESENT-but-malformed `data` (e.g. a string) still errors.
  const data = parseData(m.data ?? {}, e);
  const network = parseNetwork(m.network, e);
  const access = parseAccess(m.access, e);
  const migration = parseMigration(m.migration, e);
  const browser = parseBrowser(m.browser, e);
  const distribution = parseDistribution(m.distribution, e);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      schema_version: MANIFEST_SCHEMA_VERSION,
      name: name!,
      description: typeof m.description === "string" ? m.description : undefined,
      version: version!,
      runtime: runtime!,
      data: data!,
      network: network!,
      access: access!,
      migration: migration!,
      browser,
      distribution,
    },
  };
}

function parseDistribution(
  v: unknown,
  e: (m: string) => void,
): AppDistribution | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    e("distribution must be an object");
    return undefined;
  }
  const d = v as Record<string, unknown>;
  let pub: boolean | undefined;
  if (d.public !== undefined) {
    if (typeof d.public !== "boolean") {
      e("distribution.public must be a boolean when present");
    } else {
      pub = d.public;
    }
  }
  for (const k of Object.keys(d)) {
    if (k !== "public") e(`distribution.${k} is not a recognized field`);
  }
  return { public: pub };
}

function parseRuntime(v: unknown, e: (m: string) => void): AppRuntime | undefined {
  if (typeof v !== "object" || v === null) {
    e("runtime must be an object");
    return undefined;
  }
  const r = v as Record<string, unknown>;
  const image = stringField(r, "runtime.image", e, "image");
  const port = numberField(r, "runtime.port", e, "port");
  if (port !== undefined && (port < 1 || port > 65535 || !Number.isInteger(port))) {
    e("runtime.port must be an integer in [1, 65535]");
  }
  let env: Record<string, string> | undefined;
  if (r.env !== undefined) {
    if (typeof r.env !== "object" || r.env === null || Array.isArray(r.env)) {
      e("runtime.env must be an object of string→string");
    } else {
      env = {};
      for (const [k, val] of Object.entries(r.env as Record<string, unknown>)) {
        if (k.startsWith(RESERVED_ENV_PREFIX)) {
          e(`runtime.env.${k}: keys starting with ${RESERVED_ENV_PREFIX} are reserved by the runtime`);
          continue;
        }
        if (typeof val !== "string") {
          e(`runtime.env.${k} must be a string`);
          continue;
        }
        env[k] = val;
      }
    }
  }
  if (!image || port === undefined) return undefined;
  return { image, port, env };
}

function parseData(v: unknown, e: (m: string) => void): AppData | undefined {
  if (typeof v !== "object" || v === null) {
    e("data must be an object");
    return undefined;
  }
  const d = v as Record<string, unknown>;
  let path: string | undefined;
  if (d.path !== undefined) {
    if (typeof d.path !== "string" || d.path.length === 0) {
      e("data.path must be a non-empty string when present");
    } else if (!d.path.startsWith("/")) {
      e("data.path must be absolute (starting with /)");
    } else {
      path = d.path;
    }
  }
  let excludes: string[] | undefined;
  if (d.excludes !== undefined) {
    if (!Array.isArray(d.excludes)) {
      e("data.excludes must be an array of strings");
    } else {
      excludes = [];
      for (const item of d.excludes) {
        if (typeof item !== "string") {
          e("data.excludes entries must be strings");
        } else {
          excludes.push(item);
        }
      }
    }
  }
  let stores: AppDataStores | undefined;
  if (d.stores !== undefined) {
    if (typeof d.stores !== "object" || d.stores === null || Array.isArray(d.stores)) {
      e("data.stores must be an object");
    } else {
      stores = {};
      const s = d.stores as Record<string, unknown>;
      for (const k of ["postgres", "objects", "kv"] as const) {
        if (s[k] !== undefined) {
          const v = s[k];
          if (typeof v === "boolean") {
            stores[k] = v;
          } else if (Array.isArray(v)) {
            try {
              normalizeStoreFlag(v as string[]);
              stores[k] = v as string[];
            } catch (err) {
              e(`data.stores.${k}: ${(err as Error).message}`);
            }
          } else {
            e(`data.stores.${k} must be a boolean or an array of instance names`);
          }
        }
      }
      // Reject any unknown store flags so typos don't silently disable a store.
      for (const k of Object.keys(s)) {
        if (k !== "postgres" && k !== "objects" && k !== "kv") {
          e(`data.stores.${k} is not a recognized store flag`);
        }
      }
    }
  }
  return { path, excludes, stores };
}

function parseNetwork(v: unknown, e: (m: string) => void): AppNetwork | undefined {
  if (typeof v !== "object" || v === null) {
    e("network must be an object");
    return undefined;
  }
  const n = v as Record<string, unknown>;
  const sub = stringField(n, "network.subdomain", e, "subdomain");
  if (sub && !SUBDOMAIN_RE.test(sub)) {
    e("network.subdomain must be a DNS label");
  }
  if (!sub) return undefined;
  return { subdomain: sub };
}

function parseAccess(v: unknown, e: (m: string) => void): AppAccess | undefined {
  if (typeof v !== "object" || v === null) {
    e("access must be an object");
    return undefined;
  }
  const a = v as Record<string, unknown>;
  if (a.enabled !== true) {
    e("access.enabled must be exactly true (apps cannot opt out of platform identity)");
  }
  let defaultRole: AppAccess["default_role"] = "viewer";
  if (a.default_role !== undefined) {
    if (typeof a.default_role !== "string" || !VALID_ROLES.has(a.default_role)) {
      e("access.default_role must be one of owner, admin, member, viewer");
    } else {
      defaultRole = a.default_role as AppAccess["default_role"];
    }
  }
  let customRoles: string[] | undefined;
  if (a.custom_roles !== undefined) {
    if (!Array.isArray(a.custom_roles)) {
      e("access.custom_roles must be an array of strings");
    } else {
      customRoles = [];
      for (const r of a.custom_roles) {
        if (typeof r !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(r)) {
          e(`access.custom_roles entries must be lowercase identifiers (got ${JSON.stringify(r)})`);
        } else {
          customRoles.push(r);
        }
      }
    }
  }
  let publicRoutes: string[] | undefined;
  if (a.public_routes !== undefined) {
    if (!Array.isArray(a.public_routes)) {
      e("access.public_routes must be an array of strings");
    } else {
      publicRoutes = [];
      for (const p of a.public_routes) {
        if (typeof p !== "string" || !p.startsWith("/")) {
          e(`access.public_routes entries must be absolute paths starting with "/" (got ${JSON.stringify(p)})`);
        } else {
          publicRoutes.push(p);
        }
      }
    }
  }
  let queryableBy: string[] | undefined;
  if (a.queryable_by !== undefined) {
    if (!Array.isArray(a.queryable_by)) {
      e("access.queryable_by must be an array of app ids");
    } else {
      queryableBy = [];
      const seen = new Set<string>();
      for (const q of a.queryable_by) {
        if (typeof q !== "string" || !NAME_RE.test(q)) {
          e(
            `access.queryable_by entries must be DNS-safe app ids (got ${JSON.stringify(q)})`,
          );
        } else if (seen.has(q)) {
          e(`access.queryable_by has a duplicate entry ${JSON.stringify(q)}`);
        } else {
          seen.add(q);
          queryableBy.push(q);
        }
      }
    }
  }
  if (a.enabled !== true) return undefined;
  return {
    enabled: true,
    default_role: defaultRole,
    custom_roles: customRoles,
    public_routes: publicRoutes,
    queryable_by: queryableBy,
  };
}

function parseBrowser(v: unknown, e: (m: string) => void): AppBrowser | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    e("browser must be an object");
    return undefined;
  }
  const b = v as Record<string, unknown>;

  if (!Array.isArray(b.domains)) {
    e("browser.domains must be an array of host strings");
    return undefined;
  }
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const d of b.domains) {
    if (typeof d !== "string") {
      e("browser.domains entries must be strings");
      continue;
    }
    if (!LITERAL_HOST_RE.test(d) && !WILDCARD_HOST_RE.test(d)) {
      e(
        `browser.domains entry ${JSON.stringify(d)} must be a host like "example.com" or "*.example.com" (no schemes, paths, single-label hosts, or trailing dots)`,
      );
      continue;
    }
    if (seen.has(d)) {
      e(`browser.domains has duplicate entry ${JSON.stringify(d)}`);
      continue;
    }
    seen.add(d);
    domains.push(d);
  }

  let loginRequired: boolean | undefined;
  if (b.login_required !== undefined) {
    if (typeof b.login_required !== "boolean") {
      e("browser.login_required must be a boolean when present");
    } else {
      loginRequired = b.login_required;
    }
  }

  // Reject unknown keys so a typo'd field (e.g. "domain" singular) doesn't
  // silently disable the gate the user thought they were declaring.
  for (const k of Object.keys(b)) {
    if (k !== "domains" && k !== "login_required") {
      e(`browser.${k} is not a recognized field`);
    }
  }

  return { domains, login_required: loginRequired };
}

function parseMigration(v: unknown, e: (m: string) => void): AppMigration | undefined {
  if (typeof v !== "object" || v === null) {
    e("migration must be an object");
    return undefined;
  }
  const mg = v as Record<string, unknown>;
  if (mg.verification !== "standard" && mg.verification !== "elevated") {
    e('migration.verification must be "standard" or "elevated"');
    return undefined;
  }
  return { verification: mg.verification };
}

function stringField(
  o: Record<string, unknown>,
  fullName: string,
  e: (m: string) => void,
  shortName: string = fullName,
): string | undefined {
  const v = o[shortName];
  if (typeof v !== "string" || v.length === 0) {
    e(`${fullName} must be a non-empty string`);
    return undefined;
  }
  return v;
}

function optionalString(o: Record<string, unknown>, name: string, e: (m: string) => void): void {
  const v = o[name];
  if (v !== undefined && typeof v !== "string") {
    e(`${name} must be a string when present`);
  }
}

function numberField(
  o: Record<string, unknown>,
  fullName: string,
  e: (m: string) => void,
  shortName: string,
): number | undefined {
  const v = o[shortName];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    e(`${fullName} must be a finite number`);
    return undefined;
  }
  return v;
}
