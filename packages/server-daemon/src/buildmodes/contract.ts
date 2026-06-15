/**
 * The Flagship app contract, rendered for an EXTERNAL builder (an IDE
 * agent over MCP) rather than for the box's own model. It restates the
 * same hard-rules the vibe-code system prompt locks (kept deliberately
 * in sync with `systemPrompt.ts`'s "Hard rules" section) plus the
 * manifest shape and the injected env vars, so a Cursor/Cline agent can
 * fetch the rules and build to them without a Flagship-specific model.
 *
 * Containment does NOT depend on the agent reading this — cap-drop,
 * read-only FS, single port and the domain-gated browser API enforce the
 * walls structurally (see serviceRunner / serviceProxy). This document
 * just lets a well-behaved agent avoid building something the harness
 * would reject.
 */

export const BUILD_CONTRACT_VERSION = "1";

export interface BuildContractRule {
  id: string;
  rule: string;
}

export const BUILD_CONTRACT_RULES: BuildContractRule[] = [
  { id: "no-auth", rule: "Do NOT write authentication. The daemon injects X-Flagship-User, X-Flagship-Role, X-Flagship-Member and X-Flagship-Signature on every request. Read those headers. No login forms, passwords, cookies, or JWTs. `X-Flagship-User: anonymous` arrives on routes listed in access.public_routes." },
  { id: "no-raw-browser", rule: "Do NOT use raw CDP, Puppeteer, Playwright, or shell out to Chromium. Set browser.domains in the manifest and call the daemon's /.flagship/browser/* API from inside the container." },
  { id: "single-port", rule: "Listen on runtime.port ONLY. No second HTTP server, metrics port, or debug port." },
  { id: "no-egress", rule: "No outbound calls to hosts not in browser.domains. The container has no general egress; fetch() outside the allowlist hangs." },
  { id: "data-layer-only", rule: "Do NOT persist to the container filesystem (wiped every deploy). Use FLAGSHIP_PG_URL, FLAGSHIP_S3_*, FLAGSHIP_REDIS_URL." },
  { id: "reserved-env", rule: "Do NOT define env vars whose names start with FLAGSHIP_ — that prefix is reserved by the runtime." },
  { id: "no-hardcoded-identity", rule: "Do NOT hardcode the username, hostname, or any <user>.flagship.services URL. Apps move between boxes; take identity from request headers and FLAGSHIP_* env." },
  { id: "owner-env-names-only", rule: "Owner-set secrets are env vars you reference by NAME (read from the process environment). Never ask for, guess, or hardcode their values; request a new one via the request_env_var tool, which is value-free." },
];

export const INJECTED_ENV: Record<string, string> = {
  "data.stores.postgres": "FLAGSHIP_PG_URL, FLAGSHIP_PG_DATABASE, FLAGSHIP_PG_ROLE (named: FLAGSHIP_PG_URL_<INSTANCE>)",
  "data.stores.objects": "FLAGSHIP_S3_ENDPOINT, FLAGSHIP_S3_BUCKET, FLAGSHIP_S3_ACCESS_KEY, FLAGSHIP_S3_SECRET_KEY",
  "data.stores.kv": "FLAGSHIP_REDIS_URL, FLAGSHIP_REDIS_PREFIX (every key must start with the prefix)",
  always: "FLAGSHIP_APP_TOKEN (bearer for /.flagship/* daemon APIs), FLAGSHIP_PEERS_TOKEN (sister-app lookups)",
};

export const MANIFEST_SCHEMA_SUMMARY =
  "flagship.app.json, schema_version=1. Required: name (lowercase DNS label), version (semver, start 0.1.0), " +
  "description (<=30 chars), runtime{image:'flagship/<name>:0.1.0', port:int}, network{subdomain}, " +
  "access{enabled:true, default_role:'owner'|'admin'|'member'|'viewer', public_routes?:string[], custom_roles?:string[]}, " +
  "migration{verification:'standard'|'elevated'}. Optional: data.stores.{postgres,objects,kv} (true | string[]), " +
  "browser.domains?:string[] (literal host or *.host), distribution.public?:bool. " +
  "The build is a directory: flagship.app.json + Dockerfile (final stage EXPOSEs runtime.port) + source + optional migrations/0001_init.sql.";

/** Full contract as markdown — the get_contract tool / contract resource body. */
export function renderContractMarkdown(): string {
  const rules = BUILD_CONTRACT_RULES.map((r) => `- (${r.id}) ${r.rule}`).join("\n");
  const env = Object.entries(INJECTED_ENV)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return [
    `# Flagship app contract (v${BUILD_CONTRACT_VERSION})`,
    "",
    "You are building a containerised app that the Flagship daemon will build, run, and front with a TLS reverse proxy on the user's own box. Produce a directory of files in the build workspace via the write_file tool, then call deploy.",
    "",
    "## Hard rules (the harness enforces these; breaking them fails the build or hangs the app)",
    rules,
    "",
    "## Manifest",
    MANIFEST_SCHEMA_SUMMARY,
    "",
    "## Env vars the daemon injects (by manifest declaration)",
    env,
    "",
    "## Workflow",
    "1. read the contract (this), 2. write_file each file (start with flagship.app.json), 3. validate, 4. deploy. Use request_env_var for owner secrets (value-free). get_journal shows the full history.",
  ].join("\n");
}
