/**
 * Flagship app manifest — `flagship.app.json` at the root of every app's git repo.
 *
 * The LLM harness emits this; the platform validates it; it's the single source of
 * truth for how the app is deployed, what it exposes, who can access it, and
 * whether it can be migrated to another user.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

/** Repo-wide cap on the app one-liner (`manifest.description`, and the
 *  marketplace `tagline` that mirrors it). It renders in tight rows
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

/** The runtimes a box builds apps on (docs/app-runtimes.md §4); the box pins each. */
export const RUNTIME_BASES = ["node-24", "python-3.13", "static"] as const;
export type RuntimeBase = (typeof RUNTIME_BASES)[number];

/**
 * The files at an app's root that decide how it's built. An AI (or an
 * adapter, which is an AI's changes replayed) never adds or changes them: the
 * box writes the build for a runtime app.
 */
export function isBuildFilePath(path: string): boolean {
  return !path.includes("/") && /^(\.dockerignore|(docker|container)file(\..+)?)$/i.test(path);
}

export interface AppRuntime {
  /**
   * The runtime the box builds the app on (docs/app-runtimes.md). The box
   * writes the build itself; an app's own Dockerfile is ignored.
   */
  base?: RuntimeBase;
  /** The start command (argv, no shell). node-24 defaults to `npm start`; python-3.13 needs one. */
  start?: string[];
  /** `static`: the folder to serve, relative to the app (default the whole app). */
  root?: string;
  /**
   * The image the app runs. A runtime app leaves it out: the box sets it to
   * the image it built. Otherwise an OCI reference the box can pull.
   */
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
   * Unified data-layer access. Apps must use these for persistent state:
   * Postgres for relational data, file metadata, caches, queues and pub/sub,
   * and a per-app files folder for uploads and other blobs. The runtime
   * injects FLAGSHIP_PG_URL / FLAGSHIP_FILES_DIR into the container's env when
   * each is enabled. There is no S3 server and no Redis.
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
  /**
   * One writable folder for the app, mounted at FLAGSHIP_FILES_DIR (`/data`)
   * and kept across restarts and redeploys. Only `true`/`false`.
   */
  files?: boolean;
  /**
   * Older manifests' S3 buckets. Still accepted, but there is no S3 server:
   * the parser turns any `objects` into `files: true` and drops it, so a
   * parsed manifest never carries it.
   */
  objects?: StoreFlag;
  /**
   * Older manifests' Redis. Still accepted, but there is no Redis: the parser
   * turns it into the app's Postgres database (`postgres: true` unless one is
   * declared) and drops it, so a parsed manifest never carries it.
   */
  kv?: StoreFlag;
}

/** The note `parseManifest` gives a manifest that still asks for S3. */
export const OBJECTS_STORE_NOTE =
  "data.stores.objects is no longer supported: there is no S3 server, so the app gets one files folder instead " +
  "(FLAGSHIP_FILES_DIR=/data, the same as data.stores.files: true). Store uploads there, keep their metadata in " +
  'Postgres, and serve them through the app. Replace objects with "files": true.';

/** The note `parseManifest` gives a manifest that still asks for Redis. */
export const KV_STORE_NOTE =
  "data.stores.kv is no longer supported: there is no Redis, so the app gets its Postgres database instead " +
  "(FLAGSHIP_PG_URL). Use Postgres: UNLOGGED tables for caches, LISTEN/NOTIFY for pub/sub. Replace kv with " +
  '"postgres": true.';

function flagUsed(flag: StoreFlag | undefined): boolean {
  return flag === true || (Array.isArray(flag) && flag.length > 0);
}

/** Whether the stores ask for the per-app files folder (an older `objects` counts). */
export function wantsFiles(stores: AppDataStores | undefined): boolean {
  return !!stores && (stores.files === true || flagUsed(stores.objects));
}

/** Whether the stores need a Postgres database (an older `kv` counts). */
export function wantsPostgres(stores: AppDataStores | undefined): boolean {
  return !!stores && (flagUsed(stores.postgres) || flagUsed(stores.kv));
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
  /**
   * Internet hosts the live app asks to reach (`api.example.com`, or
   * `*.example.com` for any subdomain of it but not example.com itself).
   * A live app has no internet at all by default: these open only after the
   * owner signs an `app-egress` grant for them, and only on TLS 443 / HTTP 80.
   * A manifest entry is a host string or `{host, why}`; the hosts land here.
   */
  egress?: string[];
  /**
   * The short reason (≤ `EGRESS_WHY_MAX` chars) a `{host, why}` entry gave,
   * by host. Absent when no entry gave one. The box writes it as the comment
   * on the host's line in the suggested access list it drafts for the owner.
   */
  egressWhy?: Record<string, string>;
}

/** Longest `why` a `network.egress` entry may carry. */
export const EGRESS_WHY_MAX = 120;

/** A suggested host and why the app needs it (from `network.egress`). */
export interface EgressSuggestion {
  host: string;
  why?: string;
}

/** The manifest's `network.egress` hosts, each with its reason when it gave one. */
export function egressSuggestions(network: AppNetwork | undefined): EgressSuggestion[] {
  const why = network?.egressWhy ?? {};
  return (network?.egress ?? []).map((host) => {
    const w = Object.prototype.hasOwnProperty.call(why, host) ? why[host] : undefined;
    return w ? { host, why: w } : { host };
  });
}

/** Most hosts one app may declare in `network.egress`. */
export const EGRESS_HOSTS_MAX = 32;

/**
 * A valid `network.egress` / `app-egress` grant host: a lowercase multi-label
 * DNS name, or `*.` + one, and never an IPv4 literal (an owner approves names).
 */
export function isEgressHost(h: string): boolean {
  if (h.length > 253) return false;
  if (!LITERAL_HOST_RE.test(h) && !WILDCARD_HOST_RE.test(h)) return false;
  return !/^[0-9.]+$/.test(h.replace(/^\*\./, ""));
}

export interface AppAccess {
  /** Mandatory true. Apps cannot opt out of identity injection. */
  enabled: true;
  /**
   * The rank a member has until the owner gives them another, on Flagship's
   * ordered ranks member < manager < master (only the box owner is owner).
   * Older manifests' names map onto them: viewer → member, editor →
   * manager, admin and owner → master.
   */
  default_role: "member" | "manager" | "master" | "owner" | "admin" | "editor" | "viewer";
  /**
   * One line per rank telling the owner what it can do in THIS app, shown in
   * the rank picker (e.g. `{ member: "Plays and saves games", manager:
   * "Runs tournaments", master: "Changes the club's settings" }`).
   */
  role_descriptions?: Partial<Record<"member" | "manager" | "master", string>>;
  /** Older manifests' app-defined role labels; members' roles are the fixed ladder. */
  custom_roles?: string[];
  /**
   * Paths the app exposes to anonymous visitors (X-Flagship-Visitor: anonymous, no user or role).
   * Default: empty — all routes require membership. Adding entries explicitly
   * opens them for public access (e.g. "/", "/about"). An entry ending in
   * `/*` is a segment-aware prefix: "/api/public/*" opens `/api/public/` and
   * everything under it (not `/api/publicity`); "/*" opens the whole app.
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
  | {
      ok: true;
      manifest: AppManifest;
      /** Accepted, but worth telling the author: an older `objects` or `kv` store and what replaced it. */
      notes?: string[];
    }
  | { ok: false; errors: string[] };

const RESERVED_ENV_PREFIX = "FLAGSHIP_";
const VALID_ROLES = new Set(["member", "manager", "master", "owner", "admin", "editor", "viewer"]);
const RANKS = ["member", "manager", "master"] as const;
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
  // Only `runtime` (image+port) is genuinely required to RUN. The rest default to
  // their sensible/mandatory minimum when ABSENT, so a minimal AI-authored manifest
  // (a static site) no longer fails deploy with "<field> must be an object". A
  // PRESENT-but-malformed field (e.g. a string, a bad role) still errors.
  //   - data    ⇒ {} (no data stores; identical to data:{}, which already validated)
  //   - network ⇒ {} (no subdomain hint; the daemon derives the url label from the name)
  //   - access  ⇒ {enabled:true} — apps cannot OPT OUT of platform identity, so absent
  //               is treated as the only valid value (enabled:true), not a rejection.
  //   - migration ⇒ {verification:"standard"}
  const notes: string[] = [];
  const data = parseData(m.data ?? {}, e, notes);
  const network = parseNetwork(m.network ?? {}, e);
  const access = parseAccess(m.access ?? { enabled: true }, e);
  const migration = parseMigration(m.migration ?? { verification: "standard" }, e);
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
    ...(notes.length > 0 ? { notes } : {}),
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
  let base: RuntimeBase | undefined;
  if (r.base !== undefined) {
    if (typeof r.base === "string" && (RUNTIME_BASES as readonly string[]).includes(r.base)) base = r.base as RuntimeBase;
    else e(`runtime.base must be one of ${RUNTIME_BASES.join(", ")}`);
  }
  let start: string[] | undefined;
  if (r.start !== undefined) {
    if (
      !Array.isArray(r.start) ||
      r.start.length < 1 ||
      r.start.length > 32 ||
      r.start.some((a) => typeof a !== "string" || a.length < 1 || a.length > 1024 || /[\u0000-\u001f]/.test(a))
    ) {
      e("runtime.start must be a command as 1-32 strings (no shell), e.g. [\"node\", \"server.js\"]");
    } else start = [...(r.start as string[])];
    if (r.base === undefined) e("runtime.start needs runtime.base");
  }
  let root: string | undefined;
  if (r.root !== undefined) {
    if (typeof r.root !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(r.root) || r.root.split("/").includes("..")) {
      e("runtime.root must be a folder inside the app, e.g. \"public\"");
    } else root = r.root;
    if (r.base !== "static") e("runtime.root is only for the static runtime");
  }
  // A runtime app's image is the one the box builds; it has none until then.
  const image = base !== undefined && r.image === undefined ? "" : stringField(r, "runtime.image", e, "image");
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
  if ((!image && base === undefined) || image === undefined || port === undefined) return undefined;
  return { ...(base ? { base } : {}), ...(start ? { start } : {}), ...(root ? { root } : {}), image, port, env };
}

function parseData(v: unknown, e: (m: string) => void, notes: string[]): AppData | undefined {
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
      if (s.files !== undefined) {
        if (typeof s.files === "boolean") stores.files = s.files;
        else e("data.stores.files must be true or false");
      }
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
        if (k !== "postgres" && k !== "files" && k !== "objects" && k !== "kv") {
          e(`data.stores.${k} is not a recognized store flag`);
        }
      }
      // Older stores the box no longer runs become the ones that replace them.
      if (stores.objects !== undefined) {
        if (flagUsed(stores.objects)) {
          stores.files = true;
          notes.push(OBJECTS_STORE_NOTE);
        }
        delete stores.objects;
      }
      if (stores.kv !== undefined) {
        if (flagUsed(stores.kv)) {
          if (!flagUsed(stores.postgres)) stores.postgres = true;
          notes.push(KV_STORE_NOTE);
        }
        delete stores.kv;
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
  // subdomain is OPTIONAL — it's a cosmetic hint; the daemon derives the url label
  // from the service slug, not from here. Absent ⇒ no subdomain (no error). Present
  // ⇒ it must be a valid DNS label.
  const parsed = parseEgress(n.egress, e);
  const egress = parsed?.hosts;
  const why = parsed && Object.keys(parsed.why).length > 0 ? { egressWhy: parsed.why } : {};
  if (n.subdomain === undefined) return egress ? ({ egress, ...why } as AppNetwork) : undefined;
  if (typeof n.subdomain !== "string" || n.subdomain.length === 0) {
    e("network.subdomain must be a non-empty string");
    return undefined;
  }
  if (!SUBDOMAIN_RE.test(n.subdomain)) {
    e("network.subdomain must be a DNS label");
    return undefined;
  }
  return egress ? { subdomain: n.subdomain, egress, ...why } : { subdomain: n.subdomain };
}

function parseEgress(
  v: unknown,
  e: (m: string) => void,
): { hosts: string[]; why: Record<string, string> } | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    e("network.egress must be an array of host strings or {host, why} objects");
    return undefined;
  }
  if (v.length > EGRESS_HOSTS_MAX) {
    e(`network.egress may list at most ${EGRESS_HOSTS_MAX} hosts`);
    return undefined;
  }
  const hosts: string[] = [];
  const why: Record<string, string> = {};
  for (const entry of v) {
    let h: unknown = entry;
    let reason: string | undefined;
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const o = entry as Record<string, unknown>;
      h = o.host;
      if (o.why !== undefined) {
        if (typeof o.why !== "string") {
          e(`network.egress entry for ${JSON.stringify(h)}: why must be a string`);
          continue;
        }
        const w = o.why.trim();
        if (w.length > EGRESS_WHY_MAX) {
          e(`network.egress entry for ${JSON.stringify(h)}: why may be at most ${EGRESS_WHY_MAX} characters`);
          continue;
        }
        if (/[\u0000-\u001f\u007f]/.test(w)) {
          e(`network.egress entry for ${JSON.stringify(h)}: why must be one line of plain text`);
          continue;
        }
        if (w.length > 0) reason = w;
      }
    }
    if (typeof h !== "string" || !isEgressHost(h)) {
      e(
        `network.egress entry ${JSON.stringify(h)} must be a lowercase host like "api.example.com" or "*.example.com" (no scheme, port, path, IP address or trailing dot)`,
      );
      continue;
    }
    if (hosts.includes(h)) {
      e(`network.egress has duplicate entry ${JSON.stringify(h)}`);
      continue;
    }
    hosts.push(h);
    if (reason !== undefined) why[h] = reason;
  }
  return { hosts, why };
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
  let defaultRole: AppAccess["default_role"] = "member";
  if (a.default_role !== undefined) {
    if (typeof a.default_role !== "string" || !VALID_ROLES.has(a.default_role)) {
      e("access.default_role must be one of member, manager, master");
    } else {
      defaultRole = a.default_role as AppAccess["default_role"];
    }
  }
  let roleDescriptions: AppAccess["role_descriptions"];
  if (a.role_descriptions !== undefined) {
    const d = a.role_descriptions;
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      e("access.role_descriptions must be an object of rank → one line");
    } else {
      roleDescriptions = {};
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        if (!(RANKS as readonly string[]).includes(k)) {
          e(`access.role_descriptions: "${k}" isn't a rank (member, manager, master)`);
        } else if (typeof v !== "string" || v.trim().length === 0 || v.length > 120 || /[\r\n]/.test(v)) {
          e(`access.role_descriptions.${k} must be one line of at most 120 characters`);
        } else {
          roleDescriptions[k as (typeof RANKS)[number]] = v.trim();
        }
      }
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
        } else if (p.slice(0, p.endsWith("/*") ? -2 : undefined).includes("*")) {
          e(
            `access.public_routes entry ${JSON.stringify(p)}: a * may only end a prefix, as in "/api/public/*" (everything under /api/public/) or "/*" (the whole app)`,
          );
        } else if (/[?#\s]/.test(p)) {
          e(`access.public_routes entry ${JSON.stringify(p)} must be a path only, without a query, fragment or spaces`);
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
    ...(roleDescriptions ? { role_descriptions: roleDescriptions } : {}),
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
