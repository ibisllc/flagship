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

import { dataRecipesMarkdown } from "../dataLayer/guide.js";

export const BUILD_CONTRACT_VERSION = "1";

export interface BuildContractRule {
  id: string;
  rule: string;
}

export const BUILD_CONTRACT_RULES: BuildContractRule[] = [
  { id: "sign-in", rule: "Prefer Flagship identity, and suggest it to the owner: the box checks who is calling before the app sees a request and injects signed headers on every request, X-Flagship-User (a stable member id; `anonymous` on routes listed in access.public_routes), X-Flagship-Role, X-Flagship-Timestamp and X-Flagship-Signature. Read those: no login code, no passwords. Build the app's own sign-in only when the owner asks for it, and then: store passwords only as slow salted hashes (pgcrypto `crypt(pw, gen_salt('bf'))`, or the language's bcrypt, argon2 or scrypt), never in plaintext or reversibly; for social sign-in (Google, GitHub, …) request the client id and secret with request_env_var (value-free) and tell the owner where to get them, and list the provider's hosts in network.egress (the owner approves them); list the login, signup and OAuth callback paths in access.public_routes; keep sessions in Postgres; set session cookies `Secure; HttpOnly; SameSite=Lax`; protect state-changing forms against CSRF; rate-limit login attempts. Unsafe requests (anything but GET/HEAD/OPTIONS) and WebSocket upgrades sent from another site's page arrive as anonymous." },
  { id: "live-and-machine-clients", rule: "WebSockets and Server-Sent Events work: the box streams responses as the app sends them and passes WebSocket upgrades through, deciding access and injecting the identity headers on the upgrade request like on any other; an idle connection closes after 10 minutes, so send a heartbeat. For pub/sub, put Postgres LISTEN/NOTIFY behind the app's own WebSocket or SSE route. Machine clients (scripts, devices, other servers) use API keys the owner creates on the app's page: the box checks `Authorization: Bearer fsk_…` itself, strips it, and injects X-Flagship-User: apikey:<keyId>, X-Flagship-Role: api and X-Flagship-Api-Scope: read|write (a read key may only GET/HEAD/OPTIONS); don't build another API-key system. access.public_routes entries are exact paths or a prefix ending in /* (\"/api/public/*\"; \"/*\" makes the whole app public). The box adds no CORS headers: send your own if another site must call the app." },
  { id: "no-raw-browser", rule: "Do NOT use raw CDP, Puppeteer, Playwright, or shell out to Chromium. Set browser.domains in the manifest and call the daemon's /.flagship/browser/* API from inside the container." },
  { id: "single-port", rule: "Listen on the port the daemon injects as the PORT environment variable (process.env.PORT / $PORT), which equals your manifest runtime.port. Bind 0.0.0.0:$PORT. Do NOT hardcode a port number, and do NOT open a second HTTP server, metrics port, or debug port. Your Dockerfile's final stage should EXPOSE the same runtime.port." },
  { id: "no-egress", rule: "The app has NO internet. A live app may reach only hosts the owner allows. List the hosts it needs in the manifest's network.egress, each a host or {host, why} with a short reason (at most 120 characters) the owner reads, e.g. [{\"host\": \"api.open-meteo.com\", \"why\": \"weather forecasts\"}, \"*.tile.openstreetmap.org\"] (HTTPS 443 or HTTP 80 only). When the app goes live the box suggests them to the owner as a draft access list; nothing opens until they approve it on their phone, and in the private test copy those calls fail (the name doesn't resolve). Declare only hosts the app really needs, and make the app work (show a clear message) while they are blocked." },
  { id: "build-sandbox", rule: "Docker build RUN steps reach only package registries (npm, PyPI, Debian/Ubuntu/Alpine mirrors, GitHub, Go, crates.io, RubyGems). The box rejects `ADD <url>` (download in a RUN step, or COPY from the repo) and FROM / COPY --from images outside docker.io, ghcr.io, quay.io, mcr.microsoft.com, public.ecr.aws and gcr.io." },
  { id: "data-layer-only", rule: "Do NOT persist to the container filesystem (wiped every deploy). Store data in Postgres (FLAGSHIP_PG_URL) and files in FLAGSHIP_FILES_DIR (data.stores.files); keep file metadata and listings in Postgres and serve files through the app. S3 and Redis are not available. See \"Storing things\" below." },
  { id: "locked-down-container", rule: "The container runs with a READ-ONLY root filesystem (only /tmp is writable: a 64 MB scratch space, wiped on restart), with every Linux capability dropped and no-new-privileges, so a process can't change file ownership or switch user. Point any scratch or cache files (pid files, temp dirs) at /tmp, and prefer images that run as a non-root user. Stock web-server images such as nginx, httpd or caddy exit at startup here. For a static site use `FROM nginxinc/nginx-unprivileged:alpine` (copy files to /usr/share/nginx/html; it listens on 8080, so set runtime.port 8080), or `FROM busybox:stable` with `CMD [\"sh\",\"-c\",\"exec httpd -f -p 0.0.0.0:${PORT} -h /www\"]`." },
  { id: "reserved-env", rule: "Do NOT define env vars whose names start with FLAGSHIP_ — that prefix is reserved by the runtime." },
  { id: "no-hardcoded-identity", rule: "Do NOT hardcode the username, hostname, or any <user>.flagship.services URL. Apps move between boxes; take identity from request headers and FLAGSHIP_* env." },
  { id: "owner-env-names-only", rule: "Owner-set secrets are env vars you reference by NAME (read from the process environment). Never ask for, guess, or hardcode their values; request a new one via the request_env_var tool, which is value-free." },
];

export const INJECTED_ENV: Record<string, string> = {
  "data.stores.postgres": "FLAGSHIP_PG_URL, FLAGSHIP_PG_DATABASE, FLAGSHIP_PG_ROLE (named: FLAGSHIP_PG_URL_<INSTANCE>, the instance name upper-cased with - as _)",
  "data.stores.files": "FLAGSHIP_FILES_DIR=/data (the app's one writable folder, kept across restarts and redeploys)",
  "data.stores.objects / data.stores.kv": "older manifests only: S3 and Redis are not available. objects gives the files folder, kv the Postgres database; validate says so",
  always: "PORT (the port to listen on — equals runtime.port; bind 0.0.0.0:$PORT), FLAGSHIP_APP_TOKEN (bearer for /.flagship/* daemon APIs), FLAGSHIP_PEERS_TOKEN (sister-app lookups)",
};

export const MANIFEST_SCHEMA_SUMMARY =
  "flagship.app.json, schema_version=1. Required: name (lowercase DNS label), version (semver, start 0.1.0), " +
  "description (<=30 chars), runtime{image:'flagship/<name>:0.1.0', port:int}, network{subdomain}, " +
  "access{enabled:true, default_role:'owner'|'admin'|'member'|'viewer', public_routes?:string[] (exact paths, or a prefix ending in /*), custom_roles?:string[]}, " +
  "migration{verification:'standard'|'elevated'}. Optional: data.stores.postgres (true | string[]), data.stores.files (true), " +
  "browser.domains?:string[] (literal host or *.host), network.egress?:(string|{host,why})[] (internet hosts the live app needs, each optionally with a short why; the owner must approve them), distribution.public?:bool. " +
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
    "You are building a containerised app that the Flagship daemon will build, run, and front with a TLS reverse proxy on the user's own box. Produce a directory of files in the build workspace via the write_file tool, deploy a private test copy, test it, then call finish.",
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
    "## Storing things (Postgres and the files folder)",
    dataRecipesMarkdown(),
    "",
    "## Workflow",
    "1. read the contract (this), 2. write_file each file (start with flagship.app.json), 3. validate, 4. deploy: the box builds the image and starts a PRIVATE TEST COPY with sample data, placeholder values for owner secrets, and no internet; it reports whether it built and started, 5. test it with check_app (one HTTP request, sent as a signed-in owner) and get_logs (its output), and look at what it stored with list_tables and query_db (its database: sample data only, at most 200 rows back) and list_data_files / read_data_file (its /data folder); fix, validate and deploy again until it works, 6. finish: the box then puts that same image live on its own, with the real data, and this session ends (every tool refuses from then on). finish only works after a successful deploy of the current files. Use request_env_var for owner secrets (value-free). get_journal shows the full history.",
  ].join("\n");
}
