import type { AppManifest } from "@flagship/protocol";
import type { AppDataCredentials } from "./dataLayer/index.js";
import type { DataProvisioner } from "./dataLayer/index.js";

/**
 * Renders the markdown context blob the vibe-coding LLM gets prepended to
 * its system prompt when working on an app. It tells the model:
 *
 *   - which env vars are available inside the container
 *   - what the connection URLs are (so generated code reads from the right place)
 *   - the current Postgres schema (table names, optionally column lists)
 *   - which sister apps are queryable
 *
 * The blob is regenerated on demand by the daemon — we don't cache it
 * because schema changes happen out-of-band (the user runs migrations).
 */

export interface LlmAppContextOptions {
  manifest: AppManifest;
  credentials?: AppDataCredentials;
  /** Manifests of every deployed app on this server, keyed by appId. Used to compute sister-app visibility. */
  deployedApps: Map<string, { manifest: AppManifest }>;
  /** Optional live admin to introspect the running schema. */
  dataProvisioner?: DataProvisioner;
  /** Whether to include the actual connection URLs (sensitive) or just the env-var names. */
  revealCredentials: boolean;
}

export interface LlmAppContext {
  appId: string;
  markdown: string;
  /** Programmatic surface for clients that want to build their own UX. */
  envVars: { name: string; description: string; sample?: string }[];
  sisterApps: { appId: string; subdomain: string }[];
}

export async function buildLlmAppContext(
  opts: LlmAppContextOptions,
): Promise<LlmAppContext> {
  const m = opts.manifest;
  const sisterApps = listVisibleSisterApps(m.name, opts.deployedApps);
  const envVars = enumerateEnvVars(m, opts.credentials, opts.revealCredentials);

  const tablesByDb = await collectTables(opts.credentials, opts.dataProvisioner);

  const md: string[] = [];
  md.push(`# Flagship app context — \`${m.name}\``);
  md.push("");
  md.push(
    `You are generating code for a Flagship app. The app runs as a podman ` +
      `container; persistent state must use the unified data layer (Postgres ` +
      `for relational, MinIO for blobs/files, Redis for cache/pubsub). The ` +
      `runtime exposes credentials as ` +
      `\`FLAGSHIP_*\` env vars below.`,
  );
  md.push("");
  md.push(`**App:** ${m.name} (v${m.version})`);
  if (m.description) md.push(`**Description:** ${m.description}`);
  md.push(`**Subdomain:** \`${m.network.subdomain}.<user>.flagship.services\``);
  md.push(`**Container image:** \`${m.runtime.image}\` listening on ${m.runtime.port}`);
  md.push(`**Default role:** ${m.access.default_role}`);
  if (m.access.custom_roles?.length) {
    md.push(`**Custom roles:** ${m.access.custom_roles.join(", ")}`);
  }
  md.push("");

  md.push("## Identity contract");
  md.push("");
  md.push(
    "Every inbound HTTP request carries `X-Flagship-User`, `X-Flagship-Role`, " +
      "`X-Flagship-Member`, and `X-Flagship-Signature`. Don't implement your own " +
      "auth — verify the signature against `/.flagship/runtime-pubkey` if you " +
      "need to gate sensitive operations, and use `X-Flagship-User` / `Role` " +
      "for authorization. **Never** read user identity from any other header, " +
      "cookie, or request body.",
  );
  md.push("");

  md.push("## Environment variables");
  md.push("");
  if (envVars.length === 0) {
    md.push("_(no data-layer stores enabled for this app)_");
  } else {
    for (const v of envVars) {
      const sample = v.sample ? `: \`${v.sample}\`` : "";
      md.push(`- \`${v.name}\` — ${v.description}${sample}`);
    }
  }
  md.push("");

  if (Object.keys(tablesByDb).length > 0) {
    md.push("## Postgres schema");
    md.push("");
    for (const [db, tables] of Object.entries(tablesByDb)) {
      md.push(`### \`${db}\``);
      if (tables.length === 0) {
        md.push("_(empty — your migration runs first)_");
      } else {
        md.push(tables.map((t) => `- \`${t}\``).join("\n"));
      }
      md.push("");
    }
  }

  md.push("## Sister apps");
  md.push("");
  if (sisterApps.length === 0) {
    md.push(
      "_No sister apps. To collaborate with another app, ask its owner to add " +
        `\`${m.name}\` to that app's \`access.queryable_by\` list._`,
    );
  } else {
    for (const s of sisterApps) {
      md.push(`- \`${s.appId}\` — query at \`${s.subdomain}.<user>.flagship.services\``);
    }
    md.push("");
    md.push(
      "Use `GET /.flagship/peers/<targetAppId>/installed` (with " +
        "`Authorization: Bearer $FLAGSHIP_PEERS_TOKEN`) to check whether a " +
        "sister app is installed before invoking it.",
    );
  }
  md.push("");

  md.push("## Hard rules");
  md.push("");
  md.push("- Do NOT read or write outside the FLAGSHIP_* env-supplied resources.");
  md.push("- Do NOT implement login forms, password storage, or session cookies.");
  md.push("- Do NOT hardcode user IDs or server IDs — they come from `X-Flagship-User`.");
  md.push("- Public routes (`access.public_routes`) get `X-Flagship-User: anonymous`.");
  md.push("");

  return { appId: m.name, markdown: md.join("\n"), envVars, sisterApps };
}

function listVisibleSisterApps(
  selfAppId: string,
  deployedApps: Map<string, { manifest: AppManifest }>,
): { appId: string; subdomain: string }[] {
  const out: { appId: string; subdomain: string }[] = [];
  for (const [appId, entry] of deployedApps) {
    if (appId === selfAppId) continue;
    const queryable = entry.manifest.access.queryable_by ?? [];
    if (queryable.includes(selfAppId)) {
      out.push({ appId, subdomain: entry.manifest.network.subdomain });
    }
  }
  return out;
}

function enumerateEnvVars(
  m: AppManifest,
  creds: AppDataCredentials | undefined,
  reveal: boolean,
): { name: string; description: string; sample?: string }[] {
  const out: { name: string; description: string; sample?: string }[] = [];
  // Always-on identity headers (delivered as request headers, not env, but we
  // remind the LLM here so it doesn't reach for env-var auth).
  if (creds?.postgres) {
    if (creds.postgresSingleton) {
      const inst = creds.postgres.default;
      if (inst) {
        out.push({
          name: "FLAGSHIP_PG_URL",
          description: "Postgres connection (per-app role + database)",
          sample: reveal ? inst.url : undefined,
        });
        out.push({
          name: "FLAGSHIP_PG_DATABASE",
          description: "Per-app database name",
          sample: inst.database,
        });
        out.push({
          name: "FLAGSHIP_PG_ROLE",
          description: "Per-app Postgres role",
          sample: inst.role,
        });
      }
    } else {
      out.push({
        name: "FLAGSHIP_PG_INSTANCES",
        description: "Comma-separated list of Postgres instance names",
        sample: Object.keys(creds.postgres).join(","),
      });
      for (const [instance, inst] of Object.entries(creds.postgres)) {
        const upper = instance.replace(/-/g, "_").toUpperCase();
        out.push({
          name: `FLAGSHIP_PG_URL_${upper}`,
          description: `Postgres connection for instance "${instance}"`,
          sample: reveal ? inst.url : undefined,
        });
      }
    }
  }
  if (creds?.objects) {
    if (creds.objectsSingleton) {
      const inst = creds.objects.default;
      if (inst) {
        out.push({ name: "FLAGSHIP_S3_ENDPOINT", description: "MinIO endpoint", sample: inst.endpoint });
        out.push({ name: "FLAGSHIP_S3_BUCKET", description: "Per-app bucket", sample: inst.bucket });
        out.push({
          name: "FLAGSHIP_S3_ACCESS_KEY",
          description: "Bucket access key",
          sample: reveal ? inst.accessKey : undefined,
        });
        out.push({
          name: "FLAGSHIP_S3_SECRET_KEY",
          description: "Bucket secret key (treat as sensitive)",
          sample: reveal ? inst.secretKey : undefined,
        });
      }
    } else {
      for (const [instance, inst] of Object.entries(creds.objects)) {
        const upper = instance.replace(/-/g, "_").toUpperCase();
        out.push({
          name: `FLAGSHIP_S3_BUCKET_${upper}`,
          description: `Bucket for instance "${instance}"`,
          sample: inst.bucket,
        });
      }
    }
  }
  if (creds?.kv) {
    if (creds.kvSingleton) {
      const inst = creds.kv.default;
      if (inst) {
        out.push({
          name: "FLAGSHIP_REDIS_URL",
          description: "Redis connection (auth + key prefix in URL)",
          sample: reveal ? inst.url : undefined,
        });
        out.push({
          name: "FLAGSHIP_REDIS_PREFIX",
          description: "Required prefix for every key your app touches",
          sample: inst.prefix,
        });
      }
    } else {
      for (const [instance, inst] of Object.entries(creds.kv)) {
        const upper = instance.replace(/-/g, "_").toUpperCase();
        out.push({
          name: `FLAGSHIP_REDIS_PREFIX_${upper}`,
          description: `Redis prefix for instance "${instance}"`,
          sample: inst.prefix,
        });
      }
    }
  }
  if ((m.access.queryable_by?.length ?? 0) > 0 || true) {
    // FLAGSHIP_PEERS_TOKEN is always issued so `is_app_installed` queries work.
    out.push({
      name: "FLAGSHIP_PEERS_TOKEN",
      description: "Service token for the local /.flagship/peers/* endpoints (sister-app discovery)",
    });
  }
  // User-declared env from the manifest, surfaced for context (the LLM should
  // know what was already configured).
  for (const [k, v] of Object.entries(m.runtime.env ?? {})) {
    out.push({ name: k, description: "manifest-declared env", sample: reveal ? v : undefined });
  }
  return out;
}

async function collectTables(
  creds: AppDataCredentials | undefined,
  provisioner: DataProvisioner | undefined,
): Promise<Record<string, string[]>> {
  if (!creds?.postgres || !provisioner) return {};
  const out: Record<string, string[]> = {};
  for (const inst of Object.values(creds.postgres)) {
    try {
      out[inst.database] = await provisioner.listPostgresTables(inst.database);
    } catch {
      out[inst.database] = [];
    }
  }
  return out;
}
