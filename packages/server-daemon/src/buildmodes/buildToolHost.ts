/**
 * The Flagship build TOOL SURFACE — one authoritative implementation of the
 * limited, contract-bounded functions a build agent drives:
 *   get_contract · list_files · read_file · write_file · delete_file ·
 *   validate · request_env_var · get_journal · deploy · check_app ·
 *   get_logs · query_db · list_tables · list_data_files · read_data_file ·
 *   finish
 *
 * BOTH callers route through here, so the surface can never drift between
 * them:
 *   - the box's OWN AI (the agentic git-adapt loop) — `buildAgent.ts`
 *     dispatches the model's tool calls through `call()`.
 *   - an EXTERNAL IDE/agent over MCP — `mcpServer.ts` wraps `call()` in the
 *     JSON-RPC 2.0 envelope.
 *
 * The host operates on a `BuildWorkspace` + the shared `BuildJournal` plus
 * the same hooks the MCP context took (owner env NAMES, value-free
 * `recordEnvRequest`, `deploy`, `logs`). It is transport-agnostic and
 * journals every call value-free (names/sizes/validation problems only —
 * never file contents, never a secret value).
 *
 * `deploy`, `check_app`, `get_logs` and the data tools (`query_db`,
 * `list_tables`, `list_data_files`, `read_data_file`: the copy's sample
 * data, after a successful deploy) only ever reach the build's private
 * staging copy (`staging.ts`), never a live service or its data; `finish` hands the
 * build to the box, which seals it (`sealed` then refuses every tool) before
 * it goes live. See docs/ai-privacy-and-staging.md §2.
 */

import { RUNTIME_BASES, parseManifest } from "@flagship/protocol";
import type { BuildJournal, BuildMode } from "./buildJournal.js";
import type { BuildWorkspace } from "./buildWorkspace.js";
import { renderContractMarkdown } from "./contract.js";
import { checkDockerfile } from "./dockerfilePolicy.js";
import { noRedaction, type ModelRedactor } from "../llm/modelPrivacy.js";
import { environmentFailureForAgent, type EnvironmentFailure } from "./environmentFailure.js";

export interface BuildToolDeployResult {
  ok: boolean;
  reason?: string;
  /** The box, not the app, failed: the agent is told to stop, and loops end. */
  environment?: EnvironmentFailure;
}

export interface BuildToolCheckResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  body?: string;
  truncated?: boolean;
  reason?: string;
}

/** A data tool's answer: compact JSON for the model, or why not. */
export type BuildToolDataResult = { ok: true; text: string } | { ok: false; reason: string };

/** The staging copy's sample data, bound to one build (staging.ts `StagingDataTools`). */
export interface BuildToolDataHooks {
  queryDb(req: { sql: string; store?: string }): Promise<BuildToolDataResult>;
  listTables(req: { store?: string }): Promise<BuildToolDataResult>;
  listDataFiles(req: { path?: string }): Promise<BuildToolDataResult>;
  readDataFile(req: { path: string }): Promise<BuildToolDataResult>;
}

export interface BuildToolHostContext {
  buildId: string;
  workspace: BuildWorkspace;
  journal: BuildJournal;
  serverFqdn: string;
  /** Owner-set env var NAMES (never values). */
  envNames: () => Promise<string[]>;
  /**
   * Record a value-free request that the owner set a named env var. The
   * actual value is supplied later from the phone via the signed
   * set-app-env path — NEVER through a build tool. Optional.
   */
  recordEnvRequest?: (req: { name: string; why?: string; secret?: boolean }) => Promise<void>;
  /** Build the workspace and run it as the private staging copy. Absent ⇒ the deploy tool refuses. */
  deploy?: () => Promise<BuildToolDeployResult>;
  /** Request a path from the staging copy (never a live service). */
  checkApp?: (req: { path: string; method?: string; body?: string }) => Promise<BuildToolCheckResult>;
  /** The staging copy's recent output; null when nothing is running. */
  logs?: () => Promise<string | null>;
  /** The staging copy's sample data (dev database, dev files volume). Absent ⇒ those tools refuse. */
  data?: BuildToolDataHooks;
  /** The AI says the app works. The box decides; a refusal comes back as the reason. */
  finish?: () => Promise<{ ok: boolean; reason?: string }>;
  /** True once the build is sealed: every tool refuses from then on. */
  sealed?: () => boolean;
  /**
   * Which build mode owns the journal entries this host writes. `mcp` for
   * the external-IDE path, `git` for the box's own agentic adapt loop.
   */
  mode?: BuildMode;
  /**
   * Strips the owner's identity (account, server, addresses) from every
   * box-written text a model reads back. Absent ⇒ texts pass unchanged.
   */
  redact?: ModelRedactor;
}

/** Tools whose results are the repo's own bytes, never box-written text. */
const REPO_CONTENT_TOOLS = new Set(["read_file", "list_files"]);

/** The result of one tool call. `text` is what the model/IDE sees back. */
export interface BuildToolResult {
  text: string;
  isError?: boolean;
  /** Value-free journal summary (defaults to the tool name). */
  journalSummary?: string;
  journalDetail?: string;
  /** Set when the call hit a failure of the box itself; the box's own loops stop on it. */
  environment?: EnvironmentFailure;
}

/** Names of the tools the surface exposes, in the order they appear. */
export const BUILD_TOOL_NAMES = [
  "get_contract",
  "list_files",
  "read_file",
  "write_file",
  "delete_file",
  "validate",
  "request_env_var",
  "get_journal",
  "deploy",
  "check_app",
  "get_logs",
  "query_db",
  "list_tables",
  "list_data_files",
  "read_data_file",
  "finish",
] as const;

export type BuildToolName = (typeof BUILD_TOOL_NAMES)[number];

export interface BuildToolSpec {
  name: BuildToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The canonical tool specs. The MCP server publishes these verbatim under
 * `tools/list`; the agentic loop hands them to the model as the provider's
 * native tool shape. ONE definition so the two paths can never diverge.
 */
export const BUILD_TOOL_SPECS: BuildToolSpec[] = [
  {
    name: "get_contract",
    description:
      "Read the Flagship app contract: hard rules, manifest schema, injected env vars, and the build workflow. Read this first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "List the paths currently in the build workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read one file from the build workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the build workspace. Paths are repo-relative (forward slashes, no '..'). Never a Dockerfile: the box writes the build from runtime.base.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Remove a file from the build workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "validate",
    description:
      "Validate the workspace's flagship.app.json against the manifest schema (and that the box can build it: runtime.base). Returns problems, or ok.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "request_env_var",
    description:
      "Ask the owner to set a named secret env var. VALUE-FREE: you never see or send the value — the owner supplies it from their phone. Returns whether it is currently set.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        why: { type: "string" },
        secret: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_journal",
    description: "Read the build journal — the full history of this build across all modes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "deploy",
    description:
      "Build the container from the workspace and start it as a PRIVATE TEST COPY on the box, with sample data and no internet. Returns whether it built and started (and why not). It does not make the app public.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_app",
    description:
      "Send one HTTP request to the test copy (after deploy) as a signed-in owner and see the status, content type and the first 4 KB of the answer.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to request, starting with /, e.g. \"/\" or \"/api/items\"." },
        method: { type: "string", description: "HTTP method (default GET)." },
        body: { type: "string", description: "Request body for POST/PUT/PATCH (JSON is sent as application/json)." },
      },
      required: ["path"],
    },
  },
  {
    name: "get_logs",
    description: "Read the recent output of the test copy (after deploy).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_db",
    description:
      "Run SQL against the test copy's database (after a deploy, even one whose app failed to start). It holds only sample data, never the owner's. Returns at most 200 rows as JSON; statements time out after 10 s. Writes are allowed (they change only the test copy).",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL to run, e.g. \"SELECT * FROM items LIMIT 20\"." },
        store: { type: "string", description: "Which Postgres store, for an app with several (data.stores.postgres names)." },
      },
      required: ["sql"],
    },
  },
  {
    name: "list_tables",
    description:
      "List the test copy's database tables with their columns, types and row counts (after a deploy, even one whose app failed to start).",
    inputSchema: {
      type: "object",
      properties: { store: { type: "string", description: "Which Postgres store, for an app with several." } },
    },
  },
  {
    name: "list_data_files",
    description:
      "List what the test copy has written to its files folder (/data, FLAGSHIP_FILES_DIR) with sizes (after a deploy, even one whose app failed to start). Not the workspace: use list_files for that.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "A folder under /data to list (default: all of /data)." } },
    },
  },
  {
    name: "read_data_file",
    description: "Read the first 16 KB of one file the test copy wrote to /data (after a deploy, even one whose app failed to start).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "The file's path under /data, e.g. \"uploads/a.txt\"." } },
      required: ["path"],
    },
  },
  {
    name: "finish",
    description:
      "Say the app works. Only after a successful deploy of the current files. The box then puts it live; your session ends and you can't use any tool on this build again.",
    inputSchema: { type: "object", properties: {} },
  },
];

export class BuildToolHost {
  constructor(private readonly ctx: BuildToolHostContext) {}

  /** The names of all tools the host exposes. */
  toolNames(): readonly BuildToolName[] {
    return BUILD_TOOL_NAMES;
  }

  /**
   * Dispatch ONE tool call and journal it (value-free). `args` is the
   * model's / IDE's parsed argument object. Never throws for a tool-level
   * failure — it returns `{isError:true}` so the agent can recover.
   */
  async call(name: string, args: Record<string, unknown>): Promise<BuildToolResult> {
    const raw = this.ctx.sealed?.()
      ? toolErr("this build is closed: the app was handed to the box, and its tools no longer answer", `refused ${name}: sealed`)
      : await this.dispatch(name, args);
    const r = REPO_CONTENT_TOOLS.has(name) ? raw : { ...raw, text: (this.ctx.redact ?? noRedaction)(raw.text) };
    await this.ctx.journal.append(this.ctx.buildId, {
      mode: this.ctx.mode ?? "mcp",
      kind: "mcp-call",
      actor: (this.ctx.mode ?? "mcp") === "mcp" ? "ide" : "ai",
      summary: r.journalSummary ?? name,
      ...(r.journalDetail != null ? { detail: r.journalDetail } : {}),
    });
    return r;
  }

  /** One staging data tool. Journal summaries never carry the SQL or a path's contents. */
  private async dataCall(
    name: string,
    run: (d: BuildToolDataHooks) => Promise<BuildToolDataResult>,
    summary: string,
  ): Promise<BuildToolResult> {
    if (!this.ctx.data) return toolErr(`${name} is not available for this session`, `${name} unavailable`);
    const r = await run(this.ctx.data);
    if (!r.ok) return toolErr(r.reason, `${name}: refused`);
    return { text: r.text, journalSummary: summary };
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<BuildToolResult> {
    switch (name) {
      case "get_contract":
        return { text: renderContractMarkdown(), journalSummary: "read contract" };

      case "list_files": {
        const files = this.ctx.workspace.list();
        return { text: JSON.stringify({ files }), journalSummary: `list_files (${files.length})` };
      }

      case "read_file": {
        const path = str(args.path);
        const content = this.ctx.workspace.read(path);
        if (content == null) return toolErr(`no such file: ${path}`, `read_file miss: ${path}`);
        return { text: content, journalSummary: `read_file ${path}` };
      }

      case "write_file": {
        const path = str(args.path);
        const content = typeof args.content === "string" ? args.content : "";
        const w = this.ctx.workspace.write(path, content);
        if (!w.ok) return toolErr(w.reason, `write_file rejected: ${path}`);
        return {
          text: JSON.stringify({ ok: true, path, bytes: Buffer.byteLength(content, "utf8") }),
          journalSummary: `wrote ${path}`,
        };
      }

      case "delete_file": {
        const path = str(args.path);
        const existed = this.ctx.workspace.delete(path);
        return { text: JSON.stringify({ ok: true, existed }), journalSummary: `delete ${path}` };
      }

      case "validate": {
        const manifestJson = this.ctx.workspace.manifestJson();
        if (manifestJson == null) return toolErr("no flagship.app.json in the workspace yet", "validate: no manifest");
        let parsed: unknown;
        try {
          parsed = JSON.parse(manifestJson);
        } catch (e) {
          return toolErr(`flagship.app.json is not valid JSON: ${(e as Error).message}`, "validate: bad json");
        }
        const result = parseManifest(parsed);
        if (!result.ok) {
          return {
            text: JSON.stringify({ ok: false, problems: result.errors }),
            journalSummary: `validate: ${result.errors.length} problem(s)`,
          };
        }
        // A runtime app is built by the box. Without a runtime, only the
        // imported repo's own Dockerfile (an AI can't write one) can build it.
        const dockerfile = result.manifest.runtime.base ? null : this.ctx.workspace.read("Dockerfile");
        const policy = dockerfile == null ? null : checkDockerfile(dockerfile);
        const dockerfileProblems = policy && !policy.ok ? policy.problems : [];
        const problems = [
          ...(!result.manifest.runtime.base && dockerfile == null
            ? [`set runtime.base to one of ${RUNTIME_BASES.join(", ")}: the box builds the app on it`]
            : []),
          ...dockerfileProblems,
        ];
        return {
          text: JSON.stringify({
            ok: problems.length === 0,
            manifestName: result.manifest.name,
            problems,
            // An older objects/kv store: accepted, but S3 and Redis aren't available.
            ...(result.notes ? { notes: result.notes } : {}),
          }),
          journalSummary:
            dockerfileProblems.length > 0
              ? `validate: ${dockerfileProblems.length} Dockerfile problem(s)`
              : problems.length
                ? `validate: ${problems.join(", ")}`
                : "validate: ok",
        };
      }

      case "request_env_var": {
        const envName = str(args.name);
        if (!envName) return toolErr("name required", "request_env_var: no name");
        if (envName.startsWith("FLAGSHIP_")) return toolErr("FLAGSHIP_ prefix is reserved", "request_env_var: reserved");
        const why = typeof args.why === "string" ? args.why : undefined;
        const secret = typeof args.secret === "boolean" ? args.secret : undefined;
        if (this.ctx.recordEnvRequest) {
          await this.ctx.recordEnvRequest({ name: envName, why, secret });
        }
        const names = await this.ctx.envNames();
        const currentlySet = names.includes(envName);
        return {
          text: JSON.stringify({
            name: envName,
            status: currentlySet ? "set" : "pending-owner",
            currentlySet,
            note: "The owner sets the value from their phone. You will never receive it; read it from the process environment at runtime.",
          }),
          journalSummary: `requested env var ${envName}${currentlySet ? " (already set)" : ""}`,
        };
      }

      case "get_journal": {
        // What happened, in order, without when (clock times hint at the
        // owner's day and time zone) or which service and URL it became.
        const entries = await this.ctx.journal.read(this.ctx.buildId);
        const history = entries.map((e) => ({ kind: e.kind, actor: e.actor, summary: e.summary }));
        return { text: JSON.stringify(history), journalSummary: "read journal" };
      }

      case "deploy": {
        if (!this.ctx.deploy) return toolErr("deploy is not available for this session", "deploy unavailable");
        if (!this.ctx.workspace.manifestJson())
          return toolErr("nothing to deploy: write flagship.app.json first", "deploy: no manifest");
        const d = await this.ctx.deploy();
        if (!d.ok && d.environment) {
          return {
            ...toolErr(environmentFailureForAgent(d.environment), `staging failed: the server's ${d.environment.kind} is down`),
            environment: d.environment,
          };
        }
        if (!d.ok) return toolErr(d.reason ?? "deploy failed", `staging failed: ${firstLine(d.reason ?? "")}`);
        return { text: JSON.stringify({ ok: true }), journalSummary: "staged a test copy" };
      }

      case "check_app": {
        if (!this.ctx.checkApp) return toolErr("check_app is not available for this session", "check_app unavailable");
        const path = str(args.path);
        if (!path) return toolErr("path required", "check_app: no path");
        const r = await this.ctx.checkApp({
          path,
          ...(typeof args.method === "string" ? { method: args.method } : {}),
          ...(typeof args.body === "string" ? { body: args.body } : {}),
        });
        if (!r.ok) return toolErr(r.reason ?? "request failed", `check_app ${path}: no answer`);
        return {
          text: JSON.stringify({
            status: r.status,
            contentType: r.contentType,
            body: r.body,
            ...(r.truncated ? { truncated: true } : {}),
          }),
          journalSummary: `check_app ${path} → ${r.status}`,
        };
      }

      case "get_logs": {
        const text = this.ctx.logs ? await this.ctx.logs() : null;
        if (text == null) return { text: "nothing is running yet: call deploy first", journalSummary: "get_logs (none)" };
        return { text: text || "(no output yet)", journalSummary: "read staging logs" };
      }

      case "query_db": {
        const sql = str(args.sql);
        if (!sql.trim()) return toolErr("sql required", "query_db: no sql");
        const store = optStr(args.store);
        return this.dataCall("query_db", (d) => d.queryDb({ sql, ...(store ? { store } : {}) }), "ran a query on the test copy");
      }

      case "list_tables": {
        const store = optStr(args.store);
        return this.dataCall("list_tables", (d) => d.listTables(store ? { store } : {}), "listed the test copy's tables");
      }

      case "list_data_files": {
        const path = optStr(args.path);
        return this.dataCall("list_data_files", (d) => d.listDataFiles(path ? { path } : {}), "listed the test copy's files");
      }

      case "read_data_file": {
        const path = str(args.path);
        if (!path) return toolErr("path required", "read_data_file: no path");
        return this.dataCall("read_data_file", (d) => d.readDataFile({ path }), "read a test copy file");
      }

      case "finish": {
        if (!this.ctx.finish) return toolErr("finish is not available for this session", "finish unavailable");
        const f = await this.ctx.finish();
        if (!f.ok) return toolErr(f.reason ?? "not finished", "finish refused");
        return {
          text: JSON.stringify({ ok: true, note: "Thanks. The box takes it from here; this session is over." }),
          journalSummary: "the AI finished",
        };
      }

      default:
        return toolErr(`unknown tool: ${name}`, `unknown tool: ${name}`);
    }
  }
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function toolErr(message: string, journalSummary: string): BuildToolResult {
  return { text: JSON.stringify({ ok: false, error: message }), isError: true, journalSummary };
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
